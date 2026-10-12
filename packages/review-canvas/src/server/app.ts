import { Cause, Effect, Layer, Queue, Result, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { encodeDocument, FeedbackDocument } from "../schema/document.ts";
import type { Revision, Timestamp } from "../schema/primitives.ts";
import { LAYOUT_COOKIE } from "../review/layout.ts";
import { feedbackOf } from "../store/store.ts";
import { Assets } from "./assets.ts";
import {
  attempt,
  ok,
  readDocument,
  readJson,
  refused,
  RequestRefused,
} from "./json.ts";
import { homePage } from "./pages/home.ts";
import { reviewPage, waitingPage } from "./pages/review.ts";
import { MAX_REQUEST_BYTES, PageActionRequest } from "./requests.ts";
import { Activity, ReviewStore } from "./services.ts";

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const secure = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, securityHeaders);

/**
 * Router middleware may not handle a failed route, such as an unknown path, so it cannot replace the failure with a
 * response. It keeps the failure for the server to report and attaches the secured response as a defect: the server
 * sends a response it finds among the defects instead of deriving its own.
 */
const secureFailure = <E>(cause: Cause.Cause<E>) =>
  Effect.flatMap(HttpServerError.causeResponse(cause), ([response, rest]) =>
    Effect.failCause(
      Cause.fromReasons([
        ...rest.reasons.filter(
          (reason) =>
            !(
              Cause.isDieReason(reason) &&
              HttpServerResponse.isHttpServerResponse(reason.defect)
            ),
        ),
        Cause.makeDieReason(secure(response)),
      ]),
    ),
  );

/** The Host values that address this server on a loopback port. Browsers omit the port when it is HTTP's default. */
export const loopbackHosts = (port: number): ReadonlySet<string> => {
  const names = ["127.0.0.1", "localhost"];
  const withPort = names.map((name) => `${name}:${port}`);
  return new Set(port === 80 ? [...names, ...withPort] : withPort);
};

/** The Origin values a page served here sends with a change. */
export const loopbackOrigins = (port: number): ReadonlySet<string> =>
  new Set([...loopbackHosts(port)].map((host) => `http://${host}`));

/**
 * Answers only requests addressed to this server by its loopback name and port, so a page on another site that
 * rebinds its DNS name to 127.0.0.1 gets nothing. Every response carries the security headers, including the 404 or
 * 500 for a failed route.
 */
const Guard = HttpRouter.middleware(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const hosts =
      address._tag === "UnixPathAddress"
        ? new Set<string>()
        : loopbackHosts(address.port);
    return (respond) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!hosts.has(request.headers.host ?? "")) {
          return secure(
            HttpServerResponse.text("Unknown host", { status: 403 }),
          );
        }
        return yield* respond.pipe(
          Effect.map(secure),
          Effect.catchCause(secureFailure),
        );
      });
  }),
  { global: true },
);

const htmlResponse = (body: { readonly value: string }) =>
  HttpServerResponse.text(body.value, {
    contentType: "text/html; charset=utf-8",
    headers: { "cache-control": "no-store" },
  });

const Home = HttpRouter.add(
  "GET",
  "/",
  Effect.gen(function* () {
    const assets = yield* Assets;
    const store = yield* ReviewStore;
    return htmlResponse(homePage(assets, store.reviews()));
  }),
);

const notFound = HttpServerResponse.text("No such review", { status: 404 });

const Review = HttpRouter.add(
  "GET",
  "/reviews/:id",
  Effect.gen(function* () {
    const assets = yield* Assets;
    const store = yield* ReviewStore;
    const { id } = yield* HttpRouter.params;
    const view = id === undefined ? undefined : store.review(id);
    if (view === undefined) return notFound;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A view preference the page keeps in a cookie, so a refresh renders the layout the reviewer chose.
    const layout =
      request.cookies[LAYOUT_COOKIE] === "split" ? "split" : "unified";
    return htmlResponse(
      view.input === undefined
        ? waitingPage(assets, view)
        : reviewPage(assets, view, view.input, layout),
    );
  }),
);

