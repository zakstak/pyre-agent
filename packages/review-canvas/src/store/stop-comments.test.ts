// Comments on a stop of the tour: they stay on the stop across rounds that keep it, move to the comments on the whole
// change when a round drops it, and the agents see which stop each one is about.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import { Comment, Feedback } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { RepoPath, RoundNumber } from "../schema/primitives.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { turnOf } from "../review/queries.ts";
import { ActionError } from "../review/state.ts";
import { statusOf } from "../server/status.ts";
import { feedbackOf, Store } from "./store.ts";

const base = (): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return decoded.success;
};

/** A stop of the agent's tour, in the input's shape. */
const stop = (
  title: string,
  excerpt?: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
  },
) => ({
  title,
  summary: "",
  attention: null,
  excerpts:
    excerpt === undefined
      ? []
      : [
          {
            path: excerpt.path as RepoPath,
            side: "new" as const,
            start: excerpt.start,
            end: excerpt.end,
            caption: "",
          },
        ],
  files: [],
  notes: [],
  questions: [`Why ${title}?`],
});

const withStops = (
  input: ReviewInput,
  stops: ReadonlyArray<ReturnType<typeof stop>>,
): ReviewInput => ({ ...input, stops }) as unknown as ReviewInput;

const SAVE = stop("Atomic save", {
  path: "src/notes/store.py",
  start: 11,
  end: 17,
});

const opened = (store: Store, first: ReviewInput) => {
  const { review, thread, token } = store.register({
    target: first.target,
    label: "Claude Code",
    host: { kind: "claude-code" },
  });
  store.publish(review.state.id, thread.id, first);
  return { id: review.state.id, thread, token };
};

const round = (n: number) => n as RoundNumber;

const fails = (work: () => unknown, kind: string, message: RegExp) =>
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ActionError, String(error));
    assert.equal(error.kind, kind);
    assert.match(error.message, message);
    return true;
  });

test("a question on a stop is anchored to the stop, with its excerpts, and the agents see it at once", () => {
  const store = Store.open(":memory:");
  const first = withStops(base(), [SAVE, stop("The rename")]);
  const { id } = opened(store, first);
  store.saveDraft(id, {
    kind: "stop",
    stop: { kind: "stop", title: "Atomic save", occurrence: 0 },
    body: "Why a temporary file",
  });
  store.act(id, {
    kind: "stop_comment",
    round: round(1),
    stop: { kind: "stop", title: "Atomic save", occurrence: 0 },
    body: "Why a temporary file?",
    question: true,
  });
  const view = store.review(id);
  assert.ok(view !== undefined);
  const [comment] = view.state.comments;
  assert.ok(comment?.kind === "stop");
  assert.deepEqual(comment.anchor, {
    kind: "stop",
    snapshot: { round: 1, input_sha256: view.round?.input_sha256 },
    stop: { kind: "stop", title: "Atomic save", occurrence: 0 },
    excerpts: [
      { path: "src/notes/store.py", side: "new", start_line: 11, end_line: 17 },
    ],
  });
  assert.deepEqual(comment.attachment, { state: "attached", stop: 0 });
  // Sending the box's text empties its saved draft.
  assert.deepEqual(store.drafts(id), []);
  const status = statusOf(
    view,
    "http://127.0.0.1:1",
    "2026-11-03T00:00:00.000Z" as never,
  );
  assert.deepEqual(status.questions, [comment.id]);
  assert.deepEqual(
    status.feedback?.comments.map((item) =>
      item.kind === "stop" ? item.anchor.stop : item.kind,
    ),
    [{ kind: "stop", title: "Atomic save", occurrence: 0 }],
  );
  store.close();
});

test("a plain comment on a stop is pending until the finish, like any comment", () => {
  const store = Store.open(":memory:");
  const first = withStops(base(), [SAVE]);
  const { id } = opened(store, first);
  store.act(id, {
    kind: "stop_comment",
    round: round(1),
    stop: { kind: "closing" },
    body: "Do these need a test?",
  });
  const before = store.review(id);
  assert.ok(before !== undefined);
  assert.deepEqual(
    feedbackOf(before, "2026-11-03T00:00:00.000Z" as never)?.comments,
    [],
  );
  store.act(id, {
    kind: "submit",
    round: round(1),
    verdict: "comment",
    body: "",
  });
  const after = store.review(id);
  const [comment] = after?.state.comments ?? [];
  assert.ok(comment?.kind === "stop");
  assert.equal(turnOf(comment), "agent");
  assert.deepEqual(comment.anchor.stop, { kind: "closing" });
  store.close();
});

