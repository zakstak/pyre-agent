import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useRef } from "react";
import { useFreshness, usePreference } from "../preferences.ts";
import { parsePullRequest } from "../../schema/forge-url.ts";
import type {
  OpenPullRequest,
  PullScope,
  RepositoryPullRequests as PullSnapshot,
} from "../../schema/pull-requests.ts";
import type {
  HomeSnapshot,
  RepositoryEntry,
  ReviewSummary,
} from "../../schema/rpc.ts";
import { type Target, pullRequestKey } from "../../schema/target.ts";
import { pullRequestStacks, type StackLayer } from "../../review/stacks.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FIELD } from "../ui/field.ts";
import { homeAtom, repositoryPullRequestsAtom, pullListKey } from "./data.ts";

const number = (pull: OpenPullRequest) => {
  const address = parsePullRequest(pull.url);
  return `${address?.provider === "gitlab" ? "!" : "#"}${address?.number ?? ""}`;
};

const Layer = ({
  layer,
  reviews,
  current,
  repository,
}: {
  readonly layer: StackLayer;
  readonly repository: RepositoryEntry;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly current?: string | undefined;
}) => {
  const { pull, parent, depth } = layer;
  const review = reviews.find(
    (item) =>
      item.closed_at === undefined &&
      item.target.kind !== "worktree" &&
      pullRequestKey(item.target.url) === pullRequestKey(pull.url),
  );
  return (
    <li
      className="border-l border-separator py-2 pl-4"
      style={{ marginInlineStart: `${Math.min(depth, 4)}rem` }}
      aria-current={current === pullRequestKey(pull.url) ? "page" : undefined}
    >
      <a
        className={cn(TOUCH_TARGET, "font-semibold hover:underline")}
        href={
          review === undefined
            ? `/pulls?${new URLSearchParams({ repo: repository.id, url: pull.url })}`
            : `/reviews/${review.id}`
        }
      >
        {number(pull)} {pull.title}
      </a>
      <p className="text-small text-muted wrap-anywhere">
        {pull.head_branch} → {pull.base_branch}
        {parent === undefined ? null : ` · Depends on ${number(parent)}`}
        {review === undefined ? " · No local review" : " · Review available"}
        {current === pullRequestKey(pull.url) ? " · Current PR" : null}
        {review === undefined ? null : (
          <>
            {" "}
            ·{" "}
            <a href={pull.url} className="underline">
              Open PR
            </a>
          </>
        )}
      </p>
    </li>
  );
};

