/**
 * Repository summaries, with checkout details on demand. Discovery and missing paths stay in disclosures;
 * searching reveals matching checkouts. Rescan reads the snapshot again without changing monitoring.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import {
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  FileDiff,
  GitBranch,
  GitPullRequest,
} from "lucide-react";
import { Atom } from "effect/reactivity";
import { type FormEvent, useEffect, useState } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type {
  Checkout,
  CheckoutStatus,
  HomeSnapshot,
  RepositoryEntry,
  ReviewSummary,
} from "../../schema/rpc.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import { Stat } from "../ui/stat.tsx";
import { landOnHash } from "../ui/page.tsx";
import { failureText } from "../rpc.ts";
import {
  busyAtom,
  type Filter,
  filterAtom,
  homeAtom,
  type MonitoringChange,
  monitoringAtom,
  queryAtom,
  rootAtom,
} from "./data.ts";
import { count, underRoot } from "../names.ts";

/** A checkout's state as the filter names it. */
const stateOf = (
  status: CheckoutStatus,
): "changed" | "clean" | "unavailable" =>
  status.kind === "ready"
    ? status.changed > 0
      ? "changed"
      : "clean"
    : "unavailable";

/** Checkouts matching a name, path, or branch and an older link's status filter. */
const checkoutsMatching = (
  entry: RepositoryEntry,
  query: string,
  filter: Option.Option<Filter>,
): ReadonlyArray<Checkout> => {
  const repositoryMatches = entry.full_name.toLowerCase().includes(query);
  const kind = Option.getOrUndefined(filter);
  return entry.checkouts.filter((checkout) => {
    const branch =
      checkout.status?.kind === "ready"
        ? (checkout.status.branch ?? "detached")
        : "";
    return (
      (repositoryMatches ||
        `${checkout.root} ${branch}`.toLowerCase().includes(query)) &&
      ((kind !== "changed" && kind !== "unavailable") ||
        (checkout.status !== undefined && stateOf(checkout.status) === kind))
    );
  });
};

/** Whether a repository matches the search text, lowercased, by name, path, or branch, and the link's filter. */
const matches = (
  entry: RepositoryEntry,
  query: string,
  filter: Option.Option<Filter>,
): boolean => {
  const kind = Option.getOrUndefined(filter);
  if (
    (kind === "monitored" && !entry.monitored) ||
    (kind === "discovered" && entry.monitored)
  )
    return false;
  return checkoutsMatching(entry, query, filter).length > 0;
};

const isMissing = (checkout: Checkout): boolean =>
  checkout.status?.kind === "unavailable" &&
  checkout.status.reason === "directory missing";

/** The word a checkout row shows for why it is unavailable; the full message is its title. */
const unavailableWord = (reason: string): string =>
  reason === "directory missing"
    ? "missing"
    : reason === "status unreadable"
      ? "unreadable"
      : reason;

/** Review titles in one title attribute. */
const titles = (reviews: ReadonlyArray<ReviewSummary>): string =>
  reviews.map((item) => item.target.title).join(" · ");

/** A checkout's state as icons and numbers: files changed, why it is unavailable, its reviews. Blank is clean. */
const CheckoutStats = ({
  status,
  reviews,
}: {
  readonly status: CheckoutStatus | undefined;
  readonly reviews: ReadonlyArray<ReviewSummary>;
}) => (
  <span className="flex items-center justify-end gap-x-2.5">
    {status?.kind === "ready" && status.changed > 0 ? (
      <Stat
        icon={FileDiff}
        tone="warning"
        title={`${count(status.changed, "file")} changed`}
      >
        {status.changed}
      </Stat>
    ) : null}
    {status?.kind === "unavailable" ? (
      <Stat icon={CircleAlert} tone="danger" title={status.message}>
        {unavailableWord(status.reason)}
      </Stat>
    ) : null}
    {reviews.length === 0 ? null : (
      <Stat icon={ClipboardCheck} title={titles(reviews)}>
        {reviews.length}
      </Stat>
    )}
  </span>
);

/**
 * A checkout as a table row: its branch, its path under the scan directory that holds it, then its stats. Below
 * `md` the path drops to a second line.
 */
