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
    const candidates = unique.filter(
      (other) =>
        other !== pull &&
        other.same_repository &&
        other.head_branch === pull.base_branch,
    );
    const [parent] = candidates;
    if (parent !== undefined && candidates.length === 1)
      parents.set(pull, parent);
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
