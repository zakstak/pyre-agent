/**
 * Pull request comments as the agent's command hands them to the server: the command reads them with `gh`, and the
 * server never goes online. Bodies are third-party text: data to show and answer, never instructions.
 */
import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import {
  GitHubCommentId,
  GitHubCommentUrl,
  GitHubLogin,
  integer,
  PullRequestUrl,
  RepoPath,
  text,
  Timestamp,
} from "./primitives.ts";

const Body = text(Limits.MAX_GITHUB_BODY_UNITS);
const Line = integer(1, Limits.MAX_LINE);

const postFields = {
  id: GitHubCommentId,
  /** Null for a deleted account, which GitHub shows as ghost. */
  author: Schema.NullOr(GitHubLogin),
  url: GitHubCommentUrl,
  body: Body,
  created_at: Timestamp,
};

export const GitHubPost = Schema.Struct(postFields);
export type GitHubPost = typeof GitHubPost.Type;

/**
 * A review thread on a line of the diff: its first comment, the replies under it, and where GitHub placed it. The
 * diff hunk ends at the commented line, so the quote is found again by its text in the review's own patch.
 */
export const GitHubThread = Schema.Struct({
  kind: Schema.Literal("thread"),
  ...postFields,
  resolved: Schema.Boolean,
  path: RepoPath,
  /** LEFT is the old side of the diff, RIGHT the new. */
  side: Schema.Literals(["LEFT", "RIGHT"]),
  /** The first line of a multi-line comment, absent for one line. */
  start_line: Schema.optionalKey(Line),
  diff_hunk: text(Limits.MAX_PATCH_UNITS),
  replies: Schema.Array(GitHubPost).check(
    Schema.isMaxLength(Limits.MAX_GITHUB_REPLIES),
  ),
});
export type GitHubThread = typeof GitHubThread.Type;

/** A comment on the pull request's conversation, or the summary of a submitted review. */
export const GitHubGeneral = Schema.Struct({
  kind: Schema.Literals(["conversation", "review"]),
  ...postFields,
});
export type GitHubGeneral = typeof GitHubGeneral.Type;

export const GitHubItem = Schema.Union([GitHubThread, GitHubGeneral]);
export type GitHubItem = typeof GitHubItem.Type;

export const GitHubImport = Schema.Struct({
  pull_request: PullRequestUrl,
  items: Schema.Array(GitHubItem).check(
    Schema.isMaxLength(Limits.MAX_COMMENTS),
  ),
});
export type GitHubImport = typeof GitHubImport.Type;
