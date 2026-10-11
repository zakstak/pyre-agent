import * as Schema from "effect/Schema"
import { documentBytes } from "./encoding.ts"
import { FileGroup, FileStatus } from "./input.ts"
import * as Limits from "./limits.ts"
import {
  CommentId,
  CommitSha,
  Fingerprint,
  GitHubCommentId,
  GitHubCommentUrl,
  GitHubLogin,
  InputDigest,
  integer,
  nonEmptyText,
  PatchDigest,
  ReplyId,
  RepoPath,
  ReviewId,
  RoundNumber,
  text,
  ThreadId,
  Timestamp
} from "./primitives.ts"
import { pullRequestKey, Target } from "./target.ts"
import { Thread } from "./thread.ts"

/** The format key of feedback: a review's notes, approvals, and comments, exported or imported as one file. */
export const FEEDBACK_FORMAT = "review-canvas.feedback/1"

const Text = text(Limits.MAX_TEXT_UNITS)
const RequiredText = nonEmptyText(Limits.MAX_TEXT_UNITS)
// GitHub decides what a body may hold: a review summary is often empty, and refusing a body would fail an import.
const GitHubBody = text(Limits.MAX_GITHUB_BODY_UNITS)
const Offset = integer(0, Limits.MAX_OFFSET)
const Row = integer(0, Limits.MAX_ROW)
const SourceLine = integer(1, Limits.MAX_LINE)

/** The index of the first value that repeats an earlier one. */
function firstDuplicate(values: ReadonlyArray<string>): number | undefined {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) return index
    seen.add(value)
  }
  return undefined
}

/** A round of the review, by number and by the digest of its input. */
export const RoundSnapshot = Schema.Struct({ round: RoundNumber, input_sha256: InputDigest })
export type RoundSnapshot = typeof RoundSnapshot.Type

const AnchorFields = Schema.Struct({
  /** The round the selection was made in. */
  snapshot: RoundSnapshot,
  path: RepoPath,
  patch_sha256: PatchDigest,
  /** Zero-based UTF-16 offsets into the patch rows joined with LF; end is exclusive. */
  start: Offset,
  end: Offset,
  quote: RequiredText,
  prefix: text(Limits.MAX_CONTEXT_UNITS),
  suffix: text(Limits.MAX_CONTEXT_UNITS),
  /** Zero-based patch rows, counting hunk headers. */
  start_row: Row,
  end_row: Row,
  /** Deleted lines, alone or with context, are old-side; any other selection is new-side. */
  side: Schema.Literals(["old", "new"]),
  /** Source line numbers on that side, from the first to the last selected row that has one. */
  start_line: SourceLine,
  end_line: SourceLine
})

/**
 * Where a comment points: an exact text selection in one file's patch, with context to find it again in a later
 * round. It never changes when the diff moves.
 */
export const Anchor = AnchorFields.check(Schema.makeFilter((anchor: typeof AnchorFields.Type) => {
  if (anchor.end <= anchor.start || anchor.end - anchor.start !== anchor.quote.length) {
    return { path: ["end"], issue: "must exceed start by the quote's length in UTF-16 code units" }
  }
  if (anchor.end_row < anchor.start_row) return { path: ["end_row"], issue: "must not come before start_row" }
  if (anchor.end_line < anchor.start_line) return { path: ["end_line"], issue: "must not come before start_line" }
  return undefined
}))
export type Anchor = typeof Anchor.Type

const Reason = text(Limits.MAX_ATTACHMENT_REASON_UNITS)
const AttachedFields = Schema.Struct({ state: Schema.Literal("attached"), reason: Reason, start: Offset, end: Offset })

/**
 * Where a comment's anchor lands in the current round: attached at offsets, or an orphan when its code changed,
 * moved ambiguously, or is gone. Attached offsets span the anchor's quote, found again at the anchor's own offsets or
 * by its context. The server derives it; an import never trusts it.
 */
