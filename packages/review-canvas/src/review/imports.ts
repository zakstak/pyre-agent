/**
 * Imports into a review: a feedback file, and a pull request's GitHub comments. Both add what the review does not
 * hold yet, under the same turn rules as the actions that make it, and report what they left out and why.
 */
import * as Result from "effect/Result";
import type {
  Anchor,
  Approval,
  Attachment,
  Comment,
  Feedback,
  Reply,
  RoundSnapshot,
} from "../schema/feedback.ts";
import { compareReplies } from "../schema/feedback.ts";
import type { GitHubItem, GitHubPost, GitHubThread } from "../schema/github.ts";
import type { ReviewFile } from "../schema/input.ts";
import type { CommitSha, ReplyId, Timestamp } from "../schema/primitives.ts";
import { targetKey } from "../schema/target.ts";
import type { Thread } from "../schema/thread.ts";
import { anchorAt, attach } from "./anchor.ts";
import { attachedRows, parseRows, type Row } from "./patch.ts";
import { type ActionContext, ActionError, appendReply, withRound } from "./state.ts";
import { type ReviewState, type Turn } from "./queries.ts";

export interface ImportReport {
  readonly comments: number;
  readonly replies: number;
  readonly approvals: number;
  /** Comments the review already held, by ID or GitHub ID. */
  readonly already: number;
  /** Threads the review already held whose resolution on GitHub changed since the last import. */
  readonly resolutions: number;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * A turn while replaying a comment's replies. `github` is a GitHub thread after its opening post or a GitHub reply:
 * GitHub's resolution decides between the agents' turn and resolved there, and a feedback document holds only the
 * resolution of its last import, not the one each reply was made under. Either is accepted.
 */
type ReplayTurn = Turn | "github";

/** The turn after a reply, or undefined when the reply was not its author's to make. */
const nextTurn = (turn: ReplayTurn, reply: Reply): ReplayTurn | undefined => {
  if (turn === "github")
    return nextTurn("agent", reply) ?? nextTurn("resolved", reply);
  switch (reply.actor) {
    case "agent":
      return turn === "agent" ? "reviewer" : undefined;
    case "github":
      return "github";
    case "reviewer":
      if (reply.action === "reopen")
        return turn === "resolved" ? "agent" : undefined;
      if (turn === "resolved") return undefined;
      return reply.action === "accept" ? "resolved" : "agent";
  }
};

const startTurn = (source: Comment["source"]): ReplayTurn =>
  source.kind === "github" ? "github" : "agent";

/** Every GitHub ID a review holds, on comments and replies, so an import adds each GitHub comment once. */
const gitHubIds = (comments: ReadonlyArray<Comment>): Set<string> => {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (comment.source.kind === "github") ids.add(comment.source.id);
    for (const reply of comment.replies)
      if (reply.actor === "github") ids.add(reply.github.id);
  }
  return ids;
};

const replyIds = (comments: ReadonlyArray<Comment>): Set<string> =>
  new Set(
    comments.flatMap((comment) => comment.replies.map((reply) => reply.id)),
  );

/**
 * An imported inline anchor in the current round. Where its quote attaches, it becomes an anchor of the current
 * patch; where it does not, it keeps its quote and context, now named as of the current round, and stays an orphan.
 */
const reanchor = (
  anchor: Anchor,
  file: ReviewFile | undefined,
  snapshot: RoundSnapshot,
): Anchor => {
  const found = attach(anchor, file);
  if (found.state === "attached" && file?.patch !== undefined) {
    const moved = anchorAt(file.patch, file.path, snapshot, {
      start: found.start,
      end: found.end,
      side: anchor.side,
    });
    if (!("kind" in moved)) return moved;
  }
  return { ...anchor, snapshot };
};

export interface FeedbackImport {
  readonly state: ReviewState;
  readonly report: ImportReport;
  /** Threads the imported answers name that the review does not have yet. */
  readonly threads: ReadonlyArray<Thread>;
}

/**
 * Imports a feedback file of the same target. Approvals carry where the file is unchanged. Comments the review
 * lacks are added with their replies, up to the first reply that was not its author's turn. Notes and submissions
 * are not imported: a finish belongs to the round the reviewer read.
 */