const CheckoutLine = ({
  checkout,
  roots,
  reviews,
}: {
  readonly checkout: Checkout;
  readonly roots: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<ReviewSummary>;
}) => {
  const { status } = checkout;
  const branch =
    status?.kind === "ready" ? (status.branch ?? undefined) : undefined;
  return (
    <li
      data-checkout=""
      className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] items-center gap-x-4 md:h-7 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-1"
    >
      {/* A found repository's checkouts have no status to show: the path takes the branch's column too. */}
      {status === undefined ? null : (
        <span className="flex min-w-0 items-center gap-1.5" title={branch}>
          <GitBranch
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted"
          />
          {status.kind === "unavailable" ? (
            <span className="text-small text-muted">—</span>
          ) : branch === undefined ? (
            <span className="text-small text-muted">detached</span>
          ) : (
            <span className="truncate text-small text-ink">{branch}</span>
          )}
        </span>
      )}
      <code
        className={cn(
          "truncate font-mono text-technical text-muted",
          status === undefined
            ? "col-span-2 max-md:col-span-1"
            : "max-md:col-span-2 max-md:row-start-2",
        )}
        title={checkout.root}
      >
        {underRoot(checkout.shown, roots)}
      </code>
      <CheckoutStats
        status={status}
        reviews={reviews.filter(
          (item) =>
            item.target.kind === "worktree" &&
            item.target.root === checkout.root,
        )}
      />
    </li>
  );
};

