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
  Verdict,
} from "../schema/feedback.ts";
import { compareReplies } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { StopRef } from "../schema/reading.ts";
import type { Selection } from "../schema/selection.ts";
import type {
  CommentId,
  CommitSha,
  Fingerprint,
  ReplyId,
  RepoPath,
  Revision,
  RoundNumber,
  ThreadId,
  Timestamp,
} from "../schema/primitives.ts";
import {
  anchorFor,
  type AnchorProblem,
  attach,
  isAnchorProblem,
} from "./anchor.ts";
import {
  attachStop,
  findStop,
  stopAnchorFor,
  stopTitle,
} from "./stop-anchor.ts";
import { tourView } from "./tour.ts";
import {
  approvalHolds,
  canDelete,
  canEdit,
  currentRound,
  currentSubmission,
  isPending,
  type OwnComment,
  turnOf,
  type ReviewState,
  type Round,
  type SubmissionRecord,
} from "./queries.ts";

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

const after = (time: Timestamp): Timestamp =>
  new Date(Date.parse(time) + 1).toISOString() as Timestamp;

/** When the reviewer last edited a sent comment, if they did. */
const editedAt = (comment: Comment): Timestamp | undefined =>
  comment.source.kind === "reviewer" && comment.source.state === "edited"
    ? comment.source.edited_at
    : undefined;

/**
 * Appends a reply, keeping the conversation in its one order. A reply never goes before an earlier one, nor before
 * the comment's last edit, so whether an edit came after an answer is a comparison of times.
 */
export const appendReply = (
  comment: Comment,
  reply: Reply,
  now: Timestamp,
): Comment => {
  const last = comment.replies.at(-1);
  let created_at =
    last !== undefined &&
    compareReplies(last, { ...reply, created_at: now }) > 0
      ? after(last.created_at)
      : now;
  const edited = editedAt(comment);
  if (edited !== undefined && created_at <= edited) created_at = after(edited);
  return {
    ...comment,
    updated_at: created_at,
    replies: [...comment.replies, { ...reply, created_at }],
  };
};

const ANCHOR_PROBLEMS: Readonly<Record<AnchorProblem["problem"], string>> = {
  no_patch: "the file has no patch",
  no_text: "the round does not hold the file's text",
  changed:
    "the file changed since the page showed it. Select the lines again in the current round",
  out_of_range: "the selected rows are outside the patch",
  no_source_line: "select at least one line of code, not only a hunk header",
  blank:
    "the selected lines are blank. Include a line with code in the selection",
};

const anchorFailure = (problem: AnchorProblem, doing: string) =>
  fail(
    problem.problem === "changed" ? "changed" : "bad_anchor",
    `Cannot ${doing}: ${ANCHOR_PROBLEMS[problem.problem]}.`,
  );

/**
 * How a new comment of the reviewer's starts. A question goes to the agents at once. A plain comment waits, pending,
 * for Finish review, unless the reviewer already finished the round: then it goes at once, since no finish is left to
 * send it.
 */
const reviewerSource = (
  state: ReviewState,
  question: boolean,
): Comment["source"] => {
  if (question) return { kind: "reviewer", state: "sent", question: true };
  return currentSubmission(state) === undefined
    ? { kind: "reviewer", state: "pending" }
    : { kind: "reviewer", state: "sent" };
};

/** A comment on a selection of rows of a file's patch, or of lines of its text, in the current round. */
export const addInlineComment = (
  state: ReviewState,
  context: ActionContext,
  selection: Selection,
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
  const anchor = anchorFor(
    file,
    { round: round.round, input_sha256: round.input_sha256 },
    selection,
  );
  if (isAnchorProblem(anchor)) return anchorFailure(anchor, "comment there");
  const comment: Comment = {
    kind: "inline",
    id: context.commentId(),
    source: reviewerSource(state, question),
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
    source: reviewerSource(state, question),
    body,
    created_at: context.now,
    updated_at: context.now,
    replies: [],
  };
  return Result.succeed({ ...state, comments: [...state.comments, comment] });
};

/**
 * A comment on a stop of the current round's tour, such as one of the questions the stop suggests. The page names the
 * round it showed, so a question never lands on a stop the reviewer has not seen.
 */
