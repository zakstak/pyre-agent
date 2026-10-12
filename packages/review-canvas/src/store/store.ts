/**
 * The review store: every review, round, and thread on this machine, in one SQLite database. Each change is one
 * transaction that raises the review's revision, and no state is written that the feedback schema would refuse.
 */
import * as Result from "effect/Result";
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
import type {
  CommentId,
  Fingerprint,
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
  ActionError,
  addGeneralComment,
  addInlineComment,
  agentAnswer,
  approve,
  carriedApprovals,
  currentRound,
  publishRound,
  reattach,
  reviewerReply,
  type ReviewState,
  type Round,
  submit,
  unapprove,
} from "../review/state.ts";
import { tourView } from "../review/tour.ts";

const SCHEMA_VERSION = 1;

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
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews (id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  registered_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX threads_by_review ON threads (review_id, registered_at);
CREATE TABLE rounds (
  review_id TEXT NOT NULL REFERENCES reviews (id),
  round INTEGER NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  input_sha256 TEXT NOT NULL,
  input BLOB NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (review_id, round)
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
    }
  | { readonly kind: "general_comment"; readonly body: string }
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
    submissions: view.state.submissions,
  };
};

export class Store {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<ChangeListener>();

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens the database at `path`, creating its folder (0700) and file (0600). */
  static open(path: string): Store {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    const db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA foreign_keys = ON");
    const row = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (row.user_version === 0) {
      db.exec("BEGIN");
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } else if (row.user_version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `${path} has schema version ${row.user_version}; this version reads ${SCHEMA_VERSION}.`,
      );
    }
    return new Store(db);
  }

  close(): void {
    this.#db.close();
  }

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #row(id: string): ReviewRow | undefined {
    return this.#db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as
      | ReviewRow
      | undefined;
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
        this.#write(existing.state.id, { ...existing.state, closed_at: at });
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
      const revision = this.#bump(reviewId);
      const review = this.review(reviewId);
      if (review === undefined) throw new NoSuchReview(reviewId);
      this.#notify(reviewId, revision);
      return { review, thread, token, created };
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
            );
          case "general_comment":
            return addGeneralComment(state, context, action.body);
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
            return submit(state, context, action.verdict, action.body);
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

  #notify(reviewId: ReviewId, revision: Revision): void {
    // After the commit, from the caller's point of view: the transaction wrapper commits before it returns, and
    // listeners that read the store see the new revision. Deliver on the next tick so a listener never runs inside
    // the transaction.
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(reviewId, revision);
    });
  }
}
