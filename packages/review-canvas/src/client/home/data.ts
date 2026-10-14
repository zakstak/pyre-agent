/**
 * The home page as atoms: what the URL asks for, the snapshot the server builds for it, and the one change the page
 * makes, which is monitoring a repository or not. Every value about reviews and repositories comes from the server.
 */
import { Cause, Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";
import type { WorktreeRoot } from "../../schema/primitives.ts";
import type { RepositoryId } from "../../schema/repositories.ts";
import type { Refused } from "../../schema/rpc.ts";
import { epochAtom, PageClient } from "../rpc.ts";

// ------------------------------------------------------------------------------------------------------------- url

/**
 * The repository filter's text, kept in the URL as `q` as the reviewer types. Filtering never contacts the server.
 * Unlike `Atom.searchParam`, which adds a history entry half a second after each pause, it replaces the current entry
 * at once: Back leaves the page instead of undoing keystrokes, and a reload keeps what was typed.
 */
export const queryAtom = Atom.writable(
  () => new URLSearchParams(location.search).get("q") ?? "",
  (context, value: string) => {
    const params = new URLSearchParams(location.search);
    if (value === "") params.delete("q");
    else params.set("q", value);
    const search = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`);
    context.setSelf(value);
  },
);

/**
 * Which repositories an older link narrows the list to, kept in the URL as `filter`. The page has no control for it:
 * rows are grouped by monitoring, and every checkout says its state.
 */
export const FILTERS = ["monitored", "discovered", "changed", "unavailable"] as const;
export type Filter = (typeof FILTERS)[number];
export const filterAtom = Atom.searchParam("filter", { schema: Schema.Literals(FILTERS) });

/** A directory to scan instead of the server's scan directories, kept in the URL as `root`; empty for theirs. */
export const rootAtom = Atom.searchParam("root");

// -------------------------------------------------------------------------------------------------------- snapshot

/** The reviews and repositories, read again after a reconnect, a rescan, a new scan directory, or a change. */
export const homeAtom = PageClient.runtime.atom((get) => {
  const root = get(rootAtom);
  if (get(epochAtom) === 0) return Effect.never;
  return Effect.gen(function* () {
    const client = yield* PageClient;
    return yield* client("home.load", root === "" ? {} : { root });
  });
});

// --------------------------------------------------------------------------------------------------------- changes

/** Monitoring one repository from one of its checkouts, or no longer monitoring it. */
export type MonitoringChange =
  | { readonly kind: "accept"; readonly id: RepositoryId; readonly root: WorktreeRoot }
  | { readonly kind: "remove"; readonly id: RepositoryId };

/**
 * Sends one monitoring change, then reads the snapshot again so the lists show it. The page allows one change at a
 * time: its buttons wait while a change or the reload after it is under way.
 */
export const monitoringAtom = PageClient.runtime.fn((change: MonitoringChange, get) =>
  Effect.gen(function* () {
    const client = yield* PageClient;
    if (change.kind === "accept") yield* client("repositories.accept", { root: change.root, id: change.id });
    else yield* client("repositories.remove", { id: change.id });
    get.registry.refresh(homeAtom);
  }),
);

/** Whether a change, or the reload after it, is under way. Rescan, Monitor, and Remove wait meanwhile. */
export const busyAtom = Atom.make((get) => get(monitoringAtom).waiting || get(homeAtom).waiting);

/** What a page call can fail with: the server's refusal, or the socket. */
export type CallError = Refused | RpcClientError.RpcClientError;

/** Why a call failed, in words the page shows: the server's refusal as it says it, or the socket being down. */
export const failureText = (cause: Cause.Cause<CallError>, fallback: string): string => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return fallback;
  switch (error.value._tag) {
    case "Refused":
      return error.value.message;
    case "RpcClientError":
      return "Could not reach the server.";
  }
};
