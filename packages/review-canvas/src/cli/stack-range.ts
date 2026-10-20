import type { ComparisonRequest } from "../schema/pull-requests.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import { stackAncestors } from "../review/stacks.ts";
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
