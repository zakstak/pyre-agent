import assert from "node:assert/strict";
import { test } from "node:test";
import * as Result from "effect/Result";
import { Schema } from "effect";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { ReviewInput } from "../schema/input.ts";
import {
  type CommitSha,
  Fingerprint,
  type PullRequestUrl,
  type ReviewId,
  type RoundNumber,
  type StackId,
  type Timestamp,
} from "../schema/primitives.ts";
import type { OpenPullRequest } from "../schema/pull-requests.ts";
import {
  STACK_FORMAT,
  StepKey,
  type StackRecord,
  type StackStep,
} from "../schema/stack.ts";
import { fixtureBytes } from "../schema/testing.ts";
import {
  carryProgress,
  type LayerSource,
  pinLayers,
  readState,
  resolveStack,
  resumeAt,
  StackRefused,
  stackPath,
} from "./stack-walk.ts";
import { neighbors } from "./stack-steps.ts";

const url = (n: number) =>
  `https://github.com/acme/project/pull/${n}` as PullRequestUrl;
const sha = (n: number) => String(n).padStart(2, "0").repeat(20) as CommitSha;
const stepKey = Schema.decodeSync(StepKey);
const at = "2026-10-20T00:00:00.000Z" as Timestamp;

const open = (
  n: number,
  head: string,
  base: string,
  extra: Partial<OpenPullRequest> = {},
): OpenPullRequest => ({
  url: url(n),
  title: `PR ${n}`,
  head_branch: head,
  base_branch: base,
  same_repository: true,
  ...extra,
});

/** A merged PR whose history says it was first based on `parent`'s branch, then retargeted to main. */
const merged = (
  n: number,
  branch: string,
  parent: string | undefined,
): OpenPullRequest =>
  open(n, branch, "main", {
    history: {
      state: "MERGED",
      base_sha: sha(1),
      head_sha: sha(n),
      default_branch: "main",
      base_branches: parent === undefined ? [] : [parent],
      timeline_complete: true,
    },
  });

test("a branching stack's walkthrough path follows the tip's ancestors and leaves siblings out", () => {
  // #68 -> #65 -> #69, with #66, #70, #71, and #72 also based on #68.
  const items = [
    open(68, "core", "main"),
    open(65, "api", "core"),
    open(69, "ui", "api"),
    open(66, "docs", "core"),
    open(70, "cli", "core"),
    open(71, "perf", "core"),
    open(72, "bench", "core"),
  ];
  const found = stackPath(items, url(69));
  assert.deepEqual(
    found?.path.map((pull) => pull.url),
    [url(68), url(65), url(69)],
  );
  assert.deepEqual(
    found?.excluded.map((pull) => pull.url).toSorted(),
    [url(66), url(70), url(71), url(72)].toSorted(),
  );
  // A walkthrough to a middle layer leaves out the PR that builds on it.
  assert.deepEqual(
    stackPath(items, url(65))
      ?.excluded.map((pull) => pull.url)
      .includes(url(69)),
    true,
  );
  assert.equal(stackPath(items, url(99)), undefined);
});

test("a historical five-layer stack resolves its path from base-change history", () => {
  const items = [
    merged(67, "one", undefined),
    merged(73, "two", "one"),
    merged(74, "three", "two"),
    merged(75, "four", "three"),
    merged(76, "five", "four"),
  ];
  const found = stackPath(items, url(76));
  assert.deepEqual(
    found?.path.map((pull) => pull.url),
    [url(67), url(73), url(74), url(75), url(76)],
  );
  assert.deepEqual(
    found?.path.map((pull) => pull.history?.head_sha),
    [sha(67), sha(73), sha(74), sha(75), sha(76)],
  );
  assert.deepEqual(found?.excluded, []);
});

const fixture = (): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/pull-request.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return decoded.success;
};

/** The PR fixture as layer `n` at its own head. */
const layer = (n: number, head = sha(n)): ReviewInput => {
  const base = fixture();
  if (base.target.kind === "worktree") assert.fail("expected a PR fixture");
  return {
    ...base,
    target: { ...base.target, url: url(n), title: `PR ${n}`, head_sha: head },
  };
};

const stop = (n: number, title: string, path = "src/retry.py"): StackStep => ({
  layer: url(n),
  title,
  summary: `${title} summary`,
  attention: null,
  excerpts: [],
  files: [{ path: path as StackStep["files"][number]["path"] }],
  notes: [],
  questions: [],
});

