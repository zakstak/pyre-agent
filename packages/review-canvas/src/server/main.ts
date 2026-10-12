// Module paths, not the package index: the index also loads its Redis module, which needs a package not installed here.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { AgentApi } from "./agent.ts";
import { App } from "./app.ts";
import * as Assets from "./assets.ts";
import { databasePath, idleMinutes, runtimeDir, socketPath } from "./paths.ts";
import {
  Activity,
  activityLayer,
  PageAddress,
  storeLayer,
} from "./services.ts";

const clientDir = fileURLToPath(new URL("../../dist/client", import.meta.url));

class SocketInUse extends Data.TaggedError("SocketInUse")<{
  readonly path: string;
}> {
  override get message() {
    return `A review canvas server already listens on ${this.path}.`;
  }
}

/** Whether a server answers on the socket. A stale socket file refuses the connection. */
const socketInUse = (path: string) =>
  new Promise<boolean>((resolve) => {
    const client = connect(path);
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });

/**
 * Claims the socket path: the folder is private, and a socket file nobody answers on is removed. A live server
 * keeps its socket, and this one exits, so the socket is the single-instance lock.
 */
const claimSocket = Effect.gen(function* () {
  const dir = runtimeDir();
  const path = socketPath();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (yield* Effect.promise(() => socketInUse(path))) {
    return yield* Effect.fail(new SocketInUse({ path }));
  }
  rmSync(path, { force: true });
  return path;
});

// Loopback only. Port 0 lets the system pick a free port; the listen log prints the address.
const PageServer = NodeHttpServer.layerConfig(createServer, {
  host: Config.succeed("127.0.0.1"),
  port: Config.Port("REVIEW_CANVAS_PORT").pipe(Config.withDefault(0)),
});

const AgentServer = Layer.unwrap(
  Effect.map(claimSocket, (path) =>
    NodeHttpServer.layer(createServer, { path }).pipe(
      Layer.tap(() => Effect.sync(() => chmodSync(path, 0o600))),
    ),
  ),
);

/** Stops the server after the idle time passes with no agent request, page change, or open event stream. */
const idleWatcher = Effect.gen(function* () {
  const activity = yield* Activity;
  const limit = idleMinutes() * 60_000;
  while (true) {
    yield* Effect.sleep("60 seconds");
    const since = activity.idleSince();
    if (since !== undefined && Date.now() - since > limit) {
      yield* Effect.logInfo(`Idle for ${idleMinutes()} minutes; stopping.`);
      return;
    }
  }
});

const Pages = HttpRouter.serve(App({ clientDir }), {
  disableLogger: true,
}).pipe(Layer.provideMerge(PageServer));

// The page address the agent API reports comes from the page server once it listens.
const pageAddress = Layer.effect(
  PageAddress,
  Effect.map(HttpServer.HttpServer, ({ address }) => ({
    origin:
      address._tag === "UnixPathAddress"
        ? "http://127.0.0.1"
        : `http://127.0.0.1:${address.port}`,
  })),
);

const Agents = HttpRouter.serve(AgentApi, {
  disableLogger: true,
  disableListenLog: true,
}).pipe(Layer.provide(AgentServer));

/** Both listeners share the store and the activity counter. */
export const Main = Layer.mergeAll(
  Pages,
  Agents.pipe(Layer.provide(pageAddress.pipe(Layer.provide(Pages)))),
).pipe(
  Layer.provide(Assets.layerFromBuild(clientDir)),
  Layer.provide(storeLayer(databasePath())),
  Layer.provideMerge(activityLayer),
  Layer.provide(NodeServices.layer),
);

/** Serves until the idle watcher returns; closing the scope stops both listeners and the store. */
export const run = () =>
  NodeRuntime.runMain(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Main);
        yield* idleWatcher.pipe(Effect.provide(context));
      }),
    ),
  );

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  run();
