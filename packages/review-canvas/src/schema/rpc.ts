/**
 * Everything a page asks of the server, as one RPC group over a WebSocket. The server implements it in
 * server/rpc.ts; the page calls it through client/rpc.ts. Payloads, results, and refusals are schemas, so both sides
 * decode what crosses the socket.
 */
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { REVIEWER_ACTIONS, VERDICTS } from "./feedback.ts";
import { ReviewInput } from "./input.ts";
import * as Limits from "./limits.ts";
import {
  CommentId,
  Count,
  Fingerprint,
  integer,
  nonEmptyText,
  PatchDigest,
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
  text,
  Timestamp,
  WorktreeRoot,
  PullRequestUrl,
} from "./primitives.ts";
import { RepositoryId, RepositoryIdentity } from "./repositories.ts";
import { ReviewState } from "./state.ts";
import { Target } from "./target.ts";
import {
  ComparisonRequest,
  PullScope,
  RepositoryPullRequests,
  PullRequestSnapshot,
} from "./pull-requests.ts";
import { Thread } from "./thread.ts";

/**
 * Why the server refused a request, in words the page shows. `kind` names the rule; `revision` is the review's
 * current revision when the refusal is that the page acted on an older one.
 */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  kind: Schema.String,
  message: Schema.String,
  revision: Schema.optional(Revision),
}) {}

const Row = integer(0, Limits.MAX_ROW);
const Body = text(Limits.MAX_TEXT_UNITS);
const RequiredBody = nonEmptyText(Limits.MAX_TEXT_UNITS);

/** Whole rows of one file's patch. The digest names the patch the page showed, so rows cannot land on another. */
export const Selection = Schema.Struct({
  path: RepoPath,
  patch_sha256: PatchDigest,
  start_row: Row,
  end_row: Row,
});
export type Selection = typeof Selection.Type;

/** A change a page asks for. */
export const PageAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("comment"),
    selection: Selection,
    body: RequiredBody,
    /** Ask now: the agents answer without waiting for the round to finish. */
    question: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("general_comment"),
    body: RequiredBody,
    question: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    comment: CommentId,
    action: Schema.Literals(REVIEWER_ACTIONS),
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("approve"),
    path: RepoPath,
    fingerprint: Fingerprint,
  }),
  Schema.Struct({ kind: Schema.Literal("unapprove"), path: RepoPath }),
  Schema.Struct({
    kind: Schema.Literal("submit"),
    round: RoundNumber,
    verdict: Schema.Literals(VERDICTS),
    body: Body,
  }),
  Schema.Struct({
    kind: Schema.Literal("reattach"),
    comment: CommentId,
    selection: Selection,
  }),
]).annotate({
  expected:
    "an action whose kind is comment, general_comment, reply, approve, unapprove, submit, or reattach",
});
export type PageAction = typeof PageAction.Type;

/** A review as an open page follows it: everything that changes, at one revision. Round inputs come separately. */
export const ReviewSnapshot = Schema.Struct({
  state: ReviewState,
  revision: Revision,
  threads: Schema.Array(Thread),
  /** The review that replaced this one with a fresh start, if this one is closed. */
  replaced_by: Schema.optional(ReviewId),
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;

/**
 * One round's input, which never changes once published, with each patch's digest: a comment's selection names the
 * patch it was made on, and the page cannot hash synchronously.
 */
export const RoundView = Schema.Struct({
  input: ReviewInput,
  digests: Schema.Record(RepoPath, PatchDigest),
});
export type RoundView = typeof RoundView.Type;

/** What a round before the current one said. */
export const EarlierRound = Schema.Struct({
  round: RoundNumber,
  summary: Schema.optional(Schema.String),
});
export type EarlierRound = typeof EarlierRound.Type;

/** What an imported feedback file added, and what it left out and why. */
export const ImportReport = Schema.Struct({
  comments: Count,
  replies: Count,
  approvals: Count,
  /** Comments the review already held, by ID or GitHub ID. */
  already: Count,
  /** Threads the review already held whose resolution on GitHub changed since the last import. */
  resolutions: Count,
  skipped: Schema.Array(Schema.String),
});
export type ImportReport = typeof ImportReport.Type;

/** How far the reviewer is with a review's current round, as the home page counts it. */
export const SummaryProgress = Schema.Struct({
  viewable: Count,
  viewed: Count,
  forYou: Count,
  waiting: Count,
  pending: Count,
});

/** A review as the home page lists it. */
export const ReviewSummary = Schema.Struct({
  id: ReviewId,
  target: Target,
  created_at: Timestamp,
  closed_at: Schema.optional(Timestamp),
  revision: Revision,
  round: Schema.optional(RoundNumber),
  open_comments: Count,
  comments: Count,
  approvals: Count,
  files: Schema.optional(Count),
  submitted: Schema.Boolean,
  threads: Schema.Array(Thread),
  /** The review this one replaced with a fresh start, if any. */
  carry_from: Schema.optional(ReviewId),
  /** When the current round was published. */
  published_at: Schema.optional(Timestamp),
  /** The verdict the reviewer finished the current round with. */
  verdict: Schema.optional(Schema.Literals(VERDICTS)),
  progress: Schema.optional(SummaryProgress),
  /** Files an agent found changed since the current round. */
  drift: Schema.optional(Count),
});
export type ReviewSummary = typeof ReviewSummary.Type;

/** A checkout's branch and changed items, or why they could not be read. */
export const CheckoutStatus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    branch: Schema.NullOr(Schema.String),
    changed: Count,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: Schema.String,
    /** The reason in a few words: another repository, status unreadable, or directory missing. */
    reason: Schema.String,
  }),
]);
export type CheckoutStatus = typeof CheckoutStatus.Type;