const record = (
  steps: ReadonlyArray<StackStep>,
  layers = [68, 65, 69],
): StackRecord => ({
  id: "stack-test" as StackId,
  created_at: at,
  walkthrough: {
    format: STACK_FORMAT,
    title: "The stack",
    tip: url(layers.at(-1) ?? 0),
    steps,
  },
  historical: false,
  layers: layers.map((n) => ({
    url: url(n),
    title: `PR ${n}`,
    head_sha: sha(n),
    target_key: `github_pr:${url(n)}`,
  })),
  excluded: [],
});

const current = (n: number, input = layer(n)): LayerSource => ({
  kind: "current",
  review: `review-${n}` as ReviewId,
  round: 1 as RoundNumber,
  input,
});

test("steps run across PR boundaries in base-to-tip order, each layer closing with its uncovered files", () => {
  const walk = record([
    stop(68, "Core retry"),
    stop(65, "API limit", "config/retry.json"),
    stop(69, "UI"),
  ]);
  const resolved = resolveStack(walk, [current(68), current(65), current(69)], {
    marks: [],
  });
  assert.deepEqual(
    resolved.steps.map((step) => step.key),
    ["L0:S0", "L0:other", "L1:S0", "L1:other", "L2:S0", "L2:other"],
  );
  assert.deepEqual(
    resolved.steps.map((step) => step.authored),
    [0, undefined, 1, undefined, 2, undefined],
  );
  assert.equal(resolved.position, "L0:S0");
  const { previous, next } = neighbors(resolved.steps, stepKey("L0:other"));
  assert.equal(previous?.key, "L0:S0");
  assert.equal(next?.key, "L1:S0", "next crosses into the next PR");
  assert.equal(neighbors(resolved.steps, stepKey("L2:other")).next, undefined);
});

test("a mark counts only at the head and file versions it was read at", () => {
  const walk = record([stop(68, "Core retry")], [68]);
  const first = resolveStack(walk, [current(68)], { marks: [] });
  const version = first.versions.get(stepKey("L0:S0"));
  assert.ok(version !== undefined);
  const mark = { step: stepKey("L0:S0"), ...version, read_at: at };
  assert.equal(
    resolveStack(walk, [current(68)], { marks: [mark] }).steps[0]?.read,
    "read",
  );

  // A later round at the same head changed the file the step covers.
  const changed = layer(68);
  const edited = {
    ...changed,
    files: changed.files.map((file) =>
      file.path === "src/retry.py"
        ? {
            ...file,
            fingerprint: Schema.decodeSync(Fingerprint)("f".repeat(64)),
          }
        : file,
    ),
  };
  assert.equal(
    resolveStack(walk, [current(68, edited)], { marks: [mark] }).steps[0]?.read,
    "changed",
  );
  // Another file of the layer changed: this step's mark still holds.
  const other = {
    ...changed,
    files: changed.files.map((file) =>
      file.path === "config/retry.json"
        ? {
            ...file,
            fingerprint: Schema.decodeSync(Fingerprint)("e".repeat(64)),
          }
        : file,
    ),
  };
  assert.equal(
    resolveStack(walk, [current(68, other)], { marks: [mark] }).steps[0]?.read,
    "read",
  );
  assert.equal(
    readState(mark, { head_sha: sha(99), files: version.files }),
    "changed",
  );
  assert.equal(readState(undefined, version), "unread");
});

test("a stale or missing layer keeps the agent's prose, hides excerpts, and invalidates its marks", () => {
  const walk = record([stop(68, "Core retry"), stop(69, "UI")]);
  const fresh = resolveStack(walk, [current(68), current(65), current(69)], {
    marks: [],
  });
  const version = fresh.versions.get(stepKey("L2:S0"));
  assert.ok(version !== undefined);
  const marks = [{ step: stepKey("L2:S0"), ...version, read_at: at }];
  const resolved = resolveStack(
    walk,
    [
      current(68),
      { kind: "missing" },
      { kind: "stale", review: "review-69" as ReviewId, head_sha: sha(90) },
    ],
    { marks },
  );
  const byKey = new Map(resolved.steps.map((step) => [step.key, step]));
  // The missing layer had no authored step: a placeholder keeps it in the progression.
  assert.deepEqual(byKey.get(stepKey("L1:missing"))?.title, "#65 PR 65");
  // The stale layer's step keeps its prose, has no tour stop, and its read mark no longer counts.
  const stale = byKey.get(stepKey("L2:S0"));
  assert.equal(stale?.stop, undefined);
  assert.equal(stale?.summary, "UI summary");
  assert.equal(stale?.read, "changed");
  assert.equal(
    resolved.versions.has(stepKey("L2:S0")),
    false,
    "a stale step cannot be marked read",
  );
  assert.equal(byKey.has(stepKey("L2:other")), false);
  assert.deepEqual(
    resolved.layers.map((item) => item.state.kind),
    ["current", "missing", "stale"],
  );
});

