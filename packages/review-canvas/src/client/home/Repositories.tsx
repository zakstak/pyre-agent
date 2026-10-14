/**
 * The repositories on this machine: the monitored ones with each checkout's branch and state and their reviews, then
 * those found but not monitored, then the scan form. One search field narrows them by name, path, or branch; an
 * older link's `filter` still narrows them, with no control for it.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { ChevronRight } from "lucide-react";
import type { FormEvent } from "react";
import type { ReviewId } from "../../schema/primitives.ts";
import type { Checkout, CheckoutStatus, HomeSnapshot, RepositoryEntry, ReviewSummary } from "../../schema/rpc.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
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
import { count, targetName } from "../names.ts";

const FIELD =
  "min-h-11 w-full rounded-control border border-line bg-raised px-2.5 text-small text-ink placeholder:text-muted";

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

/** A checkout's state in a few words, coloured only when it needs a look. */
const CheckoutState = ({ status }: { readonly status: CheckoutStatus }) => {
  const place = "ml-auto whitespace-nowrap text-small max-md:ml-0 max-md:whitespace-normal";
  if (status.kind === "unavailable")
    return (
      <span className={cn(place, "text-danger")} title={status.message}>
        unavailable · {status.reason}
      </span>
    );
  const branch = status.branch ?? "detached";
  return status.changed > 0 ? (
    <span className={cn(place, "text-warning")}>
      {branch} · {status.changed} changed
    </span>
  ) : (
    <span className={cn(place, "text-muted")}>{branch} · clean</span>
  );
};

const ReviewLinks = ({
  reviews,
  label,
}: {
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly label?: string;
}) =>
  reviews.length === 0 ? null : (
    <ul aria-label={label} className="pl-4 text-small">
      {reviews.map((item) => {
        const name = targetName(item.target);
        return (
          <li key={item.id} data-repository-review="">
            <a href={`/reviews/${item.id}`} className="inline-flex min-h-11 items-center text-link underline">
              {item.target.title}
            </a>{" "}
            <span className="text-muted">
              {name.kind === "pr" ? `${name.number} · ` : ""}
              {item.closed_at !== undefined ? "closed" : item.round === undefined ? "waiting" : `round ${item.round}`}
            </span>
          </li>
        );
      })}
    </ul>
  );

const CheckoutLine = ({
  checkout,
  reviews,
}: {
  readonly checkout: Checkout;
  readonly reviews: ReadonlyArray<ReviewSummary>;
}) => (
  <li data-checkout="">
    <div className="flex flex-wrap items-baseline gap-x-4">
      <code className="min-w-0 wrap-anywhere" title={checkout.root}>
        {checkout.shown}
      </code>
      {checkout.status === undefined ? null : <CheckoutState status={checkout.status} />}
    </div>
    <ReviewLinks
      reviews={reviews.filter((item) => item.target.kind === "worktree" && item.target.root === checkout.root)}
    />
  </li>
);

const RepositoryRow = ({
  entry,
  reviews,
  byId,
  busy,
  change,
}: {
  readonly entry: RepositoryEntry;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly byId: ReadonlyMap<ReviewId, ReviewSummary>;
  readonly busy: boolean;
  readonly change: (change: MonitoringChange) => void;
}) => {
  const root = entry.checkouts[0].root;
  return (
    <li
      data-repository=""
      data-monitoring={entry.monitored ? "monitored" : "discovered"}
      className="px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="min-w-0 text-reading font-semibold wrap-anywhere" title={entry.full_name}>
          {entry.name}
          {entry.host === "" ? null : (
            <>
              {" "}
              <code className="ml-1.5 font-normal text-muted">{entry.host}</code>
            </>
          )}
        </h3>
        <Button
          size="sm"
          className={cn("ml-auto", entry.monitored && "text-muted hover:text-ink")}
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
      <ul className="mt-2">
        {entry.checkouts.map((checkout) => (
          <CheckoutLine key={checkout.root} checkout={checkout} reviews={reviews} />
        ))}
      </ul>
      <ReviewLinks
        label="Pull request reviews"
        reviews={entry.pull_requests.flatMap((id) => {
          const item = byId.get(id);
          return item === undefined ? [] : [item];
        })}
      />
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
    <Collapsible.Root defaultOpen={open} className="mt-4">
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
            <Button type="submit">Scan</Button>
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
  const [monitoring, change] = useAtom(monitoringAtom);
  const busy = useAtomValue(busyAtom);
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
      <RepositoryRow key={entry.id} entry={entry} reviews={reviews} byId={byId} busy={busy} change={change} />
    ));
  const list = "divide-y divide-separator rounded-control border border-separator bg-surface";
  return (
    <section aria-labelledby="repositories-title" data-repositories="" className="mt-9">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
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
      {monitored.length === 0 ? (
        none ? null : (
          <p className="text-muted">None monitored yet. Monitor one of those found below.</p>
        )
      ) : shownMonitored.length === 0 ? null : (
        <ul aria-label="Monitored repositories" className={list}>
          {rows(shownMonitored)}
        </ul>
      )}
      {shownDiscovered.length === 0 ? null : (
        <>
          <div className="mt-6 mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h2 id="found-title" className="text-heading font-semibold">
              Found, not monitored
            </h2>
            <span className="text-small text-muted">{discovered.length}</span>
          </div>
          <ul aria-labelledby="found-title" className={list}>
            {rows(shownDiscovered)}
          </ul>
        </>
      )}
      <Scan roots={snapshot.roots} warnings={snapshot.warnings} open={none} />
    </section>
  );
};
