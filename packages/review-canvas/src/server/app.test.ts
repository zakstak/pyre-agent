import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Context, Effect, Exit, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RpcClient,
  type RpcClientError,
  type RpcGroup,
  RpcSerialization,
} from "effect/rpc";
import { Socket } from "effect/socket";
import { App, loopbackHosts } from "./app.ts";
import { Assets, layerFromBuild } from "./assets.ts";
import { activityLayer, ReviewStore, storeLayer } from "./services.ts";
import { Store } from "../store/store.ts";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import { fixtureBytes } from "../schema/testing.ts";
import * as Result from "effect/Result";
import { gitEnvironment } from "../collector/git.ts";
import { identifyRepository } from "./repositories.ts";
import { repositoryId } from "../schema/repositories.ts";
import { PageRpcs } from "../schema/rpc.ts";
import { Schema } from "effect";
import { WorktreeRoot } from "../schema/primitives.ts";

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

const SHELL =
  '<!doctype html><title>Review canvas</title><script type="module" src="/assets/main.js"></script>';

/** Runs calls through the page RPCs over the socket, as a page on `origin` would. */
const rpc = <A, E>(
  port: number,
  use: (
    client: RpcClient.RpcClient.Flat<
      RpcGroup.Rpcs<typeof PageRpcs>,
      RpcClientError.RpcClientError
    >,
  ) => Effect.Effect<A, E>,
  origin = `http://127.0.0.1:${port}`,
) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(RpcClient.make(PageRpcs, { flatten: true }), use),
    ).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`, {
              headers: { origin },
            }),
          ),
          // The browser's constructor sends no Origin; Node's can.
          Layer.provide(NodeSocket.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
    ),
  );

const clientBuild = () => {
  const clientDir = mkdtempSync(join(tmpdir(), "review-canvas-"));
  mkdirSync(join(clientDir, "assets"));
  writeFileSync(join(clientDir, "assets", "main.css"), "body{}");
  // Exists just outside the served folder, so a 404 for it shows containment, not a missing file.
  writeFileSync(join(clientDir, "secret.txt"), "secret");
  return clientDir;
};

// Serves the app on a free loopback port with fixed assets, then runs the check against it.
const withServer = (
  check: (port: number) => Promise<void>,
  repositoryRoots: ReadonlyArray<string> = [],
  store?: Store,
) => {
  const clientDir = clientBuild();
  const TestAssets = Layer.succeed(Assets, { index: SHELL });
  const Server = NodeHttpServer.layer(createServer, {
    host: "127.0.0.1",
    port: 0,
  });
  const Live = HttpRouter.serve(App({ clientDir, repositoryRoots }), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(TestAssets),
    Layer.provide(
      store === undefined
        ? storeLayer(":memory:")
        : Layer.succeed(ReviewStore, store),
    ),
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

test("every page path serves the built shell with the security headers", () =>
  withServer(async (port) => {
    for (const path of ["/", "/reviews/review-anything"]) {
      const page = await get(port, path);
      assert.equal(page.status, 200, path);
      assert.match(page.header("content-type"), /^text\/html/);
      assert.equal(page.header("cache-control"), "no-store");
      assert.match(
        page.header("content-security-policy"),
        /frame-ancestors 'none'/,
      );
      assert.equal(page.body, SHELL);
    }
  }));

test("the RPC socket opens only for a page of this server", () =>
  withServer(async (port) => {
    const upgrade = (origin: string | undefined, path = "/rpc") =>
      new Promise<number>((resolve, reject) => {
        const socket = request({
          host: "127.0.0.1",
          port,
          path,
          // A refused upgrade leaves its connection to close; each attempt gets its own.
          agent: false,
          headers: {
            host: `127.0.0.1:${port}`,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key":
              Buffer.from("origin-fixture!!").toString("base64"),
            "sec-websocket-version": "13",
            ...(origin === undefined ? {} : { origin }),
          },
        });
        socket.once("upgrade", (response, stream) => {
          stream.destroy();
          resolve(response.statusCode ?? 0);
        });
        socket.once("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        socket.once("error", reject);
        socket.end();
      });
    assert.equal(await upgrade("https://evil.example"), 403);
    assert.equal(await upgrade(undefined), 403);
    // The router matches these as /rpc too; the check holds for any upgrade, not one spelling of the path.
    for (const path of ["/rpc/", "/rpc//", "/RPC", "/%72pc", "/rpc?x=1"])
      assert.equal(await upgrade("https://evil.example", path), 403, path);
    assert.equal(await upgrade(`http://localhost:${port}`), 101);
    assert.equal(await upgrade(`http://127.0.0.1:${port}`), 101);
  }));

