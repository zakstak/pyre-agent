import * as Schema from "effect/Schema";
import { nonEmptyText, PullRequestUrl } from "./primitives.ts";
import { ReviewInput } from "./input.ts";

/** Repository PRs exist independently of locally registered reviews. */
export const OpenPullRequest = Schema.Struct({
  url: PullRequestUrl,
  title: Schema.String,
  base_branch: nonEmptyText(1024),
  head_branch: nonEmptyText(1024),
  /** False when the source repository is deleted or differs from the target repository. */
  same_repository: Schema.Boolean,
});
export type OpenPullRequest = typeof OpenPullRequest.Type;

export const RepositoryPullRequests = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    items: Schema.Array(OpenPullRequest),
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
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: Schema.String,
  }),
]);
export type PullRequestSnapshot = typeof PullRequestSnapshot.Type;
