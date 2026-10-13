/**
 * A review's state and the actions that change it, as pure functions. The store keeps the state, runs an action in
 * a transaction, and checks the result against the feedback schema before it commits, so every state the store
 * holds is a valid feedback document.
 */
import * as Result from "effect/Result";
import type {
  Anchor,
  Answer,
  Approval,
  Comment,
  Reply,
  ReviewerReply,
  Submission,
  Verdict,
} from "../schema/feedback.ts";
import { compareReplies } from "../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type {
  CommentId,
  CommitSha,
  Fingerprint,
  InputDigest,
  ReplyId,
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
  ThreadId,
  Timestamp,
} from "../schema/primitives.ts";
import type { Target } from "../schema/target.ts";
import {
  type AnchorProblem,
  anchorForRows,
  attach,
  type RowSelection,
} from "./anchor.ts";

/** A published round: who published it, when, and the digest that names its input. */
export interface Round {
  readonly round: RoundNumber;
  readonly input_sha256: InputDigest;
  readonly thread: ThreadId;
  readonly published_at: Timestamp;
}

/**
 * A submission as the store keeps it: with the revision it made, so an agent can tell a new finish from one it has
 * already read. Feedback exports leave the revision out.
 */
export interface SubmissionRecord extends Submission {
  readonly revision: Revision;
}

/** Everything about a review that actions change. Round inputs and thread tokens live beside it in the store. */
export interface ReviewState {
  readonly id: ReviewId;
  readonly target: Target;
  readonly created_at: Timestamp;
  /** Set when a fresh start closed this review. A closed review is read-only. */
  readonly closed_at: Timestamp | undefined;
  /** The review this one replaced, whose matching approvals carry into the first round. */
  readonly carry_from: ReviewId | undefined;
  readonly rounds: ReadonlyArray<Round>;
  readonly approvals: ReadonlyArray<Approval>;
  readonly comments: ReadonlyArray<Comment>;
  readonly submissions: ReadonlyArray<SubmissionRecord>;
  /**
   * What an agent found when it compared the code with the current round: the files that changed since, and for a
   * pull request the head it found. The page shows it until the next round replaces the round it describes.
   */
  readonly drift?: Drift | undefined;
}

export interface Drift {
  readonly round: RoundNumber;
  readonly checked_at: Timestamp;
  readonly paths: ReadonlyArray<RepoPath>;
  readonly head_sha?: CommitSha | undefined;
}

/** A question the reviewer asked now, which the agents answer without waiting for the round to finish. */
export const isQuestion = (comment: Comment): boolean =>
  comment.source.kind === "reviewer" && comment.source.question === true;

/** Whose move a comment waits for. */
export type Turn = "agent" | "reviewer" | "resolved";

/**
 * A GitHub thread that GitHub shows resolved is settled while nothing here followed GitHub's last word. An agent's
 * answer still waits for the reviewer, and the reviewer's own reply or reopen outranks GitHub's flag.
 */
