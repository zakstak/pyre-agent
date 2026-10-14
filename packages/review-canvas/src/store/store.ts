/**
 * The review store: every review, round, and thread on this machine, in one SQLite database. Each change is one
 * transaction that raises the review's revision, and no state is written that the feedback schema would refuse.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { WorktreeRoot } from "../schema/primitives.ts";
import { Repository, RepositoryId, repositoryId } from "../schema/repositories.ts";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  decodeBytes,
  encodeDocument,
  FeedbackDocument,
  InputDocument,
} from "../schema/document.ts";
import { documentBytes } from "../schema/encoding.ts";
import type {
  Answer,
  Feedback,
  ReviewerReply,
  Verdict,
} from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type {
  CommentId,
  CommitSha,
  Fingerprint,
  PullRequestUrl,
  InputDigest,
  ReplyId,
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
  ThreadId,
  ThreadToken,
  Timestamp,
} from "../schema/primitives.ts";
import { type Target, targetKey } from "../schema/target.ts";
import type { Thread, ThreadHost } from "../schema/thread.ts";
import type { RowSelection } from "../review/anchor.ts";
import {
  type ActionContext,
  ActionError,
  addGeneralComment,
  addInlineComment,
  agentAnswer,
  approve,
  approvalHolds,
  carriedApprovals,
  currentRound,
  currentSubmission,
  publishRound,
  reattach,
  reportDrift,
  reviewerReply,
  type ReviewState,
  turnOf,
  type Round,
  submit,
  unapprove,
} from "../review/state.ts";
import { tourView } from "../review/tour.ts";
import { type Progress, progress } from "../review/progress.ts";
import {
  type ImportReport,
  importFeedback,
  importGitHub,
} from "../review/imports.ts";
import type { GitHubItem } from "../schema/github.ts";
import { pullRequestKey } from "../schema/target.ts";

/**
 * Version 4 monitors repository identities rather than checkout paths. Versions 2 and 3 upgrade in place; version 1
 * was never released, so it is refused with other unknown versions.
 */
const SCHEMA_VERSION = 4;

const REPOSITORIES_SCHEMA = `
CREATE TABLE monitored_repositories (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE pending_repository_migrations (
  root TEXT PRIMARY KEY
) WITHOUT ROWID;
`;

const SCHEMA = `
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX reviews_by_target ON reviews (target_key, created_at);
CREATE TABLE threads (
  id TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews (id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  -- A thread that answered in one review can appear in another through an imported feedback file.
  PRIMARY KEY (review_id, id)
) WITHOUT ROWID;
CREATE INDEX threads_by_review ON threads (review_id, registered_at);
CREATE TABLE rounds (
  review_id TEXT NOT NULL REFERENCES reviews (id),
  round INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  input BLOB NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (review_id, round),
  FOREIGN KEY (review_id, thread_id) REFERENCES threads (review_id, id)
) WITHOUT ROWID;
`;

/** A review as the list page shows it. */
export interface ReviewSummary {
  readonly id: ReviewId;
  readonly target: Target;
  readonly created_at: Timestamp;
  readonly closed_at: Timestamp | undefined;
  readonly revision: Revision;
  readonly round: RoundNumber | undefined;
  readonly open_comments: number;
  readonly comments: number;
  readonly approvals: number;
  readonly files: number | undefined;
  readonly submitted: boolean;
  readonly threads: ReadonlyArray<Thread>;
  /** The review this one replaced with a fresh start, if any. */
  readonly carry_from: ReviewId | undefined;
  /** When the current round was published. */
  readonly published_at: Timestamp | undefined;
  /** The verdict the reviewer finished the current round with. */
  readonly verdict: Verdict | undefined;
  /** How far the reviewer is with the current round, as the review page counts it. */
  readonly progress: Omit<Progress, "viewed"> & { readonly viewed: number } | undefined;
  /** Files an agent found changed since the current round. */
  readonly drift: number | undefined;
}

