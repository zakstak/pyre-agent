// Module paths, not the package index: the index also loads its Redis module, which needs a package not installed here.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { App } from "./app.ts"
import * as Assets from "./assets.ts"

const clientDir = fileURLToPath(new URL("../../dist/client", import.meta.url))

// Loopback only. Port 0 lets the system pick a free port; the listen log prints the address.
const Server = NodeHttpServer.layerConfig(createServer, {
  host: Config.succeed("127.0.0.1"),
  port: Config.Port("REVIEW_CANVAS_PORT").pipe(Config.withDefault(0))
})

// Requests are not logged; the server runs beside an agent's terminal.
const Main = HttpRouter.serve(App({ clientDir }), { disableLogger: true }).pipe(
  Layer.provide(Assets.layerFromBuild(clientDir)),
  Layer.provide(Server)
)

NodeRuntime.runMain(Layer.launch(Main))
