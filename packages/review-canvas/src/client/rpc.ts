/**
 * The page's one connection to the server: the RPCs of schema/rpc.ts over a WebSocket, as atoms. The socket
 * reconnects on its own; while it is down, calls fail at once and open watches end, and the connection atom says so.
 */
import { Effect, Layer } from "effect";
import { Atom, AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { PageRpcs } from "../schema/rpc.ts";

/**
 * Whether the socket is up. `epoch` counts connections, so an atom that reads it subscribes again after a reconnect.
 * `lost` counts consecutive drops: two in a row mean the server is gone, not a blip.
 */
export interface Connection {
  readonly state: "connecting" | "connected" | "reconnecting" | "disconnected";
  readonly epoch: number;
  readonly lost: number;
}

export const connectionAtom = Atom.make<Connection>({ state: "connecting", epoch: 0, lost: 0 }).pipe(Atom.keepAlive);

/** The socket's connection count. Atoms that read it run again after a reconnect; 0 means not connected yet. */
export const epochAtom = Atom.map(connectionAtom, (connection) => connection.epoch);

const socketUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;

export class PageClient extends AtomRpc.Service<PageClient>()("review-canvas/PageClient", {
  group: PageRpcs,
  protocol: (get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          // `once` reads without subscribing: a dependency here would rebuild the runtime on every change.
          onConnect: Effect.sync(() => {
            const now = get.once(connectionAtom);
            get.set(connectionAtom, { state: "connected", epoch: now.epoch + 1, lost: 0 });
          }),
          onDisconnect: Effect.sync(() => {
            const now = get.once(connectionAtom);
            const lost = now.lost + 1;
            get.set(connectionAtom, { ...now, state: lost >= 2 ? "disconnected" : "reconnecting", lost });
          }),
        }),
      ),
      Layer.provide(Socket.layerWebSocket(socketUrl())),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    ),
}) {}
