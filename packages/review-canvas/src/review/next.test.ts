import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import {
  commentElementId,
  fileElementId,
  nextStep,
  walkthroughOrder,
} from "./next.ts";
import type { ReviewState } from "./state.ts";
import { tourView } from "./tour.ts";

const patch = "@@ -0,0 +1,2 @@\n+one\n+two\n";

const file = (path: string, fingerprint: string | undefined): ReviewFile =>
  ({
    path,
    status: "added",
    group: "core",
    additions: 2,
    deletions: 0,
    patch,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  }) as ReviewFile;

// Stop 1 excerpts b.ts and lists c.ts; a.ts, d.bin, and e.ts go in the closing stop, in input order.
const input = {
  target: { kind: "worktree", title: "T", root: "/r", head_sha: "a".repeat(40) },
  files_complete: true,
  files: [
    file("a.ts", "1".repeat(64)),
    file("b.ts", "2".repeat(64)),
    file("c.ts", "3".repeat(64)),
    file("d.bin", undefined),
    file("e.ts", "5".repeat(64)),
  ],
  stops: [
    {
      title: "First",
      summary: "",
      attention: null,
      excerpts: [{ path: "b.ts", side: "new", start: 1, end: 2, caption: "" }],
      files: [{ path: "c.ts" }],
      notes: [],
      questions: [],
    },
  ],
} as unknown as ReviewInput;

const stops = tourView(input).stops;

const at = (minute: number) =>
  `2026-10-13T19:${String(minute).padStart(2, "0")}:00.000Z`;

const state = (extra: Record<string, unknown> = {}): ReviewState =>
  ({
    id: "review-x",
    target: input.target,
    created_at: at(0),
    closed_at: undefined,
    carry_from: undefined,
    rounds: [
      { round: 2, input_sha256: "f".repeat(64), thread: "t1", published_at: at(1) },
    ],
    approvals: [],
    comments: [],
    submissions: [],
    ...extra,
  }) as unknown as ReviewState;

const approval = (path: string, fingerprint: string) => ({
  path,
  fingerprint,
  approved_at: at(2),
  round: 2,
});

const general = (id: string, minute: number, replies: Array<unknown>): Comment =>
  ({
    kind: "general",
    id,
    source: { kind: "reviewer" },
    body: "Why?",
    created_at: at(minute),
    updated_at: at(minute),
    replies,
  }) as unknown as Comment;

const answer = (thread: string, minute: number) => ({
  id: `reply-${minute}`,
  created_at: at(minute),
  actor: "agent",
  thread,
  disposition: "answered",
  body: "Because.",
});

test("walkthrough order is each stop's owned files in its order, then the closing stop", () => {
  assert.deepEqual(
    walkthroughOrder(stops).map((item) => `${item.stop}:${item.path}`),
    ["1:b.ts", "1:c.ts", "2:a.ts", "2:d.bin", "2:e.ts"],
  );
});

test("the oldest answer to read comes first, with how many more follow", () => {
  const orphan = {
    kind: "inline",
    id: "c-orphan",
    source: { kind: "reviewer" },
    body: "Floor?",
    created_at: at(3),
    updated_at: at(9),
    anchor: { path: "b.ts", start_line: 11, end_line: 12 },
    history: [],
    attachment: { state: "orphan", reason: "The lines changed." },
    replies: [{ ...answer("t2", 9), disposition: "fixed", fixed_in: { fingerprint: "2".repeat(64) } }],
  } as unknown as Comment;
  const next = nextStep(
    state({
      comments: [
        general("c-late", 5, [answer("t1", 6)]),
        orphan,
        general("c-waiting", 1, []),
      ],
    }),
    input,
    stops,
  );
  assert.deepEqual(next, {
    kind: "answer",
    comment: "c-orphan",
    thread: "t2",
    github: false,
    place: { kind: "inline", path: "b.ts", start: 11, end: 12 },
    more: 1,
    target: commentElementId("c-orphan"),
  });
});

test("drift in this round comes before files; drift from an earlier round does not count", () => {
  const drift = { round: 2, checked_at: at(4), paths: ["b.ts", "c.ts"] };
  assert.deepEqual(nextStep(state({ drift }), input, stops), {
    kind: "drift",
    files: 2,
    target: "drift",
  });
  const old = { ...drift, round: 1 };
  assert.equal(nextStep(state({ drift: old }), input, stops).kind, "file");
});

test("the next file is the first in walkthrough order whose approval does not hold", () => {
  const next = nextStep(
    state({
      approvals: [
        approval("b.ts", "2".repeat(64)),
        // A lapsed approval: c.ts changed since it was viewed.
        approval("c.ts", "9".repeat(64)),
      ],
    }),
    input,
    stops,
  );
  assert.deepEqual(next, {
    kind: "file",
    path: "c.ts",
    stop: 1,
    left: 3,
    target: fileElementId("c.ts"),
  });
});

test("a file without a fingerprint is skipped, and with every file viewed the round is finished next", () => {
  const viewed = ["a.ts", "b.ts", "c.ts", "e.ts"].map((path) =>
    approval(path, input.files.find((item) => item.path === path)?.fingerprint ?? ""),
  );
  const next = nextStep(
    state({
      approvals: viewed,
      comments: [general("c-waiting", 1, [])],
    }),
    input,
    stops,
  );
  assert.deepEqual(next, { kind: "finish", round: 2, waiting: 1, target: "finish" });
});

test("a finished round and a closed review have nothing next, even with answers to read", () => {
  const comments = [general("c-late", 5, [answer("t1", 6)])];
  assert.deepEqual(
    nextStep(
      state({
        comments,
        submissions: [{ round: 2, verdict: "request_changes", body: "", submitted_at: at(7), revision: 3 }],
      }),
      input,
      stops,
    ),
    { kind: "finished", round: 2, verdict: "request_changes" },
  );
  assert.deepEqual(
    nextStep(state({ comments, closed_at: at(8) }), input, stops),
    { kind: "closed" },
  );
});
