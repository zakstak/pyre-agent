/**
 * What a review's state says, without changing it: whose turn a comment is, the current round and its finish, and
 * whether an approval holds. The page and the server read these; the actions in state.ts change the state.
 */
import type { Approval, Comment } from "../schema/feedback.ts";
import type { ReviewFile } from "../schema/input.ts";
import type { ReviewState, Round, SubmissionRecord } from "../schema/state.ts";

export type {
  Drift,
  ReviewState,
  Round,
  SubmissionRecord,
} from "../schema/state.ts";

/** A question the reviewer asked now, which the agents answer without waiting for the round to finish. */
export const isQuestion = (comment: Comment): boolean =>
  comment.source.kind === "reviewer" &&
  comment.source.state !== "pending" &&
  comment.source.question === true;

/** A reviewer's comment that Finish review has not sent yet. No agent sees it. */
export const isPending = (comment: Comment): boolean =>
  comment.source.kind === "reviewer" && comment.source.state === "pending";

/** The comments an agent sees: every comment but the pending ones. */
export const agentComments = (
  comments: ReadonlyArray<Comment>,
): ReadonlyArray<Comment> => comments.filter((comment) => !isPending(comment));

/** A comment the reviewer wrote on the page. */
export type OwnComment = Comment & {
  readonly source: Extract<Comment["source"], { readonly kind: "reviewer" }>;
};

/** Whether the reviewer may change a comment's body: any comment of theirs, not one imported from the git host. */
export const canEdit = (comment: Comment): comment is OwnComment =>
  comment.source.kind === "reviewer";

/**
 * Whether the reviewer may delete a comment: one of theirs that nobody replied to, which every pending comment is.
 * A comment with replies is part of a conversation; withdrawing it takes it back instead.
 */
export const canDelete = (comment: Comment): boolean =>
  canEdit(comment) && comment.replies.length === 0;

/** Whose move a comment waits for. */
export type Turn = "agent" | "reviewer" | "resolved";

/**
 * A GitHub thread that GitHub shows resolved is settled while nothing here followed GitHub's last word. An agent's
 * answer still waits for the reviewer, and the reviewer's own reply or reopen outranks GitHub's flag. A reviewer's
 * edit after the last answer asks the agents again, as a reply would. A pending comment waits for the agents too, but
 * only once Finish review sends it: until then no agent sees it.
 */
export const turnOf = (comment: Comment): Turn => {
  const last = comment.replies.at(-1);
  const remote = comment.source.kind === "github" && comment.source.resolved;
  if (last === undefined) return remote ? "resolved" : "agent";
  switch (last.actor) {
    case "agent":
      return comment.source.kind === "reviewer" &&
        comment.source.state === "edited" &&
        comment.source.edited_at > last.created_at
        ? "agent"
        : "reviewer";
    case "github":
      return remote ? "resolved" : "agent";
    case "reviewer":
      return last.action === "accept" ? "resolved" : "agent";
  }
};

export const currentRound = (state: ReviewState): Round | undefined =>
  state.rounds.at(-1);

/** The latest submission of the current round, if the reviewer finished it. */
export const currentSubmission = (
  state: ReviewState,
): SubmissionRecord | undefined => {
  const round = currentRound(state);
  return round === undefined
    ? undefined
    : state.submissions.findLast((item) => item.round === round.round);
};

/** Whether the approval holds for the file as the current round shows it. */
export const approvalHolds = (
  approval: Approval,
  files: ReadonlyArray<ReviewFile>,
): boolean =>
  files.some(
    (file) =>
      file.path === approval.path && file.fingerprint === approval.fingerprint,
  );
