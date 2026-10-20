import * as Schema from "effect/Schema";
import { CommitSha, nonEmptyText, PullRequestUrl } from "./primitives.ts";
import { ReviewInput } from "./input.ts";

export const PullScope = Schema.Literals(["all", "requested", "history"]);
export type PullScope = typeof PullScope.Type;

export const ComparisonMode = Schema.Literals(["host", "layer", "cumulative"]);
export type ComparisonMode = typeof ComparisonMode.Type;
export const ComparisonRequest = Schema.Struct({
  mode: ComparisonMode,
  historical: Schema.Boolean,
});
export type ComparisonRequest = typeof ComparisonRequest.Type;

/** Repository PRs exist independently of locally registered reviews. */
export const OpenPullRequest = Schema.Struct({
  url: PullRequestUrl,
  title: Schema.String,
  base_branch: nonEmptyText(1024),
  head_branch: nonEmptyText(1024),
  /** False when the source repository is deleted or differs from the target repository. */
  same_repository: Schema.Boolean,
  history: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
      base_sha: CommitSha,
      head_sha: CommitSha,
      default_branch: Schema.String,
      base_branches: Schema.Array(Schema.String),
      timeline_complete: Schema.Boolean,
    }),
  ),
});
export type OpenPullRequest = typeof OpenPullRequest.Type;

export const RepositoryPullRequests = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    items: Schema.Array(OpenPullRequest),
    fetched_at: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: Schema.String,
  }),
]);
export type RepositoryPullRequests = typeof RepositoryPullRequests.Type;

/** A browse-only snapshot; collecting it does not create a review or an agent thread. */
export const PullRequestSnapshot = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    input: ReviewInput,
    warnings: Schema.Array(Schema.String),
    collected_at: Schema.String,
    comparison: Schema.optional(
      Schema.Struct({
        mode: ComparisonMode,
        base_sha: CommitSha,
        head_sha: CommitSha,
        historical: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: Schema.String,
  }),
]);
export type PullRequestSnapshot = typeof PullRequestSnapshot.Type;
