/**
 * Saving the reviewer's unsent text as they type: each slot's latest text goes to the server once they pause, and
 * the calls go one at a time in the order they were made, so an older text never lands after a newer one. Pure of
 * the page and the socket, which `save` and `discard` stand for, so it can be tested with a fake clock.
 */
import * as Schema from "effect/Schema";
import {
  type Draft,
  type DraftSlot,
  type DraftWrite,
  DraftWrites,
  slotKey,
  slotOf,
  slotOfWrite,
} from "../../schema/draft.ts";

/** How long after the last keystroke a draft is saved. The spec allows up to a second. */
export const DRAFT_DELAY_MS = 500;

/** Where the saving of drafts is: nothing to save, saving, everything saved, or the last save failed and why. */
export type DraftStatus =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "saved"; readonly at: string }
  | { readonly state: "failed"; readonly message: string };

/** What a call came to: done at a time, or refused with the message the page shows. */
export type CallOutcome =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly message: string };

/** The calls a draft queue makes: save a draft, empty a slot, or send several writes in a request that outlives the page. */
export interface DraftCalls {
  readonly save: (draft: Draft) => Promise<CallOutcome>;
  readonly discard: (slot: DraftSlot) => Promise<CallOutcome>;
  /**
   * Sends the writes at once in one request that finishes even when the page closes, unlike a socket call, with
   * {@link keepBody} as its body, which the queue keeps within {@link KEEP_BYTES}.
   */
  readonly keep: (writes: ReadonlyArray<DraftWrite>) => Promise<CallOutcome>;
}

/**
 * How many bytes of body the requests that outlive a page may carry in all, by the Fetch standard's keepalive limit.
 * A browser refuses a request past it outright, and `sendBeacon` counts against the same limit.
 */
export const KEEP_BYTES = 64 * 1024;

/** The body of the request that keeps `writes`. */
export const keepBody = (writes: ReadonlyArray<DraftWrite>): string =>
  JSON.stringify(Schema.encodeSync(DraftWrites)({ writes }));

const utf8 = new TextEncoder();

/**
 * The writes one request within {@link KEEP_BYTES} can carry, chosen smallest first so that as many slots as fit are
 * kept however long one text is, and the rest; each in the order given.
 */
export const keepable = (
  writes: ReadonlyArray<DraftWrite>,
): {
  readonly kept: ReadonlyArray<DraftWrite>;
  readonly rest: ReadonlyArray<DraftWrite>;
} => {
  // A body of several writes is the empty body with each write's own bytes inside, and a comma between two.
  const empty = utf8.encode(keepBody([])).length;
  const smallestFirst = writes
    .map((write) => ({
      write,
      bytes: utf8.encode(keepBody([write])).length - empty,
    }))
    .toSorted((a, b) => a.bytes - b.bytes);
  const chosen = new Set<DraftWrite>();
  let total = empty;
  for (const { write, bytes } of smallestFirst) {
    const after = total + bytes + (chosen.size === 0 ? 0 : 1);
    if (after > KEEP_BYTES) break;
    chosen.add(write);
    total = after;
  }
  return {
    kept: writes.filter((write) => chosen.has(write)),
    rest: writes.filter((write) => !chosen.has(write)),
  };
};

/** The timers a queue uses: the page's, or a test's fake clock. */
export interface Clock<H> {
  readonly setTimeout: (run: () => void, ms: number) => H;
  readonly clearTimeout: (handle: H) => void;
}

/** The page's own timers. */
export const pageClock: Clock<ReturnType<typeof setTimeout>> = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface DraftQueue {
  /** Saves the slot's text once the reviewer has paused for {@link DRAFT_DELAY_MS}; a newer text replaces it. */
  readonly schedule: (draft: Draft) => void;
  /** Saves every scheduled text now, as when the reviewer leaves a box. Resolves when the server has them. */
  readonly flush: () => Promise<void>;
  /**
   * Sends every write not sent yet, scheduled or in line behind other calls, in one request that outlives the page:
   * for a page being hidden or closed, whose socket calls may never go out. Writes it could not send wait to be sent
   * again, unless the reviewer wrote in, sent, or cancelled their slots since. Writes past what such a request may
   * carry go on the socket at once instead, which delivers them while the page lives on, as when it was only hidden.
   */
  readonly leave: () => Promise<void>;
  /**
   * Drops a slot's scheduled text without a call: for a box that was sent, whose action empties its slot on the
   * server. Call it before sending.
   */
  readonly forget: (slot: DraftSlot) => void;
  /** Drops a slot's scheduled text and empties the slot on the server: for a box the reviewer cancelled. */
  readonly discard: (slot: DraftSlot) => Promise<void>;
}

