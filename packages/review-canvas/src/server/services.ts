import { Context, Effect, Layer } from "effect";
import type { Live } from "../review/presence.ts";
import type { ReviewId, ThreadId } from "../schema/primitives.ts";
import { Store } from "../store/store.ts";

/** The one store every route reads and writes. */
export class ReviewStore extends Context.Service<ReviewStore, Store>()(
  "review-canvas/ReviewStore",
) {}

export const storeLayer = (path: string) =>
  Layer.effect(
    ReviewStore,
    Effect.acquireRelease(
      Effect.sync(() => Store.open(path)),
      (store) => Effect.sync(() => store.close()),
    ),
  );

/** Where pages are served, so the server can tell an agent the URL of a review. */
export class PageAddress extends Context.Service<
  PageAddress,
  { readonly origin: string }
>()("review-canvas/PageAddress") {}

/**
 * What keeps the server alive: agent requests and open event streams. The idle watcher reads it and stops the
 * server after a quiet period.
 */
export class Activity extends Context.Service<
  Activity,
  {
    readonly touch: () => void;
    readonly streamOpened: () => void;
    readonly streamClosed: () => void;
    readonly idleSince: () => number | undefined;
  }
>()("review-canvas/Activity") {}

export const activityLayer = Layer.sync(Activity, () => {
  let last = Date.now();
  let streams = 0;
  return {
    touch: () => {
      last = Date.now();
    },
    streamOpened: () => {
      streams++;
      last = Date.now();
    },
    streamClosed: () => {
      streams--;
      last = Date.now();
    },
    idleSince: () => (streams > 0 ? undefined : last),
  };
});

/**
 * What the server saw of each agent thread since it started: the long polls `wait` holds open, when the last one
 * ended, and when the thread last made any request. Pages follow it to show whether an agent listens.
 */
export class AgentPresence extends Context.Service<
  AgentPresence,
  {
    /** A request from a thread of a review. */
    readonly seen: (review: ReviewId, thread: ThreadId) => void;
    /** A long poll a thread opened; the function it returns closes it. */
    readonly waiting: (review: ReviewId, thread: ThreadId) => () => void;
    readonly live: (review: ReviewId) => ReadonlyMap<ThreadId, Live>;
    /** Calls `listener` with the review whenever what the server saw of one of its threads changes. */
    readonly subscribe: (listener: (review: ReviewId) => void) => () => void;
  }
>()("review-canvas/AgentPresence") {}

export const presenceLayer = Layer.sync(AgentPresence, () => {
  const reviews = new Map<ReviewId, Map<ThreadId, Live>>();
  const listeners = new Set<(review: ReviewId) => void>();
  const update = (
    review: ReviewId,
    thread: ThreadId,
    change: (live: Live) => Live,
  ) => {
    const threads = reviews.get(review) ?? new Map<ThreadId, Live>();
    reviews.set(review, threads);
    threads.set(
      thread,
      change(
        threads.get(thread) ?? {
          waits: 0,
          waitEnded: undefined,
          seen: undefined,
        },
      ),
    );
    for (const listener of listeners) listener(review);
  };
  return {
    seen: (review, thread) =>
      update(review, thread, (live) => ({ ...live, seen: Date.now() })),
    waiting: (review, thread) => {
      update(review, thread, (live) => ({
        ...live,
        waits: live.waits + 1,
        seen: Date.now(),
      }));
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        const now = Date.now();
        update(review, thread, (live) => ({
          waits: live.waits - 1,
          waitEnded: now,
          seen: now,
        }));
      };
    },
    live: (review) => reviews.get(review) ?? new Map(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