export const importFeedback = (
  state: ReviewState,
  context: ActionContext,
  feedback: Feedback,
  knownThreads: ReadonlySet<string>,
): Result.Result<FeedbackImport, ActionError> => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  if (targetKey(feedback.target) !== targetKey(state.target)) {
    return Result.fail(
      new ActionError(
        "invalid",
        "This feedback is for another target than the review.",
      ),
    );
  }
  const snapshot = { round: round.round, input_sha256: round.input_sha256 };
  const files = new Map(input.files.map((file) => [file.path, file]));
  const skipped: Array<string> = [];

  let approvals: Array<Approval> = [...state.approvals];
  let approvalCount = 0;
  for (const approval of feedback.approvals) {
    const file = files.get(approval.path);
    if (file === undefined) continue;
    if (file.fingerprint !== approval.fingerprint) {
      skipped.push(
        `The approval of ${approval.path}: the file changed since it was approved.`,
      );
      continue;
    }
    if (
      approvals.some(
        (item) =>
          item.path === approval.path &&
          item.fingerprint === approval.fingerprint,
      )
    )
      continue;
    approvals = [
      ...approvals.filter((item) => item.path !== approval.path),
      {
        path: approval.path,
        fingerprint: approval.fingerprint,
        approved_at: approval.approved_at,
        round: round.round,
      },
    ];
    approvalCount++;
  }

  const comments: Array<Comment> = [...state.comments];
  const ids = new Set(comments.map((comment) => comment.id));
  const github = gitHubIds(comments);
  const usedReplyIds = replyIds(comments);
  const threads = new Map<string, Thread>();
  let commentCount = 0;
  let replyCount = 0;
  let already = 0;
  for (const imported of feedback.comments) {
    const same = comments.find((comment) => comment.id === imported.id);
    if (
      (same !== undefined &&
        same.created_at === imported.created_at &&
        same.body === imported.body) ||
      (imported.source.kind === "github" && github.has(imported.source.id))
    ) {
      already++;
      continue;
    }
    let turn = startTurn(imported.source);
    const kept: Array<Reply> = [];
    for (const reply of imported.replies) {
      if (reply.actor === "github" && github.has(reply.github.id)) continue;
      const next = nextTurn(turn, reply);
      if (next === undefined) {
        skipped.push(
          `Comment ${imported.id}: ${imported.replies.length - kept.length} replies, from the first one out of turn, were left out.`,
        );
        break;
      }
      if (reply.actor === "agent" && !knownThreads.has(reply.thread)) {
        const thread = feedback.threads.find(
          (item) => item.id === reply.thread,
        );
        if (thread !== undefined) threads.set(thread.id, thread);
      }
      const id = usedReplyIds.has(reply.id) ? context.replyId() : reply.id;
      usedReplyIds.add(id);
      kept.push({ ...reply, id } as Reply);
      turn = next;
    }
    const id = ids.has(imported.id) ? context.commentId() : imported.id;
    ids.add(id);
    const updated_at = (kept.at(-1)?.created_at ??
      imported.created_at) as Timestamp;
    if (imported.kind === "inline") {
      const file = files.get(imported.anchor.path);
      const anchor = reanchor(imported.anchor, file, snapshot);
      comments.push({
        ...imported,
        id,
        updated_at,
        replies: kept,
        anchor,
        history: [],
        attachment: attach(anchor, file),
      });
    } else {
      comments.push({ ...imported, id, updated_at, replies: kept });
    }
    commentCount++;
    replyCount += kept.length;
  }

  const notes =
    feedback.general_notes.trim() !== "" ||
    feedback.files.some((file) => file.notes.trim() !== "") ||
    feedback.earlier_rounds.length > 0;
  if (notes)
    skipped.push("Notes are not imported; comments carry the review now.");
  if ((feedback.submissions ?? []).length > 0)
    skipped.push(
      "Finished rounds are not imported: a finish belongs to the round the reviewer read.",
    );

  return Result.succeed({
    state: { ...state, approvals, comments },
    report: {
      comments: commentCount,
      replies: replyCount,
      approvals: approvalCount,
      already,
      resolutions: 0,
      skipped,
    },
    threads: [...threads.values()],
  });
};

