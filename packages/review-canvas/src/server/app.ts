import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
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

/**
 * Answers only requests addressed to this server by its loopback name and port, so a page on another site that
 * rebinds its DNS name to 127.0.0.1 gets nothing. Every response carries the security headers.
 */
const Guard = HttpRouter.middleware(
  Effect.gen(function*() {
    const { address } = yield* HttpServer.HttpServer
    const hosts = address._tag === "UnixPathAddress"
      ? new Set<string>()
      : new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
    return (respond) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const response = hosts.has(request.headers.host ?? "")
          ? yield* respond
          : HttpServerResponse.text("Unknown host", { status: 403 })
        return HttpServerResponse.setHeaders(response, securityHeaders)
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
