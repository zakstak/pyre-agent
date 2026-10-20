import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { parsePullRequest } from "../../schema/forge-url.ts";
import type { OpenPullRequest } from "../../schema/pull-requests.ts";
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
import { homeAtom, repositoryPullRequestsAtom } from "./data.ts";

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
}: {
  readonly repository: RepositoryEntry;
  readonly reviews: ReadonlyArray<ReviewSummary>;
  readonly current?: string | undefined;
}) => {
  const atom = repositoryPullRequestsAtom(repository.id);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const value = AsyncResult.value(result);
  return (
    <div>
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
              current === undefined ||
              layers.some(
                (layer) => pullRequestKey(layer.pull.url) === current,
              ),
          );
          if (stacks.length === 0)
            return (
              <p className="text-small text-muted">
                {current === undefined
                  ? "No open PRs."
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
  const [selected, setSelected] = useState("");
  const repository =
    repositories.find((item) => item.id === selected) ?? repositories[0];
  return (
    <section aria-label="Open pull requests" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold">Open pull requests</h1>
        {repository === undefined ? null : (
          <select
            aria-label="PR repository"
            className={cn(FIELD, "max-w-full")}
            value={repository.id}
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            {repositories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.full_name}
              </option>
            ))}
          </select>
        )}
      </div>
      {repository === undefined ? (
        <p className="text-muted">
          <a href="/settings/repositories" className="underline">
            Monitor a repository
          </a>{" "}
          to see its open PRs.
        </p>
      ) : (
        <RepositoryPullRequests
          key={repository.id}
          repository={repository}
          reviews={home.reviews}
        />
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
