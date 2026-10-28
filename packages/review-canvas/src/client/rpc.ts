/**
 * The page's one connection to the server: the RPCs of schema/rpc.ts over a WebSocket, as atoms. The socket
 * reconnects on its own; while it is down, calls fail at once and open watches end, and the connection atom says so.
 */
import { Cause, Effect, Layer, Option } from "effect";
import { Atom, AtomRpc } from "effect/reactivity";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { PageRpcs, Refused } from "../schema/rpc.ts";

/**
 * Whether the socket is up. `epoch` counts connections, so an atom that reads it subscribes again after a reconnect.
 * `lost` counts consecutive drops: two in a row mean the server is gone, not a blip.
 */
export interface Connection {
  readonly state: "connecting" | "connected" | "reconnecting" | "disconnected";
  readonly epoch: number;
  readonly lost: number;
}

export const connectionAtom = Atom.make<Connection>({
  state: "connecting",
  epoch: 0,
  lost: 0,
}).pipe(Atom.keepAlive);

/** The socket's connection count. Atoms that read it run again after a reconnect; 0 means not connected yet. */
export const epochAtom = Atom.map(
  connectionAtom,
  (connection) => connection.epoch,
);

/** The socket's state as every page says it, empty while it is up or not up yet. */
export const CONNECTION_TEXT: Readonly<Record<Connection["state"], string>> = {
  connecting: "",
  connected: "",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

/** What a page call can fail with: the server's refusal, or the socket. */
export type CallError = Refused | RpcClientError.RpcClientError;

/** What every page says when the socket failed a call, or a call could not be made. */
export const NO_ANSWER = "The server did not answer. Is it still running?";

/**
 * Why a call failed, in words the page shows: the server's refusal as it says it, and any other error, such as the
 * socket's or a watch that ended, as the server not answering. `fallback` is for a failure with no error in it, such
 * as an interruption.
 */
export const failureText = (
  cause: Cause.Cause<unknown>,
  fallback = NO_ANSWER,
): string =>
  Cause.findErrorOption(cause).pipe(
    Option.map((error) =>
      error instanceof Refused ? error.message : NO_ANSWER,
    ),
    Option.getOrElse(() => fallback),
  );

const socketUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;

export class PageClient extends AtomRpc.Service<PageClient>()(
  "review-canvas/PageClient",
  {
    group: PageRpcs,
    protocol: (get) =>
      RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
        Layer.provide(
          Layer.succeed(RpcClient.ConnectionHooks, {
            // `once` reads without subscribing: a dependency here would rebuild the runtime on every change.
            onConnect: Effect.sync(() => {
              const now = get.once(connectionAtom);
              get.set(connectionAtom, {
                state: "connected",
                epoch: now.epoch + 1,
                lost: 0,
              });
            }),
            onDisconnect: Effect.sync(() => {
              const now = get.once(connectionAtom);
              const lost = now.lost + 1;
              get.set(connectionAtom, {
                ...now,
                state: lost >= 2 ? "disconnected" : "reconnecting",
                lost,
              });
            }),
          }),
        ),
        Layer.provide(Socket.layerWebSocket(socketUrl())),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      ),
  },
) {}