const Export = HttpRouter.add(
  "GET",
  "/reviews/:id/feedback.json",
  Effect.gen(function* () {
    const store = yield* ReviewStore;
    const { id } = yield* HttpRouter.params;
    const view = id === undefined ? undefined : store.review(id);
    if (view === undefined) return notFound;
    const feedback = feedbackOf(view, new Date().toISOString() as Timestamp);
    if (feedback === undefined)
      return HttpServerResponse.text("The review has no round yet", {
        status: 409,
      });
    const encoded = encodeDocument(FeedbackDocument, feedback);
    if (Result.isFailure(encoded))
      return HttpServerResponse.text(encoded.failure.message, { status: 500 });
    return HttpServerResponse.raw(encoded.success, {
      contentType: "application/json; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="review-feedback-${view.round?.input_sha256.slice(0, 12) ?? "none"}.json"`,
      },
    });
  }),
);

/**
 * The review a page change names, after the checks every page change passes: the Origin must be this server's, so
 * no other site can act through the reviewer's browser, and the review must exist. A change counts as activity.
 */
const pageChange = Effect.gen(function* () {
  const store = yield* ReviewStore;
  const activity = yield* Activity;
  const { address } = yield* HttpServer.HttpServer;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origins =
    address._tag === "UnixPathAddress"
      ? new Set<string>()
      : loopbackOrigins(address.port);
  if (!origins.has(request.headers.origin ?? ""))
    return yield* Effect.fail(
      new RequestRefused(
        403,
        "origin",
        "The request did not come from this page.",
      ),
    );
  const { id } = yield* HttpRouter.params;
  if (id === undefined || store.review(id) === undefined)
    return yield* Effect.fail(
      new RequestRefused(404, "not_found", `No review ${id ?? ""}.`),
    );
  activity.touch();
  return { store, id };
});

/** Changes a page asks for. */
const Actions = HttpRouter.add(
  "POST",
  "/reviews/:id/actions",
  Effect.gen(function* () {
    const { store, id } = yield* pageChange;
    const body = yield* readJson(PageActionRequest, MAX_REQUEST_BYTES);
    const revision = yield* attempt(() =>
      store.act(id, body.action, body.revision),
    );
    return ok({ ok: true, revision });
  }).pipe(Effect.catch((error) => Effect.succeed(refused(error)))),
);

/**
 * A feedback file the reviewer chose, imported into the review. The body is the file as it is; the revision the
 * page saw comes in the query, so a stale page learns about the change first.
 */
const Import = HttpRouter.add(
  "POST",
  "/reviews/:id/import",
  Effect.gen(function* () {
    const { store, id } = yield* pageChange;
    const params = yield* HttpServerRequest.ParsedSearchParams;
    const seen =
      typeof params.revision === "string" && /^[0-9]+$/.test(params.revision)
        ? (Number(params.revision) as Revision)
        : undefined;
    const feedback = yield* readDocument(FeedbackDocument);
    const imported = yield* attempt(() =>
      store.importFeedback(id, feedback, seen),
    );
    return ok({ ok: true, ...imported });
  }).pipe(Effect.catch((error) => Effect.succeed(refused(error)))),
);

const event = (revision: Revision | number) =>
  `event: change\ndata: {"revision":${revision}}\n\n`;

/**
 * Server-sent events for an open page: the review's revision whenever it changes, and a comment every 20 seconds
 * to keep the connection alive. The page fetches what changed. An open stream keeps the server from idling out.
 */
const Events = HttpRouter.add(
  "GET",
  "/reviews/:id/events",
  Effect.gen(function* () {
    const store = yield* ReviewStore;
    const activity = yield* Activity;
    const { id } = yield* HttpRouter.params;
    const view = id === undefined ? undefined : store.review(id);
    if (view === undefined || id === undefined) return notFound;
    const changes = Stream.callback<string>((queue) =>
      Effect.gen(function* () {
        activity.streamOpened();
        const unsubscribe = store.subscribe((review, revision) => {
          if (review === id) Queue.offerUnsafe(queue, event(revision));
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            activity.streamClosed();
          }),
        );
      }),
    );
    const heartbeat = Stream.tick("20 seconds").pipe(
      Stream.map(() => ": ping\n\n"),
    );
    const body = Stream.make(event(view.revision)).pipe(
      Stream.concat(Stream.merge(changes, heartbeat)),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(body, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }),
);

/** The page routes, the built browser assets under /assets, and the guard. */
export const App = (options: { readonly clientDir: string }) =>
  Layer.mergeAll(
    Home,
    Review,
    Export,
    Actions,
    Import,
    Events,
    HttpStaticServer.layer({
      root: `${options.clientDir}/assets`,
      prefix: "/assets",
      cacheControl: "public, max-age=31536000, immutable",
    }),
    Guard,
  );
