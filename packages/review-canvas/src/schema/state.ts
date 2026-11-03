/**
 * A review's state as the store keeps it and the page receives it. The store checks every state against the feedback
 * schema before it commits; this schema is the state's own shape, which pages decode from the server.
 */
import * as Schema from "effect/Schema";
import { Approval, Comment, Submission } from "./feedback.ts";
import * as Limits from "./limits.ts";
import {
  CommitSha,
  Count,
  InputDigest,
  nonEmptyText,
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
  ThreadId,
  Timestamp,
} from "./primitives.ts";
import { Target } from "./target.ts";

/** A published round: who published it, when, and the digest that names its input. */
export const Round = Schema.Struct({
  round: RoundNumber,
  input_sha256: InputDigest,
  thread: ThreadId,
  published_at: Timestamp,
});
export type Round = typeof Round.Type;

/**
 * A submission as the store keeps it: with the revision it made, so an agent can tell a new finish from one it has
 * already read. Feedback exports leave the revision out.
 */
export const SubmissionRecord = Schema.Struct({
  ...Submission.fields,
  revision: Revision,
});
export type SubmissionRecord = typeof SubmissionRecord.Type;

const Reason = nonEmptyText(Limits.MAX_TEXT_UNITS);

/**
 * What the git host found when it compared the round's head with the head it shows now: `listed`, the commits the new
 * head adds and every file that differs; `unlisted`, the commits but not every file, as after a force-push or past the
 * host's file limit, and why; `failed`, why the host could not compare them.
 */
export const HeadComparison = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("listed"), commits: Count }),
  Schema.Struct({
    kind: Schema.Literal("unlisted"),
    commits: Count,
    reason: Reason,
  }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Reason }),
]).annotate({
  expected: "a head comparison whose kind is listed, unlisted, or failed",
});
export type HeadComparison = typeof HeadComparison.Type;

/**
 * What was found changed since the current round, by an agent's check or, for a pull request, by the server when the
 * host's list of open pull requests showed a new head: the files known to have changed since, and for a pull request
 * the head found and, when the host compared it with the round's, what that found. A head with no comparison came from
 * an agent that could not compare it. The page shows it until the next round replaces the round it describes.
 */
export const Drift = Schema.Struct({
  round: RoundNumber,
  checked_at: Timestamp,
  paths: Schema.Array(RepoPath),
  head_sha: Schema.optional(CommitSha),
  compared: Schema.optional(HeadComparison),
});
export type Drift = typeof Drift.Type;

/** Everything about a review that actions change. Round inputs and thread tokens live beside it in the store. */
export const ReviewState = Schema.Struct({
  id: ReviewId,
  target: Target,
  created_at: Timestamp,
  /** Set when a fresh start closed this review. A closed review is read-only. */
  closed_at: Schema.optional(Timestamp),
  /** The review this one replaced, whose matching approvals carry into the first round. */
  carry_from: Schema.optional(ReviewId),
  rounds: Schema.Array(Round),
  approvals: Schema.Array(Approval),
  comments: Schema.Array(Comment),
  submissions: Schema.Array(SubmissionRecord),
  drift: Schema.optional(Drift),
});
export type ReviewState = typeof ReviewState.Type;
