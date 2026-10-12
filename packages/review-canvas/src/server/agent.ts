/**
 * The agent API, served on the Unix socket only. A thread registers once and then proves itself with its token.
 */
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { InputDocument } from "../schema/document.ts";
import type { ReviewId, Timestamp } from "../schema/primitives.ts";
import type { Thread } from "../schema/thread.ts";
import type { ReviewView } from "../store/store.ts";
import {
  attempt,
  ok,
  readDocument,
  readJson,
  refused,
  RequestRefused,
} from "./json.ts";
import {
  AnswerRequest,
  MAX_REQUEST_BYTES,
  RegisterRequest,
} from "./requests.ts";
import { Activity, PageAddress, ReviewStore } from "./services.ts";
import { statusOf } from "./status.ts";

const now = () => new Date().toISOString() as Timestamp;

/** A refused request answers as JSON with its status. */
const handled = <A, R>(route: Effect.Effect<A, RequestRefused, R>) =>
  route.pipe(Effect.catch((error) => Effect.succeed(refused(error))));

/** The review a route names, and the thread the bearer token proves. */
const authenticated = Effect.gen(function* () {
  const store = yield* ReviewStore;
  const { id } = yield* HttpRouter.params;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const thread = id === undefined ? undefined : store.authenticate(id, token);
  if (id === undefined || thread === undefined) {
    return yield* Effect.fail(
      new RequestRefused(
        401,
        "unauthorized",
        "The token does not belong to a thread of this review.",
      ),
    );
  }
  const view = store.review(id);
  if (view === undefined)
    return yield* Effect.fail(
      new RequestRefused(404, "not_found", `No review ${id}.`),
    );
  return {
    store,
    id: id as ReviewId,
    thread: thread as Thread,
    view: view as ReviewView,
  };
});

const Register = HttpRouter.add(
  "POST",
  "/agent/register",
  handled(
    Effect.gen(function* () {
      const store = yield* ReviewStore;
      const { origin } = yield* PageAddress;
      const body = yield* readJson(RegisterRequest, MAX_REQUEST_BYTES);
      const registered = yield* attempt(() =>
        store.register({
          target: body.target,
          label: body.label,
          host: body.host,
          ...(body.fresh === undefined ? {} : { fresh: body.fresh }),
        }),
      );
      return ok({
        ok: true,
        review: registered.review.state.id,
        thread: registered.thread,
        token: registered.token,
        created: registered.created,
        url: `${origin}/reviews/${registered.review.state.id}`,
        status: statusOf(registered.review, origin, now()),
      });
    }),
  ),
);

const Publish = HttpRouter.add(
  "POST",
  "/agent/reviews/:id/rounds",
  handled(
    Effect.gen(function* () {
      const { store, id, thread } = yield* authenticated;
      const { origin } = yield* PageAddress;
      const input = yield* readDocument(InputDocument);
      const published = yield* attempt(() =>
        store.publish(id, thread.id, input),
      );
      return ok({
        ok: true,
        round: published.round,
        revision: published.revision,
        warnings: published.warnings,
        url: `${origin}/reviews/${id}`,
      });
    }),
  ),
);

const GetStatus = HttpRouter.add(
  "GET",
  "/agent/reviews/:id",
  handled(
    Effect.gen(function* () {
      const { view } = yield* authenticated;
      const { origin } = yield* PageAddress;
      return ok({ ok: true, status: statusOf(view, origin, now()) });
    }),
  ),
);

/** Answers after the review passes the revision the agent saw, or after the timeout, whichever comes first. */
const Wait = HttpRouter.add(
  "GET",
  "/agent/reviews/:id/wait",
  handled(
    Effect.gen(function* () {
      const { store, id, view } = yield* authenticated;
      const { origin } = yield* PageAddress;
      const params = yield* HttpServerRequest.ParsedSearchParams;
      const seen = Number(params.revision ?? "-1");
      const timeout = Math.min(
        Number(params.timeout ?? "25000") || 25000,
        120_000,
      );
      if (view.revision > seen)
        return ok({ ok: true, status: statusOf(view, origin, now()) });
      const changed = yield* Deferred.make<void>();
      const unsubscribe = store.subscribe((review) => {
        if (review === id) Deferred.doneUnsafe(changed, Effect.void);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* Deferred.await(changed).pipe(Effect.timeoutOption(timeout));
      const latest = store.review(id) ?? view;
      return ok({ ok: true, status: statusOf(latest, origin, now()) });
    }),
  ),
);

const Answer = HttpRouter.add(
  "POST",
  "/agent/reviews/:id/answers",
  handled(
    Effect.gen(function* () {
      const { store, id, thread } = yield* authenticated;
      const body = yield* readJson(AnswerRequest, MAX_REQUEST_BYTES);
      const revision = yield* attempt(() =>
        store.act(id, {
          kind: "answer",
          thread: thread.id,
          comment: body.comment,
          answer: body.answer,
        }),
      );
      return ok({ ok: true, revision });
    }),
  ),
);

/** Every agent request counts as activity. */
const AgentGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const activity = yield* Activity;
    return (respond) =>
      Effect.suspend(() => {
        activity.touch();
        return respond;
      });
  }),
  { global: true },
);

export const AgentApi = Layer.mergeAll(
  Register,
  Publish,
  GetStatus,
  Wait,
  Answer,
  AgentGuard,
);
