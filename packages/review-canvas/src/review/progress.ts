/**
 * How far the reviewer is with the current round, counted in one place for everything that shows it: the next step,
 * the next strip, the file headers, the finish section, and the home page. Counts that are computed twice drift apart.
 */
import type { Comment } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { RepoPath } from "../schema/primitives.ts";
import {
  approvalHolds,
  isPending,
  type ReviewState,
  type Turn,
  turnOf,
} from "./queries.ts";

/**
 * Whose move a comment waits for, as the page says it. A pending comment of the reviewer's waits for neither side:
 * Finish review sends it to the agents.
 */
export type Standing = Turn | "pending";

/** A comment's standing. */
export const standingOf = (comment: Comment): Standing =>
  isPending(comment) ? "pending" : turnOf(comment);

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
  const tally = { reviewer: 0, agent: 0, pending: 0, resolved: 0 };
  for (const comment of state.comments) tally[standingOf(comment)]++;
  return {
    viewable: viewable.length,
    viewed,
    forYou: tally.reviewer,
    waiting: tally.agent,
    pending: tally.pending,
  };
};
