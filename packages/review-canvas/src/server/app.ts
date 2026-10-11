import { Cause, Effect, Layer } from "effect"
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { Assets } from "./assets.ts"
import { html } from "./html.ts"
import { page } from "./page.ts"

const securityHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin"
}

const secure = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, securityHeaders)

/**
 * Router middleware may not handle a failed route, such as an unknown path, so it cannot replace the failure with a
 * response. It keeps the failure for the server to report and attaches the secured response as a defect: the server
 * sends a response it finds among the defects instead of deriving its own.
 */
const secureFailure = <E>(cause: Cause.Cause<E>) =>
  Effect.flatMap(HttpServerError.causeResponse(cause), ([response, rest]) =>
    Effect.failCause(Cause.fromReasons([
      ...rest.reasons.filter((reason) =>
        !(Cause.isDieReason(reason) && HttpServerResponse.isHttpServerResponse(reason.defect))
      ),
      Cause.makeDieReason(secure(response))
    ])))

/** The Host values that address this server on a loopback port. Browsers omit the port when it is HTTP's default. */
export const loopbackHosts = (port: number): ReadonlySet<string> => {
  const names = ["127.0.0.1", "localhost"]
  const withPort = names.map((name) => `${name}:${port}`)
  return new Set(port === 80 ? [...names, ...withPort] : withPort)
}

/**
 * Answers only requests addressed to this server by its loopback name and port, so a page on another site that
 * rebinds its DNS name to 127.0.0.1 gets nothing. Every response carries the security headers, including the 404 or
 * 500 for a failed route.
 */
const Guard = HttpRouter.middleware(
  Effect.gen(function*() {
    const { address } = yield* HttpServer.HttpServer
    const hosts = address._tag === "UnixPathAddress" ? new Set<string>() : loopbackHosts(address.port)
    return (respond) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!hosts.has(request.headers.host ?? "")) {
          return secure(HttpServerResponse.text("Unknown host", { status: 403 }))
        }
        return yield* respond.pipe(Effect.map(secure), Effect.catchCause(secureFailure))
      })
  }),
  { global: true }
)

const Home = HttpRouter.add(
  "GET",
  "/",
  Effect.gen(function*() {
    const assets = yield* Assets
    const body = html`<main class="mx-auto max-w-3xl p-8">
  <h1 class="text-2xl font-semibold">Review canvas</h1>
  <p class="text-muted mt-2">No reviews yet.</p>
</main>`
    return HttpServerResponse.text(page(assets, { title: "Review canvas", body }).value, {
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store" }
    })
  })
)

/** The routes, the built browser assets under /assets, and the guard. */
export const App = (options: { readonly clientDir: string }) =>
  Layer.mergeAll(
    Home,
    HttpStaticServer.layer({
      root: `${options.clientDir}/assets`,
      prefix: "/assets",
      cacheControl: "public, max-age=31536000, immutable"
    }),
    Guard
  )