export const Attachment = Schema.Union([
  AttachedFields.check(Schema.makeFilter((attached: typeof AttachedFields.Type) =>
    attached.end > attached.start || { path: ["end"], issue: "must exceed start" }
  )),
  Schema.Struct({ state: Schema.Literal("orphan"), reason: Reason })
])
export type Attachment = typeof Attachment.Type

/**
 * A pull request comment's identity on GitHub, kept so a refresh imports each comment once. Every GitHub comment and
 * reply in a review comes from one pull request: the target's, or the open one of the working tree's branch.
 */
const gitHubFields = {
  id: GitHubCommentId,
  /** Null when GitHub reports no author, as for a deleted account. The page then shows "ghost", as GitHub does. */
  author: Schema.NullOr(GitHubLogin),
  url: GitHubCommentUrl
}

/** Who started a comment: the reviewer on the page, or someone on GitHub, whose comment arrives with its state. */
export const CommentSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reviewer") }),
  Schema.Struct({
    kind: Schema.Literal("github"),
    ...gitHubFields,
    /** Whether the review thread was resolved on GitHub when it was imported. */
    resolved: Schema.Boolean
  })
]).annotate({ expected: "a source whose kind is reviewer or github" })
export type CommentSource = typeof CommentSource.Type

const replyFields = { id: ReplyId, created_at: Timestamp }

export const REVIEWER_ACTIONS = ["accept", "reopen", "reply"] as const
const ReviewerReplyFields = Schema.Struct({
  ...replyFields,
  actor: Schema.Literal("reviewer"),
  /** Accept resolves the comment; reopen and reply return it to the agents. */
  action: Schema.Literals(REVIEWER_ACTIONS),
  body: Text
})

/** The reviewer's answer to the agents. Only an accept may leave the body empty. */
export const ReviewerReply = ReviewerReplyFields.check(Schema.makeFilter((reply: typeof ReviewerReplyFields.Type) =>
  reply.action === "accept" || reply.body.trim() !== "" ||
  { path: ["body"], issue: "must not be empty unless the reply accepts" }
))
export type ReviewerReply = typeof ReviewerReply.Type

/** What fixed a comment: the file version in a round, or a commit. */
export const FixedIn = Schema.Union([Schema.Struct({ fingerprint: Fingerprint }), Schema.Struct({ commit: CommitSha })])
export type FixedIn = typeof FixedIn.Type

export const DISPOSITIONS = ["fixed", "rejected", "deferred", "question"] as const
export type Disposition = (typeof DISPOSITIONS)[number]

// One variant per disposition, keyed by it.
const answerFields = {
  fixed: { disposition: Schema.Literal("fixed"), body: RequiredText, fixed_in: FixedIn },
  /** The body gives the reason. */
  rejected: { disposition: Schema.Literal("rejected"), body: RequiredText },
  deferred: { disposition: Schema.Literal("deferred"), body: RequiredText, blocker: RequiredText },
  question: { disposition: Schema.Literal("question"), body: RequiredText }
} satisfies { readonly [D in Disposition]: Schema.Struct.Fields & { readonly disposition: Schema.Literal<D> } }

const DISPOSITION_EXPECTED = { expected: `a disposition of ${DISPOSITIONS.join(", ")}` }

/**
 * An agent's answer to a comment. A fixed answer names what fixed it, and a deferred one its blocker; no other answer
 * carries either.
 */
export const Answer = Schema.Union([
  Schema.Struct(answerFields.fixed),
  Schema.Struct(answerFields.rejected),
  Schema.Struct(answerFields.deferred),
  Schema.Struct(answerFields.question)
]).annotate(DISPOSITION_EXPECTED)
export type Answer = typeof Answer.Type

const agentFields = { ...replyFields, actor: Schema.Literal("agent"), thread: ThreadId }

