/**
 * How far the reviewer is with the current round, counted in one place for everything that shows it: the next step,
 * the next strip, the file headers, the finish section, and the home page. Counts that are computed twice drift apart.
 */
import type { Comment } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { RepoPath } from "../schema/primitives.ts";
import { approvalHolds, currentRound, currentSubmission, isQuestion, type ReviewState, type Turn, turnOf } from "./queries.ts";

/**
 * Whose move a comment waits for, as the page says it. A plain comment of the reviewer's that nobody answered and
 * that no finished review carried yet is pending: the agents see it when the reviewer finishes, so it waits for
 * neither side. A question goes out at once, and so does a comment made after the reviewer finished the round.
 * A new publication keeps earlier comments waiting for the agents; only comments after it can be pending.
 */
export type Standing = Turn | "pending";

/** The standing of each comment of a review. */
export const standingOf = (
  state: ReviewState,
): ((comment: Comment) => Standing) => {
  const finished = currentSubmission(state) !== undefined;
  const lastSent = state.submissions.at(-1)?.submitted_at;
  const published = currentRound(state)?.published_at;
  return (comment) => {
    const held =
      !finished &&
      comment.source.kind === "reviewer" &&
      !isQuestion(comment) &&
      comment.replies.length === 0 &&
      (lastSent === undefined || comment.created_at > lastSent) &&
      (published === undefined || comment.created_at > published);
    return held ? "pending" : turnOf(comment);
  };
};

export interface Progress {
  /** Files the reviewer can mark viewed: those with a fingerprint. */
  readonly viewable: number;
  /** Files whose approval holds for this round's version. */
  readonly viewed: ReadonlySet<RepoPath>;
  /** Comments whose turn is the reviewer's, such as answers to read. */
  readonly forYou: number;
  /** Comments that wait for an agent. */
  readonly waiting: number;
  /** Comments that go out with the reviewer's finish. */
  readonly pending: number;
}

export const progress = (state: ReviewState, input: ReviewInput): Progress => {
  const viewable = input.files.filter((file) => file.fingerprint !== undefined);
  const viewed = new Set(
    viewable
      .filter((file) =>
        state.approvals.some(
          (approval) =>
            approval.path === file.path && approvalHolds(approval, [file]),
        ),
      )
      .map((file) => file.path),
  );
  const standing = standingOf(state);
  const tally = { reviewer: 0, agent: 0, pending: 0, resolved: 0 };
  for (const comment of state.comments) tally[standing(comment)]++;
  return {
    viewable: viewable.length,
    viewed,
    forYou: tally.reviewer,
    waiting: tally.agent,
    pending: tally.pending,
  };
};
