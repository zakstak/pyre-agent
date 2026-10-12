/** A review as an agent reads it: the feedback document, whose turn each comment waits for, and where it lives. */
import type { Feedback } from "../schema/feedback.ts";
import type { CommentId, Timestamp } from "../schema/primitives.ts";
import {
  approvalHolds,
  currentSubmission,
  type Turn,
  turnOf,
} from "../review/state.ts";
import { feedbackOf, type ReviewView } from "../store/store.ts";

export interface Status {
  readonly review: string;
  readonly url: string;
  readonly revision: number;
  readonly closed: boolean;
  readonly round: number | undefined;
  /** The reviewer's verdict on the current round, once they finished it. */
  readonly submission: Feedback["submissions"] extends
    | ReadonlyArray<infer S>
    | undefined
    ? S | undefined
    : never;
  /** Comments whose turn is the agent's: answer each before publishing the next round. */
  readonly to_answer: ReadonlyArray<CommentId>;
  readonly turns: Readonly<Record<string, Turn>>;
  /** Approved files whose fingerprint still matches the current round. */
  readonly approved: ReadonlyArray<string>;
  readonly feedback: Feedback | undefined;
}

export const statusOf = (
  view: ReviewView,
  origin: string,
  now: Timestamp,
): Status => {
  const turns = Object.fromEntries(
    view.state.comments.map((comment) => [comment.id, turnOf(comment)]),
  );
  return {
    review: view.state.id,
    url: `${origin}/reviews/${view.state.id}`,
    revision: view.revision,
    closed: view.state.closed_at !== undefined,
    round: view.round?.round,
    submission: currentSubmission(view.state),
    to_answer: view.state.comments
      .filter((comment) => turnOf(comment) === "agent")
      .map((comment) => comment.id),
    turns,
    approved:
      view.input === undefined
        ? []
        : view.state.approvals
            .filter((approval) =>
              approvalHolds(approval, view.input?.files ?? []),
            )
            .map((approval) => approval.path),
    feedback: feedbackOf(view, now),
  };
};
