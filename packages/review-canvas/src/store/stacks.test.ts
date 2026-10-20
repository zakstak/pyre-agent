import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as Result from "effect/Result";
import { Schema } from "effect";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { ReviewInput } from "../schema/input.ts";
import type {
  CommitSha,
  Fingerprint,
  PullRequestUrl,
  RepoPath,
  ReviewId,
} from "../schema/primitives.ts";
import {
  STACK_FORMAT,
  StackSnapshot,
  StepKey,
  type StackPublishRequest,
  type StackStep,
} from "../schema/stack.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { ActionError } from "../review/state.ts";
import { Store } from "./store.ts";

const host = { kind: "claude-code" } as const;
const url = (n: number) =>
  `https://github.com/acme/project/pull/${n}` as PullRequestUrl;
const sha = (n: number) => String(n).padStart(2, "0").repeat(20) as CommitSha;
const stepKey = Schema.decodeSync(StepKey);

const layer = (n: number, head = sha(n)): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/pull-request.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  const base = decoded.success;
  if (base.target.kind === "worktree") assert.fail("expected a PR fixture");
  return {
    ...base,
    target: { ...base.target, url: url(n), title: `PR ${n}`, head_sha: head },
  };
};

const step = (n: number, title: string, path = "src/retry.py"): StackStep => ({
  layer: url(n),
  title,
  summary: "",
  attention: null,
  excerpts: [],
  files: [{ path: path as RepoPath }],
  notes: [],
  questions: [],
});

/** Registers and publishes a review of each layer, as an agent does before publishing the walkthrough. */
const reviewed = (store: Store, layers: ReadonlyArray<number>) =>
  layers.map((n) => {
    const input = layer(n);
    const registered = store.register({
      target: input.target,
      label: `Thread ${n}`,
      host,
    });
    store.publish(registered.review.state.id, registered.thread.id, input);
    return {
      n,
      review: registered.review.state.id,
      thread: registered.thread.id,
    };
  });

const request = (
  layers: ReadonlyArray<number>,
  steps: ReadonlyArray<StackStep>,
): Omit<StackPublishRequest, "sessions"> => ({
  walkthrough: {
    format: STACK_FORMAT,
    title: "Retry stack",
    tip: url(layers.at(-1) ?? 0),
    steps,
  },
  historical: false,
  path: layers.map((n) => ({
    url: url(n),
    title: `PR ${n}`,
    head_sha: sha(n),
  })),
  excluded: [{ url: url(66), title: "Sibling docs" }],
});

