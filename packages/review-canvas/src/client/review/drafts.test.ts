import assert from "node:assert/strict";
import { test } from "node:test";
import type { Draft, DraftSlot, DraftWrite } from "../../schema/draft.ts";
import type { CommentId } from "../../schema/primitives.ts";
import {
  type CallOutcome,
  type Clock,
  DRAFT_DELAY_MS,
  draftQueue,
  type DraftStatus,
} from "./drafts.ts";

/** A clock the test moves by hand. */
const fakeClock = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { readonly at: number; run: () => void }>();
  const clock: Clock<number> = {
    setTimeout: (run, ms) => {
      timers.set(++next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(handle);
      timer.run();
    }
  };
  return { clock, advance, pending: () => timers.size };
};

/** Calls that record what they were asked, and answer when the test says. */
const recordingCalls = () => {
  const made: Array<string> = [];
  const answers: Array<(outcome: CallOutcome) => void> = [];
  const answer = () =>
    new Promise<CallOutcome>((resolve) => answers.push(resolve));
  return {
    made,
    answers,
    calls: {
      save: (draft: Draft) => {
        made.push(`save ${draft.kind} ${draft.body}`);
        return answer();
      },
      discard: (slot: DraftSlot) => {
        made.push(`discard ${slot.kind}`);
        return answer();
      },
      keep: (writes: ReadonlyArray<DraftWrite>) => {
        made.push(
          `keep ${writes
            .map((write) =>
              write.kind === "save"
                ? `save ${write.draft.kind} ${write.draft.body}`
                : `discard ${write.slot.kind}`,
            )
            .join(", ")}`,
        );
        return answer();
      },
    },
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

const general = (body: string): Draft => ({ kind: "general", body });

test("a draft is saved once the reviewer pauses, with the latest text only, and within a second", async () => {
  assert.ok(DRAFT_DELAY_MS <= 1000);
  const time = fakeClock();
  const record = recordingCalls();
  const statuses: Array<DraftStatus["state"]> = [];
  const queue = draftQueue(
    record.calls,
    (status) => statuses.push(status.state),
    time.clock,
  );
  queue.schedule(general("H"));
  time.advance(DRAFT_DELAY_MS - 1);
  queue.schedule(general("He"));
  time.advance(DRAFT_DELAY_MS - 1);
  queue.schedule(general("Hello"));
  assert.deepEqual(record.made, []);
  time.advance(DRAFT_DELAY_MS);
  await settle();
  assert.deepEqual(record.made, ["save general Hello"]);
  record.answers[0]?.({ ok: true, at: "2026-10-10T00:00:00.000Z" });
  await settle();
  assert.deepEqual(statuses, ["saving", "saved"]);
});

test("each slot waits on its own, and calls go one at a time in the order they were made", async () => {
  const time = fakeClock();
  const record = recordingCalls();
  const queue = draftQueue(record.calls, () => undefined, time.clock);
  const comment = "c-1" as CommentId;
  queue.schedule(general("Overall"));
  queue.schedule({ kind: "reply", comment, body: "Why?" });
  time.advance(DRAFT_DELAY_MS);
  await settle();
  // The second call waits for the first to be answered.
  assert.deepEqual(record.made, ["save general Overall"]);
  record.answers[0]?.({ ok: true, at: "t" });
  await settle();
  assert.deepEqual(record.made, ["save general Overall", "save reply Why?"]);
});

test("forgetting a sent box drops its waiting save, even one queued behind another call", async () => {
  const time = fakeClock();
  const record = recordingCalls();
  const statuses: Array<DraftStatus["state"]> = [];
  const queue = draftQueue(
    record.calls,
    (status) => statuses.push(status.state),
    time.clock,
  );
  queue.schedule({ kind: "finish", verdict: "approve", body: "Ship it" });
  queue.forget({ kind: "finish" });
  time.advance(DRAFT_DELAY_MS);
  assert.equal(time.pending(), 0);

  // A save of another slot is out; the general draft's save queues behind it, then the box is sent.
  queue.schedule({ kind: "edit", comment: "c-1" as CommentId, body: "x" });
  time.advance(DRAFT_DELAY_MS);
  queue.schedule(general("Sent"));
  time.advance(DRAFT_DELAY_MS);
  queue.forget({ kind: "general" });
  await settle();
  record.answers[0]?.({ ok: true, at: "t" });
  await settle();
  assert.deepEqual(record.made, ["save edit x"]);
  assert.equal(statuses.at(-1), "saved");
});

test("cancelling a box empties its slot on the server, and flushing sends what waits at once", async () => {
  const time = fakeClock();
  const record = recordingCalls();
  const queue = draftQueue(record.calls, () => undefined, time.clock);
  queue.schedule(general("Draft"));
  const discarded = queue.discard({ kind: "general" });
  await settle();
  assert.deepEqual(record.made, ["discard general"]);
  record.answers[0]?.({ ok: true, at: "t" });
  await discarded;

  queue.schedule(general("Before leaving"));
  const flushed = queue.flush();
  await settle();
  assert.deepEqual(record.made, [
    "discard general",
    "save general Before leaving",
  ]);
  record.answers[1]?.({ ok: true, at: "t" });
  await flushed;
  assert.equal(time.pending(), 0);
});

test("a refused save reports the server's words, and an unanswered one says the server did not answer", async () => {
  const time = fakeClock();
  const statuses: Array<DraftStatus> = [];
  const queue = draftQueue(
    {
      save: async (draft) =>
        draft.body === "closed"
          ? { ok: false, message: "This review is closed." }
          : Promise.reject(new Error("socket")),
      discard: async () => ({ ok: true, at: "t" }),
      keep: async () => ({ ok: true, at: "t" }),
    },
    (status) => statuses.push(status),
    time.clock,
  );
  queue.schedule(general("closed"));
  await queue.flush();
  assert.deepEqual(statuses.at(-1), {
    state: "failed",
    message: "This review is closed.",
  });
  queue.schedule(general("down"));
  await queue.flush();
  assert.deepEqual(statuses.at(-1), {
    state: "failed",
    message: "The server did not answer. Is it still running?",
  });
});

test("leaving sends every unsent write in one request, and none of them goes out on the socket after it", async () => {
  const time = fakeClock();
  const record = recordingCalls();
  const statuses: Array<DraftStatus["state"]> = [];
  const queue = draftQueue(
    record.calls,
    (status) => statuses.push(status.state),
    time.clock,
  );
  // A save of an edit is out; the general text waits in line behind it, a reply waits for the reviewer to pause, and
  // the finish box was cancelled, its emptying in line too.
  queue.schedule({ kind: "edit", comment: "c-1" as CommentId, body: "x" });
  time.advance(DRAFT_DELAY_MS);
  await settle();
  queue.schedule(general("Overall"));
  time.advance(DRAFT_DELAY_MS);
  queue.schedule({ kind: "reply", comment: "c-2" as CommentId, body: "Why?" });
  queue.schedule({ kind: "finish", verdict: "approve", body: "Ship" });
  void queue.discard({ kind: "finish" });
  const left = queue.leave();
  await settle();
  assert.deepEqual(record.made, [
    "save edit x",
    "keep save general Overall, save reply Why?, discard finish",
  ]);
  assert.equal(time.pending(), 0);
  record.answers[1]?.({ ok: true, at: "t" });
  await left;
  // The socket's calls in line skip what the request sent.
  record.answers[0]?.({ ok: true, at: "t" });
  await queue.flush();
  time.advance(DRAFT_DELAY_MS);
  await settle();
  assert.equal(record.made.length, 2);
  assert.equal(statuses.at(-1), "saved");
  // With nothing unsent, leaving sends nothing.
  await queue.leave();
  assert.equal(record.made.length, 2);
});

test("writes a refused request could not keep wait to be sent again, unless the reviewer wrote in their slot since", async () => {
  const time = fakeClock();
  const record = recordingCalls();
  const statuses: Array<DraftStatus> = [];
  const queue = draftQueue(
    record.calls,
    (status) => statuses.push(status),
    time.clock,
  );
  queue.schedule(general("Overall"));
  queue.schedule({ kind: "reply", comment: "c-2" as CommentId, body: "Why?" });
  const left = queue.leave();
  // The page stayed open, and the reviewer went on typing in the general box.
  queue.schedule(general("Overall, and more"));
  record.answers[0]?.({ ok: false, message: "The server did not answer." });
  await left;
  assert.deepEqual(statuses.at(-1), {
    state: "failed",
    message: "The server did not answer.",
  });
  time.advance(DRAFT_DELAY_MS);
  await settle();
  assert.deepEqual(record.made.slice(1), ["save general Overall, and more"]);
  record.answers[1]?.({ ok: true, at: "t" });
  await settle();
  assert.deepEqual(record.made.slice(1), [
    "save general Overall, and more",
    "save reply Why?",
  ]);
});