export const addStopComment = (
  state: ReviewState,
  context: ActionContext,
  seen: RoundNumber,
  ref: StopRef,
  body: string,
  question = false,
): Outcome => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  if (round.round !== seen)
    return fail(
      "changed",
      `Round ${round.round} was published after the page showed round ${seen}. Ask about the stop as it is now.`,
    );
  const stops = tourView(input).stops;
  const stop = findStop(stops, ref);
  if (stop === undefined)
    return fail(
      "not_found",
      `Round ${round.round}'s tour has no stop “${stopTitle(ref)}”.`,
    );
  const anchor = stopAnchorFor(
    { round: round.round, input_sha256: round.input_sha256 },
    ref,
    stop,
    input,
  );
  const comment: Comment = {
    kind: "stop",
    id: context.commentId(),
    source: reviewerSource(state, question),
    body,
    created_at: context.now,
    updated_at: context.now,
    replies: [],
    anchor,
    attachment: attachStop(anchor, stops, round.round),
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
  if (isPending(comment))
    return fail(
      "invalid",
      "This comment is pending: edit it, or finish the review to send it.",
    );
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
  // A pending comment is not there for the agents: it is refused as a comment that does not exist.
  if (isPending(comment))
    return fail("not_found", `No comment ${id} in this review.`);
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
 * The state with every pending comment sent, as Finish review sends them, and as a fresh start leaves the review it
 * closes, which no finish can send them from.
 */
export const sendPending = (state: ReviewState): ReviewState => ({
  ...state,
  comments: state.comments.map((comment) =>
    isPending(comment)
      ? { ...comment, source: { kind: "reviewer", state: "sent" } }
      : comment,
  ),
});

/**
 * The reviewer finished a round. It must be the current one: a verdict on a round the reviewer has not seen would
 * approve unread code. The finish sends every pending comment with the verdict, in the same change.
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
  const sent = sendPending(state);
  return Result.succeed({
    ...sent,
    submissions: [...sent.submissions, submission],
  });
};

/** One of the reviewer's own comments, which the reviewer may change: not one imported from a git host. */
const ownComment = (
  state: ReviewState,
  id: CommentId,
  doing: string,
): Result.Result<OwnComment, ActionError> => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const found = findComment(state, id);
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const comment = found.success;
  if (!canEdit(comment))
    return fail(
      "invalid",
      `A comment imported from the git host cannot be ${doing} here.`,
    );
  return Result.succeed(comment);
};

/**
 * Changes the body of one of the reviewer's comments. A pending comment stays pending, as nobody has seen it. A sent
 * one is marked edited at this time, so the agents see that the text they read changed; after an answer, the edit
 * returns the comment to them. The same body changes nothing.
 */
export const editComment = (
  state: ReviewState,
  context: ActionContext,
  id: CommentId,
  body: string,
): Outcome => {
  const found = ownComment(state, id, "edited");
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const comment = found.success;
  if (body.trim() === "")
    return fail("invalid", "Write the comment, or delete it.");
  if (body === comment.body) return Result.succeed(state);
  const { source } = comment;
  // An edit comes after every reply, even one made in the same millisecond, so the turn it hands back is clear.
  const last = comment.replies.at(-1)?.created_at;
  const edited: Comment["source"] =
    source.state === "pending"
      ? source
      : {
          kind: "reviewer",
          state: "edited",
          ...(source.question === true ? { question: true } : {}),
          edited_at:
            last !== undefined && context.now <= last
              ? after(last)
              : context.now,
        };
  return Result.succeed(
    replaceComment(state, {
      ...comment,
      source: edited,
      body,
      updated_at: edited.state === "edited" ? edited.edited_at : context.now,
    }),
  );
};

/**
 * Deletes one of the reviewer's comments: a pending one, or a sent one nobody replied to. A comment with replies is
 * part of a conversation, so it stays; withdrawing it takes it back.
 */
export const deleteComment = (state: ReviewState, id: CommentId): Outcome => {
  const found = ownComment(state, id, "deleted");
  if (Result.isFailure(found)) return Result.fail(found.failure);
  if (!canDelete(found.success))
    return fail(
      "invalid",
      "This comment has replies, so it cannot be deleted. Withdraw it instead.",
    );
  return Result.succeed({
    ...state,
    comments: state.comments.filter((comment) => comment.id !== id),
  });
};

/**
 * A new round from a thread: every inline comment reattaches to the new patches, every comment on a stop to the stop
 * of the same identity in the new tour, and approvals stay as they are, holding only where the fingerprint still
 * matches.
 */
export const publishRound = (
  state: ReviewState,
  input: ReviewInput,
  round: Round,
): Outcome => {
  const closed = open(state);
  if (closed !== undefined) return Result.fail(closed);
  const files = new Map(input.files.map((file) => [file.path, file]));
  const stops = tourView(input).stops;
  return Result.succeed({
    ...state,
    rounds: [...state.rounds, round],
    drift: undefined,
    comments: state.comments.map((comment): Comment => {
      switch (comment.kind) {
        case "inline":
          return {
            ...comment,
            attachment: attach(comment.anchor, files.get(comment.anchor.path)),
          };
        case "stop":
          return {
            ...comment,
            attachment: attachStop(comment.anchor, stops, round.round),
          };
        case "general":
          return comment;
      }
    }),
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
  selection: Selection,
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
  const anchor: Anchor | AnchorProblem = anchorFor(
    file,
    { round: round.round, input_sha256: round.input_sha256 },
    selection,
  );
  if (isAnchorProblem(anchor))
    return anchorFailure(anchor, "attach the comment to those lines");
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
    head_sha !== undefined && target.kind !== "worktree"
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