/** A review with everything a page or an agent reads: its state, threads, and the current round's input. */
export interface ReviewView {
  readonly state: ReviewState;
  readonly revision: Revision;
  readonly threads: ReadonlyArray<Thread>;
  readonly round: Round | undefined;
  readonly input: ReviewInput | undefined;
}

export interface Registration {
  readonly review: ReviewView;
  readonly thread: Thread;
  readonly token: ThreadToken;
  /** True when registration created the review instead of joining an open one. */
  readonly created: boolean;
}

export interface Published {
  readonly round: Round;
  readonly revision: Revision;
  readonly warnings: ReadonlyArray<string>;
}

/** A change one page or agent asks for. */
export type Action =
  | {
      readonly kind: "comment";
      readonly selection: RowSelection;
      readonly body: string;
      /** Asked now: the agents answer without waiting for the round to finish. */
      readonly question?: boolean | undefined;
    }
  | {
      readonly kind: "general_comment";
      readonly body: string;
      readonly question?: boolean | undefined;
    }
  | {
      readonly kind: "reply";
      readonly comment: CommentId;
      readonly action: ReviewerReply["action"];
      readonly body: string;
    }
  | {
      readonly kind: "approve";
      readonly path: RepoPath;
      readonly fingerprint: Fingerprint;
    }
  | { readonly kind: "unapprove"; readonly path: RepoPath }
  | {
      readonly kind: "submit";
      /** The round the reviewer read. */
      readonly round: RoundNumber;
      readonly verdict: Verdict;
      readonly body: string;
    }
  | {
      readonly kind: "reattach";
      readonly comment: CommentId;
      readonly selection: RowSelection;
    }
  | {
      readonly kind: "answer";
      readonly thread: ThreadId;
      readonly comment: CommentId;
      readonly answer: Answer;
    }
  | {
      readonly kind: "drift";
      readonly paths: ReadonlyArray<RepoPath>;
      readonly head_sha?: CommitSha | undefined;
    };

export type ChangeListener = (reviewId: ReviewId, revision: Revision) => void;

export class StaleRevision extends Error {
  readonly revision: Revision;
  constructor(revision: Revision) {
    super(`The review changed since the page loaded (revision ${revision}).`);
    this.revision = revision;
  }
}

export class NoSuchReview extends Error {
  constructor(id: string) {
    super(`No review ${id}.`);
  }
}

const now = (): Timestamp => new Date().toISOString() as Timestamp;

const randomId = <T extends string>(prefix: string): T =>
  `${prefix}-${randomBytes(9).toString("base64url")}` as T;

const tokenHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

const inputDigest = (input: ReviewInput): InputDigest =>
  createHash("sha256")
    .update(documentBytes(input))
    .digest("hex") as InputDigest;

interface ReviewRow {
  readonly id: string;
  readonly target_key: string;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly revision: number;
  readonly state: string;
}

interface ThreadRow {
  readonly id: string;
  readonly review_id: string;
  readonly label: string;
  readonly host: string;
  readonly registered_at: string;
}

/** The feedback document a review's state and current round make. The store refuses a state this cannot encode. */
export const feedbackOf = (
  view: ReviewView,
  exported_at: Timestamp,
): Feedback | undefined => {
  if (view.round === undefined || view.input === undefined) return undefined;
  return {
    format: "review-canvas.feedback/1",
    target: view.state.target,
    round: view.round.round,
    input_sha256: view.round.input_sha256,
    exported_at,
    general_notes: "",
    files: view.input.files.map((file) => ({
      path: file.path,
      status: file.status,
      group: file.group,
      notes: "",
    })),
    approvals: view.state.approvals,
    threads: view.threads,
    comments: view.state.comments,
    earlier_rounds: [],
    // The revision a submission made is the store's bookkeeping, not part of the document.
    submissions: view.state.submissions.map(
      ({ revision: _revision, ...submission }) => submission,
    ),
  };
};

