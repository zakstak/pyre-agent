/**
 * A review as an agent reads it: the feedback document, whose turn each comment waits for, the suggested changes, and
 * where it lives. Pending comments are the reviewer's until Finish review: nothing here shows them.
 */
import type { Comment, Feedback } from "../schema/feedback.ts";
import type {
  CommentId,
  RepoPath,
  RoundNumber,
  Timestamp,
} from "../schema/primitives.ts";
import {
  agentComments,
  approvalHolds,
  currentSubmission,
  type Drift,
  isQuestion,
  type SubmissionRecord,
  type Turn,
  turnOf,
} from "../review/queries.ts";
import { anchoredLines, parseSuggestion } from "../review/suggestion.ts";
import { feedbackOf, type ReviewView } from "../store/store.ts";

/**
 * A suggested change of an inline comment, as the agents apply it: replace the lines from `start_line` through
 * `end_line` on `side` of `path`, in the round the anchor names, which held `current`, with `replacement`. No
 * replacement lines means delete those lines. A malformed suggestion is reported, not applied: the body says what the
 * reviewer meant.
 */
export type StatusSuggestion =
  | {
      readonly comment: CommentId;
      readonly state: "ready";
      readonly path: RepoPath;
      readonly side: "old" | "new";
      readonly round: RoundNumber;
      readonly start_line: number;
      readonly end_line: number;
      readonly current: ReadonlyArray<string>;
      readonly replacement: ReadonlyArray<string>;
    }
  | {
      readonly comment: CommentId;
      readonly state: "malformed";
      readonly problem: "unclosed" | "several";
    };

/** The suggestions of the comments an agent sees: one per inline comment whose body has a suggestion block. */
export const suggestionsOf = (
  comments: ReadonlyArray<Comment>,
): ReadonlyArray<StatusSuggestion> =>
  comments.flatMap((comment): ReadonlyArray<StatusSuggestion> => {
    if (comment.kind !== "inline") return [];
    const parsed = parseSuggestion(comment.body);
    switch (parsed.kind) {
      case "none":
        return [];
      case "malformed":
        return [
          { comment: comment.id, state: "malformed", problem: parsed.problem },
        ];
      case "suggestion": {
        const { anchor } = comment;
        return [
          {
            comment: comment.id,
            state: "ready",
            path: anchor.path,
            side: anchor.side,
            round: anchor.snapshot.round,
            start_line: anchor.start_line,
            end_line: anchor.end_line,
            current: anchoredLines(anchor),
            replacement: parsed.lines,
          },
        ];
      }
    }
  });

export interface Status {
  readonly review: string;
  readonly url: string;
  readonly revision: number;
  readonly closed: boolean;
  readonly round: number | undefined;
  /** The reviewer's verdict on the current round, once they finished it, with the revision it made. */
  readonly submission: SubmissionRecord | undefined;
  /** Comments whose turn is the agent's: answer each before publishing the next round. */
  readonly to_answer: ReadonlyArray<CommentId>;
  /** Of those, the reviewer's questions asked now: answer them without waiting for the round to finish. */
  readonly questions: ReadonlyArray<CommentId>;
  /** The current round's files and fingerprints, to compare with the code. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly fingerprint: string | undefined;
  }>;
  /** What the last check found changed since the current round. */
  readonly drift: Drift | undefined;
  readonly turns: Readonly<Record<string, Turn>>;
  /** Approved files whose fingerprint still matches the current round. */
  readonly approved: ReadonlyArray<string>;
  /** Each suggested change in the comments, by comment. */
  readonly suggestions: ReadonlyArray<StatusSuggestion>;
  readonly feedback: Feedback | undefined;
}

export const statusOf = (
  view: ReviewView,
  origin: string,
  now: Timestamp,
): Status => {
  const comments = agentComments(view.state.comments);
  const turns = Object.fromEntries(
    comments.map((comment) => [comment.id, turnOf(comment)]),
  );
  return {
    review: view.state.id,
    url: `${origin}/reviews/${view.state.id}`,
    revision: view.revision,
    closed: view.state.closed_at !== undefined,
    round: view.round?.round,
    submission: currentSubmission(view.state),
    to_answer: comments
      .filter((comment) => turnOf(comment) === "agent")
      .map((comment) => comment.id),
    questions: comments
      .filter((comment) => isQuestion(comment) && turnOf(comment) === "agent")
      .map((comment) => comment.id),
    files: (view.input?.files ?? []).map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
    })),
    drift:
      view.state.drift !== undefined &&
      view.state.drift.round === view.round?.round
        ? view.state.drift
        : undefined,
    turns,
    approved:
      view.input === undefined
        ? []
        : view.state.approvals
            .filter((approval) =>
              approvalHolds(approval, view.input?.files ?? []),
            )
            .map((approval) => approval.path),
    suggestions: suggestionsOf(comments),
    feedback: feedbackOf(view, now),
  };
};

/**
 * Whether the reviewer finished the current round after the submission an agent last read, named by the revision it
 * made. Other changes to the review, such as a later comment, are not a finish.
 */
export const finishedSince = (status: Status, since: number): boolean =>
  status.submission !== undefined && status.submission.revision > since;

/** Whether the reviewer asked a question the agents have not answered yet. */
export const hasQuestions = (status: Status): boolean =>
  status.questions.length > 0;