/** An {@link Answer} as the review holds it, naming the thread that answered. */
export const AgentReply = Schema.Union([
  Schema.Struct({ ...agentFields, ...answerFields.fixed }),
  Schema.Struct({ ...agentFields, ...answerFields.rejected }),
  Schema.Struct({ ...agentFields, ...answerFields.deferred }),
  Schema.Struct({ ...agentFields, ...answerFields.question })
]).annotate(DISPOSITION_EXPECTED)
export type AgentReply = typeof AgentReply.Type

/** A reply in the comment's GitHub review thread, with its GitHub author. Like a GitHub comment, it may be empty. */
export const GitHubReply = Schema.Struct({
  ...replyFields,
  actor: Schema.Literal("github"),
  github: Schema.Struct(gitHubFields),
  body: GitHubBody
})
export type GitHubReply = typeof GitHubReply.Type

/** One entry in a comment's conversation. */
export const Reply = Schema.Union([ReviewerReply, AgentReply, GitHubReply]).annotate({
  expected: "a reply whose actor is reviewer, agent, or github"
})
export type Reply = typeof Reply.Type

// At one time, an agent's answer comes first and the reviewer's reply last, since an accept or a reopen judges what
// came before it. Replies imported from GitHub sit between.
const ACTOR_ORDER = { agent: 0, github: 1, reviewer: 2 } satisfies { readonly [A in Reply["actor"]]: number }

/**
 * The order of a comment's conversation, as the Python version sorted it: by time, then by actor, then by ID. Times
 * compare as strings, since a timestamp has one spelling. Feedback lists replies in this order, so an import replays
 * them in it, and an export must sort with it.
 */
export const compareReplies = (a: Reply, b: Reply): number =>
  a.created_at !== b.created_at
    ? a.created_at < b.created_at ? -1 : 1
    : ACTOR_ORDER[a.actor] - ACTOR_ORDER[b.actor] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const commentFields = {
  id: CommentId,
  source: CommentSource,
  /**
   * The reviewer's comment holds text, up to {@link Limits.MAX_TEXT_UNITS} units. A GitHub comment may be empty, as a
   * review summary that only approves is, and may run to {@link Limits.MAX_GITHUB_BODY_UNITS} units.
   */
  body: GitHubBody,
  created_at: Timestamp,
  updated_at: Timestamp,
  /** The conversation, in the order {@link compareReplies} gives. */
  replies: Schema.Array(Reply)
}

const CommentFields = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("inline"),
    ...commentFields,
    anchor: Anchor,
    /** Earlier anchors, kept when the reviewer reattaches the comment by hand. */
    history: Schema.Array(Anchor).check(Schema.isMaxLength(Limits.MAX_ANCHOR_HISTORY)),
    attachment: Attachment
  }),
  /** A comment on the whole review, such as a GitHub conversation comment or review summary. */
  Schema.Struct({ kind: Schema.Literal("general"), ...commentFields })
])

/** Whether a GitHub comment URL names a review discussion: an inline comment, in a thread that can be resolved. */
const isDiscussion = (url: GitHubCommentUrl) => url.slice(url.indexOf("#")).startsWith("#discussion_r")

/**
 * A comment the agents must answer: inline on a patch selection, or general. Of GitHub's comments, only review
 * comments are inline, threaded, and resolvable; conversation comments and review summaries are general, and have no
 * GitHub replies and no resolved state.
 */