export class Store {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<ChangeListener>();
  /** Changes made by the open transaction, announced only once it commits. */
  #pending: Array<readonly [ReviewId, Revision]> = [];
  /** Each review's last progress count, by the round input and revision it counted. */
  readonly #progressCache = new Map<string, { readonly key: string; readonly progress: ReviewSummary["progress"] }>();

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens the database at `path`, creating its folder (0700) and file (0600). */
  static open(path: string): Store {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    // A busy timeout lets a second process, such as a server that is about to find another one running, wait for a
    // write in progress instead of failing.
    const db = new DatabaseSync(path, { timeout: 5000 });
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys = ON");
    // The version is read again under the write lock, so two first opens cannot both create the schema.
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (row.user_version === 0) {
      db.exec(SCHEMA);
      db.exec(REPOSITORIES_SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } else if (row.user_version === 2) {
      db.exec(REPOSITORIES_SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } else if (row.user_version === 3) {
      db.exec("ALTER TABLE monitored_repositories RENAME TO pending_repository_migrations");
      db.exec("CREATE TABLE monitored_repositories (id TEXT PRIMARY KEY, repository TEXT NOT NULL) WITHOUT ROWID");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } else if (row.user_version === SCHEMA_VERSION) {
      db.exec("COMMIT");
    } else {
      db.exec("ROLLBACK");
      db.close();
      throw new Error(
        `${path} has schema version ${row.user_version}; this version reads ${SCHEMA_VERSION}. Move it aside to start an empty one.`,
      );
    }
    return new Store(db);
  }

  close(): void {
    this.#db.close();
  }

  /** Only an explicit acceptance adds a repository; reviews and scans never do. */
  monitoredRepositories(): ReadonlyArray<Repository> {
    return this.#db.prepare("SELECT repository FROM monitored_repositories ORDER BY id").all()
      .map((row) => {
        if (typeof row.repository !== "string") throw new Error("Invalid stored repository.");
        const decoded: unknown = JSON.parse(row.repository);
        return Schema.decodeUnknownSync(Repository)(decoded);
      });
  }

  monitorRepository(repository: Repository): void {
    this.#db.prepare("INSERT INTO monitored_repositories (id, repository) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET repository = excluded.repository")
      .run(repositoryId(repository.identity), JSON.stringify(repository));
  }

  /** A scan can refresh copies of an accepted repo, but cannot enroll a new repository identity. */
  refreshMonitoredRepository(repository: Repository): void {
    this.#db.prepare("UPDATE monitored_repositories SET repository = ? WHERE id = ?")
      .run(JSON.stringify(repository), repositoryId(repository.identity));
  }

  unmonitorRepository(id: RepositoryId): void {
    this.#db.prepare("DELETE FROM monitored_repositories WHERE id = ?").run(id);
  }

  pendingRepositoryMigrations(): ReadonlyArray<WorktreeRoot> {
    return this.#db.prepare("SELECT root FROM pending_repository_migrations ORDER BY root").all()
      .map((row) => Schema.decodeUnknownSync(WorktreeRoot)(row.root));
  }

  migrateAcceptedCheckout(root: WorktreeRoot, repository: Repository): void {
    this.#transaction(() => {
      this.monitorRepository(repository);
      this.#db.prepare("DELETE FROM pending_repository_migrations WHERE root = ?").run(root);
    });
  }