const sideOf = (side: GitHubThread["side"]) =>
  side === "LEFT" ? ("old" as const) : ("new" as const);

/**
 * The anchor of rows `from` through `end` of a patch. A span of blank lines takes in the rows before it, within its
 * hunk, since a blank quote could never be found again.
 */
const spanAnchor = (
  patch: string,
  rows: ReadonlyArray<Row>,
  path: GitHubThread["path"],
  snapshot: RoundSnapshot,
  side: "old" | "new",
  from: number,
  end: number,
): Anchor | undefined => {
  const last = rows[end];
  if (last === undefined) return undefined;
  for (let at = from; at >= 0; at--) {
    const first = rows[at];
    if (first === undefined || first.kind === "hunk") break;
    if (first.kind === "meta") continue;
    const anchor = anchorAt(patch, path, snapshot, {
      start: first.offset,
      end: last.offset + last.text.length,
      side,
    });
    if (!("kind" in anchor)) return anchor;
    if (anchor.kind !== "blank") return undefined;
  }
  return undefined;
};

/**
 * The anchor of a GitHub review thread: the commented lines at the end of its diff hunk, on the thread's side, from
 * the first line the comment was written on.
 */
export const gitHubAnchor = (
  thread: GitHubThread,
  snapshot: RoundSnapshot,
): Anchor | undefined => {
  const side = sideOf(thread.side);
  const rows = parseRows(thread.diff_hunk);
  const end = rows.findLastIndex((row) => row[side] !== undefined);
  const last = rows[end];
  if (last === undefined) return undefined;
  const startSide =
    thread.start_side === undefined ? side : sideOf(thread.start_side);
  const firstLine = thread.start_line ?? last[side] ?? 0;
  const from = rows.findIndex(
    (row, at) => at <= end && (row[startSide] ?? 0) >= firstLine,
  );
  return spanAnchor(
    thread.diff_hunk,
    rows,
    thread.path,
    snapshot,
    side,
    from === -1 ? end : from,
    end,
  );
};

/**
 * A thread placed where GitHub shows it on the head the round shows: it ends on GitHub's line and spans as many lines
 * on its side as the comment did, within one hunk. GitHub keeps a thread current while its last line is unchanged,
 * so the lines above it may differ from the quote.
 */
const placedAnchor = (
  thread: GitHubThread,
  file: ReviewFile,
  snapshot: RoundSnapshot,
  lines: number,
): Anchor | undefined => {
  if (thread.line === undefined || file.patch === undefined) return undefined;
  const side = sideOf(thread.side);
  const rows = parseRows(file.patch);
  const end = rows.findIndex((row) => row[side] === thread.line);
  if (end === -1) return undefined;
  let from = end;
  for (let counted = 1; counted < lines;) {
    const before = rows[from - 1];
    if (before === undefined || before.kind === "hunk") break;
    from--;
    if (before[side] !== undefined) counted++;
  }
  return spanAnchor(file.patch, rows, thread.path, snapshot, side, from, end);
};

/**
 * Where an imported thread goes in the round. Its quote, found again in the round's patch, places it, unless the
 * round shows the head GitHub read and the quote is missing or ends on another line than GitHub's: then GitHub's
 * line does.
 */
const gitHubPlacement = (
  thread: GitHubThread,
  file: ReviewFile | undefined,
  snapshot: RoundSnapshot,
  onHead: boolean,
): { readonly anchor: Anchor; readonly attachment: Attachment } | undefined => {
  const quoted = gitHubAnchor(thread, snapshot);
  const found =
    quoted === undefined
      ? undefined
      : { anchor: quoted, attachment: attach(quoted, file) };
  if (!onHead || thread.line === undefined || file?.patch === undefined)
    return found;
  const side = sideOf(thread.side);
  const rows = parseRows(file.patch);
  const span =
    found === undefined ? undefined : attachedRows(rows, found.attachment);
  if (span !== undefined && rows[span.end]?.[side] === thread.line)
    return found;
  const lines =
    quoted === undefined ? 1 : quoted.end_line - quoted.start_line + 1;
  const placed = placedAnchor(thread, file, snapshot, lines);
  return placed === undefined
    ? found
    : {
        anchor: placed,
        attachment: {
          state: "attached",
          reason: "Placed on the line GitHub shows it on at this head.",
          start: placed.start,
          end: placed.end,
        },
      };
};

