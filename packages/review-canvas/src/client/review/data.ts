/**
 * A review as the page holds it: the live snapshot the server pushes, the rounds' inputs, and the one way to change
 * it. Every value comes from the server over the RPC socket; the page renders whatever these atoms hold.
 */
import { Effect, Option, Semaphore, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReviewId, Revision, RoundNumber } from "../../schema/primitives.ts";
import type { PageAction } from "../../schema/rpc.ts";
import { epochAtom, PageClient } from "../rpc.ts";

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
    const before = get.self<AsyncResult.AsyncResult<A, E>>().pipe(Option.flatMap(AsyncResult.value));
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

/** The rounds before `round`: their summaries and file versions. */
export const earlierAtom = Atom.family((key: RoundKey) =>
  readOnce(
    Effect.gen(function* () {
      const client = yield* PageClient;
      return yield* client("review.earlier", key);
    }),
  ),
);

/**
 * The revision the page's actions carry. The server refuses an action on a revision other than the review's current
 * one, so the page sends the revision of the snapshot it shows, advanced by its own actions while nothing else
 * changed in between: those only add what the reviewer did, so the snapshot still describes the review.
 */
const basisAtom = Atom.family((_id: ReviewId) => Atom.make<Revision | undefined>(undefined));

/** The basis an action leaves: advanced when the action was sent on it and made exactly the next revision. */
export const afterOwnAction = (basis: Revision, made: Revision): Revision => (made === basis + 1 ? made : basis);

/** The later of the revision the page shows and its basis. A newer snapshot carries the page's own changes. */
const basisOf = (registry: Atom.FnContext["registry"], id: ReviewId): Revision | undefined => {
  const shown = AsyncResult.value(registry.get(reviewAtom(id))).pipe(
    Option.map((snapshot) => snapshot.revision),
    Option.getOrUndefined,
  );
  const own = registry.get(basisAtom(id));
  return shown === undefined || (own !== undefined && own > shown) ? own : shown;
};

/** One change at a time per review, actions and imports alike, so each is sent on the basis the one before left. */
const lockOf = Atom.family((_id: ReviewId) => Atom.make(() => Semaphore.makeUnsafe(1)).pipe(Atom.keepAlive));

/**
 * Sends one change after the ones before it. Reads go through the registry, so the function depends on no atom and
 * nothing interrupts a change in flight.
 */
export const actAtom = Atom.family((id: ReviewId) =>
  PageClient.runtime.fn(
    (action: PageAction, get) =>
      get.registry.get(lockOf(id)).withPermits(1)(
        Effect.gen(function* () {
          const client = yield* PageClient;
          const sentWith = basisOf(get.registry, id);
          const { revision } = yield* client("review.act", {
            id,
            action,
            ...(sentWith === undefined ? {} : { revision: sentWith }),
          });
          if (sentWith !== undefined) get.registry.set(basisAtom(id), afterOwnAction(sentWith, revision));
          return revision;
        }),
      ),
    { concurrent: true },
  ),
);

/** Imports a feedback file's text after the changes before it. */
export const importAtom = Atom.family((id: ReviewId) =>
  PageClient.runtime.fn(
    (text: string, get) =>
      get.registry.get(lockOf(id)).withPermits(1)(
        Effect.gen(function* () {
          const client = yield* PageClient;
          const sentWith = basisOf(get.registry, id);
          const { revision, report } = yield* client("review.import", {
            id,
            text,
            ...(sentWith === undefined ? {} : { revision: sentWith }),
          });
          if (sentWith !== undefined) get.registry.set(basisAtom(id), afterOwnAction(sentWith, revision));
          return report;
        }),
      ),
    { concurrent: true },
  ),
);
