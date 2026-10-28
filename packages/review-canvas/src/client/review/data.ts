/**
 * A review as the page holds it: the live snapshot the server pushes, the rounds' inputs, and the one way to change
 * it. Every value comes from the server over the RPC socket; the page renders whatever these atoms hold.
 */
import { Effect, type Exit, Option, Ref, Semaphore, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type {
  ReviewId,
  Revision,
  RoundNumber,
} from "../../schema/primitives.ts";
import type { ImportReport, PageAction } from "../../schema/rpc.ts";
import { type CallError, epochAtom, PageClient } from "../rpc.ts";

/**
 * The review now, and again after every change, while the page shows it. A dropped socket ends the watch; the next
 * connection starts a new one, whose first snapshot is the review as it is then.
 */
export const reviewAtom = Atom.family((id: ReviewId) =>
  PageClient.runtime.atom((get) =>
    get(epochAtom) === 0
      ? Stream.never
      : Stream.unwrap(
          Effect.gen(function* () {
            const client = yield* PageClient;
            return client("review.watch", { id });
          }),
        ),
  ),
);

/** A review and one of its rounds. Families compare plain objects by value, so equal keys share one atom. */
export interface RoundKey {
  readonly id: ReviewId;
  readonly round: RoundNumber;
}

/**
 * A value read once: a round's input never changes after it is published. A read the socket failed is tried again
 * after the next reconnect; one that succeeded is kept.
 */
const readOnce = <A, E>(read: Effect.Effect<A, E, PageClient>) =>
  PageClient.runtime.atom((get) => {
    const before = get
      .self<AsyncResult.AsyncResult<A, E>>()
      .pipe(Option.flatMap(AsyncResult.value));
    if (Option.isSome(before)) return Effect.succeed(before.value);
    if (get(epochAtom) === 0) return Effect.never;
    return read;
  });

/** A round's input and patch digests. */
export const roundAtom = Atom.family((key: RoundKey) =>
  readOnce(
    Effect.gen(function* () {
      const client = yield* PageClient;
      return yield* client("review.round", key);
    }),
  ),
);

/** The rounds before `round`: their summaries. */
export const earlierAtom = Atom.family((key: RoundKey) =>
  readOnce(
    Effect.gen(function* () {
      const client = yield* PageClient;
      return yield* client("review.earlier", key);
    }),
  ),
);

/** The basis an action leaves: advanced when the action made exactly the next revision. */
export const afterOwnAction = (basis: Revision, made: Revision): Revision =>
  made === basis + 1 ? made : basis;

/** `shown` is the revision of the snapshot the page shows, which can trail the newest while a new round loads. */
export interface ReviewActions {
  /** Sends an action after the changes before it, and answers with the revision it made. */
  readonly act: (
    action: PageAction,
    shown: Revision,
  ) => Promise<Exit.Exit<Revision, CallError>>;
  /** Imports a feedback file's text after the changes before it, and answers with what it added. */
  readonly importFeedback: (
    text: string,
    shown: Revision,
  ) => Promise<Exit.Exit<ImportReport, CallError>>;
}

/**
 * The one way a page changes a review. Changes go one at a time, and each caller gets its own change's outcome.
 *
 * The server refuses a change on a revision other than the review's current one, so each carries the revision of
 * the snapshot the page shows, advanced by the page's own changes while nothing else changed in between: those only
 * add what the reviewer did, so the snapshot still describes the review. A newer snapshot the page does not show yet,
 * such as a round whose input is still loading, does not count, so a change made on the old page is refused as stale.
 */
export const actionsAtom = Atom.family((id: ReviewId) =>
  PageClient.runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* PageClient;
        const lock = yield* Semaphore.make(1);
        const own = yield* Ref.make<Revision | undefined>(undefined);
        const send = <A extends { readonly revision: Revision }, E>(
          shown: Revision,
          change: (revision: Revision) => Effect.Effect<A, E>,
        ) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const ownBasis = yield* Ref.get(own);
              const basis =
                ownBasis !== undefined && ownBasis > shown ? ownBasis : shown;
              const done = yield* change(basis);
              yield* Ref.set(own, afterOwnAction(basis, done.revision));
              return done;
            }),
          );
        return {
          act: (action, shown) =>
            Effect.runPromiseExit(
              send(shown, (revision) =>
                client("review.act", { id, action, revision }),
              ).pipe(Effect.map((done) => done.revision)),
            ),
          importFeedback: (text, shown) =>
            Effect.runPromiseExit(
              send(shown, (revision) =>
                client("review.import", { id, text, revision }),
              ).pipe(Effect.map((done) => done.report)),
            ),
        } satisfies ReviewActions;
      }),
    )
    .pipe(Atom.keepAlive),
);
