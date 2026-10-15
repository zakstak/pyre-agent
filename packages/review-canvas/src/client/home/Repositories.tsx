/**
 * The repositories on this machine: the monitored ones, each a heading over a small table of its checkouts, then
 * those found but not monitored, then the scan form. One search field narrows them by name, path, or branch; an
 * older link's `filter` still narrows them, with no control for it. Rescan reads them all again.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { ChevronRight, CircleAlert, ClipboardCheck, FileDiff, GitBranch, GitPullRequest } from "lucide-react";
import { Atom } from "effect/reactivity";
import { type FormEvent, useEffect } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type { Checkout, CheckoutStatus, HomeSnapshot, RepositoryEntry, ReviewSummary } from "../../schema/rpc.ts";
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
const stateOf = (status: CheckoutStatus): "changed" | "clean" | "unavailable" =>
  status.kind === "ready" ? (status.changed > 0 ? "changed" : "clean") : "unavailable";

/** A repository's states: each monitored checkout's, or `discovered`. */
const statesOf = (entry: RepositoryEntry): ReadonlyArray<string> =>
  entry.monitored
    ? [...new Set(entry.checkouts.flatMap((checkout) => (checkout.status === undefined ? [] : [stateOf(checkout.status)])))]
    : ["discovered"];

/** Whether a repository matches the search text, lowercased, by name, path, or branch, and the link's filter. */
const matches = (entry: RepositoryEntry, query: string, filter: Option.Option<Filter>): boolean => {
  const branches = entry.monitored
    ? entry.checkouts
        .map((checkout) => (checkout.status?.kind === "ready" ? (checkout.status.branch ?? "detached") : ""))
        .join(" ")
    : "";
  const text = `${entry.full_name} ${entry.checkouts.map((checkout) => checkout.root).join(" ")} ${branches}`;
  return (
    text.toLowerCase().includes(query) &&
    Option.match(filter, {
      onNone: () => true,
      onSome: (kind) => kind === (entry.monitored ? "monitored" : "discovered") || statesOf(entry).includes(kind),
    })
  );
};

/** The word a checkout row shows for why it is unavailable; the full message is its title. */
const unavailableWord = (reason: string): string =>
  reason === "directory missing" ? "missing" : reason === "status unreadable" ? "unreadable" : reason;

