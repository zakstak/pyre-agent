import type { PullRequestUrl } from "../schema/primitives.ts";
import type { OpenPullRequest } from "../schema/pull-requests.ts";
import { pullRequestKey } from "../schema/target.ts";

export interface StackLayer {
  readonly pull: OpenPullRequest;
  readonly depth: number;
  readonly parent: OpenPullRequest | undefined;
}

/** Branch names imply a dependency only when exactly one PR supplies that branch in the target repository. */
export const pullRequestStacks = (
  items: ReadonlyArray<OpenPullRequest>,
): ReadonlyArray<ReadonlyArray<StackLayer>> => {
  const unique = [
    ...new Map(items.map((pull) => [pullRequestKey(pull.url), pull])).values(),
  ];
  const parents = new Map<OpenPullRequest, OpenPullRequest>();
  for (const pull of unique) {
    // Most recent historical base wins. Reused branch names remain ambiguous.
    const branches =
      pull.history === undefined
        ? [pull.base_branch]
        : pull.history.timeline_complete
          ? pull.history.base_branches.filter(
              (branch) => branch !== pull.history?.default_branch,
            )
          : [];
    for (const branch of branches) {
      const candidates = unique.filter(
        (other) =>
          other !== pull &&
          other.same_repository &&
          other.head_branch === branch,
      );
      if (candidates.length === 0) continue;
      const [parent] = candidates;
      if (parent !== undefined && candidates.length === 1)
        parents.set(pull, parent);
      break;
    }
  }
  // Corrupt or transitional host data must never make a cyclic stack, or hide its PRs.
  for (const pull of unique) {
    const seen = new Set<OpenPullRequest>();
    let current: OpenPullRequest | undefined = pull;
    while (current !== undefined) {
      if (seen.has(current)) {
        for (const member of seen) parents.delete(member);
        break;
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  const children = new Map<OpenPullRequest, Array<OpenPullRequest>>();
  for (const [child, parent] of parents)
    children.set(parent, [...(children.get(parent) ?? []), child]);
  return unique
    .filter((pull) => !parents.has(pull))
    .map((root) => {
      const layers: Array<StackLayer> = [];
      const pending = [{ pull: root, depth: 0 }];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        layers.push({ ...next, parent: parents.get(next.pull) });
        for (const child of (children.get(next.pull) ?? []).toReversed())
          pending.push({ pull: child, depth: next.depth + 1 });
      }
      return layers;
    });
};

/** Only the selected tip's ancestors participate; sibling branches never enter a cumulative diff. */
export const stackAncestors = (
  items: ReadonlyArray<OpenPullRequest>,
  url: PullRequestUrl,
): ReadonlyArray<OpenPullRequest> => {
  const stack = pullRequestStacks(items).find((layers) =>
    layers.some(
      (layer) => pullRequestKey(layer.pull.url) === pullRequestKey(url),
    ),
  );
  let layer = stack?.find(
    (layer) => pullRequestKey(layer.pull.url) === pullRequestKey(url),
  );
  const chain: OpenPullRequest[] = [];
  while (layer !== undefined) {
    chain.unshift(layer.pull);
    const parent = layer.parent;
    layer =
      parent === undefined
        ? undefined
        : stack?.find((item) => item.pull === parent);
  }
  return chain;
};
