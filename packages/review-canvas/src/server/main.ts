// Module paths, not the package index: the index also loads its Redis module, which needs a package not installed here.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Context, Data, Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import * as Limits from "../schema/limits.ts";
import { AgentApi } from "./agent.ts";
import { MAX_REQUEST_BYTES } from "./requests.ts";
import { clientDir as installedClientDir } from "./install.ts";
import { App } from "./app.ts";
import { repositoryRoots } from "./repositories.ts";
import * as Assets from "./assets.ts";
import {
  databasePath,
  idleMinutes,
  portPath,
  runtimeDir,
  socketPath,
} from "./paths.ts";
import { checkSocket, secureRuntimeDir, StartLock } from "./runtime.ts";
import { acquireOperationLock } from "./operation.ts";
import { Lifecycle, LifecycleApi, lifecycleLayer } from "./lifecycle.ts";
import {
  Activity,
  activityLayer,
  PageAddress,
  storeLayer,
} from "./services.ts";

const clientDir = installedClientDir();

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

class RuntimeRefused extends Data.TaggedError("RuntimeRefused")<{
  readonly message: string;
}> {}

class StartTimedOut extends Data.TaggedError("StartTimedOut")<{
  readonly dir: string;
}> {
  override get message() {
    return `Another review canvas server holds the start lock in ${this.dir} but does not answer.`;
  }
}

/**
 * Takes the start lock for the life of the scope. While another server holds it, this one waits: if that server
 * answers on the socket, this one exits; if it is still starting, this one tries again.
 */
const startLock = (dir: string, path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 100; attempt++) {
        const lock = StartLock.try(dir);
        if (lock !== undefined) return lock;
        if (yield* Effect.promise(() => socketInUse(path)))
          return yield* new SocketInUse({ path });
        yield* Effect.sleep("100 millis");
      }
      return yield* new StartTimedOut({ dir });
    }),
    (lock) => Effect.sync(() => lock.release()),
  );

/**
 * Claims the socket path under the start lock: the folder is this user's and private, and a socket file nobody
 * answers on is removed. The lock stays held while the server runs, so no other start can remove a live socket.
 */
const claimSocket = Effect.gen(function* () {
  const dir = runtimeDir();
  const path = socketPath();
  yield* Effect.try({
    try: () => {
      secureRuntimeDir(dir);
      checkSocket(path);
    },
    catch: (error) =>
      new RuntimeRefused({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  yield* startLock(dir, path);
  if (yield* Effect.promise(() => socketInUse(path)))
    return yield* new SocketInUse({ path });
  rmSync(path, { force: true });
  return path;
});

/** The port the last server remembered, or undefined when there is none or the file holds no port. */
const rememberedPort = (): number | undefined => {
  let text: string;
  try {
    text = readFileSync(portPath(), "utf8").trim();
  } catch {
    return undefined;
  }
  const port = Number(text);
  return /^\d+$/.test(text) && port > 0 && port < 65536 ? port : undefined;
};

/**
 * The pages' RPC sockets. Stopping closes each one, and the WebSocket library waits for the page to answer the close
 * for up to 30 seconds; a page that cannot answer, such as a frozen tab, would hold the stop that long. A second after
 * the server starts stopping, the sockets still open are cut.
 */
const pageSockets = new Set<Duplex>();

const createPageServer = () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    pageSockets.add(socket);
    socket.once("close", () => pageSockets.delete(socket));
  });
  return server;
};

const cutPageSocketsSoon = () =>
  setTimeout(() => {
    for (const socket of pageSockets) socket.destroy();
  }, 1000).unref();

/**
 * The largest WebSocket message a page may send, refused before it is parsed: a feedback file at its limit with every
 * character escaped in JSON, and an action's worth beside it.
 */
const MAX_PAGE_MESSAGE_BYTES = 2 * Limits.MAX_FEEDBACK_BYTES + MAX_REQUEST_BYTES;

const pageServerOn = (port: number) =>
  NodeHttpServer.layer(createPageServer, {
    host: "127.0.0.1",
    port,
    gracefulShutdownTimeout: "1 second",
    websocket: { maxPayload: MAX_PAGE_MESSAGE_BYTES },
  });

/**
 * Loopback only; the listen log prints the address. REVIEW_CANVAS_PORT decides the port when set. Otherwise the server
 * asks for the port the last one listened on, so pages left open reconnect after a restart, and takes any free port
 * when that one is busy. It remembers the port it got.
 */
const PageServer = Layer.unwrap(
  Effect.gen(function* () {
    const explicit = yield* Config.option(Config.Port("REVIEW_CANVAS_PORT"));
    const remembered = rememberedPort();
    const listening = explicit._tag === "Some"
      ? pageServerOn(explicit.value)
      : remembered === undefined
        ? pageServerOn(0)
        : pageServerOn(remembered).pipe(
            Layer.catchTag("ServeError", () => pageServerOn(0)),
          );
    return listening.pipe(
      Layer.tap((context) =>
        Effect.sync(() => {
          const { address } = Context.get(context, HttpServer.HttpServer);
          if (address._tag !== "UnixPathAddress")
            writeFileSync(portPath(), `${address.port}\n`, { mode: 0o600 });
        }),
      ),
    );
  }),
);

const AgentServer = Layer.unwrap(
  Effect.map(claimSocket, (path) =>
    NodeHttpServer.layer(createServer, {
      path,
      gracefulShutdownTimeout: "1 second",
    }).pipe(Layer.tap(() => Effect.sync(() => chmodSync(path, 0o600)))),
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

const Pages = HttpRouter.serve(App({ clientDir, repositoryRoots: repositoryRoots() }), {
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

const Agents = HttpRouter.serve(Layer.mergeAll(AgentApi, LifecycleApi), {
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
  Layer.provideMerge(lifecycleLayer),
  Layer.provide(NodeServices.layer),
);

/** Serves until the idle watcher returns; closing the scope stops both listeners and the store. */
export const run = () =>
  NodeRuntime.runMain(
    Effect.scoped(
      Effect.gen(function* () {
        // ensureServer holds the command lock until its child answers. Foreground starts take it themselves.
        const startup =
          process.argv[2] === "--coordinated-start"
            ? undefined
            : yield* Effect.promise(acquireOperationLock);
        if (startup !== undefined)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => startup.release()),
          );
        // This outer lock is released only after the inner scope closes both listeners and the store.
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            const lock = StartLock.try(runtimeDir(), "lifetime.lock");
            return lock === undefined
              ? Effect.fail(new SocketInUse({ path: socketPath() }))
              : Effect.succeed(lock);
          }),
          (lock) => Effect.sync(() => lock.release()),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(Main);
            startup?.release();
            yield* Effect.raceFirst(
              idleWatcher,
              Effect.flatMap(Lifecycle, ({ stopped }) =>
                Deferred.await(stopped),
              ),
            ).pipe(
              Effect.provide(context),
              // However the server stops, a signal included, before the listeners close.
              Effect.ensuring(Effect.sync(cutPageSocketsSoon)),
            );
            // Flush the lifecycle response before closing the listeners.
            yield* Effect.sleep("100 millis");
          }),
        );
      }),
    ),
  );

/** Whether this module is the program Node was started with. A path is converted, not pasted into a URL. */
export const isEntry = (moduleUrl: string, argv1: string | undefined) =>
  argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;

if (isEntry(import.meta.url, process.argv[1])) run();
