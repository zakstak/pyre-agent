/**
 * Reviews a store of an earlier version saved, read into today's state. Earlier builds kept no comment lifecycle:
 * the page called a plain comment pending while no finish had carried it, and showed agents every comment. Today a
 * pending comment is one Finish review has not sent, which no agent sees. Earlier anchors were all patch anchors.
 */
import * as Schema from "effect/Schema";
import type { Comment } from "../schema/feedback.ts";
import { ReviewState } from "../schema/state.ts";
import { currentRound, currentSubmission } from "./queries.ts";

/**
 * Whether the earlier page showed a comment as pending: a plain comment of the reviewer's, with no reply, made after
 * the last finish and after the current round was published, on a round not finished yet.
 */
const shownPending = (state: ReviewState, comment: Comment): boolean => {
  if (currentSubmission(state) !== undefined) return false;
  const lastSent = state.submissions.at(-1)?.submitted_at;
  const published = currentRound(state)?.published_at;
  return (
    comment.source.kind === "reviewer" &&
    comment.source.state === "sent" &&
    comment.source.question !== true &&
    comment.replies.length === 0 &&
    (lastSent === undefined || comment.created_at > lastSent) &&
    (published === undefined || comment.created_at > published)
  );
};

/**
 * A state as an earlier store saved it, in today's shape. Decoding fills what earlier states lack: a patch anchor's
 * kind and a reviewer comment's state, sent. On an open review, a comment the earlier page showed as pending becomes
 * pending, so it keeps waiting for Finish review as the reviewer was told it would. A closed review cannot be
 * finished, so its comments stay sent, as closing a review sends its pending comments today.
 */
export const upgradeState = (stored: unknown): ReviewState => {
  const state = Schema.decodeUnknownSync(ReviewState)(stored);
  if (state.closed_at !== undefined) return state;
  return {
    ...state,
    comments: state.comments.map((comment) =>
      shownPending(state, comment)
        ? { ...comment, source: { kind: "reviewer", state: "pending" } }
        : comment,
    ),
  };
};