/** Review titles in one title attribute. */
const titles = (reviews: ReadonlyArray<ReviewSummary>): string => reviews.map((item) => item.target.title).join(" · ");

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
      <Stat icon={FileDiff} tone="warning" title={`${count(status.changed, "file")} changed`}>
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
  const branch = status?.kind === "ready" ? (status.branch ?? undefined) : undefined;
  return (
    <li
      data-checkout=""
      className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] items-center gap-x-4 md:h-7 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-1"
    >
      {/* A found repository's checkouts have no status to show: the path takes the branch's column too. */}
      {status === undefined ? null : (
        <span className="flex min-w-0 items-center gap-1.5" title={branch}>
          <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
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
          status === undefined ? "col-span-2 max-md:col-span-1" : "max-md:col-span-2 max-md:row-start-2",
        )}
        title={checkout.root}
      >
        {underRoot(checkout.shown, roots)}
      </code>
      <CheckoutStats
        status={status}
        reviews={reviews.filter((item) => item.target.kind === "worktree" && item.target.root === checkout.root)}
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
}: {
  readonly entry: RepositoryEntry;
  readonly roots: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly byId: ReadonlyMap<ReviewId, ReviewSummary>;
  readonly busy: boolean;
  readonly change: (change: MonitoringChange) => void;
}) => {
  const root = entry.checkouts[0].root;
  const pullRequests = entry.pull_requests.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  return (
    <li
      data-repository=""
      data-monitoring={entry.monitored ? "monitored" : "discovered"}
      className="group py-3"
    >
      <div className="flex items-center gap-x-2.5">
        <h3 className="min-w-0 text-reading font-semibold wrap-anywhere" title={entry.full_name}>
          {entry.name}
          {entry.host === "" ? null : (
            <>
              {" "}
              <span className="ml-1 text-small font-normal text-muted">{entry.host}</span>
            </>
          )}
        </h3>
        {pullRequests.length === 0 ? null : (
          <Stat icon={GitPullRequest} title={titles(pullRequests)} className="shrink-0">
            {pullRequests.length}
          </Stat>
        )}
        <Button
          size="sm"
          className={cn(
            "ml-auto shrink-0",
            entry.monitored &&
              "text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
          data-repository-action={entry.monitored ? "remove" : "accept"}
          data-id={entry.id}
          data-root={root}
          aria-label={`${entry.monitored ? "Remove" : "Monitor"} ${entry.full_name}`}
          disabled={busy}
          onClick={() =>
            change(entry.monitored ? { kind: "remove", id: entry.id } : { kind: "accept", id: entry.id, root })
          }
        >
          {entry.monitored ? "Remove" : "Monitor"}
        </Button>
      </div>
      <ul className="mt-1 pl-4">
        {entry.checkouts.map((checkout) => (
          <CheckoutLine key={checkout.root} checkout={checkout} roots={roots} reviews={reviews} />
        ))}
      </ul>
    </li>
  );
};

/** The directories scanned, and a form to scan another; open when nothing was found. */
const Scan = ({ roots, warnings, open }: Pick<HomeSnapshot, "roots" | "warnings"> & { readonly open: boolean }) => {
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
    <Collapsible.Root id="scan" defaultOpen={open} className="mt-4 scroll-mt-16">
      <Collapsible.Trigger className="group flex items-center gap-1 text-left">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <span>
          Scan directories
          {roots.length === 0 ? null : (
            <>
              {" · "}
              <code className="text-muted wrap-anywhere">{roots.join(", ")}</code>
            </>
          )}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="grid gap-3 py-2">
          {/* Keyed by the directory, so going back in history shows the one scanned. */}
          <form key={root} className="flex flex-wrap items-end gap-2" onSubmit={scan}>
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
            Leave the directory empty to use the server's scan directories. Scans stop at repository roots, skip
            symlinks and hidden directories, and descend up to four levels.
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

export const Repositories = ({ snapshot }: { readonly snapshot: HomeSnapshot }) => {
  const [query, setQuery] = useAtom(queryAtom);
  const filter = useAtomValue(filterAtom);
  // The section renders once the snapshot has arrived, after the browser looked for the hash's element.
  useEffect(landOnHash, []);
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
  const shownMonitored = monitored.filter((entry) => matches(entry, search, filter));
  const shownDiscovered = discovered.filter((entry) => matches(entry, search, filter));
  const shown = shownMonitored.length + shownDiscovered.length;
  const checkouts = monitored.reduce((sum, entry) => sum + entry.checkouts.length, 0);
  const none = repositories.length === 0;
  const byId = new Map(reviews.map((item) => [item.id, item] as const));
  const error =
    monitoring._tag === "Failure" && !monitoring.waiting
      ? failureText(monitoring.cause, "Could not update monitoring. Refresh this page and try again.")
      : "";
  const rows = (entries: ReadonlyArray<RepositoryEntry>) =>
    entries.map((entry) => (
      <RepositoryRow key={entry.id} entry={entry} roots={snapshot.roots} reviews={reviews} byId={byId} busy={busy} change={change} />
    ));
  return (
    <section aria-labelledby="repositories-title" data-repositories="">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="repositories-title" className="text-heading font-semibold">
          Repositories
        </h2>
        <span className="text-small text-muted">
          <span>{monitored.length} monitored</span> · <span>{count(checkouts, "checkout")}</span>
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
        <Button size="sm" className="text-muted hover:text-ink" disabled={busy} onClick={rescan}>
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
        <p className="text-muted">
          No repositories match this filter.
        </p>
      )}
      {none ? <p className="text-muted">No repositories found. Scan a directory below.</p> : null}
      {/* The blocks keep their IDs whatever they hold, so a link to one lands. */}
      <div id="monitored" className="scroll-mt-16">
        {monitored.length === 0 ? (
          none ? null : (
            <p className="text-muted">None monitored yet. Monitor one of those found below.</p>
          )
        ) : shownMonitored.length === 0 ? null : (
          <ul aria-label="Monitored repositories">{rows(shownMonitored)}</ul>
        )}
      </div>
      {none ? null : (
      <div id="found" className="mt-6 scroll-mt-16">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h3 id="found-title" className="text-reading font-semibold">
            Found, not monitored
          </h3>
          <span className="text-small text-muted">{discovered.length}</span>
        </div>
        {shownDiscovered.length === 0 ? (
          <p className="text-muted">{discovered.length === 0 ? "Every repository found is monitored." : "None match this filter."}</p>
        ) : (
          <ul aria-labelledby="found-title">{rows(shownDiscovered)}</ul>
        )}
      </div>
      )}
      <Scan roots={snapshot.roots} warnings={snapshot.warnings} open={none} />
    </section>
  );
};