/** A write not sent yet: a save waiting for the reviewer to pause, on its timer, or a write in line for its call. */
type Unsent<H> =
  | {
      readonly state: "scheduled";
      readonly write: DraftWrite;
      readonly timer: H;
    }
  | { readonly state: "in_line"; readonly write: DraftWrite };

const NO_ANSWER: CallOutcome = {
  ok: false,
  message: "The server did not answer. Is it still running?",
};

/** A queue of draft saves for one review. `report` hears each change of the status. */
export const draftQueue = <H>(
  calls: DraftCalls,
  report: (status: DraftStatus) => void,
  clock: Clock<H>,
  delay = DRAFT_DELAY_MS,
): DraftQueue => {
  // The newest unsent write of each slot, by slot key. A write in line goes out when its turn comes only while it is
  // still its slot's entry here, so a newer text, a forgotten slot, or a write that `leave` sent drops it.
  const unsent = new Map<string, Unsent<H>>();
  // How many times the reviewer changed each slot, by slot key: wrote in it, sent its box, or cancelled it. A write
  // `leave` could not send waits again only while its slot is unchanged since, which `unsent` cannot tell once a newer
  // write has gone out.
  const changes = new Map<string, number>();
  const changesOf = (key: string) => changes.get(key) ?? 0;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  // What the last call that went out came to, which the status shows once nothing is under way.
  let last: DraftStatus = { state: "idle" };
  const started = () => {
    inFlight++;
    report({ state: "saving" });
  };
  const ended = (outcome: CallOutcome | undefined) => {
    if (outcome !== undefined) {
      last = outcome.ok
        ? { state: "saved", at: outcome.at }
        : { state: "failed", message: outcome.message };
      // A failure shows at once; a success once nothing else is under way.
      if (!outcome.ok) report(last);
    }
    inFlight--;
    if (inFlight === 0 && last.state !== "failed") report(last);
  };
  const answer = (call: () => Promise<CallOutcome>) =>
    call().catch((): CallOutcome => NO_ANSWER);
  /** Puts a slot's write in line behind the calls before it. */
  const line = (key: string, write: DraftWrite): Promise<void> => {
    const entry: Unsent<H> = { state: "in_line", write };
    unsent.set(key, entry);
    started();
    chain = chain.then(async () => {
      if (unsent.get(key) !== entry) return ended(undefined);
      unsent.delete(key);
      ended(
        await answer(() =>
          write.kind === "save"
            ? calls.save(write.draft)
            : calls.discard(write.slot),
        ),
      );
    });
    return chain;
  };
  const wait = (key: string, write: DraftWrite) => {
    unsent.set(key, {
      state: "scheduled",
      write,
      timer: clock.setTimeout(() => send(key), delay),
    });
  };
  const send = (key: string) => {
    const entry = unsent.get(key);
    if (entry?.state !== "scheduled") return;
    clock.clearTimeout(entry.timer);
    void line(key, entry.write);
  };
  const forget = (slot: DraftSlot) => {
    const key = slotKey(slot);
    const entry = unsent.get(key);
    if (entry?.state === "scheduled") clock.clearTimeout(entry.timer);
    unsent.delete(key);
    changes.set(key, changesOf(key) + 1);
  };
  return {
    schedule: (draft) => {
      const key = slotKey(slotOf(draft));
      forget(slotOf(draft));
      wait(key, { kind: "save", draft });
    },
    flush: async () => {
      for (const key of unsent.keys()) send(key);
      await chain;
    },
    leave: async () => {
      const writes = [...unsent.values()].map((entry) => {
        if (entry.state === "scheduled") clock.clearTimeout(entry.timer);
        return entry.write;
      });
      unsent.clear();
      const { kept, rest } = keepable(writes);
      for (const write of rest) void line(slotKey(slotOfWrite(write)), write);
      if (kept.length === 0) return;
      const left = kept.map((write) => {
        const key = slotKey(slotOfWrite(write));
        return { key, write, count: changesOf(key) };
      });
      started();
      const outcome = await answer(() => calls.keep(kept));
      if (!outcome.ok)
        for (const { key, write, count } of left)
          if (changesOf(key) === count) wait(key, write);
      ended(outcome);
    },
    forget,
    discard: (slot) => {
      forget(slot);
      return line(slotKey(slot), { kind: "discard", slot });
    },
  };
};