export const turnOf = (comment: Comment): Turn => {
  const last = comment.replies.at(-1);
  const remote = comment.source.kind === "github" && comment.source.resolved;
  if (last === undefined) return remote ? "resolved" : "agent";
  switch (last.actor) {
    case "agent":
      return "reviewer";
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

export type ActionErrorKind =
  | "closed"
  | "no_round"
  | "not_found"
  | "not_your_turn"
  | "resolved"
  | "bad_anchor"
  | "changed"
  | "fingerprint"
  | "invalid";

export class ActionError extends Error {
  readonly kind: ActionErrorKind;
  constructor(kind: ActionErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const fail = (kind: ActionErrorKind, message: string) =>
  Result.fail(new ActionError(kind, message));

type Outcome = Result.Result<ReviewState, ActionError>;

/** What every action needs beside the state: the current round's input, the time, and fresh IDs. */
export interface ActionContext {
  readonly input: ReviewInput | undefined;
  readonly now: Timestamp;
  /** The revision the action makes when it commits. */
  readonly revision: Revision;
  readonly commentId: () => CommentId;
  readonly replyId: () => ReplyId;
}

const open = (state: ReviewState): ActionError | undefined =>
  state.closed_at === undefined
    ? undefined
    : new ActionError(
        "closed",
        "This review is closed. Open the newest review of its target.",
      );

/** The current round and its input, on an open review that has one. */
export const withRound = (
  state: ReviewState,
  context: ActionContext,
): Result.Result<{ round: Round; input: ReviewInput }, ActionError> => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const round = currentRound(state);
  if (round === undefined || context.input === undefined)
    return fail("no_round", "The review has no round yet.");
  return Result.succeed({ round, input: context.input });
};

const findComment = (
  state: ReviewState,
  id: CommentId,
): Result.Result<Comment, ActionError> => {
  const comment = state.comments.find((item) => item.id === id);
  return comment === undefined
    ? fail("not_found", `No comment ${id} in this review.`)
    : Result.succeed(comment);
};

const replaceComment = (state: ReviewState, updated: Comment): ReviewState => ({
  ...state,
  comments: state.comments.map((item) =>
    item.id === updated.id ? updated : item,
  ),
});

/** Appends a reply, keeping the conversation in its one order. A reply never goes before an earlier one. */
export const appendReply = (
  comment: Comment,
  reply: Reply,
  now: Timestamp,
): Comment => {
  const last = comment.replies.at(-1);
  const created_at =
    last !== undefined &&
    compareReplies(last, { ...reply, created_at: now }) > 0
      ? (new Date(Date.parse(last.created_at) + 1).toISOString() as Timestamp)
      : now;
  return {
    ...comment,
    updated_at: created_at,
    replies: [...comment.replies, { ...reply, created_at }],
  };
};

const ANCHOR_PROBLEMS: Readonly<Record<AnchorProblem["kind"], string>> = {
  no_patch: "the file has no patch",
  changed:
    "the file changed since the page showed it. Select the lines again in the current round",
  out_of_range: "the selected rows are outside the patch",
  no_source_line: "select at least one line of code, not only a hunk header",
  blank:
    "the selected lines are blank. Include a line with code in the selection",
};

const anchorFailure = (problem: AnchorProblem, doing: string) =>
  fail(
    problem.kind === "changed" ? "changed" : "bad_anchor",
    `Cannot ${doing}: ${ANCHOR_PROBLEMS[problem.kind]}.`,
  );

const reviewerSource = (question: boolean): Comment["source"] =>
  question ? { kind: "reviewer", question: true } : { kind: "reviewer" };

/** A comment on a row selection of a file in the current round. */
export const addInlineComment = (
  state: ReviewState,
  context: ActionContext,
  selection: RowSelection,
  body: string,
  question = false,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  const file = input.files.find((item) => item.path === selection.path);
  if (file === undefined)
    return fail(
      "not_found",
      `No file ${selection.path} in round ${round.round}.`,
    );
  const anchor = anchorForRows(
    file,
    { round: round.round, input_sha256: round.input_sha256 },
    selection,
  );
  if ("kind" in anchor) return anchorFailure(anchor, "comment there");
  const comment: Comment = {
    kind: "inline",
    id: context.commentId(),
    source: reviewerSource(question),
    body,
    created_at: context.now,
    updated_at: context.now,
    replies: [],
    anchor,
    history: [],
    attachment: attach(anchor, file),
  };
  return Result.succeed({ ...state, comments: [...state.comments, comment] });
};

/** A comment on the review as a whole. */
export const addGeneralComment = (
  state: ReviewState,
  context: ActionContext,
  body: string,
  question = false,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const comment: Comment = {
    kind: "general",
    id: context.commentId(),
    source: reviewerSource(question),
    body,
    created_at: context.now,
    updated_at: context.now,
    replies: [],
  };
  return Result.succeed({ ...state, comments: [...state.comments, comment] });
};

/** The reviewer's reply: accept resolves, reopen returns a resolved comment to the agents, reply adds to it. */
export const reviewerReply = (
  state: ReviewState,
  context: ActionContext,
  id: CommentId,
  action: ReviewerReply["action"],
  body: string,
): Outcome => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const found = findComment(state, id);
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const comment = found.success;
  const turn = turnOf(comment);
  if (action === "reopen" && turn !== "resolved")
    return fail("not_your_turn", "Only a resolved comment can be reopened.");
  if (action !== "reopen" && turn === "resolved")
    return fail("resolved", "The comment is resolved. Reopen it first.");
  if (action !== "accept" && body.trim() === "")
    return fail("invalid", "Write what the agents should know.");
  const reply: ReviewerReply = {
    id: context.replyId(),
    created_at: context.now,
    actor: "reviewer",
    action,
    body,
  };
  return Result.succeed(
    replaceComment(state, appendReply(comment, reply, context.now)),
  );
};

/** An agent's answer, on the agent's turn, from a registered thread. */
export const agentAnswer = (
  state: ReviewState,
  context: ActionContext,
  thread: ThreadId,
  id: CommentId,
  answer: Answer,
): Outcome => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const found = findComment(state, id);
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const comment = found.success;
  const turn = turnOf(comment);
  if (turn !== "agent") {
    return fail(
      "not_your_turn",
      turn === "resolved"
        ? `Comment ${id} is resolved.`
        : `Comment ${id} waits for the reviewer; it already has an answer.`,
    );
  }
  // A fix named by file version must be one the reviewer can see: a version of the current round.
  if (
    answer.disposition === "fixed" &&
    "fingerprint" in answer.fixed_in &&
    !(context.input?.files ?? []).some(
      (file) =>
        "fingerprint" in answer.fixed_in &&
        file.fingerprint === answer.fixed_in.fingerprint,
    )
  ) {
    return fail(
      "invalid",
      `No file of the current round has fingerprint ${answer.fixed_in.fingerprint}. Publish the round with the fix first, then answer with a fingerprint from it.`,
    );
  }
  const reply: Reply = {
    id: context.replyId(),
    created_at: context.now,
    actor: "agent",
    thread,
    ...answer,
  };
  return Result.succeed(
    replaceComment(state, appendReply(comment, reply, context.now)),
  );
};

/** Approves one file as the current round shows it. The fingerprint the page saw must still be the file's. */
export const approve = (
  state: ReviewState,
  context: ActionContext,
  path: RepoPath,
  fingerprint: Fingerprint,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  const file = input.files.find((item) => item.path === path);
  if (file === undefined)
    return fail("not_found", `No file ${path} in round ${round.round}.`);
  if (file.fingerprint === undefined)
    return fail(
      "fingerprint",
      `${path} has no fingerprint, so it cannot be approved.`,
    );
  if (file.fingerprint !== fingerprint)
    return fail(
      "fingerprint",
      `${path} changed since the page loaded. Reload and read it again.`,
    );
  const approval: Approval = {
    path,
    fingerprint,
    approved_at: context.now,
    round: round.round,
  };
  return Result.succeed({
    ...state,
    approvals: [
      ...state.approvals.filter((item) => item.path !== path),
      approval,
    ],
  });
};

export const unapprove = (state: ReviewState, path: RepoPath): Outcome => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  if (!state.approvals.some((item) => item.path === path))
    return fail("not_found", `${path} is not approved.`);
  return Result.succeed({
    ...state,
    approvals: state.approvals.filter((item) => item.path !== path),
  });
};

