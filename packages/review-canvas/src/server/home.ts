/**
 * What the home page shows: every review, and the repositories on this machine with their checkouts. Discovery reads
 * the directories it is given; monitored repositories also get each checkout's branch and changed items.
 */
import { Array as Arr, Effect } from "effect";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parsePullRequest } from "../schema/forge-url.ts";
import type { WorktreeRoot } from "../schema/primitives.ts";
import { type Repository, repositoryId } from "../schema/repositories.ts";
import type { CheckoutStatus, HomeSnapshot, RepositoryEntry, ReviewSummary } from "../schema/rpc.ts";
import type { Store } from "../store/store.ts";
import {
  checkoutStatus,
  discoverRepositories,
  groupRepositories,
  identifyRepository,
  remoteAddress,
  type RepositoryStatus,
  repositoryName,
} from "./repositories.ts";

const home = homedir();

/** A local path with the home folder as `~`. */
const homePath = (path: string): string =>
  home !== "" && home !== "/" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;

/** A repository's name and where it lives: `acme/ledger` on `github.com`, or a local name with no remote. */
const nameParts = (repository: Repository): { readonly name: string; readonly host: string } => {
  if (repository.identity.kind !== "remote") return { name: repositoryName(repository), host: "no remote" };
  const address = repository.identity.address;
  const at = address.indexOf("/");
  return at === -1 ? { name: address, host: "" } : { name: address.slice(at + 1), host: address.slice(0, at) };
};

const statusOf = (root: WorktreeRoot, status: RepositoryStatus): CheckoutStatus =>
  status.kind === "ready"
    ? status
    : {
        kind: "unavailable",
        message: status.message,
        reason: /different repository/.test(status.message)
          ? "another repository"
          : existsSync(root)
            ? "status unreadable"
            : "directory missing",
      };

const entry = (
  repository: Repository,
  reviews: ReadonlyArray<ReviewSummary>,
  statuses: ReadonlyMap<WorktreeRoot, RepositoryStatus> | undefined,
): RepositoryEntry => {
  const identity = repository.identity;
  const checkouts = Arr.map(repository.checkouts, (root) => {
    const status = statuses?.get(root);
    return { root, shown: homePath(root), ...(status === undefined ? {} : { status: statusOf(root, status) }) };
  });
  return {
    id: repositoryId(identity),
    identity,
    ...nameParts(repository),
    full_name: repositoryName(repository),
    monitored: statuses !== undefined,
    checkouts,
    pull_requests: reviews
      .filter((item) => {
        if (item.target.kind === "worktree" || identity.kind !== "remote") return false;
        const pull = parsePullRequest(item.target.url);
        const address = pull === undefined ? null : remoteAddress(pull.repositoryUrl);
        return pull?.provider === "github" ? address?.toLowerCase() === identity.address.toLowerCase() : address === identity.address;
      })
      .map((item) => item.id),
  };
};

/** Identifies the repository of a path, or undefined when it is not a readable working tree. */
const identified = (root: WorktreeRoot) =>
  Effect.tryPromise(() => identifyRepository(root)).pipe(Effect.option);

/**
 * Accepted checkouts from an older database become repository identities; those that cannot be identified yet stay
 * as unresolved roots, and an unresolved one that now identifies takes its repository's place.
 */
const migrate = (store: Store) =>
  Effect.gen(function* () {
    for (const root of store.pendingRepositoryMigrations()) {
      const found = yield* identified(root);
      const repository =
        found._tag === "Some"
          ? found.value
          : { identity: { kind: "unresolved" as const, root }, checkouts: [root] as const };
      const merged = groupRepositories([...store.monitoredRepositories(), repository]).find(
        (item) => repositoryId(item.identity) === repositoryId(repository.identity),
      );
      if (merged !== undefined) store.migrateAcceptedCheckout(root, merged);
    }
    for (const saved of store.monitoredRepositories()) {
      if (saved.identity.kind !== "unresolved") continue;
      const found = yield* identified(saved.identity.root);
      if (found._tag === "None") continue;
      const group = groupRepositories([...store.monitoredRepositories(), found.value]).find(
        (item) => repositoryId(item.identity) === repositoryId(found.value.identity),
      );
      if (group !== undefined) store.resolveMigratedRepository(repositoryId(saved.identity), group);
    }
  });

export const loadHome = (store: Store, roots: ReadonlyArray<string>, selectedRoot: string | undefined) =>
  Effect.gen(function* () {
    const discovery = yield* Effect.promise(() =>
      discoverRepositories(selectedRoot === undefined || selectedRoot === "" ? roots : [selectedRoot]),
    );
    yield* migrate(store);
    const accepted = new Set(store.monitoredRepositories().map((item) => repositoryId(item.identity)));
    const groups = groupRepositories([...store.monitoredRepositories(), ...discovery.repositories]);
    const monitored = groups.filter((repository) => accepted.has(repositoryId(repository.identity)));
    // UPDATE rather than INSERT keeps discovery incapable of accepting a new repository.
    for (const repository of monitored) store.refreshMonitoredRepository(repository);
    const checkouts = monitored.flatMap((repository) => repository.checkouts.map((root) => ({ root, repository })));
    // Four Git reads at a time. A page that leaves interrupts the load, which aborts the reads under way and starts none.
    const statuses = new Map(
      yield* Effect.forEach(
        checkouts,
        ({ root, repository }) =>
          Effect.promise((signal) => checkoutStatus(root, repository.identity, signal)).pipe(
            Effect.map((status) => [root, status] as const),
          ),
        { concurrency: 4 },
      ),
    );
    const reviews = store.reviews();
    const discovered = discovery.repositories.filter((repository) => !accepted.has(repositoryId(repository.identity)));
    return {
      reviews,
      repositories: [
        ...monitored.map((repository) => entry(repository, reviews, statuses)),
        ...discovered.map((repository) => entry(repository, reviews, undefined)),
      ],
      roots: discovery.roots.map(homePath),
      warnings: discovery.warnings,
    } satisfies HomeSnapshot;
  });