test("the reviewer resumes where they were, or else at the first step not read", () => {
  const steps = [
    { key: stepKey("L0:S0"), read: "read" as const },
    { key: stepKey("L0:other"), read: "changed" as const },
    { key: stepKey("L1:S0"), read: "unread" as const },
  ];
  assert.equal(resumeAt(steps, stepKey("L1:S0")), "L1:S0");
  assert.equal(
    resumeAt(steps, stepKey("L5:S0")),
    "L0:other",
    "a step that left falls back to the first not read",
  );
  assert.equal(resumeAt(steps, undefined), "L0:other");
  assert.equal(resumeAt(steps.slice(0, 1), undefined), "L0:S0");
});

test("publication refuses sibling steps, steps out of order, missing threads, and moved heads", () => {
  const walk = record([stop(68, "Core"), stop(69, "UI")]);
  const request = {
    walkthrough: walk.walkthrough,
    historical: false,
    path: walk.layers.map(({ url, title, head_sha }) => ({
      url,
      title,
      head_sha,
    })),
    excluded: [{ url: url(66), title: "PR 66" }],
  };
  const reviews = [68, 65, 69].map((n) => ({
    review: `review-${n}` as ReviewId,
    url: url(n),
    target_key: `github_pr:${url(n)}`,
    input: layer(n),
  }));
  assert.deepEqual(
    pinLayers(request, reviews).map((item) => item.target_key),
    reviews.map((item) => item.target_key),
  );
  const refused = (
    change: Partial<typeof request>,
    list = reviews,
    message: RegExp,
  ) =>
    assert.throws(
      () => pinLayers({ ...request, ...change }, list),
      (error) => error instanceof StackRefused && message.test(error.message),
    );
  refused(
    { walkthrough: { ...walk.walkthrough, steps: [stop(66, "Docs")] } },
    reviews,
    /not an ancestor of the tip/,
  );
  refused(
    {
      walkthrough: {
        ...walk.walkthrough,
        steps: [stop(69, "UI"), stop(68, "Core")],
      },
    },
    reviews,
    /base layer to the tip/,
  );
  refused({}, reviews.slice(0, 2), /No thread given for #69/);
  refused(
    {},
    reviews.map((item) =>
      item.url === url(65) ? { ...item, input: layer(65, sha(91)) } : item,
    ),
    /Publish a round at the current head/,
  );
  refused(
    { path: request.path.slice(0, 2) },
    reviews,
    /end at the walkthrough's tip/,
  );
  refused(
    { excluded: [{ url: url(65), title: "PR 65" }] },
    reviews,
    /both on the path and excluded/,
  );
});

test("a republished walkthrough keeps progress only for steps the agent left as they were", () => {
  const before = record([stop(68, "Core"), stop(65, "API"), stop(69, "UI")]);
  const after = record([
    stop(68, "Core"),
    stop(65, "API, rewritten"),
    stop(69, "UI"),
  ]);
  const mark = (step: string) => ({
    step: stepKey(step),
    head_sha: sha(68),
    files: [],
    read_at: at,
  });
  const carried = carryProgress(before, after, {
    position: stepKey("L1:S0"),
    marks: [mark("L0:S0"), mark("L0:other"), mark("L1:S0"), mark("L2:S0")],
  });
  assert.equal(
    carried.position,
    undefined,
    "the rewritten step's position does not carry",
  );
  assert.deepEqual(
    carried.marks.map((item) => item.step),
    ["L0:S0", "L0:other", "L2:S0"],
  );
  // A layer inserted below shifts every layer index; nothing on a different PR carries.
  const shifted = record(
    [stop(68, "Core"), stop(65, "API"), stop(69, "UI")],
    [67, 68, 65, 69],
  );
  assert.deepEqual(
    carryProgress(before, shifted, { marks: [mark("L0:S0")] }).marks,
    [],
  );
});
