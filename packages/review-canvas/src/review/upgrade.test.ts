import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradeState } from "./upgrade.ts";

const at = (minute: number) =>
  `2026-10-13T19:${String(minute).padStart(2, "0")}:00.000Z`;

const anchor = {
  snapshot: { round: 1, input_sha256: "a".repeat(64) },
  path: "a.ts",
  patch_sha256: "b".repeat(64),
  start: 0,
  end: 2,
  quote: "+x",
  prefix: "",
  suffix: "",
  start_row: 1,
  end_row: 1,
  side: "new",
  start_line: 1,
  end_line: 1,
};

const comment = (id: string, minute: number, source: object, replies = []) => ({
  kind: "inline",
  id,
  source,
  body: "Why?",
  created_at: at(minute),
  updated_at: at(minute),
  replies,
  anchor,
  history: [anchor],
  attachment: { state: "attached", reason: "Same patch.", start: 0, end: 2 },
});

/** A state as a version 4 store saved it: no anchor kinds and no comment states. */
const saved = (extra: object) => ({
  id: "review-x",
  target: {
    kind: "worktree",
    title: "t",
    root: "/r",
    head_sha: "d".repeat(40),
  },
  created_at: at(0),
  rounds: [
    {
      round: 1,
      input_sha256: "a".repeat(64),
      thread: "t1",
      published_at: at(5),
    },
  ],
  approvals: [],
  comments: [],
  submissions: [],
  ...extra,
});

test("an earlier state gains patch anchor kinds, and its comments are sent unless the page showed them pending", () => {
  const answer = {
    id: "reply-1",
    created_at: at(9),
    actor: "agent",
    thread: "t1",
    disposition: "answered",
    body: "Because.",
  };
  const upgraded = upgradeState(
    saved({
      comments: [
        comment("before-round", 1, { kind: "reviewer" }),
        comment("held", 6, { kind: "reviewer" }),
        comment("asked", 7, { kind: "reviewer", question: true }),
        comment("answered", 8, { kind: "reviewer" }, [answer] as never),
      ],
    }),
  );
  const [beforeRound, held, asked, answered] = upgraded.comments;
  assert.ok(beforeRound?.kind === "inline");
  assert.equal(beforeRound.anchor.kind, "patch");
  assert.equal(beforeRound.history[0]?.kind, "patch");
  // A comment from before the current round was published reached the agents with that round.
  assert.deepEqual(beforeRound.source, { kind: "reviewer", state: "sent" });
  assert.deepEqual(held?.source, { kind: "reviewer", state: "pending" });
  assert.deepEqual(asked?.source, {
    kind: "reviewer",
    state: "sent",
    question: true,
  });
  assert.deepEqual(answered?.source, { kind: "reviewer", state: "sent" });
});

test("after a finish of the current round, an earlier comment was sent", () => {
  const upgraded = upgradeState(
    saved({
      comments: [comment("late", 8, { kind: "reviewer" })],
      submissions: [
        {
          round: 1,
          verdict: "comment",
          body: "",
          submitted_at: at(7),
          revision: 3,
        },
      ],
    }),
  );
  assert.deepEqual(upgraded.comments[0]?.source, {
    kind: "reviewer",
    state: "sent",
  });
});

test("a closed review's comments stay sent, since it can no longer be finished", () => {
  const upgraded = upgradeState(
    saved({
      closed_at: at(9),
      comments: [comment("late", 6, { kind: "reviewer" })],
    }),
  );
  assert.deepEqual(upgraded.comments[0]?.source, {
    kind: "reviewer",
    state: "sent",
  });
});

test("a state that does not read refuses the upgrade", () => {
  assert.throws(() => upgradeState({ id: "review-x" }));
});