const gitHubReply = (post: GitHubPost, id: ReplyId): Reply => ({
  id,
  created_at: post.created_at,
  actor: "github",
  github: { id: post.id, author: post.author, url: post.url },
  body: post.body,
});

/**
 * Imports a pull request's GitHub comments: review threads become inline comments found again by their quote, and
 * conversation comments and review summaries become general ones. A comment the review already holds gets only its
 * new replies and GitHub's current resolution. Each arrives as the agents' turn, except a thread GitHub shows
 * resolved. `head` is the commit GitHub numbered the threads' current lines on; a round of that pull request head can
 * place a thread by them.
 */
export const importGitHub = (
  state: ReviewState,
  context: ActionContext,
  items: ReadonlyArray<GitHubItem>,
  head?: CommitSha,
): Result.Result<
  { readonly state: ReviewState; readonly report: ImportReport },
  ActionError
> => {
  const current = withRound(state, context);
  if (Result.isFailure(current)) return Result.fail(current.failure);
  const { round, input } = current.success;
  const snapshot = { round: round.round, input_sha256: round.input_sha256 };
  const onHead =
    head !== undefined &&
    input.target.kind === "github_pr" &&
    input.target.head_sha.toLowerCase() === head.toLowerCase();
  const files = new Map(input.files.map((file) => [file.path, file]));
  const comments: Array<Comment> = [...state.comments];
  const github = gitHubIds(comments);
  const skipped: Array<string> = [];
  let commentCount = 0;
  let replyCount = 0;
  let already = 0;
  let resolutions = 0;
  const sortedReplies = (posts: ReadonlyArray<GitHubPost>) =>
    posts
      .filter((post) => !github.has(post.id))
      .map((post) => gitHubReply(post, context.replyId()))
      .sort(compareReplies);

  for (const item of items) {
    if (item.kind === "thread") {
      const at = comments.findIndex(
        (comment) =>
          comment.source.kind === "github" && comment.source.id === item.id,
      );
      const existing = comments[at];
      if (existing !== undefined) {
        already++;
        let updated = existing;
        if (
          updated.source.kind === "github" &&
          updated.source.resolved !== item.resolved
        ) {
          updated = {
            ...updated,
            source: { ...updated.source, resolved: item.resolved },
          };
          resolutions++;
        }
        for (const post of item.replies) {
          if (github.has(post.id)) continue;
          updated = appendReply(
            updated,
            gitHubReply(post, context.replyId()),
            post.created_at,
          );
          github.add(post.id);
          replyCount++;
        }
        comments[at] = updated;
        continue;
      }
      const placement = gitHubPlacement(
        item,
        files.get(item.path),
        snapshot,
        onHead,
      );
      if (placement === undefined) {
        skipped.push(
          `${item.url}: its diff hunk shows no line on the ${item.side === "LEFT" ? "old" : "new"} side.`,
        );
        continue;
      }
      const replies = sortedReplies(item.replies);
      comments.push({
        kind: "inline",
        id: context.commentId(),
        source: {
          kind: "github",
          id: item.id,
          author: item.author,
          url: item.url,
          resolved: item.resolved,
        },
        body: item.body,
        created_at: item.created_at,
        updated_at: (replies.at(-1)?.created_at ??
          item.created_at) as Timestamp,
        replies,
        anchor: placement.anchor,
        history: [],
        attachment: placement.attachment,
      });
      github.add(item.id);
      for (const post of item.replies) github.add(post.id);
      commentCount++;
      replyCount += replies.length;
      continue;
    }
    if (github.has(item.id)) {
      already++;
      continue;
    }
    comments.push({
      kind: "general",
      id: context.commentId(),
      source: {
        kind: "github",
        id: item.id,
        author: item.author,
        url: item.url,
        resolved: false,
      },
      body: item.body,
      created_at: item.created_at,
      updated_at: item.created_at,
      replies: [],
    });
    github.add(item.id);
    commentCount++;
  }
  return Result.succeed({
    state: { ...state, comments },
    report: {
      comments: commentCount,
      replies: replyCount,
      approvals: 0,
      already,
      resolutions,
      skipped,
    },
  });
};