test("a comment on a stop follows the stop into later rounds, and becomes an orphan when a round drops it", () => {
  const store = Store.open(":memory:");
  const first = withStops(base(), [SAVE, stop("The rename")]);
  const { id, thread } = opened(store, first);
  store.act(id, {
    kind: "stop_comment",
    round: round(1),
    stop: { kind: "stop", title: "The rename", occurrence: 0 },
    body: "Why now?",
    question: true,
  });
  const attachment = () => {
    const comment = store.review(id)?.state.comments[0];
    assert.ok(comment?.kind === "stop");
    return comment.attachment;
  };
  // A new stop before it moves it to the third place.
  store.publish(
    id,
    thread.id,
    withStops(base(), [stop("Setup"), SAVE, stop("The rename")]),
  );
  assert.deepEqual(attachment(), { state: "attached", stop: 2 });
  store.publish(id, thread.id, withStops(base(), [SAVE]));
  assert.deepEqual(attachment(), {
    state: "orphan",
    reason: "Round 3's tour has no stop “The rename”.",
  });
  // A round that brings the stop back puts the comment on it again.
  store.publish(id, thread.id, withStops(base(), [stop("The rename")]));
  assert.deepEqual(attachment(), { state: "attached", stop: 0 });
  store.close();
});

test("a comment on a stop names the round the page showed and a stop of it", () => {
  const store = Store.open(":memory:");
  const first = withStops(base(), [SAVE]);
  const { id, thread } = opened(store, first);
  store.publish(id, thread.id, withStops(base(), [SAVE, stop("New")]));
  fails(
    () =>
      store.act(id, {
        kind: "stop_comment",
        round: round(1),
        stop: { kind: "stop", title: "Atomic save", occurrence: 0 },
        body: "Old page",
      }),
    "changed",
    /Round 2 was published after the page showed round 1/,
  );
  fails(
    () =>
      store.act(id, {
        kind: "stop_comment",
        round: round(2),
        stop: { kind: "stop", title: "Atomic save", occurrence: 1 },
        body: "No such stop",
      }),
    "not_found",
    /has no stop “Atomic save”/,
  );
  store.close();
});

test("an exported comment on a stop imports onto the same stop of another review, or as an orphan", () => {
  const store = Store.open(":memory:");
  const first = withStops(base(), [SAVE, stop("The rename")]);
  const { id } = opened(store, first);
  for (const title of ["Atomic save", "The rename"])
    store.act(id, {
      kind: "stop_comment",
      round: round(1),
      stop: { kind: "stop", title, occurrence: 0 },
      body: `About ${title}`,
      question: true,
    });
  const view = store.review(id);
  assert.ok(view !== undefined);
  const feedback = feedbackOf(view, "2026-11-03T00:00:00.000Z" as never);
  assert.ok(feedback !== undefined);
  // The document round-trips through its schema.
  const decoded = Schema.decodeUnknownSync(Feedback)(
    Schema.encodeSync(Feedback)(feedback),
  );
  const fresh = store.register({
    target: first.target,
    label: "Codex",
    host: { kind: "codex" },
    fresh: true,
  });
  store.publish(
    fresh.review.state.id,
    fresh.thread.id,
    withStops(base(), [stop("Setup"), SAVE]),
  );
  const imported = store.importFeedback(fresh.review.state.id, decoded);
  assert.equal(imported.report.comments, 2);
  const comments = store.review(fresh.review.state.id)?.state.comments ?? [];
  assert.deepEqual(
    comments.map((comment) =>
      comment.kind === "stop"
        ? [
            comment.anchor.snapshot.round,
            comment.attachment.state,
            comment.attachment.state === "attached"
              ? comment.attachment.stop
              : undefined,
          ]
        : comment.kind,
    ),
    [
      [1, "attached", 1],
      [1, "orphan", undefined],
    ],
  );
  store.close();
});

test("a comment on a stop is the reviewer's, on excerpt lines in order", () => {
  const comment = {
    kind: "stop",
    id: "comment-1",
    source: { kind: "reviewer", state: "sent" },
    body: "Why?",
    created_at: "2026-11-03T00:00:00.000Z",
    updated_at: "2026-11-03T00:00:00.000Z",
    replies: [],
    anchor: {
      kind: "stop",
      snapshot: { round: 1, input_sha256: "a".repeat(64) },
      stop: { kind: "stop", title: "Atomic save", occurrence: 0 },
      excerpts: [{ path: "src/a.ts", side: "new", start_line: 3, end_line: 2 }],
    },
    attachment: { state: "attached", stop: 0 },
  };
  const decode = Schema.decodeUnknownResult(Comment);
  const backwards = decode(comment);
  assert.ok(Result.isFailure(backwards));
  assert.match(backwards.failure.message, /must not come before start_line/);
  const valid = {
    ...comment,
    anchor: {
      ...comment.anchor,
      excerpts: [{ path: "src/a.ts", side: "new", start_line: 2, end_line: 3 }],
    },
  };
  assert.ok(Result.isSuccess(decode(valid)));
  const hosted = decode({
    ...valid,
    source: {
      kind: "github",
      id: "IC_1",
      author: "octocat",
      url: "https://github.com/acme/notes/pull/1#issuecomment-1",
      resolved: false,
    },
  });
  assert.ok(Result.isFailure(hosted));
  assert.match(hosted.failure.message, /a comment on a stop is the reviewer's/);
});