const RepositoryPullRequests = ({
  repository,
  reviews,
  current,
  scope = "all",
  query = "",
}: {
  readonly scope?: PullScope;
  readonly query?: string;
  readonly repository: RepositoryEntry;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly current?: string | undefined;
}) => {
  const atom = repositoryPullRequestsAtom(pullListKey(repository.id, scope));
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useFreshness(refresh, result.waiting);
  const lastReady = useRef<PullSnapshot | undefined>(undefined);
  const latest = Option.getOrUndefined(AsyncResult.value(result));
  if (latest?.kind === "ready") lastReady.current = latest;
  const snapshot = latest?.kind === "ready" ? latest : lastReady.current;
  const value = Option.fromNullishOr(snapshot);

  return (
    <div role="group" aria-label={repository.full_name}>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-small text-muted">{repository.full_name}</span>
        <Button
          size="sm"
          variant="quiet"
          disabled={result.waiting}
          onClick={refresh}
        >
          Refresh PRs
        </Button>
      </div>
      {result.waiting ? (
        <p role="status" className="text-small text-muted">
          Loading open PRs…
        </p>
      ) : null}
      {latest?.kind === "unavailable" ? (
        <p role="alert">
          {latest.message}
          {snapshot === undefined ? "" : " Showing the last successful list."}
        </p>
      ) : null}
      {snapshot?.kind === "ready" && snapshot.fetched_at ? (
        <p className="text-small text-muted">
          Updated {new Date(snapshot.fetched_at).toLocaleTimeString()} ·
          refreshes every minute while visible
        </p>
      ) : null}
      {AsyncResult.isFailure(result) ? (
        <p role="alert">Could not load PRs. Retry with Refresh PRs.</p>
      ) : null}
      {Option.match(value, {
        onNone: () => null,
        onSome: (snapshot) => {
          if (snapshot.kind === "unavailable")
            return (
              <p role="alert" className="text-small text-muted">
                {snapshot.message}
              </p>
            );
          const stacks = pullRequestStacks(snapshot.items).filter(
            (layers) =>
              (query === "" ||
                layers.some((layer) =>
                  `${number(layer.pull)} ${layer.pull.title} ${layer.pull.head_branch}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )) &&
              (current === undefined ||
                layers.some(
                  (layer) => pullRequestKey(layer.pull.url) === current,
                )),
          );
          if (stacks.length === 0)
            return (
              <p className="text-small text-muted">
                {current === undefined
                  ? query !== ""
                    ? "No matching PRs."
                    : scope === "requested"
                      ? "No PRs requesting your review."
                      : "No open PRs."
                  : "This PR is no longer in the open PR list."}
              </p>
            );
          return (
            <div className="space-y-4">
              {stacks.map((layers, index) => (
                <div key={index} data-pr-stack="">
                  {layers.length > 1 ? (
                    <p className="mb-1 text-small font-semibold">
                      Stack · {layers.length} PRs · Base first
                    </p>
                  ) : null}
                  <ol>
                    {layers.map((layer) => (
                      <Layer
                        key={layer.pull.url}
                        layer={layer}
                        repository={repository}
                        reviews={reviews}
                        current={current}
                      />
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          );
        },
      })}
    </div>
  );
};

export const PullRequests = ({ home }: { readonly home: HomeSnapshot }) => {
  const repositories = home.repositories.filter(
    (repository) =>
      repository.monitored && repository.identity.kind === "remote",
  );
  const [selected, setSelected] = usePreference("pr-repo", "all");
  const [storedScope, setScope] = usePreference("pr-scope", "all");
  const scope = storedScope === "requested" ? "requested" : "all";
  const [query, setQuery] = usePreference("pr-query", "");
  const visible =
    selected === "all"
      ? repositories
      : repositories.filter((item) => item.id === selected);
  const repository = repositories[0];
  return (
    <section aria-label="Open pull requests" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold">Open pull requests</h1>
        {repository === undefined ? null : (
          <select
            aria-label="PR repository"
            className={cn(FIELD, "max-w-full")}
            value={selected}
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            <option value="all">All monitored repositories</option>
            {repositories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.full_name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="PR inbox"
          className={FIELD}
          value={scope}
          onChange={(event) => setScope(event.currentTarget.value)}
        >
          <option value="all">All open PRs</option>
          <option value="requested">Needs my review</option>
        </select>
        <input
          aria-label="Search PRs"
          className={FIELD}
          placeholder="Search PRs"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {repository === undefined ? (
        <p className="text-muted">
          <a href="/settings/repositories" className="underline">
            Monitor a repository
          </a>{" "}
          to see its open PRs.
        </p>
      ) : (
        <div className="space-y-6">
          {visible.map((item) => (
            <RepositoryPullRequests
              key={`${item.id}:${scope}`}
              repository={item}
              reviews={home.reviews}
              scope={scope}
              query={query}
            />
          ))}
          {visible.length === 0 ? (
            <p>
              The saved repository is no longer monitored. Choose All monitored
              repositories.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
};

/** The same base-to-tip navigation stays visible while reviewing one layer. */
export const ReviewStack = ({ target }: { readonly target: Target }) => {
  const result = useAtomValue(homeAtom);
  const home = AsyncResult.value(result);
  if (target.kind === "worktree" || home._tag === "None") return null;
  const address = parsePullRequest(target.url);
  const repository = home.value.repositories.find(
    (item) =>
      item.monitored &&
      item.identity.kind === "remote" &&
      (address?.provider === "github"
        ? item.identity.address.toLowerCase() ===
          `${address.host}/${address.repository}`.toLowerCase()
        : item.identity.address === `${address?.host}/${address?.repository}`),
  );
  return repository === undefined ? null : (
    <nav aria-label="PR stack" className="my-6">
      <RepositoryPullRequests
        repository={repository}
        reviews={home.value.reviews}
        current={pullRequestKey(target.url)}
      />
    </nav>
  );
};
