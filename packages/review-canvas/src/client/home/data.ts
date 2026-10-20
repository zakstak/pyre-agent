/**
 * The home page as atoms: what the URL asks for, the snapshot the server builds for it, and the one change the page
 * makes, which is monitoring a repository or not. Every value about reviews and repositories comes from the server.
 */
import { Effect, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { WorktreeRoot } from "../../schema/primitives.ts";
import type { RepositoryId } from "../../schema/repositories.ts";
import { epochAtom, PageClient } from "../rpc.ts";

/**
 * A search parameter as text, with the value its absence stands for. Unlike `Atom.searchParam`, which adds a history
 * entry half a second after each pause, it replaces the current entry at once: Back leaves the page instead of
 * undoing keystrokes, and a reload keeps what was typed. Writing the absent value removes the parameter.
 */
const textParam = (key: string, absent: string) =>
  Atom.writable(
    () => new URLSearchParams(location.search).get(key) ?? absent,
    (context, value: string) => {
      const params = new URLSearchParams(location.search);
      if (value === absent) params.delete(key);
      else params.set(key, value);
      const search = params.toString();
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`,
      );
      context.setSelf(value);
    },
  );

/** The repository filter's text on the repositories page, kept in the URL as `q`. Filtering never contacts the server. */
export const queryAtom = textParam("q", "");

/**
 * The review query on the home page, kept in the URL as `q`; open reviews when it is absent, and an empty `q` for all.
 * Filtering never contacts the server.
 */
export const reviewQueryAtom = textParam("q", "is:open");

/**
 * Which repositories an older link narrows the list to, kept in the URL as `filter`. The page has no control for it:
 * rows are grouped by monitoring, and every checkout says its state.
 */
const FILTERS = ["monitored", "discovered", "changed", "unavailable"] as const;
export type Filter = (typeof FILTERS)[number];
export const filterAtom = Atom.searchParam("filter", {
  schema: Schema.Literals(FILTERS),
});

/** A directory to scan instead of the server's scan directories, kept in the URL as `root`; empty for theirs. */
export const rootAtom = Atom.searchParam("root");

/** The reviews and repositories, read again after a reconnect, a rescan, a new scan directory, or a change. */
export const homeAtom = PageClient.runtime.atom((get) => {
  const root = get(rootAtom);
  if (get(epochAtom) === 0) return Effect.never;
  return Effect.gen(function* () {
    const client = yield* PageClient;
    return yield* client("home.load", root === "" ? {} : { root });
  });
});

/** Monitoring one repository from one of its checkouts, or no longer monitoring it. */
export type MonitoringChange =
  | {
      readonly kind: "accept";
      readonly id: RepositoryId;
      readonly root: WorktreeRoot;
    }
  | { readonly kind: "remove"; readonly id: RepositoryId };

/**
 * Sends one monitoring change, then reads the snapshot again so the lists show it. The page allows one change at a
 * time: its buttons wait while a change or the reload after it is under way.
 */
export const monitoringAtom = PageClient.runtime.fn(
  (change: MonitoringChange, get) =>
    Effect.gen(function* () {
      const client = yield* PageClient;
      if (change.kind === "accept")
        yield* client("repositories.accept", {
          root: change.root,
          id: change.id,
        });
      else yield* client("repositories.remove", { id: change.id });
      get.registry.refresh(homeAtom);
    }),
);

/** Whether a change, or the reload after it, is under way. Rescan, Monitor, and Remove wait meanwhile. */
export const busyAtom = Atom.make(
  (get) => get(monitoringAtom).waiting || get(homeAtom).waiting,
);

/** Hosted lists load independently of the local home snapshot. */
export const repositoryPullRequestsAtom = Atom.family((id: RepositoryId) =>
  PageClient.runtime.atom((get) => {
    if (get(epochAtom) === 0) return Effect.never;
    return Effect.flatMap(PageClient, (client) =>
      client("repositories.pulls", { id }),
    );
  }),
);
