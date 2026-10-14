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
import { progress, standingOf } from "./progress.ts";
import type { ReviewState, Round } from "./queries.ts";
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

const [round] = state().rounds;

const next = (extra: Record<string, unknown> = {}) => nextStep(state(extra), input, stops, round as Round);

/** An inline comment on b.ts, attached at a patch offset, or orphaned when the offset is undefined. */
const inline = (id: string, minute: number, offset: number | undefined, replies: Array<unknown>, path = "b.ts"): Comment =>
  ({
    kind: "inline",
    id,
    source: { kind: "reviewer" },
    body: "Floor?",
    created_at: at(minute),
    updated_at: at(minute),
    anchor: { path, start_line: 1, end_line: 1 },
    history: [],
    attachment:
      offset === undefined
        ? { state: "orphan", reason: "The lines changed." }
        : { state: "attached", start: offset, end: offset + 4, reason: "Same patch." },
    replies,
  }) as unknown as Comment;

test("answers to read come in page order: by file in walkthrough order, then row, orphans last in their file, then the whole change", () => {
  const orphan = inline("c-orphan", 1, undefined, [
    { ...answer("t2", 9), disposition: "fixed", fixed_in: { fingerprint: "2".repeat(64) } },
  ]);
  const comments = [
    general("c-general", 0, [answer("t1", 6)]),
    orphan,
    inline("c-row-20", 3, 20, [answer("t1", 7)]),
    inline("c-row-2", 4, 2, [answer("t1", 8)]),
    inline("c-closing", 0, 2, [answer("t1", 5)], "a.ts"),
    general("c-waiting", 1, []),
  ];
  // b.ts is stop 1's first file, a.ts is in the closing stop: the oldest answer, on a.ts, is not first.
  assert.deepEqual(next({ comments }), {
    kind: "answer",
    comment: "c-row-2",
    thread: "t1",
    github: false,
    place: { kind: "inline", path: "b.ts", start: 1, end: 1 },
    more: 4,
    target: commentElementId("c-row-2"),
  });
  const order: Array<string> = [];
  let left = [...comments];
  for (;;) {
    const step = next({ comments: left });
    if (step.kind !== "answer") break;
    order.push(step.comment);
    left = left.filter((comment) => comment.id !== step.comment);
  }
  assert.deepEqual(order, ["c-row-2", "c-row-20", "c-orphan", "c-closing", "c-general"]);
});

test("an answer counts how many more follow it", () => {
  assert.equal(next({ comments: [general("c-1", 1, [answer("t1", 2)])] }).kind, "answer");
  const one = next({ comments: [general("c-1", 1, [answer("t1", 2)])] });
  assert.equal(one.kind === "answer" ? one.more : -1, 0);
  const three = next({
    comments: [general("c-1", 1, [answer("t1", 2)]), general("c-2", 3, [answer("t1", 4)]), general("c-3", 5, [answer("t2", 6)])],
  });
  assert.equal(three.kind === "answer" ? three.more : -1, 2);
});

test("a reply on a comment from GitHub is the reply, not an agent's answer", () => {
  const fromGitHub = {
    ...general("c-gh", 1, []),
    source: { kind: "github", author: "octocat", resolved: false },
    replies: [answer("t1", 2)],
  } as unknown as Comment;
  const step = next({ comments: [fromGitHub] });
  assert.equal(step.kind, "answer");
  assert.equal(step.kind === "answer" && step.github, true);
});

test("drift is not a step: the strip goes on to the files", () => {
  const drift = { round: 2, checked_at: at(4), paths: ["b.ts", "c.ts"] };
  assert.equal(next({ drift }).kind, "file");
});

test("the next file is the first in walkthrough order whose approval does not hold", () => {
  assert.deepEqual(
    next({
      approvals: [
        approval("b.ts", "2".repeat(64)),
        // A lapsed approval: c.ts changed since it was viewed.
        approval("c.ts", "9".repeat(64)),
      ],
    }),
    { kind: "file", path: "c.ts", stop: 1, left: 3, target: fileElementId("c.ts") },
  );
});

test("a file without a fingerprint is skipped, and with every file viewed the round is finished next", () => {
  const viewed = ["a.ts", "b.ts", "c.ts", "e.ts"].map((path) =>
    approval(path, input.files.find((item) => item.path === path)?.fingerprint ?? ""),
  );
  // A question waits for an agent; a plain comment is pending until the finish, so it waits for no one yet.
  const question = { ...general("c-question", 1, []), source: { kind: "reviewer", question: true } } as unknown as Comment;
  assert.deepEqual(
    next({ approvals: viewed, comments: [question, general("c-held", 2, [])] }),
    { kind: "finish", round: 2, waiting: 1, target: "finish" },
  );
});

test("a finished round and a closed review have nothing next, even with answers to read", () => {
  const comments = [general("c-late", 5, [answer("t1", 6)])];
  assert.deepEqual(
    next({
      comments,
      submissions: [{ round: 2, verdict: "request_changes", body: "", submitted_at: at(7), revision: 3 }],
    }),
    { kind: "finished", round: 2, verdict: "request_changes" },
  );
  assert.deepEqual(next({ comments, closed_at: at(8) }), { kind: "closed" });
});

test("progress counts viewable and viewed files, answers for the reviewer, comments waiting, and pending ones", () => {
  const question = { ...general("c-question", 1, []), source: { kind: "reviewer", question: true } } as unknown as Comment;
  const counts = progress(
    state({
      approvals: [approval("b.ts", "2".repeat(64)), approval("c.ts", "9".repeat(64))],
      comments: [
        general("c-answered", 1, [answer("t1", 2)]),
        question,
        general("c-held", 3, []),
        general("c-replied", 3, [answer("t1", 4), { id: "r", created_at: at(5), actor: "reviewer", action: "reply", body: "Why?" }]),
        general("c-done", 3, [answer("t1", 4), { id: "r2", created_at: at(5), actor: "reviewer", action: "accept", body: "" }]),
      ],
    }),
    input,
  );
  assert.deepEqual(
    { ...counts, viewed: [...counts.viewed] },
    { viewable: 4, viewed: ["b.ts"], forYou: 1, waiting: 2, pending: 1 },
  );
});

test("a comment is pending until a finish carries it; one made after the round is finished waits for the agents", () => {
  const sent = general("c-sent", 1, []);
  const later = general("c-later", 9, []);
  const finishedEarlier = { round: 1, verdict: "comment", body: "", submitted_at: at(5), revision: 2 };
  const standing = standingOf(state({ comments: [sent, later], submissions: [finishedEarlier] }));
  assert.equal(standing(sent), "agent");
  assert.equal(standing(later), "pending");
  const finishedNow = { ...finishedEarlier, round: 2 };
  assert.equal(standingOf(state({ comments: [later], submissions: [finishedNow] }))(later), "agent");
});

test("a comment sent after finishing stays waiting when the next round is published", () => {
  const sent = general("c-sent", 6, []);
  const pending = general("c-pending", 9, []);
  const current = state({
    rounds: [{ ...round, published_at: at(7) }],
    submissions: [{ round: 1, verdict: "comment", body: "", submitted_at: at(5), revision: 2 }],
    comments: [sent, pending],
  });
  assert.equal(standingOf(current)(sent), "agent");
  assert.equal(standingOf(current)(pending), "pending");
  const counts = progress(current, input);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.pending, 1);
});