const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-stacks-"));
  return {
    path: join(dir, "reviews.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const fails = (work: () => unknown, message: RegExp) =>
  assert.throws(
    work,
    (error) => error instanceof ActionError && message.test(error.message),
  );

test("a walkthrough's progression and progress survive a restart, and its snapshot decodes", (t) => {
  const { path, cleanup } = tempPath();
  t.after(cleanup);
  const store = Store.open(path);
  const layers = reviewed(store, [68, 65, 69]);
  const published = store.publishStack(
    request(
      [68, 65, 69],
      [step(68, "Core"), step(65, "API", "config/retry.json"), step(69, "UI")],
    ),
    layers.map((item) => item.review),
  );
  assert.equal(published.replaced, undefined);
  const first = published.snapshot;
  assert.equal(first.position, "L0:S0");
  assert.deepEqual(
    first.layers.map((item) => item.state.kind),
    ["current", "current", "current"],
  );
  assert.deepEqual(
    first.excluded.map((item) => item.url),
    [url(66)],
  );
  // Next on the last step of #68 marks it read and crosses into #65.
  store.stackAct(published.id, {
    kind: "go",
    step: stepKey("L0:other"),
    read: stepKey("L0:S0"),
  });
  store.stackAct(published.id, {
    kind: "go",
    step: stepKey("L1:S0"),
    read: stepKey("L0:other"),
  });
  store.close();

  const reopened = Store.open(path);
  const resumed = reopened.stackSnapshot(published.id);
  assert.ok(resumed !== undefined);
  assert.equal(resumed.position, "L1:S0");
  assert.deepEqual(
    resumed.steps
      .filter((item) => item.read === "read")
      .map((item) => item.key),
    ["L0:S0", "L0:other"],
  );
  assert.ok(
    Result.isSuccess(
      Schema.decodeUnknownResult(StackSnapshot)(
        Schema.encodeSync(StackSnapshot)(resumed),
      ),
    ),
  );
  assert.deepEqual(
    reopened.stacks().map((item) => [item.id, item.read, item.steps]),
    [[published.id, 2, resumed.steps.length]],
  );
  // A step that does not exist, and reading a step that cannot be read, are refused.
  fails(
    () =>
      reopened.stackAct(published.id, { kind: "go", step: stepKey("L9:S0") }),
    /no step L9:S0/,
  );
  reopened.stackAct(published.id, { kind: "unread", step: stepKey("L0:S0") });
  assert.equal(reopened.stackSnapshot(published.id)?.steps[0]?.read, "unread");
  reopened.close();
});

test("a layer's new head makes it stale; a fresh start at the same head stays current", () => {
  const store = Store.open(":memory:");
  const layers = reviewed(store, [68, 69]);
  const { id } = store.publishStack(
    request([68, 69], [step(68, "Core"), step(69, "UI")]),
    layers.map((item) => item.review),
  );
  store.stackAct(id, {
    kind: "go",
    step: stepKey("L1:S0"),
    read: stepKey("L1:S0"),
  });
  const tip = layers[1];
  assert.ok(tip !== undefined);

  // The reviewer approves a file in the per-PR review; the walkthrough leaves that review's state alone.
  const tipFile = layer(69).files.find((file) => file.path === "src/retry.py");
  assert.ok(tipFile?.fingerprint !== undefined);
  store.act(tip.review, {
    kind: "approve",
    path: tipFile.path,
    fingerprint: tipFile.fingerprint,
  });
  assert.equal(store.review(tip.review)?.state.approvals.length, 1);

  // A fresh review of the same PR at the same head replaces the review; the layer is still current.
  const fresh = store.register({
    target: layer(69).target,
    label: "Fresh",
    host,
    fresh: true,
  });
  store.publish(fresh.review.state.id, fresh.thread.id, layer(69));
  const kept = store.stackSnapshot(id);
  assert.deepEqual(kept?.layers[1]?.state, {
    kind: "current",
    review: fresh.review.state.id,
    round: 1,
  });
  assert.equal(kept?.steps.find((item) => item.key === "L1:S0")?.read, "read");

  // A round at a new head: the layer is stale, its excerpts are not resolved, and its read no longer counts.
  const moved = layer(69, sha(90));
  store.publish(fresh.review.state.id, fresh.thread.id, {
    ...moved,
    files: moved.files.map((file) =>
      file.path === "src/retry.py"
        ? { ...file, fingerprint: "a".repeat(64) as Fingerprint }
        : file,
    ),
  });
  const stale = store.stackSnapshot(id);
  assert.deepEqual(stale?.layers[1]?.state, {
    kind: "stale",
    review: fresh.review.state.id,
    head_sha: sha(90),
  });
  const tipStep = stale?.steps.find((item) => item.key === "L1:S0");
  assert.equal(tipStep?.read, "changed");
  assert.equal(tipStep?.stop, undefined);
  fails(
    () =>
      store.stackAct(id, {
        kind: "go",
        step: stepKey("L0:S0"),
        read: stepKey("L1:S0"),
      }),
    /not current/,
  );

  // Closing the base layer's review without a replacement leaves it missing.
  store.register({
    target: layer(68).target,
    label: "Restart",
    host,
    fresh: true,
  });
  assert.deepEqual(store.stackSnapshot(id)?.layers[0]?.state.kind, "missing");
  store.close();
});

test("publication refuses worktree reviews, closed reviews, and reviews behind the host head", () => {
  const store = Store.open(":memory:");
  const layers = reviewed(store, [68, 69]);
  const ids = layers.map((item) => item.review);
  fails(
    () =>
      store.publishStack(
        {
          ...request([68, 69], []),
          path: [
            { url: url(68), title: "PR 68", head_sha: sha(68) },
            { url: url(69), title: "PR 69", head_sha: sha(91) },
          ],
        },
        ids,
      ),
    /Publish a round at the current head/,
  );
  const base = layers[0];
  assert.ok(base !== undefined);
  store.register({
    target: layer(68).target,
    label: "Restart",
    host,
    fresh: true,
  });
  fails(() => store.publishStack(request([68, 69], []), ids), /is closed/);
  store.close();
});

test("republishing a tip's walkthrough replaces it and keeps unchanged steps' progress", () => {
  const store = Store.open(":memory:");
  const layers = reviewed(store, [68, 69]);
  const ids = layers.map((item) => item.review);
  const first = store.publishStack(
    request([68, 69], [step(68, "Core"), step(69, "UI")]),
    ids,
  );
  store.stackAct(first.id, {
    kind: "go",
    step: stepKey("L1:S0"),
    read: stepKey("L0:S0"),
  });
  const second = store.publishStack(
    request([68, 69], [step(68, "Core"), step(69, "UI, explained again")]),
    ids,
  );
  assert.equal(second.replaced, first.id);
  const old = store.stackSnapshot(first.id);
  assert.ok(old?.closed_at !== undefined);
  assert.equal(old.replaced_by, second.id);
  fails(
    () => store.stackAct(first.id, { kind: "go", step: stepKey("L0:S0") }),
    /replaced/,
  );
  const now = second.snapshot;
  assert.equal(now.steps.find((item) => item.key === "L0:S0")?.read, "read");
  assert.equal(
    now.position,
    "L0:other",
    "the rewritten step's position does not carry; the first unread step does",
  );
  assert.deepEqual(
    store.stacks().map((item) => item.id),
    [second.id],
  );
  store.close();
});

test("a version 4 database from before walkthroughs opens with its reviews and gains the table", (t) => {
  const { path, cleanup } = tempPath();
  t.after(cleanup);
  const store = Store.open(path);
  const [only] = reviewed(store, [68]);
  store.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE stack_walkthroughs;");
  old.close();
  const upgraded = Store.open(path);
  assert.equal(upgraded.reviews().length, 1);
  assert.deepEqual(upgraded.stacks(), []);
  assert.ok(only !== undefined);
  const { id } = upgraded.publishStack(request([68], [step(68, "Core")]), [
    only.review as ReviewId,
  ]);
  assert.equal(upgraded.stackSnapshot(id)?.steps.length, 2);
  upgraded.close();
  const version = new DatabaseSync(path);
  assert.deepEqual(
    { ...(version.prepare("PRAGMA user_version").get() ?? {}) },
    { user_version: 4 },
  );
  version.close();
});
