import { Context, Effect, Layer } from "effect";
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
