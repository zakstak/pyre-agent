/**
 * A review's state as the store keeps it and the page receives it. The store checks every state against the feedback
 * schema before it commits; this schema is the state's own shape, which pages decode from the server.
 */
import * as Schema from "effect/Schema";
import { Approval, Comment, Submission } from "./feedback.ts";
import {
  CommitSha,
  InputDigest,
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

/**
 * What an agent found when it compared the code with the current round: the files that changed since, and for a pull
 * request the head it found. The page shows it until the next round replaces the round it describes.
 */
export const Drift = Schema.Struct({
  round: RoundNumber,
  checked_at: Timestamp,
  paths: Schema.Array(RepoPath),
  head_sha: Schema.optional(CommitSha),
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