export const Comment = CommentFields.check(Schema.makeFilter((comment: typeof CommentFields.Type) => {
  if (comment.source.kind === "reviewer") {
    if (comment.body.trim() === "") return { path: ["body"], issue: "must not be empty" }
    if (comment.body.length > Limits.MAX_TEXT_UNITS) {
      return { path: ["body"], issue: `exceeds ${Limits.MAX_TEXT_UNITS} UTF-16 code units` }
    }
  } else if (comment.kind === "inline" && !isDiscussion(comment.source.url)) {
    return { path: ["source", "url"], issue: "an inline GitHub comment is a review comment, with a #discussion_r URL" }
  } else if (comment.kind === "general" && isDiscussion(comment.source.url)) {
    return {
      path: ["source", "url"],
      issue: "a general GitHub comment is a conversation comment or review summary, not a #discussion_r URL"
    }
  } else if (comment.kind === "general" && comment.source.resolved) {
    return { path: ["source", "resolved"], issue: "only a review thread can be resolved on GitHub" }
  }
  // An attachment is where the anchor's quote was found again, exactly or by its context, so it spans the quote.
  if (comment.kind === "inline" && comment.attachment.state === "attached") {
    const { start, end } = comment.attachment
    if (end - start !== comment.anchor.quote.length) {
      return { path: ["attachment", "end"], issue: "must exceed start by the anchor quote's length in UTF-16 code units" }
    }
  }
  const thread = comment.kind === "inline" && comment.source.kind === "github" ? comment.source : undefined
  for (const [index, reply] of comment.replies.entries()) {
    if (reply.actor !== "github") continue
    if (thread === undefined) {
      return { path: ["replies", index], issue: "a GitHub reply belongs only under an inline comment from GitHub" }
    }
    if (!isDiscussion(reply.github.url) || pullRequestKey(reply.github.url) !== pullRequestKey(thread.url)) {
      return {
        path: ["replies", index, "github", "url"],
        issue: "expected a #discussion_r URL on the comment's pull request"
      }
    }
  }
  const count = (actor: Reply["actor"]) => comment.replies.filter((reply) => reply.actor === actor).length
  if (count("reviewer") > Limits.MAX_REVIEWER_REPLIES) {
    return { path: ["replies"], issue: `holds more than ${Limits.MAX_REVIEWER_REPLIES} reviewer replies` }
  }
  if (count("github") > Limits.MAX_GITHUB_REPLIES) {
    return { path: ["replies"], issue: `holds more than ${Limits.MAX_GITHUB_REPLIES} GitHub replies` }
  }
  // An import replays replies in order, and the last one decides whose turn it is, so one order is the only order.
  // Equal keys mean a repeated ID, which the feedback's ID check reports.
  let previous: Reply | undefined
  for (const [index, reply] of comment.replies.entries()) {
    if (previous !== undefined && compareReplies(previous, reply) > 0) {
      return {
        path: ["replies", index],
        issue: `is out of order in comment ${comment.id}: ` +
          "replies go by created_at, then agent, GitHub, and reviewer, then ID"
      }
    }
    previous = reply
  }
  return undefined
}))
export type Comment = typeof Comment.Type

/**
 * The reviewer approved one exact version of a file. The approval holds while the file's fingerprint matches, and is
 * shared by every thread of the review.
 */
export const Approval = Schema.Struct({
  path: RepoPath,
  fingerprint: Fingerprint,
  approved_at: Timestamp,
  /** The round of this review the approval was made in, or carried into. */
  round: RoundNumber,
  /** For an approval a fresh start carried over: the earlier review and its round. */
  carried_from: Schema.optionalKey(Schema.Struct({ review: ReviewId, round: RoundNumber }))
})
export type Approval = typeof Approval.Type

/** A file of a round, with the reviewer's notes on it. */
export const FeedbackFile = Schema.Struct({ path: RepoPath, status: FileStatus, group: FileGroup, notes: Text })
export type FeedbackFile = typeof FeedbackFile.Type

const FeedbackFiles = Schema.Array(FeedbackFile).check(
  Schema.isMaxLength(Limits.MAX_FILES),
  Schema.makeFilter((files: ReadonlyArray<FeedbackFile>) => {
    const index = firstDuplicate(files.map((file) => file.path))
    return index === undefined || { path: [index, "path"], issue: "duplicate file path" }
  })
)

/** The notes of an earlier round, kept so a new round does not lose them. It lists only the files with notes. */
export const EarlierRound = Schema.Struct({
  round: RoundNumber,
  input_sha256: InputDigest,
  general_notes: Text,
  files: FeedbackFiles
})
export type EarlierRound = typeof EarlierRound.Type

