// An agent's presence on a review: listening while it waits and a minute after, else when it was last seen, and
// whether what the reviewer sent has anyone to read it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadId, Timestamp } from "../schema/primitives.ts";
import {
  keptSightings,
  LISTENING_GRACE_MS,
  type Live,
  presenceExpires,
  presenceOf,
  unheard,
} from "./presence.ts";

const A = "thread-a" as ThreadId;
const B = "thread-b" as ThreadId;
const at = (ms: number) => new Date(ms).toISOString() as Timestamp;
const T = Date.parse("2026-11-03T12:00:00.000Z");

const live = (waits: number, waitEnded?: number, seen?: number): Live => ({
  waits,
  waitEnded,
  seen,
});

test("a thread listens while a wait is open, and for a minute after its last one ended", () => {
  const open = new Map([[A, live(1, undefined, T)]]);
  assert.deepEqual(presenceOf(open, new Map(), T + 10 * 60_000), {
    state: "listening",
    threads: [A],
  });
  assert.equal(presenceExpires(open, T), undefined);
  const ended = new Map([[A, live(0, T, T)]]);
  assert.deepEqual(presenceOf(ended, new Map(), T + LISTENING_GRACE_MS - 1), {
    state: "listening",
    threads: [A],
  });
  assert.equal(presenceExpires(ended, T + 1000), T + LISTENING_GRACE_MS);
  assert.deepEqual(presenceOf(ended, new Map(), T + LISTENING_GRACE_MS), {
    state: "away",
    thread: A,
    seen_at: at(T),
  });
  assert.equal(presenceExpires(ended, T + LISTENING_GRACE_MS), undefined);
});

test("away names the thread heard from last, by a request or by what the review keeps; never without either", () => {
  assert.deepEqual(presenceOf(new Map(), new Map(), T), { state: "never" });
  // A request that is not a wait, such as status, is a sighting but not listening.
  const requested = new Map([[A, live(0, undefined, T + 5)]]);
  assert.deepEqual(presenceOf(requested, new Map([[B, T + 9]]), T + 10), {
    state: "away",
    thread: B,
    seen_at: at(T + 9),
  });
  assert.deepEqual(presenceOf(requested, new Map([[B, T]]), T + 10), {
    state: "away",
    thread: A,
    seen_at: at(T + 5),
  });
  const kept = keptSightings({
    rounds: [
      {
        round: 1 as never,
        input_sha256: "a".repeat(64) as never,
        thread: A,
        published_at: at(T),
      },
    ],
    comments: [
      {
        kind: "general",
        id: "comment-1" as never,
        source: { kind: "reviewer", state: "sent", question: true },
        body: "Why?",
        created_at: at(T + 1),
        updated_at: at(T + 2),
        replies: [
          {
            id: "reply-1" as never,
            created_at: at(T + 2),
            actor: "agent",
            thread: B,
            disposition: "answered",
            body: "Because.",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    [...kept],
    [
      [A, T],
      [B, T + 2],
    ],
  );
});

test("what the reviewer sent is unheard while no agent listens and none checked in since", () => {
  const away = { state: "away", thread: A, seen_at: at(T) } as const;
  assert.equal(unheard(away, at(T + 1)), true);
  // A wait that returned with the question saw it, though the agent no longer listens.
  assert.equal(unheard(away, at(T)), false);
  assert.equal(unheard(away, at(T - 1)), false);
  assert.equal(unheard({ state: "listening", threads: [A] }, at(T)), false);
  assert.equal(unheard({ state: "never" }, at(T)), true);
});
