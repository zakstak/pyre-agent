import type { ComparisonRequest } from "../schema/pull-requests.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import { stackAncestors } from "../review/stacks.ts";
import { stackPath } from "../review/stack-walk.ts";
import {
  addressOf,
  readOpenPullRequests,
  readPullRequest,
  type ForgeClients,
} from "./hosted.ts";
import { readHistoricalPullRequests } from "./pull-history.ts";

/** Resolve URLs on the bound host; the browser never supplies commit IDs or Git refs. */
export const stackRange = (
  url: PullRequestUrl,
  request: ComparisonRequest,
  clients: ForgeClients,
) => {
  const address = addressOf(url);
  const items = request.historical
    ? readHistoricalPullRequests(address, clients)
    : readOpenPullRequests(address, clients);
  const chain = stackAncestors(items, url);
  const selected = chain.at(-1);
  if (selected === undefined)
    throw new Error(
      "This PR is absent from the selected PR list. Use stack history for merged or closed PRs.",
    );
  const relevant = request.mode === "layer" ? chain.slice(-2) : chain;
  const views = relevant.map((pull) => ({
    pull,
    view: readPullRequest(pull.url, clients),
  }));
  for (const { pull, view } of views) {
    if (!request.historical && view.baseRefName !== pull.base_branch)
      throw new Error(
        "A stack base branch changed while loading. Refresh before comparing.",
      );
    if (
      pull.history !== undefined &&
      (view.headRefOid !== pull.history.head_sha ||
        view.baseRefOid !== pull.history.base_sha)
    )
      throw new Error(
        "The PR changed while loading its history. Refresh before comparing.",
      );
    if (pull.history?.timeline_complete === false)
      throw new Error(
        "Base-change history is truncated; this stack cannot be reconstructed safely.",
      );
  }
  const first = views[0];
  const last = views.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("No stack range is available.");
  if (relevant.length === 1 || request.mode === "cumulative") {
    const history = first.pull.history;
    if (
      history !== undefined &&
      history.base_branches.some((branch) => branch !== history.default_branch)
    )
      throw new Error(
        "The stack's root dependency is missing or ambiguous. A cumulative base cannot be reconstructed safely.",
      );
  }
  // For a layer, the immediate parent's retained head is the base. Cumulative starts at the root PR's recorded base.
  const base =
    request.mode === "layer" && views.length > 1
      ? first.view.headRefOid
      : first.view.baseRefOid;
  return { base, head: last.view.headRefOid, selected: last.view, views };
};

/**
 * The tip's ancestor path as the host shows it now, with each layer's head, and the other PRs of its stack, which a
 * walkthrough leaves out. A historical path uses each PR's final retained head and needs complete base-change history.
 */
export const hostStackPath = (
  tip: PullRequestUrl,
  historical: boolean,
  clients: ForgeClients,
) => {
  const address = addressOf(tip);
  const items = historical
    ? readHistoricalPullRequests(address, clients)
    : readOpenPullRequests(address, clients);
  const found = stackPath(items, tip);
  if (found === undefined)
    throw new Error(
      historical
        ? "The tip is absent from the repository's PR history."
        : "The tip is not an open PR. Use --history for merged or closed stacks.",
    );
  const path = found.path.map((pull) => {
    if (pull.history !== undefined) {
      if (!pull.history.timeline_complete)
        throw new Error(
          `Base-change history of ${pull.url} is truncated; this stack cannot be reconstructed safely.`,
        );
      return {
        url: pull.url,
        title: pull.title,
        head_sha: pull.history.head_sha,
      };
    }
    const view = readPullRequest(pull.url, clients);
    if (view.baseRefName !== pull.base_branch)
      throw new Error(
        "A stack base branch changed while loading. Run the command again.",
      );
    return { url: pull.url, title: view.title, head_sha: view.headRefOid };
  });
  return {
    path,
    excluded: found.excluded.map((pull) => ({
      url: pull.url,
      title: pull.title,
    })),
  };
};
