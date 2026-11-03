/**
 * Saving the reviewer's unsent text as they type: each slot's latest text goes to the server once they pause, and
 * the calls go one at a time in the order they were made, so an older text never lands after a newer one. Pure of
 * the page and the socket, which `save` and `discard` stand for, so it can be tested with a fake clock.
 */
import {
  type Draft,
  type DraftSlot,
  slotKey,
  slotOf,
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

/** The calls a draft queue makes: save a draft, or empty a slot. */
export interface DraftCalls {
  readonly save: (draft: Draft) => Promise<CallOutcome>;
  readonly discard: (slot: DraftSlot) => Promise<CallOutcome>;
}

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
  /** Saves every scheduled text now, as when the page is hidden. Resolves when the server has them. */
  readonly flush: () => Promise<void>;
  /**
   * Drops a slot's scheduled text without a call: for a box that was sent, whose action empties its slot on the
   * server. Call it before sending.
   */
  readonly forget: (slot: DraftSlot) => void;
  /** Drops a slot's scheduled text and empties the slot on the server: for a box the reviewer cancelled. */
  readonly discard: (slot: DraftSlot) => Promise<void>;
}

/** A queue of draft saves for one review. `report` hears each change of the status. */
export const draftQueue = <H>(
  calls: DraftCalls,
  report: (status: DraftStatus) => void,
  clock: Clock<H>,
  delay = DRAFT_DELAY_MS,
): DraftQueue => {
  const waiting = new Map<
    string,
    { readonly draft: Draft; readonly timer: H }
  >();
  // Raised when a slot is forgotten or discarded, so a save queued before then never goes out after it.
  const generation = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  // What the last call that went out came to, which the status shows once nothing is under way.
  let last: DraftStatus = { state: "idle" };
  const run = (
    call: () => Promise<CallOutcome>,
    still: () => boolean = () => true,
  ): Promise<void> => {
    inFlight++;
    report({ state: "saving" });
    chain = chain.then(async () => {
      if (still()) {
        const outcome = await call().catch(
          (): CallOutcome => ({
            ok: false,
            message: "The server did not answer. Is it still running?",
          }),
        );
        last = outcome.ok
          ? { state: "saved", at: outcome.at }
          : { state: "failed", message: outcome.message };
        // A failure shows at once; a success once nothing else is under way.
        if (!outcome.ok) report(last);
      }
      inFlight--;
      if (inFlight === 0 && last.state !== "failed") report(last);
    });
    return chain;
  };
  const send = (key: string) => {
    const entry = waiting.get(key);
    if (entry === undefined) return chain;
    clock.clearTimeout(entry.timer);
    waiting.delete(key);
    const queued = generation.get(key) ?? 0;
    return run(
      () => calls.save(entry.draft),
      () => (generation.get(key) ?? 0) === queued,
    );
  };
  const forget = (slot: DraftSlot) => {
    const key = slotKey(slot);
    generation.set(key, (generation.get(key) ?? 0) + 1);
    const entry = waiting.get(key);
    if (entry === undefined) return;
    clock.clearTimeout(entry.timer);
    waiting.delete(key);
  };
  return {
    schedule: (draft) => {
      const key = slotKey(slotOf(draft));
      const before = waiting.get(key);
      if (before !== undefined) clock.clearTimeout(before.timer);
      waiting.set(key, {
        draft,
        timer: clock.setTimeout(() => void send(key), delay),
      });
    },
    flush: async () => {
      for (const key of waiting.keys()) void send(key);
      await chain;
    },
    forget,
    discard: async (slot) => {
      forget(slot);
      await run(() => calls.discard(slot));
    },
  };
};