export const Checkout = Schema.Struct({
  root: WorktreeRoot,
  /** The path with the home folder as `~`. */
  shown: Schema.String,
  /** Read only for monitored repositories. */
  status: Schema.optional(CheckoutStatus),
});
export type Checkout = typeof Checkout.Type;

/** A repository with its copies on this machine, monitored or only discovered. */
export const RepositoryEntry = Schema.Struct({
  id: RepositoryId,
  identity: RepositoryIdentity,
  /** `acme/ledger` for a remote, the folder name otherwise. */
  name: Schema.String,
  /** `github.com` for a remote, `no remote` otherwise. */
  host: Schema.String,
  /** The whole remote address or folder name, for labels and filtering. */
  full_name: Schema.String,
  monitored: Schema.Boolean,
  checkouts: Schema.NonEmptyArray(Checkout),
  /** Pull request reviews whose GitHub URL names this repository. */
  pull_requests: Schema.Array(ReviewId),
});
export type RepositoryEntry = typeof RepositoryEntry.Type;

export const HomeSnapshot = Schema.Struct({
  reviews: Schema.Array(ReviewSummary),
  repositories: Schema.Array(RepositoryEntry),
  /** The scanned directories, with the home folder as `~`. */
  roots: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type HomeSnapshot = typeof HomeSnapshot.Type;

const reviewId = { id: ReviewId };

export class PageRpcs extends RpcGroup.make(
  Rpc.make("home.load", {
    payload: {
      /** A directory to scan instead of the server's scan directories. */
      root: Schema.optional(text(Limits.MAX_PATH_UNITS)),
    },
    success: HomeSnapshot,
  }),
  Rpc.make("repositories.pulls", {
    payload: { id: RepositoryId, scope: Schema.optional(PullScope) },
    success: RepositoryPullRequests,
  }),
  Rpc.make("pulls.read", {
    payload: {
      id: RepositoryId,
      url: PullRequestUrl,
      comparison: Schema.optional(ComparisonRequest),
    },
    success: PullRequestSnapshot,
  }),
  Rpc.make("repositories.accept", {
    payload: { root: WorktreeRoot, id: RepositoryId },
    error: Refused,
  }),
  Rpc.make("repositories.remove", {
    payload: { id: RepositoryId },
  }),
  Rpc.make("review.watch", {
    payload: reviewId,
    success: ReviewSnapshot,
    error: Refused,
    stream: true,
  }),
  Rpc.make("review.round", {
    payload: { ...reviewId, round: RoundNumber },
    success: RoundView,
    error: Refused,
  }),
  /** The summaries of the rounds before `round`, for the rounds line. */
  Rpc.make("review.earlier", {
    payload: { ...reviewId, round: RoundNumber },
    success: Schema.Array(EarlierRound),
    error: Refused,
  }),
  Rpc.make("review.act", {
    payload: {
      ...reviewId,
      action: PageAction,
      /** The revision the page saw. The server refuses the action when the review moved on. */
      revision: Schema.optional(Revision),
    },
    success: Schema.Struct({ revision: Revision }),
    error: Refused,
  }),
  Rpc.make("review.import", {
    payload: {
      ...reviewId,
      /** The feedback file as the reviewer chose it; the server decodes it with the document's rules. */
      text: Schema.String.check(Schema.isMaxLength(Limits.MAX_FEEDBACK_BYTES)),
      revision: Schema.optional(Revision),
    },
    success: Schema.Struct({ revision: Revision, report: ImportReport }),
    error: Refused,
  }),
) {}