/**
 * The reviewer finished a round. It must be the current one: a verdict on a round the reviewer has not seen would
 * approve unread code.
 */
export const submit = (
  state: ReviewState,
  context: ActionContext,
  seen: RoundNumber,
  verdict: Verdict,
  body: string,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round } = current.success;
  if (round.round !== seen)
    return fail(
      "changed",
      `Round ${round.round} was published after the page showed round ${seen}. Read it before you finish.`,
    );
  const submission: SubmissionRecord = {
    round: round.round,
    verdict,
    body,
    submitted_at: context.now,
    revision: context.revision,
  };
  return Result.succeed({
    ...state,
    submissions: [...state.submissions, submission],
  });
};

/**
 * A new round from a thread: every inline comment reattaches to the new patches, and approvals stay as they are,
 * holding only where the fingerprint still matches.
 */
export const publishRound = (
  state: ReviewState,
  input: ReviewInput,
  round: Round,
): Outcome => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const files = new Map(input.files.map((file) => [file.path, file]));
  return Result.succeed({
    ...state,
    rounds: [...state.rounds, round],
    drift: undefined,
    comments: state.comments.map((comment) =>
      comment.kind === "inline"
        ? {
            ...comment,
            attachment: attach(comment.anchor, files.get(comment.anchor.path)),
          }
        : comment,
    ),
  });
};

/**
 * A new review of the same target, carrying each approval whose path and fingerprint match a file of its first
 * round, and nothing else.
 */
export const carriedApprovals = (
  earlier: ReviewState,
  input: ReviewInput,
): ReadonlyArray<Approval> =>
  earlier.approvals.flatMap((approval) => {
    const held = approvalHolds(approval, input.files);
    const from = earlier.rounds.at(-1);
    return held && from !== undefined
      ? [
          {
            ...approval,
            round: 1 as RoundNumber,
            carried_from: { review: earlier.id, round: approval.round },
          },
        ]
      : [];
  });

/** Moves an inline comment's anchor to another row selection by hand, keeping the old anchor in its history. */
export const reattach = (
  state: ReviewState,
  context: ActionContext,
  id: CommentId,
  selection: RowSelection,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  const found = findComment(state, id);
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const comment = found.success;
  if (comment.kind !== "inline")
    return fail("invalid", "Only an inline comment has an anchor.");
  // A comment that still attaches is where its replies answered it; only one that lost its place can move.
  if (comment.attachment.state !== "orphan")
    return fail(
      "invalid",
      "Only a comment that no longer attaches can be moved. Reply to it instead.",
    );
  const file = input.files.find((item) => item.path === selection.path);
  if (file === undefined)
    return fail(
      "not_found",
      `No file ${selection.path} in round ${round.round}.`,
    );
  const anchor: Anchor | AnchorProblem = anchorForRows(
    file,
    { round: round.round, input_sha256: round.input_sha256 },
    selection,
  );
  if ("kind" in anchor)
    return anchorFailure(anchor, "attach the comment to those rows");
  return Result.succeed(
    replaceComment(state, {
      ...comment,
      updated_at: context.now,
      anchor,
      history: [comment.anchor, ...comment.history],
      attachment: attach(anchor, file),
    }),
  );
};

/** Records what an agent found when it compared the code with the current round. No changed path clears it. */
export const reportDrift = (
  state: ReviewState,
  context: ActionContext,
  paths: ReadonlyArray<RepoPath>,
  head_sha: CommitSha | undefined,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round } = current.success;
  const target = state.target;
  const headMoved =
    head_sha !== undefined && target.kind === "github_pr"
      ? head_sha.toLowerCase() !== target.head_sha.toLowerCase()
      : false;
  return Result.succeed({
    ...state,
    drift:
      paths.length === 0 && !headMoved
        ? undefined
        : {
            round: round.round,
            checked_at: context.now,
            paths: [...new Set(paths)].sort(),
            ...(headMoved ? { head_sha } : {}),
          },
  });
};