const RepositoryRow = ({
  entry,
  roots,
  reviews,
  byId,
  busy,
  change,
  search,
  filter,
}: {
  readonly entry: RepositoryEntry;
  readonly roots: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly byId: ReadonlyMap<ReviewId, ReviewSummary>;
  readonly busy: boolean;
  readonly change: (change: MonitoringChange) => void;
  readonly search: string;
  readonly filter: Option.Option<Filter>;
}) => {
  const root = entry.checkouts[0].root;
  const pullRequests = entry.pull_requests.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const shown = checkoutsMatching(entry, search, filter);
  const missing = shown.filter(isMissing);
  const available = shown.filter((checkout) => !isMissing(checkout));
  const missingCount = entry.checkouts.filter(isMissing).length;
  const changed = entry.checkouts.filter(
    (checkout) =>
      checkout.status?.kind === "ready" && checkout.status.changed > 0,
  ).length;
  const reveal =
    search !== "" ||
    Option.exists(
      filter,
      (kind) => kind === "changed" || kind === "unavailable",
    );
  const checkoutRows = (checkouts: ReadonlyArray<Checkout>) =>
    checkouts.map((checkout) => (
      <CheckoutLine
        key={checkout.root}
        checkout={checkout}
        roots={roots}
        reviews={reviews}
      />
    ));
  return (
    <li
      data-repository=""
      data-monitoring={entry.monitored ? "monitored" : "discovered"}
      className="py-1"
    >
      <Collapsible.Root defaultOpen={reveal}>
        <div className="flex flex-wrap items-center gap-x-3">
          <h3 className="min-w-0 flex-[1_1_14rem]">
            <Collapsible.Trigger
              className="group flex min-h-11 w-full items-center gap-2 rounded-control py-2 text-left hover:bg-subtle"
              aria-label={`Checkouts for ${entry.full_name}`}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted transition-transform group-data-panel-open:rotate-90"
              />
              <span className="min-w-0">
                <span
                  className="block truncate text-reading font-semibold"
                  title={entry.full_name}
                >
                  {entry.name}
                </span>
                <span className="block wrap-anywhere text-small font-normal text-muted">
                  {entry.host === "" ? "" : `${entry.host} · `}
                  {count(entry.checkouts.length, "checkout")}
                  {changed === 0 ? null : ` · ${changed} with changes`}
                  {missingCount === 0 ? null : ` · ${missingCount} missing`}
                </span>
              </span>
            </Collapsible.Trigger>
          </h3>
          {pullRequests.length === 0 ? null : (
            <Stat
              icon={GitPullRequest}
              title={titles(pullRequests)}
              className="shrink-0"
            >
              {pullRequests.length}
            </Stat>
          )}
          {entry.monitored ? null : (
            <Button
              size="sm"
              data-repository-action="accept"
              data-id={entry.id}
              data-root={root}
              aria-label={`Monitor ${entry.full_name}`}
              disabled={busy}
              onClick={() => change({ kind: "accept", id: entry.id, root })}
            >
              Monitor
            </Button>
          )}
        </div>
        <Collapsible.Panel>
          <div className="mb-3 ml-2 border-l border-separator py-2 pl-4">
            {shown.length === entry.checkouts.length ? null : (
              <p className="mb-2 text-small text-muted">
                {count(shown.length, "matching checkout")}
              </p>
            )}
            {available.length === 0 ? null : <ul>{checkoutRows(available)}</ul>}
            {missing.length === 0 ? null : (
              <Collapsible.Root
                defaultOpen={reveal}
                className="mt-2"
                data-missing-checkouts=""
              >
                <Collapsible.Trigger className="group flex min-h-11 items-center gap-1 text-small text-muted hover:text-ink">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90"
                  />
                  Missing checkouts ({missing.length})
                </Collapsible.Trigger>
                <Collapsible.Panel>
                  <ul>{checkoutRows(missing)}</ul>
                </Collapsible.Panel>
              </Collapsible.Root>
            )}
            {entry.monitored ? (
              <Button
                size="sm"
                variant="quiet"
                className="mt-3 h-auto min-h-11 max-w-full whitespace-normal py-2 text-muted"
                data-repository-action="remove"
                data-id={entry.id}
                data-root={root}
                aria-label={`Remove ${entry.full_name}`}
                disabled={busy}
                onClick={() => change({ kind: "remove", id: entry.id })}
              >
                Stop monitoring
              </Button>
            ) : null}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
};

/** The directories scanned, and a form to scan another; open when nothing was found. */
const Scan = ({
  roots,
  warnings,
  open,
}: Pick<HomeSnapshot, "roots" | "warnings"> & { readonly open: boolean }) => {
  const [root, setRoot] = useAtom(rootAtom);
  const rescan = useAtomRefresh(homeAtom);
  const scan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("root");
    const next = typeof value === "string" ? value : "";
    // The same directory again scans it again.
    if (next === root) rescan();
    else setRoot(next);
  };
  return (
    <Collapsible.Root
      id="scan"
      defaultOpen={open}
      className="mt-4 scroll-mt-16"
    >
      <Collapsible.Trigger className="group flex min-h-11 items-center gap-1 text-left">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90"
        />
        <span>Scan directories</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="grid gap-3 py-2">
          {roots.length === 0 ? null : (
            <p className="text-small text-muted">
              Scanning <code className="wrap-anywhere">{roots.join(", ")}</code>
            </p>
          )}
          {/* Keyed by the directory, so going back in history shows the one scanned. */}
          <form
            key={root}
            className="flex flex-wrap items-end gap-2"
            onSubmit={scan}
          >
            <label className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1 text-small">
              Directory
              <input
                type="text"
                name="root"
                placeholder="Absolute directory path"
                defaultValue={root}
                className={FIELD}
              />
            </label>
            <Button type="submit" size="sm">
              Scan
            </Button>
          </form>
          <p className="text-small text-muted">
            Leave the directory empty to use the server's scan directories.
            Scans stop at repository roots, skip symlinks and hidden
            directories, and descend up to four levels.
          </p>
          {warnings.length === 0 ? null : (
            <ul className="text-small text-muted">
              {warnings.map((warning, at) => (
                // Warnings can repeat, and the list never reorders.
                <li key={at}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
};

export const Repositories = ({
  snapshot,
}: {
  readonly snapshot: HomeSnapshot;
}) => {
  const [query, setQuery] = useAtom(queryAtom);
  const filter = useAtomValue(filterAtom);
  // Same-page settings links must reveal their disclosure as well as scroll to it.
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  // The snapshot and an opened disclosure can both arrive after the browser looked for the hash's element.
  useEffect(landOnHash, [hash]);
  const [monitoring, change] = useAtom(monitoringAtom);
  const busy = useAtomValue(busyAtom);
  const refresh = useAtomRefresh(homeAtom);
  const rescan = () => {
    // A rescan starts afresh, as reloading the page did: the last change's refusal goes with the old lists.
    change(Atom.Reset);
    refresh();
  };
  const { repositories, reviews } = snapshot;
  const monitored = repositories.filter((entry) => entry.monitored);
  const discovered = repositories.filter((entry) => !entry.monitored);
  const search = query.trim().toLowerCase();
  const shownMonitored = monitored.filter((entry) =>
    matches(entry, search, filter),
  );
  const shownDiscovered = discovered.filter((entry) =>
    matches(entry, search, filter),
  );
  const shown = shownMonitored.length + shownDiscovered.length;
  const none = repositories.length === 0;
  const byId = new Map(reviews.map((item) => [item.id, item] as const));
  const error =
    monitoring._tag === "Failure" && !monitoring.waiting
      ? failureText(
          monitoring.cause,
          "Could not update monitoring. Refresh this page and try again.",
        )
      : "";
  const rows = (entries: ReadonlyArray<RepositoryEntry>) =>
    entries.map((entry) => (
      <RepositoryRow
        key={`${entry.id}:${search}:${Option.getOrUndefined(filter) ?? ""}`}
        entry={entry}
        roots={snapshot.roots}
        reviews={reviews}
        byId={byId}
        busy={busy}
        change={change}
        search={search}
        filter={filter}
      />
    ));
  return (
    <section aria-labelledby="repositories-title" data-repositories="">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="repositories-title" className="text-heading font-semibold">
          Repositories
        </h2>
        <span className="text-small text-muted">
          {monitored.length} monitored
        </span>
        <label className="ml-auto min-w-0 flex-[0_1_19rem]">
          <span className="sr-only">Filter repositories</span>
          <input
            type="search"
            placeholder="Filter by name, path, or branch"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className={FIELD}
          />
        </label>
        <Button
          size="sm"
          className="text-muted hover:text-ink"
          disabled={busy}
          onClick={rescan}
        >
          Rescan
        </Button>
      </div>
      <p className="sr-only" role="status">
        {shown} of {repositories.length} repositories shown
      </p>
      <p className="mb-2 text-danger empty:hidden" role="alert">
        {error}
      </p>
      {shown > 0 || none ? null : (
        <p className="text-muted">No repositories match this filter.</p>
      )}
      {none ? (
        <p className="text-muted">
          No repositories found. Scan a directory below.
        </p>
      ) : null}
      {/* The blocks keep their IDs whatever they hold, so a link to one lands. */}
      <div id="monitored" className="scroll-mt-16">
        {monitored.length === 0 ? (
          none ? null : (
            <p className="text-muted">
              No monitored repositories. Add one below.
            </p>
          )
        ) : shownMonitored.length === 0 ? null : (
          <ul
            className="divide-y divide-separator"
            aria-label="Monitored repositories"
          >
            {rows(shownMonitored)}
          </ul>
        )}
      </div>
      {none ? (
        <div id="found" className="scroll-mt-16" />
      ) : (
        <Collapsible.Root
          id="found"
          key={`${search}:${Option.getOrUndefined(filter) ?? ""}:${hash}`}
          defaultOpen={
            monitored.length === 0 ||
            search !== "" ||
            Option.contains(filter, "discovered") ||
            hash === "#found"
          }
          className="mt-6 scroll-mt-16"
        >
          <Collapsible.Trigger
            aria-label="Add repository"
            className="group flex min-h-11 max-w-full flex-wrap items-center gap-x-2 text-small font-semibold"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90"
            />
            Add repository
            <span className="font-normal text-muted">
              {discovered.length} available
            </span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            {shownDiscovered.length === 0 ? (
              <p className="text-muted">
                {discovered.length === 0
                  ? "Every repository found is monitored."
                  : "None match this filter."}
              </p>
            ) : (
              <ul
                className="divide-y divide-separator"
                aria-label="Available repositories"
              >
                {rows(shownDiscovered)}
              </ul>
            )}
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      <Scan
        key={hash}
        roots={snapshot.roots}
        warnings={snapshot.warnings}
        open={none || hash === "#scan"}
      />
    </section>
  );
};