  resolveMigratedRepository(id: RepositoryId, repository: Repository): void {
    this.#transaction(() => {
      const removed = this.#db.prepare("DELETE FROM monitored_repositories WHERE id = ?").run(id);
      if (removed.changes > 0) this.monitorRepository(repository);
    });
  }

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    this.#pending = [];
    let value: T;
    try {
      value = work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#pending = [];
      throw error;
    }
    const changes = this.#pending;
    this.#pending = [];
    // Listeners run after the caller's code, never inside the transaction.
    queueMicrotask(() => {
      for (const [reviewId, revision] of changes)
        for (const listener of this.#listeners) listener(reviewId, revision);
    });
    return value;
  }

  #row(id: string): ReviewRow | undefined {
    return this.#db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as
      ReviewRow | undefined;
  }

  #threads(reviewId: string): ReadonlyArray<Thread> {
    const rows = this.#db
      .prepare(
        "SELECT id, review_id, label, host, registered_at FROM threads WHERE review_id = ? ORDER BY registered_at, id",
      )
      .all(reviewId) as unknown as Array<ThreadRow>;
    return rows.map((row) => ({
      id: row.id as ThreadId,
      label: row.label,
      host: JSON.parse(row.host) as ThreadHost,
    }));
  }

  #input(reviewId: string, round: number): ReviewInput | undefined {
    const row = this.#db
      .prepare("SELECT input FROM rounds WHERE review_id = ? AND round = ?")
      .get(reviewId, round) as { input: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    const decoded = decodeBytes(InputDocument, row.input);
    if (Result.isFailure(decoded))
      throw new Error(
        `Stored round ${round} of ${reviewId} no longer decodes: ${decoded.failure.message}`,
      );
    return decoded.success;
  }

  #view(row: ReviewRow): ReviewView {
    const state = JSON.parse(row.state) as ReviewState;
    const round = currentRound(state);
    return {
      state,
      revision: row.revision as Revision,
      threads: this.#threads(row.id),
      round,
      input: round === undefined ? undefined : this.#input(row.id, round.round),
    };
  }

  review(id: string): ReviewView | undefined {
    const row = this.#row(id);
    return row === undefined ? undefined : this.#view(row);
  }

  /** A view of an earlier round of the review, for reading only. */
  round(id: string, round: number): ReviewInput | undefined {
    return this.#input(id, round);
  }

  /**
   * A review's progress for the list page. A round's input holds whole patches and file texts, so it is read and
   * decoded only when the review changed since the last count.
   */
  #progress(row: ReviewRow, state: ReviewState, round: Round): ReviewSummary["progress"] {
    const key = `${round.input_sha256}:${row.revision}`;
    const known = this.#progressCache.get(row.id);
    if (known?.key === key) return known.progress;
    const input = this.#input(row.id, round.round);
    const counts = input === undefined ? undefined : progress(state, input);
    const result = counts === undefined ? undefined : { ...counts, viewed: counts.viewed.size };
    this.#progressCache.set(row.id, { key, progress: result });
    return result;
  }

  /** The review that replaced this one with a fresh start, if any. */
  replacedBy(id: string): ReviewId | undefined {
    const row = this.#db
      .prepare("SELECT id FROM reviews WHERE json_extract(state, '$.carry_from') = ? ORDER BY created_at DESC LIMIT 1")
      .get(id) as { id: string } | undefined;
    return row?.id as ReviewId | undefined;
  }

  reviews(): ReadonlyArray<ReviewSummary> {
    const rows = this.#db
      .prepare("SELECT * FROM reviews ORDER BY created_at DESC, id")
      .all() as unknown as Array<ReviewRow>;
    return rows.map((row) => {
      const state = JSON.parse(row.state) as ReviewState;
      const round = currentRound(state);
      const files =
        round === undefined ? undefined : state.target.changed_files;
      return {
        id: state.id,
        target: state.target,
        created_at: state.created_at,
        closed_at: state.closed_at,
        revision: row.revision as Revision,
        round: round?.round,
        open_comments: state.comments.filter((comment) => {
          const last = comment.replies.at(-1);
          return !(last?.actor === "reviewer" && last.action === "accept");
        }).length,
        comments: state.comments.length,
        approvals: state.approvals.length,
        files,
        submitted:
          round !== undefined &&
          state.submissions.some((item) => item.round === round.round),
        threads: this.#threads(row.id),
        carry_from: state.carry_from,
        published_at: round?.published_at,
        verdict: currentSubmission(state)?.verdict,
        progress: round === undefined ? undefined : this.#progress(row, state, round),
        drift:
          state.drift !== undefined && state.drift.round === round?.round
            ? state.drift.paths.length
            : undefined,
      };
    });
  }

  /** The open review of a target, if any. */
  openReview(target: Target): ReviewView | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM reviews WHERE target_key = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(targetKey(target)) as ReviewRow | undefined;
    return row === undefined ? undefined : this.#view(row);
  }

  /**
   * Registers a thread: it joins the target's open review, or starts a review when there is none or when `fresh`
   * asks for one. A fresh start closes the open review; its matching approvals carry over with the first round.
   */
  register(options: {
    readonly target: Target;
    readonly label: string;
    readonly host: ThreadHost;
    readonly fresh?: boolean;
  }): Registration {
    return this.#transaction(() => {
      const at = now();
      let existing = this.openReview(options.target);
      let created = false;
      if (existing !== undefined && options.fresh === true) {
        // Closing is a change to the old review: its open pages and waiting agents must learn of it.
        const closed = existing.state.id;
        this.#write(closed, { ...existing.state, closed_at: at });
        this.#notify(closed, this.#bump(closed));
        existing = undefined;
      }
      let reviewId: ReviewId;
      if (existing === undefined) {
        const earlier = this.#db
          .prepare(
            "SELECT id FROM reviews WHERE target_key = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(targetKey(options.target)) as { id: string } | undefined;
        reviewId = randomId<ReviewId>("review");
        const state: ReviewState = {
          id: reviewId,
          target: options.target,
          created_at: at,
          closed_at: undefined,
          carry_from: earlier?.id as ReviewId | undefined,
          rounds: [],
          approvals: [],
          comments: [],
          submissions: [],
        };
        this.#db
          .prepare(
            "INSERT INTO reviews (id, target_key, created_at, closed_at, revision, state) VALUES (?, ?, ?, NULL, 0, ?)",
          )
          .run(reviewId, targetKey(options.target), at, JSON.stringify(state));
        created = true;
      } else {
        reviewId = existing.state.id;
      }
      if (this.#threads(reviewId).length >= Limits.MAX_THREADS) {
        throw new ActionError(
          "invalid",
          `The review already has ${Limits.MAX_THREADS} threads. Start a fresh review of the target instead.`,
        );
      }
      const token = randomBytes(32).toString("base64url") as ThreadToken;
      const thread: Thread = {
        id: randomId<ThreadId>("thread"),
        label: options.label,
        host: options.host,
      };
      this.#db
        .prepare(
          "INSERT INTO threads (id, review_id, token_hash, label, host, registered_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          thread.id,
          reviewId,
          tokenHash(token),
          thread.label,
          JSON.stringify(thread.host),
          at,
        );
      const joined = this.review(reviewId);
      if (joined === undefined) throw new NoSuchReview(reviewId);
      // The new thread joins the feedback document, so the review must still encode with it.
      this.#check(reviewId, joined.state, joined.input);
      const revision = this.#bump(reviewId);
      this.#notify(reviewId, revision);
      return { review: { ...joined, revision }, thread, token, created };
    });
  }

  /** The thread a token proves, within a review. */
  authenticate(reviewId: string, token: string): Thread | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, review_id, label, host, registered_at FROM threads WHERE review_id = ? AND token_hash = ?",
      )
      .get(reviewId, tokenHash(token)) as ThreadRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id as ThreadId,
          label: row.label,
          host: JSON.parse(row.host) as ThreadHost,
        };
  }

  /** Publishes the next round of a review from a thread. The input must name the review's target. */
  publish(reviewId: ReviewId, thread: ThreadId, input: ReviewInput): Published {
    return this.#transaction(() => {
      const row = this.#row(reviewId);
      if (row === undefined) throw new NoSuchReview(reviewId);
      let state = JSON.parse(row.state) as ReviewState;
      if (targetKey(input.target) !== row.target_key)
        throw new ActionError(
          "invalid",
          "The input names another target than the review.",
        );
      const number = ((currentRound(state)?.round ?? 0) + 1) as RoundNumber;
      const round: Round = {
        round: number,
        input_sha256: inputDigest(input),
        thread,
        published_at: now(),
      };
      if (number === 1 && state.carry_from !== undefined) {
        const earlier = this.#row(state.carry_from);
        if (earlier !== undefined) {
          state = {
            ...state,
            target: input.target,
            approvals: carriedApprovals(
              JSON.parse(earlier.state) as ReviewState,
              input,
            ),
          };
        }
      }
      const next = publishRound(
        { ...state, target: input.target },
        input,
        round,
      );
      if (Result.isFailure(next)) throw next.failure;
      const encoded = encodeDocument(InputDocument, input);
      if (Result.isFailure(encoded))
        throw new ActionError("invalid", encoded.failure.message);
      this.#db
        .prepare(
          "INSERT INTO rounds (review_id, round, thread_id, input_sha256, input, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          reviewId,
          number,
          thread,
          round.input_sha256,
          encoded.success,
          round.published_at,
        );
      this.#check(reviewId, next.success, input);
      this.#write(reviewId, next.success);
      const revision = this.#bump(reviewId);
      this.#notify(reviewId, revision);
      return { round, revision, warnings: tourView(input).warnings };
    });
  }

  /**
   * Runs one action. When `seen` is given, the review must still be at that revision, so a page acting on stale
   * state learns about the change instead of overriding it.
   */
  act(reviewId: string, action: Action, seen?: Revision): Revision {
    return this.#transaction(() => {
      const row = this.#row(reviewId);
      if (row === undefined) throw new NoSuchReview(reviewId);
      if (seen !== undefined && seen !== row.revision)
        throw new StaleRevision(row.revision as Revision);
      const view = this.#view(row);
      const context = {
        input: view.input,
        now: now(),
        revision: (row.revision + 1) as Revision,
        commentId: () => randomId<CommentId>("comment"),
        replyId: () => randomId<ReplyId>("reply"),
      };
      const state = view.state;
      const outcome = (() => {
        switch (action.kind) {
          case "comment":
            return addInlineComment(
              state,
              context,
              action.selection,
              action.body,
              action.question === true,
            );
          case "general_comment":
            return addGeneralComment(
              state,
              context,
              action.body,
              action.question === true,
            );
          case "drift":
            return reportDrift(state, context, action.paths, action.head_sha);
          case "reply":
            return reviewerReply(
              state,
              context,
              action.comment,
              action.action,
              action.body,
            );
          case "approve":
            return approve(state, context, action.path, action.fingerprint);
          case "unapprove":
            return unapprove(state, action.path);
          case "submit":
            return submit(
              state,
              context,
              action.round,
              action.verdict,
              action.body,
            );
          case "reattach":
            return reattach(state, context, action.comment, action.selection);
          case "answer":
            return agentAnswer(
              state,
              context,
              action.thread,
              action.comment,
              action.answer,
            );
        }
      })();
      if (Result.isFailure(outcome)) throw outcome.failure;
      this.#check(reviewId, outcome.success, view.input);
      this.#write(reviewId, outcome.success);
      const revision = this.#bump(reviewId);
      this.#notify(row.id as ReviewId, revision);
      return revision;
    });
  }

  /** The view, context, and transaction around an import: one change that raises the revision once. */
  #importing<T>(
    reviewId: string,
    seen: Revision | undefined,
    work: (
      view: ReviewView,
      context: ActionContext,
    ) => { readonly state: ReviewState; readonly report: T },
  ): { readonly revision: Revision; readonly report: T } {
    return this.#transaction(() => {
      const row = this.#row(reviewId);
      if (row === undefined) throw new NoSuchReview(reviewId);
      if (seen !== undefined && seen !== row.revision)
        throw new StaleRevision(row.revision as Revision);
      const view = this.#view(row);
      const { state, report } = work(view, {
        input: view.input,
        now: now(),
        revision: (row.revision + 1) as Revision,
        commentId: () => randomId<CommentId>("comment"),
        replyId: () => randomId<ReplyId>("reply"),
      });
      this.#check(reviewId, state, view.input);
      this.#write(reviewId, state);
      const revision = this.#bump(reviewId);
      this.#notify(row.id as ReviewId, revision);
      return { revision, report };
    });
  }

  /**
   * Imports a feedback file of the review's target. Threads its answers name join the review without a token, so
   * no agent can act as them.
   */
  importFeedback(
    reviewId: string,
    feedback: Feedback,
    seen?: Revision,
  ): { readonly revision: Revision; readonly report: ImportReport } {
    return this.#importing(reviewId, seen, (view, context) => {
      const known = new Set<string>(
        this.#threads(reviewId).map((thread) => thread.id),
      );
      const outcome = importFeedback(view.state, context, feedback, known);
      if (Result.isFailure(outcome)) throw outcome.failure;
      const at = now();
      for (const thread of outcome.success.threads) {
        this.#db
          .prepare(
            "INSERT INTO threads (id, review_id, token_hash, label, host, registered_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            thread.id,
            reviewId,
            tokenHash(randomBytes(32).toString("base64url")),
            thread.label,
            JSON.stringify(thread.host),
            at,
          );
      }
      return outcome.success;
    });
  }

  /** Imports the comments of the review's pull request, or of the open pull request of a working tree's branch. */
  importGitHub(
    reviewId: string,
    pullRequest: PullRequestUrl,
    items: ReadonlyArray<GitHubItem>,
    head?: CommitSha,
  ): { readonly revision: Revision; readonly report: ImportReport } {
    return this.#importing(reviewId, undefined, (view, context) => {
      const target = view.state.target;
      if (
        target.kind === "github_pr" &&
        pullRequestKey(target.url) !== pullRequestKey(pullRequest)
      )
        throw new ActionError(
          "invalid",
          "These comments are from another pull request than the review's.",
        );
      const outcome = importGitHub(view.state, context, items, head);
      if (Result.isFailure(outcome)) throw outcome.failure;
      return outcome.success;
    });
  }

  /** Refuses a state whose feedback document the schema would not accept, such as one past a limit. */
  #check(
    reviewId: string,
    state: ReviewState,
    input: ReviewInput | undefined,
  ): void {
    const round = currentRound(state);
    if (round === undefined || input === undefined) return;
    const feedback = feedbackOf(
      {
        state,
        revision: 0 as Revision,
        threads: this.#threads(reviewId),
        round,
        input,
      },
      now(),
    );
    if (feedback === undefined) return;
    const encoded = encodeDocument(FeedbackDocument, feedback);
    if (Result.isFailure(encoded))
      throw new ActionError("invalid", encoded.failure.message);
  }

  #write(reviewId: string, state: ReviewState): void {
    this.#db
      .prepare("UPDATE reviews SET state = ?, closed_at = ? WHERE id = ?")
      .run(JSON.stringify(state), state.closed_at ?? null, reviewId);
  }

  #bump(reviewId: string): Revision {
    this.#db
      .prepare("UPDATE reviews SET revision = revision + 1 WHERE id = ?")
      .run(reviewId);
    const row = this.#db
      .prepare("SELECT revision FROM reviews WHERE id = ?")
      .get(reviewId) as {
      revision: number;
    };
    return row.revision as Revision;
  }

  /** Announces a change once the open transaction commits. A rolled-back change is never announced. */
  #notify(reviewId: ReviewId, revision: Revision): void {
    this.#pending.push([reviewId, revision]);
  }
}