test("discovery proposes repos without adding them, and only acceptance changes monitoring", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "review-canvas-home-repos-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "-b", "main"], {
    cwd: root,
    env: gitEnvironment({}),
    stdio: "ignore",
  });
  mkdirSync(join(root, "subdir"));
  const checkout = Schema.decodeSync(WorktreeRoot)(root);
  const id = repositoryId((await identifyRepository(checkout)).identity);
  await withServer(
    async (port) => {
      const home = await rpc(port, (client) => client("home.load", {}));
      assert.ok(Exit.isSuccess(home));
      assert.deepEqual(
        home.value.repositories.map((item) => [item.name, item.monitored]),
        [["repo", false]],
      );
      const refused = await rpc(port, (client) =>
        client("repositories.accept", {
          root: Schema.decodeSync(WorktreeRoot)(join(root, "subdir")),
          id,
        }),
      );
      assert.ok(Exit.isFailure(refused));
      assert.match(
        String(refused.cause),
        /This path is no longer a readable Git repository root/,
      );
      const accepted = await rpc(port, (client) =>
        Effect.andThen(
          client("repositories.accept", { root: checkout, id }),
          client("home.load", {}),
        ),
      );
      assert.ok(Exit.isSuccess(accepted));
      const [entry] = accepted.value.repositories;
      assert.equal(entry?.monitored, true);
      assert.deepEqual(entry?.checkouts[0].status, {
        kind: "ready",
        branch: "main",
        changed: 0,
      });
      rmSync(root, { recursive: true });
      const gone = await rpc(port, (client) => client("home.load", {}));
      assert.ok(Exit.isSuccess(gone));
      assert.equal(
        gone.value.repositories[0]?.checkouts[0].status?.kind,
        "unavailable",
      );
      assert.equal(
        gone.value.repositories[0]?.checkouts[0].status?.kind ===
          "unavailable" &&
          gone.value.repositories[0].checkouts[0].status.reason,
        "directory missing",
      );
      const removed = await rpc(port, (client) =>
        Effect.andThen(
          client("repositories.remove", { id }),
          client("home.load", {}),
        ),
      );
      assert.ok(Exit.isSuccess(removed));
      assert.equal(
        removed.value.repositories.filter((item) => item.monitored).length,
        0,
      );
    },
    [directory],
  );
});

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

test("repository acceptance and removal carry maximum-length remote identities", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "review-canvas-long-repository-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "-b", "main"], {
    cwd: root,
    env: gitEnvironment({}),
    stdio: "ignore",
  });
  const address =
    "example.invalid/" + "x".repeat(8192 - "example.invalid/".length);
  execFileSync("git", ["remote", "add", "origin", `https://${address}`], {
    cwd: root,
    env: gitEnvironment({}),
    stdio: "ignore",
  });
  const checkout = Schema.decodeSync(WorktreeRoot)(root);
  const id = repositoryId((await identifyRepository(checkout)).identity);
  assert.ok(id.length > 8192);
  await withServer(
    async (port) => {
      const accepted = await rpc(port, (client) =>
        Effect.andThen(
          client("repositories.accept", { root: checkout, id }),
          client("home.load", {}),
        ),
      );
      assert.ok(Exit.isSuccess(accepted));
      assert.equal(
        accepted.value.repositories.filter((item) => item.monitored).length,
        1,
      );
      const removed = await rpc(port, (client) =>
        Effect.andThen(
          client("repositories.remove", { id }),
          client("home.load", {}),
        ),
      );
      assert.ok(Exit.isSuccess(removed));
      assert.equal(
        removed.value.repositories.filter((item) => item.monitored).length,
        0,
      );
    },
    [directory],
  );
});

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

