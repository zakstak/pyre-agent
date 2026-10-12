import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Exit, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, loopbackHosts } from "./app.ts";
import { Assets, layerFromBuild } from "./assets.ts";
import { html } from "./html.ts";
import { activityLayer, storeLayer } from "./services.ts";

interface Reply {
  readonly status: number;
  readonly header: (name: string) => string;
  readonly body: string;
}

// node:http rather than fetch, because fetch cannot set the Host header or send a path with "..".
const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<Reply>((resolve, reject) => {
    request(
      { host: "127.0.0.1", port, path, headers: { host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            header: (name) => String(response.headers[name] ?? ""),
            body,
          }),
        );
      },
    )
      .on("error", reject)
      .end();
  });

const clientBuild = () => {
  const clientDir = mkdtempSync(join(tmpdir(), "review-canvas-"));
  mkdirSync(join(clientDir, "assets"));
  writeFileSync(join(clientDir, "assets", "main.css"), "body{}");
  // Exists just outside the served folder, so a 404 for it shows containment, not a missing file.
  writeFileSync(join(clientDir, "secret.txt"), "secret");
  return clientDir;
};

// Serves the app on a free loopback port with fixed assets, then runs the check against it.
const withServer = (check: (port: number) => Promise<void>) => {
  const clientDir = clientBuild();
  const TestAssets = Layer.succeed(Assets, {
    styles: ["/assets/main.css"],
    scripts: [],
  });
  const Server = NodeHttpServer.layer(createServer, {
    host: "127.0.0.1",
    port: 0,
  });
  const Live = HttpRouter.serve(App({ clientDir }), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(TestAssets),
    Layer.provide(storeLayer(":memory:")),
    Layer.provide(activityLayer),
    Layer.provideMerge(Server),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { address } = Context.get(
          yield* Layer.build(Live),
          HttpServer.HttpServer,
        );
        assert.notEqual(address._tag, "UnixPathAddress");
        if (address._tag !== "UnixPathAddress")
          yield* Effect.promise(() => check(address.port));
      }),
    ),
  );
};

test("the home page renders its assets with the security headers", () =>
  withServer(async (port) => {
    const page = await get(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.header("content-type"), /^text\/html/);
    assert.equal(page.header("cache-control"), "no-store");
    assert.match(
      page.header("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.match(
      page.body,
      /<link rel="stylesheet" href="\/assets\/main\.css">/,
    );
  }));

test("a request addressed to another host is refused", () =>
  withServer(async (port) => {
    const page = await get(port, "/", `evil.example:${port}`);
    assert.equal(page.status, 403);
    assert.equal(page.header("x-content-type-options"), "nosniff");
    assert.equal(
      (await get(port, "/assets/main.css", `evil.example:${port}`)).status,
      403,
    );
    assert.equal((await get(port, "/", "127.0.0.1")).status, 403);
    assert.equal((await get(port, "/", `localhost:${port}`)).status, 200);
  }));

test("the default HTTP port also accepts the bare loopback names browsers send", () => {
  assert.deepEqual([...loopbackHosts(80)].sort(), [
    "127.0.0.1",
    "127.0.0.1:80",
    "localhost",
    "localhost:80",
  ]);
  assert.deepEqual([...loopbackHosts(8080)].sort(), [
    "127.0.0.1:8080",
    "localhost:8080",
  ]);
});

test("built assets are served immutably, and nothing outside them", () =>
  withServer(async (port) => {
    const css = await get(port, "/assets/main.css");
    assert.equal(css.status, 200);
    assert.match(css.header("cache-control"), /immutable/);
    for (const path of [
      "/assets/../secret.txt",
      "/assets/%2e%2e/secret.txt",
      "/assets/..%2fsecret.txt",
    ]) {
      assert.equal((await get(port, path)).status, 404, path);
    }
  }));

test("a missing page gets the security headers too", () =>
  withServer(async (port) => {
    const missing = await get(port, "/nope");
    assert.equal(missing.status, 404);
    assert.equal(missing.header("x-content-type-options"), "nosniff");
    assert.match(
      missing.header("content-security-policy"),
      /default-src 'self'/,
    );
  }));

test("html escapes interpolations unless they are markup", () => {
  const name = `<script>alert("x")</script>`;
  assert.equal(
    html`<p title="${name}">${name}</p>`.value,
    `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>`,
  );
  assert.equal(
    html`<ul>${["a", "b"].map((item) => html`<li>${item}</li>`)}</ul>`.value,
    "<ul><li>a</li><li>b</li></ul>",
  );
  assert.equal(html`${null}${undefined}${false}${0}`.value, "0");
});

test("assets come from the Vite manifest, and a missing build fails clearly", async () => {
  const read = (clientDir: string) =>
    Effect.runPromiseExit(
      Effect.provide(
        Assets.useSync((assets) => assets),
        layerFromBuild(clientDir).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  const clientDir = clientBuild();
  mkdirSync(join(clientDir, ".vite"));
  writeFileSync(
    join(clientDir, ".vite", "manifest.json"),
    JSON.stringify({
      "src/client/main.ts": {
        file: "assets/main-abc.js",
        css: ["assets/main-def.css"],
      },
    }),
  );
  assert.deepEqual(
    await read(clientDir),
    Exit.succeed({
      scripts: ["/assets/main-abc.js"],
      styles: ["/assets/main-def.css"],
    }),
  );
  const missing = await read(clientBuild());
  assert.ok(Exit.isFailure(missing));
  assert.match(String(missing.cause), /AssetsNotBuilt/);
});
