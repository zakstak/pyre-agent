import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import { parseForgeComment, parsePullRequest } from "./forge-url.ts";
import {
  CommitSha,
  Count,
  type GitHubCommentUrl,
  nonEmptyText,
  PullRequestUrl,
  WorktreeRoot,
} from "./primitives.ts";

const Title = nonEmptyText(Limits.MAX_TEXT_UNITS);

/** A GitHub pull request, pinned to its head commit so comments anchor to one version of its diff. */
const pullRequestFields = {
  title: Title,
  url: PullRequestUrl,
  head_sha: CommitSha,
  base_sha: Schema.optionalKey(CommitSha),
  /** The changed-file count GitHub reports. */
  changed_files: Schema.optionalKey(Count),
};
/** Retain the original discriminator for saved GitHub reviews. New providers name their API explicitly. */
const GitHubTarget = Schema.Struct({
  kind: Schema.Literal("github_pr"),
  ...pullRequestFields,
}).check(
  Schema.makeFilter(
    (target) =>
      parsePullRequest(target.url)?.provider === "github" ||
      "github_pr requires a GitHub pull request URL",
  ),
);
const HostedTarget = Schema.Struct({
  kind: Schema.Literal("pull_request"),
  provider: Schema.Literals(["github", "gitlab", "gitea"]),
  ...pullRequestFields,
}).check(
  Schema.makeFilter(
    (target) =>
      parsePullRequest(target.url)?.provider === target.provider ||
      "provider does not match the pull request URL",
  ),
);
export const PullRequestTarget = Schema.Union([GitHubTarget, HostedTarget]);
export type PullRequestTarget = typeof PullRequestTarget.Type;

/** The uncommitted changes in a local working tree, compared with its HEAD commit. */
export const WorktreeTarget = Schema.Struct({
  kind: Schema.Literal("worktree"),
  title: Title,
  root: WorktreeRoot,
  head_sha: CommitSha,
  /** The checked-out branch, absent for a detached HEAD. */
  branch: Schema.optionalKey(nonEmptyText(Limits.MAX_BRANCH_UNITS)),
  changed_files: Schema.optionalKey(Count),
});
export type WorktreeTarget = typeof WorktreeTarget.Type;

/** What a review covers. */
export const Target = Schema.Union([
  GitHubTarget,
  HostedTarget,
  WorktreeTarget,
]).annotate({
  expected: "a target whose kind is github_pr, pull_request, or worktree",
});
export type Target = typeof Target.Type;

/**
 * A pull request's identity, from its URL or a comment's: the URL without its fragment, lowercased. GitHub ignores
 * the case of owner and repository names, and the URL schemas allow letters nowhere else, so two spellings of one
 * pull request share a key. Values keep GitHub's spelling for links and display; compare them only through this key.
 */
export const pullRequestKey = (
  url: PullRequestUrl | GitHubCommentUrl,
): string => {
  const pull = parsePullRequest(url) ?? parseForgeComment(url);
  if (pull === undefined)
    throw new Error("Validated pull request URL required");
  return pull.provider === "github" ? pull.url.toLowerCase() : pull.url;
};

/** A target's identity, which keys its reviews: the pull request's key, or the working tree's root. */
export const targetKey = (target: Target): string => {
  switch (target.kind) {
    case "github_pr":
      return `github_pr:${pullRequestKey(target.url)}`;
    case "pull_request":
      return `${target.provider === "github" ? "github_pr" : "pull_request"}:${pullRequestKey(target.url)}`;
    case "worktree":
      return `worktree:${target.root}`;
  }
};

/** Two targets belong to the same review when they name the same pull request, or the same working tree root. */
export const sameTarget = (a: Target, b: Target): boolean =>
  targetKey(a) === targetKey(b);