const FeedbackFields = Schema.Struct({
  format: Schema.Literal(FEEDBACK_FORMAT),
  target: Target,
  /** The round the feedback describes, normally the review's latest. */
  round: RoundNumber,
  input_sha256: InputDigest,
  exported_at: Timestamp,
  general_notes: Text,
  files: FeedbackFiles,
  /** Approvals for files outside this round stay, so a file that returns unchanged is approved again. */
  approvals: Schema.Array(Approval).check(Schema.isMaxLength(Limits.MAX_APPROVALS)),
  /** The review's threads, including every thread an answer names. Thread tokens never appear in feedback. */
  threads: Schema.Array(Thread).check(Schema.isMaxLength(Limits.MAX_THREADS)),
  comments: Schema.Array(Comment).check(Schema.isMaxLength(Limits.MAX_COMMENTS)),
  earlier_rounds: Schema.Array(EarlierRound).check(Schema.isMaxLength(Limits.MAX_EARLIER_ROUNDS))
})
type FeedbackFields = typeof FeedbackFields.Type

/** The UTF-16 code units of every note, body, blocker, quote, and anchor path, which together have a budget. */
export const feedbackTextUnits = (
  feedback: Pick<FeedbackFields, "general_notes" | "files" | "comments" | "earlier_rounds">
): number => {
  const notes = (round: { readonly general_notes: string; readonly files: ReadonlyArray<FeedbackFile> }) =>
    round.files.reduce((total, file) => total + file.notes.length, round.general_notes.length)
  let total = notes(feedback) + feedback.earlier_rounds.reduce((sum, round) => sum + notes(round), 0)
  for (const comment of feedback.comments) {
    total += comment.body.length
    if (comment.kind === "inline") {
      for (const anchor of [comment.anchor, ...comment.history]) total += anchor.quote.length + anchor.path.length
    }
    for (const reply of comment.replies) {
      total += reply.body.length
      if (reply.actor === "agent" && reply.disposition === "deferred") total += reply.blocker.length
    }
  }
  return total
}

const OTHER_DIGEST = "differs from another digest of this round"

