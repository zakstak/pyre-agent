/**
 * The page RPCs of schema/rpc.ts. Store calls are synchronous and throw their refusals; `attempt` turns those into
 * typed `Refused` failures and anything else into a defect.
 */
import { Data, Effect, Layer, Queue, Result, Stream } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { patchDigest } from "../review/anchor.ts";
import { ActionError } from "../review/state.ts";
import { decodeBytes, FeedbackDocument } from "../schema/document.ts";
import type { PatchDigest, RepoPath, ReviewId } from "../schema/primitives.ts";
import { repositoryId } from "../schema/repositories.ts";
import { PageRpcs, Refused, type ReviewSnapshot } from "../schema/rpc.ts";
import { NoSuchReview, StaleRevision, type Store } from "../store/store.ts";
import { loadHome } from "./home.ts";
import { groupRepositories, identifyRepository } from "./repositories.ts";
import { Activity, ReviewStore } from "./services.ts";

/** An exception a store call raised that is no refusal: a bug, which fails the call as a defect. */
class Unexpected extends Data.TaggedError("Unexpected")<{ readonly cause: unknown }> {}

const refusalOf = (error: unknown): Refused | Unexpected => {
  if (error instanceof ActionError) return new Refused({ kind: error.kind, message: error.message });
  if (error instanceof StaleRevision)
    return new Refused({ kind: "stale", message: error.message, revision: error.revision });
  if (error instanceof NoSuchReview) return new Refused({ kind: "not_found", message: error.message });
  return new Unexpected({ cause: error });
};

/** Runs a store call. Its refusals fail as `Refused`; any other exception is a defect. */
const attempt = <A>(work: () => A): Effect.Effect<A, Refused> =>
  Effect.try({ try: work, catch: refusalOf }).pipe(
    Effect.catchTag("Unexpected", ({ cause }) => Effect.die(cause)),
  );

const noSuchReview = (id: string) => new Refused({ kind: "not_found", message: `No review ${id}.` });

const snapshotOf = (store: Store, id: ReviewId): Effect.Effect<ReviewSnapshot, Refused> => {
  const snapshot = store.snapshot(id);
  if (snapshot === undefined) return Effect.fail(noSuchReview(id));
  const replaced = snapshot.state.closed_at === undefined ? undefined : store.replacedBy(id);
  return Effect.succeed(replaced === undefined ? snapshot : { ...snapshot, replaced_by: replaced });
};

const handlers = (roots: ReadonlyArray<string>) =>
  PageRpcs.toLayer(
    Effect.gen(function* () {
      const store = yield* ReviewStore;
      const activity = yield* Activity;
      // Every call a page makes counts as activity.
      const touched = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => activity.touch()).pipe(Effect.andThen(effect));
      return PageRpcs.of({
        "home.load": ({ root }) => touched(loadHome(store, roots, root)),

        "repositories.accept": ({ root, id }) =>
          touched(
            Effect.gen(function* () {
              const repository = yield* Effect.tryPromise({
                try: () => identifyRepository(root),
                catch: () =>
                  new Refused({ kind: "repository", message: "Choose an existing, readable Git working tree root." }),
              });
              if (repositoryId(repository.identity) !== id)
                return yield* new Refused({
                  kind: "identity",
                  message: "This checkout's repository identity changed. Scan again.",
                });
              const group = groupRepositories([...store.monitoredRepositories(), repository]).find(
                (item) => repositoryId(item.identity) === id,
              );
              if (group !== undefined) store.monitorRepository(group);
            }),
          ),

        "repositories.remove": ({ id }) => touched(Effect.sync(() => store.unmonitorRepository(id))),

        /**
         * The review now, then again after each change. A page that falls behind gets the newest snapshot, not every
         * one between. An open watch keeps the server from idling out.
         */
        "review.watch": ({ id }) =>
          Stream.callback<void>(
            (queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  activity.streamOpened();
                  Queue.offerUnsafe(queue, undefined);
                  return store.subscribe((review) => {
                    if (review === id) Queue.offerUnsafe(queue, undefined);
                  });
                }),
                (unsubscribe) =>
                  Effect.sync(() => {
                    unsubscribe();
                    activity.streamClosed();
                  }),
              ),
            { bufferSize: 1, strategy: "sliding" },
          ).pipe(Stream.mapEffect(() => snapshotOf(store, id))),

        "review.round": ({ id, round }) =>
          touched(
            Effect.gen(function* () {
              const input = store.round(id, round);
              if (input === undefined)
                return yield* new Refused({ kind: "not_found", message: `Review ${id} has no round ${round}.` });
              const digests: Record<RepoPath, PatchDigest> = {};
              for (const file of input.files) if (file.patch !== undefined) digests[file.path] = patchDigest(file.patch);
              return { input, digests };
            }),
          ),

        "review.earlier": ({ id, round }) =>
          touched(
            Effect.gen(function* () {
              const snapshot = yield* snapshotOf(store, id);
              return snapshot.state.rounds
                .filter((item) => item.round < round)
                .map((item) => ({ round: item.round, summary: store.round(id, item.round)?.summary }));
            }),
          ),

        "review.act": ({ id, action, revision }) =>
          touched(attempt(() => ({ revision: store.act(id, action, revision) }))),

        "review.import": ({ id, text, revision }) =>
          touched(
            Effect.gen(function* () {
              const decoded = decodeBytes(FeedbackDocument, new TextEncoder().encode(text));
              if (Result.isFailure(decoded))
                return yield* new Refused({ kind: decoded.failure.reason, message: decoded.failure.message });
              return yield* attempt(() => store.importFeedback(id, decoded.success, revision));
            }),
          ),
      });
    }),
  );

const RPC_PATH = "/rpc";

/** The page RPCs on the router at {@link RPC_PATH}, as JSON over a WebSocket. */
export const PageRpcServer = (roots: ReadonlyArray<string>) =>
  RpcServer.layerHttp({ group: PageRpcs, path: RPC_PATH, protocol: "websocket" }).pipe(
    Layer.provide(handlers(roots)),
    Layer.provide(RpcSerialization.layerJson),
  );