test("the page shell comes from the build, and a missing build fails clearly", async () => {
  const read = (clientDir: string) =>
    Effect.runPromiseExit(
      Effect.provide(
        Assets.useSync((assets) => assets),
        layerFromBuild(clientDir).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  const clientDir = clientBuild();
  writeFileSync(join(clientDir, "index.html"), SHELL);
  assert.deepEqual(await read(clientDir), Exit.succeed({ index: SHELL }));
  const missing = await read(clientBuild());
  assert.ok(Exit.isFailure(missing));
  assert.match(String(missing.cause), /AssetsNotBuilt/);
});

test("PR discovery requires repository monitoring, not individual PR registration", () =>
  withServer(async (port) => {
    const id = repositoryId({
      kind: "remote",
      address: "unknown.invalid/team/project",
    });
    const answer = await rpc(port, (client) =>
      client("repositories.pulls", { id }),
    );
    assert.ok(Exit.isSuccess(answer));
    assert.equal(answer.value.kind, "unavailable");
    if (answer.value.kind === "unavailable")
      assert.match(answer.value.message, /Monitor a remote repository/);
  }));

/** A POST with a JSON body, from a page on `origin`, or with no Origin at all. */
const post = (
  port: number,
  path: string,
  body: unknown,
  origin: string | undefined,
  type = "application/json",
) =>
  new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": type,
          ...(origin === undefined ? {} : { origin }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            header: (name) => String(response.headers[name] ?? ""),
            body: text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

test("a page's drafts posted as it closes are kept, and only a page of this server can post them", async () => {
  const store = Store.open(":memory:");
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  const { review, thread } = store.register({
    target: decoded.success.target,
    label: "Claude Code: test",
    host: { kind: "claude-code" },
  });
  const id = review.state.id;
  store.publish(id, thread.id, decoded.success);
  store.saveDraft(id, { kind: "finish", verdict: "approve", body: "Old" });
  await withServer(
    async (port) => {
      const writes = {
        writes: [
          { kind: "save", draft: { kind: "general", body: "Typed at close" } },
          { kind: "discard", slot: { kind: "finish" } },
        ],
      };
      const path = `/reviews/${id}/drafts`;
      // Another site's page, a request with no Origin, and a form post are refused, and change nothing.
      for (const origin of ["https://evil.example", undefined])
        assert.equal((await post(port, path, writes, origin)).status, 403);
      const form = await post(
        port,
        path,
        writes,
        `http://127.0.0.1:${port}`,
        "text/plain",
      );
      assert.equal(form.status, 415);
      assert.deepEqual(
        store.drafts(id).map(({ draft }) => draft.body),
        ["Old"],
      );

      const kept = await post(port, path, writes, `http://localhost:${port}`);
      assert.equal(kept.status, 200, kept.body);
      assert.equal(JSON.parse(kept.body).ok, true);
      assert.deepEqual(
        store.drafts(id).map(({ draft }) => draft),
        [{ kind: "general", body: "Typed at close" }],
      );

      // A refused write keeps the others, and the answer says why.
      const mixed = await post(
        port,
        path,
        {
          writes: [
            {
              kind: "save",
              draft: { kind: "reply", comment: "comment-none", body: "x" },
            },
            { kind: "save", draft: { kind: "general", body: "Still kept" } },
          ],
        },
        `http://127.0.0.1:${port}`,
      );
      assert.equal(mixed.status, 404, mixed.body);
      assert.deepEqual(
        store.drafts(id).map(({ draft }) => draft.body),
        ["Still kept"],
      );
      assert.equal(
        (
          await post(
            port,
            "/reviews/review-none/drafts",
            writes,
            `http://127.0.0.1:${port}`,
          )
        ).status,
        404,
      );
    },
    [],
    store,
  );
});
