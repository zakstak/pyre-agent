import { Cause, Effect, Layer, Result } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { encodeDocument, FeedbackDocument } from "../schema/document.ts";
import type { Timestamp } from "../schema/primitives.ts";
import { feedbackOf } from "../store/store.ts";
import { Assets } from "./assets.ts";
import { PageRpcServer } from "./rpc.ts";
import { ReviewStore } from "./services.ts";

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

/** The Origin values a page served here sends when it opens the RPC socket. */
export const loopbackOrigins = (port: number): ReadonlySet<string> =>
  new Set([...loopbackHosts(port)].map((host) => `http://${host}`));

/**
 * Answers only requests addressed to this server by its loopback name and port, so a page on another site that
 * rebinds its DNS name to 127.0.0.1 gets nothing. A WebSocket, which is how pages read and change reviews, also needs
 * this server's own Origin: browsers send any site's WebSocket to localhost, and only the Origin says whose page opened
 * it.
 * Every response carries the security headers, including the 404 or 500 for a failed route.
 */
const Guard = HttpRouter.middleware(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const hosts =
      address._tag === "UnixPathAddress"
        ? new Set<string>()
        : loopbackHosts(address.port);
    const origins =
      address._tag === "UnixPathAddress"
        ? new Set<string>()
        : loopbackOrigins(address.port);
    return (respond) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!hosts.has(request.headers.host ?? "")) {
          return secure(
            HttpServerResponse.text("Unknown host", { status: 403 }),
          );
        }
        // Every WebSocket upgrade, whatever its path: the router also matches `/rpc/`, `/RPC`, and `/%72pc`.
        if (
          (request.headers.upgrade ?? "").toLowerCase() === "websocket" &&
          !origins.has(request.headers.origin ?? "")
        ) {
          return secure(
            HttpServerResponse.text("The request did not come from this page.", { status: 403 }),
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

/** The page shell Vite builds. The browser renders every page from the RPCs; the server renders none. */
const shellAt = (path: HttpRouter.PathInput) =>
  HttpRouter.add(
    "GET",
    path,
    Effect.gen(function* () {
      const { index } = yield* Assets;
      return HttpServerResponse.text(index, {
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-store" },
      });
    }),
  );

const notFound = HttpServerResponse.text("No such review", { status: 404 });

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

/** The page shell, the RPCs, the feedback download, the built browser assets under /assets, and the guard. */
export const App = (options: { readonly clientDir: string; readonly repositoryRoots?: ReadonlyArray<string> }) =>
  Layer.mergeAll(
    shellAt("/"),
    shellAt("/reviews/:id"),
    Export,
    PageRpcServer(options.repositoryRoots ?? []),
    HttpStaticServer.layer({
      root: `${options.clientDir}/assets`,
      prefix: "/assets",
      cacheControl: "public, max-age=31536000, immutable",
    }),
    Guard,
  );