const feedbackRules = Schema.makeFilter((feedback: FeedbackFields) => {
  const approval = firstDuplicate(feedback.approvals.map((item) => item.path))
  if (approval !== undefined) return { path: ["approvals", approval, "path"], issue: "duplicate approval path" }
  const later = feedback.approvals.findIndex((item) => item.round > feedback.round)
  if (later !== -1) return { path: ["approvals", later, "round"], issue: "is after the feedback's round" }

  const thread = firstDuplicate(feedback.threads.map((item) => item.id))
  if (thread !== undefined) return { path: ["threads", thread, "id"], issue: "duplicate thread ID" }
  const threads = new Set<string>(feedback.threads.map((item) => item.id))

  // Each round has one input, so every place that names a round must give it the same digest.
  const digests = new Map<number, string>([[feedback.round, feedback.input_sha256]])
  const sameDigest = (snapshot: RoundSnapshot) => {
    const known = digests.get(snapshot.round)
    if (known === undefined) digests.set(snapshot.round, snapshot.input_sha256)
    return known === undefined || known === snapshot.input_sha256
  }

  const round = firstDuplicate(feedback.earlier_rounds.map((item) => String(item.round)))
  if (round !== undefined) return { path: ["earlier_rounds", round, "round"], issue: "duplicate round" }
  for (const [index, earlier] of feedback.earlier_rounds.entries()) {
    if (earlier.round >= feedback.round) {
      return { path: ["earlier_rounds", index, "round"], issue: "is not before the feedback's round" }
    }
    if (!sameDigest(earlier)) {
      return { path: ["earlier_rounds", index, "input_sha256"], issue: OTHER_DIGEST }
    }
  }

  // GitHub IDs are unique, and every GitHub comment comes from one pull request: the target's, or for a working tree
  // the one its first GitHub comment names. Pull requests compare by key, since GitHub ignores the case of names.
  const gitHubIds = new Set<string>()
  let pullRequest = feedback.target.kind === "github_pr" ? pullRequestKey(feedback.target.url) : undefined
  const fromGitHub = (
    github: { readonly id: string; readonly url: GitHubCommentUrl },
    at: ReadonlyArray<PropertyKey>
  ): Schema.FilterIssue | undefined => {
    if (gitHubIds.has(github.id)) return { path: [...at, "id"], issue: "duplicate GitHub comment ID" }
    gitHubIds.add(github.id)
    const page = pullRequestKey(github.url)
    pullRequest ??= page
    if (page === pullRequest) return undefined
    return {
      path: [...at, "url"],
      issue: feedback.target.kind === "github_pr"
        ? "is not a comment on the target's pull request"
        : "is on another pull request than the review's other GitHub comments"
    }
  }

  const commentIds = new Set<string>()
  const replyIds = new Set<string>()
  let answers = 0
  for (const [index, comment] of feedback.comments.entries()) {
    if (commentIds.has(comment.id)) return { path: ["comments", index, "id"], issue: "duplicate comment ID" }
    commentIds.add(comment.id)
    if (comment.source.kind === "github") {
      const problem = fromGitHub(comment.source, ["comments", index, "source"])
      if (problem !== undefined) return problem
    }
    if (comment.kind === "inline") {
      for (const [position, anchor] of [comment.anchor, ...comment.history].entries()) {
        const at = position === 0 ? ["anchor", "snapshot"] : ["history", position - 1, "snapshot"]
        if (anchor.snapshot.round > feedback.round) {
          return { path: ["comments", index, ...at, "round"], issue: "is after the feedback's round" }
        }
        if (!sameDigest(anchor.snapshot)) {
          return { path: ["comments", index, ...at, "input_sha256"], issue: OTHER_DIGEST }
        }
      }
    }
    for (const [position, reply] of comment.replies.entries()) {
      const at = ["comments", index, "replies", position]
      if (replyIds.has(reply.id)) return { path: [...at, "id"], issue: "duplicate reply ID" }
      replyIds.add(reply.id)
      if (reply.actor === "agent") {
        answers++
        if (!threads.has(reply.thread)) return { path: [...at, "thread"], issue: "names no thread in threads" }
      }
      if (reply.actor === "github") {
        const problem = fromGitHub(reply.github, [...at, "github"])
        if (problem !== undefined) return problem
      }
    }
  }
  if (answers > Limits.MAX_AGENT_ANSWERS) {
    return { path: ["comments"], issue: `hold more than ${Limits.MAX_AGENT_ANSWERS} agent answers` }
  }
  if (feedbackTextUnits(feedback) > Limits.MAX_FEEDBACK_TEXT_UNITS) {
    return `notes, comments, and replies exceed ${Limits.MAX_FEEDBACK_TEXT_UNITS} UTF-16 code units together`
  }
  // The rule every other limit only approaches: written as a document, feedback fits its byte limit, so an export
  // always imports again. The text budget counts UTF-16 units, which can take up to 3 bytes each.
  const bytes = documentBytes(feedback).byteLength
  if (bytes > Limits.MAX_FEEDBACK_BYTES) {
    return `takes ${bytes} bytes as exported JSON, more than ${Limits.MAX_FEEDBACK_BYTES / 1024 / 1024} MiB`
  }
  return undefined
})

/**
 * A review's feedback as one file: the round it describes, the reviewer's notes, approvals, comments with their
 * conversations, and the threads that answered. Export writes it; import replays its comments and replies as actions.
 * Only replies have a required order. Comments, approvals, threads, and earlier rounds are keyed by a unique ID,
 * path, or round, and none depends on another, so their order changes nothing.
 */
export const Feedback = FeedbackFields.check(feedbackRules)
export type Feedback = typeof Feedback.Type
