// The reviewer's work on a review: comments that wait for Finish review, edits and deletes, drafts, stop reading,
// comments on lines outside the patch, and suggestions, as the store keeps them and an agent's status shows them.
import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type {
  CommentId,
  Fingerprint,
  RepoPath,
  ReviewId,
  RoundNumber,
  Timestamp,
} from "../schema/primitives.ts";
import type { Selection } from "../schema/selection.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { contentDigest, patchDigest } from "../review/anchor.ts";
import { unifiedDiff } from "../review/linediff.ts";
import { turnOf } from "../review/queries.ts";
import { ActionError } from "../review/state.ts";
import { statusOf } from "../server/status.ts";
import { Store } from "./store.ts";

const STORE = "src/notes/store.py" as RepoPath;
const SOURCE = "src/notes/source.py" as RepoPath;

const fixtureInput = (): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return decoded.success;
};

const BASE = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`);

/** A file changed from the base text to `after`, with its whole new text, as the collector writes one. */
const textFile = (after: ReadonlyArray<string>, print: string): ReviewFile => {
  const patch = unifiedDiff(`${BASE.join("\n")}\n`, `${after.join("\n")}\n`);
  assert.ok(patch !== undefined);
  return {
    path: SOURCE,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch,
    new_content: `${after.join("\n")}\n`,
    fingerprint: print.repeat(64) as Fingerprint,
  } as ReviewFile;
};

/** A round of the fixture's change with one more file, whose text the page can show beyond its patch. */
const round = (
  after: ReadonlyArray<string>,
  print: string,
  stops?: ReviewInput["stops"],
): ReviewInput => {
  const base = fixtureInput();
  const files = [...base.files, textFile(after, print)];
  return {
    ...base,
    target: { ...base.target, changed_files: files.length },
    files,
    ...(stops === undefined ? {} : { stops }),
  };
};

const firstText = BASE.map((line, at) => (at === 0 ? "line one" : line));

const opened = (store: Store, first = round(firstText, "1")) => {
  const { review, thread, token } = store.register({
    target: first.target,
    label: "Claude Code",
    host: { kind: "claude-code" },
  });
  store.publish(review.state.id, thread.id, first);
  return { id: review.state.id, thread, token, first };
};

const rows = (
  input: ReviewInput,
  path: RepoPath,
  start_row: number,
  end_row: number,
): Selection => {
  const file = input.files.find((item) => item.path === path);
  assert.ok(file?.patch !== undefined);
  return {
    kind: "rows",
    path,
    patch_sha256: patchDigest(file.patch),
    start_row,
    end_row,
  };
};

const lines = (
  input: ReviewInput,
  start_line: number,
  end_line: number,
): Selection => {
  const file = input.files.find((item) => item.path === SOURCE);
  assert.ok(file?.new_content !== undefined);
  return {
    kind: "text",
    path: SOURCE,
    content_sha256: contentDigest(file.new_content),
    start_line,
    end_line,
  };
};

const status = (store: Store, id: ReviewId) => {
  const view = store.review(id);
  assert.ok(view !== undefined);
  return statusOf(
    view,
    "http://127.0.0.1:1",
    "2026-10-12T00:00:00.000Z" as Timestamp,
  );
};

const fails = (
  work: () => unknown,
  kind: ActionError["kind"],
  message: RegExp,
) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ActionError, String(error));
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);
    return;
  }
  assert.fail(`expected an ActionError of kind ${kind}`);
};

const comments = (store: Store, id: ReviewId) =>
  store.review(id)?.state.comments ?? [];

test("three pending comments stay out of the agent's status; after an edit and a delete, Finish sends exactly two", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  for (const [start, body] of [
    [1, "First."],
    [4, "Second."],
    [7, "Third."],
  ] as const)
    store.act(id, {
      kind: "comment",
      selection: rows(first, STORE, start, start),
      body,
    });
  const [one, two, three] = comments(store, id);
  assert.ok(one !== undefined && two !== undefined && three !== undefined);
  assert.equal(one.source.kind === "reviewer" && one.source.state, "pending");
  const hidden = status(store, id);
  assert.deepEqual(hidden.to_answer, []);
  assert.deepEqual(hidden.feedback?.comments, []);
  assert.deepEqual(hidden.turns, {});
  // The agents cannot answer what they cannot see.
  fails(
    () =>
      store.act(id, {
        kind: "answer",
        thread: thread.id,
        comment: one.id,
        answer: { disposition: "answered", body: "Seen." },
      }),
    "not_found",
    /No comment/,
  );
  // Nor can the reviewer reply to it: it is theirs to edit.
  fails(
    () =>
      store.act(id, {
        kind: "reply",
        comment: one.id,
        action: "reply",
        body: "More.",
      }),
    "invalid",
    /pending/,
  );

  // A reply box under a pending comment cannot be sent, so it keeps no draft; an edit box can.
  fails(
    () => store.saveDraft(id, { kind: "reply", comment: one.id, body: "x" }),
    "invalid",
    /pending/,
  );
  store.saveDraft(id, { kind: "edit", comment: two.id, body: "Second, ed" });
  store.act(id, {
    kind: "edit_comment",
    comment: two.id,
    body: "Second, edited.",
  });
  assert.deepEqual(store.snapshot(id)?.drafts, []);
  store.act(id, { kind: "delete_comment", comment: three.id });
  // A pending comment's edit is no edit the agents need to know of.
  const edited = comments(store, id).find((item) => item.id === two.id);
  assert.deepEqual(edited?.source, { kind: "reviewer", state: "pending" });

  store.act(id, {
    kind: "submit",
    round: 1 as RoundNumber,
    verdict: "request_changes",
    body: "See the comments.",
  });
  const sent = status(store, id);
  assert.deepEqual(sent.to_answer, [one.id, two.id]);
  assert.deepEqual(
    sent.feedback?.comments.map((item) => item.body),
    ["First.", "Second, edited."],
  );
  assert.deepEqual(sent.feedback?.comments[0]?.source, {
    kind: "reviewer",
    state: "sent",
  });
  assert.equal(sent.submission?.verdict, "request_changes");

  // After the finish, a plain comment goes at once: no finish is left to send it.
  store.act(id, {
    kind: "comment",
    selection: rows(first, STORE, 8, 8),
    body: "One more.",
  });
  assert.equal(status(store, id).to_answer.length, 3);
  store.close();
});

test("a question goes at once; editing a sent comment flags it, and after an answer hands it back to the agents", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: rows(first, STORE, 1, 1),
    body: "Why json?",
    question: true,
  });
  const [asked] = comments(store, id);
  assert.ok(asked !== undefined);
  assert.deepEqual(status(store, id).questions, [asked.id]);
  store.act(id, {
    kind: "answer",
    thread: thread.id,
    comment: asked.id,
    answer: { disposition: "answered", body: "It is the format." },
  });
  assert.equal(turnOf(comments(store, id)[0] ?? asked), "reviewer");

  store.act(id, {
    kind: "edit_comment",
    comment: asked.id,
    body: "Why json, not toml?",
  });
  const edited = comments(store, id)[0];
  assert.ok(edited?.source.kind === "reviewer");
  assert.equal(edited.source.state, "edited");
  assert.ok(
    edited.source.state === "edited" && edited.source.question === true,
  );
  assert.equal(edited.body, "Why json, not toml?");
  const seen = status(store, id);
  assert.deepEqual(seen.questions, [asked.id]);
  assert.equal(seen.turns[asked.id], "agent");
  assert.deepEqual(seen.feedback?.comments[0]?.source, edited.source);

  // The same body again changes nothing; an empty one is refused.
  const before = edited.source;
  store.act(id, {
    kind: "edit_comment",
    comment: asked.id,
    body: "Why json, not toml?",
  });
  assert.deepEqual(comments(store, id)[0]?.source, before);
  fails(
    () => store.act(id, { kind: "edit_comment", comment: asked.id, body: " " }),
    "invalid",
    /Write the comment/,
  );
  // It has replies, so it stays; withdrawing takes it back.
  fails(
    () => store.act(id, { kind: "delete_comment", comment: asked.id }),
    "invalid",
    /Withdraw it instead/,
  );
  store.close();
});

test("a sent comment nobody answered can be deleted; one imported from the git host cannot be changed", () => {
  const store = Store.open(":memory:");
  const { id } = opened(store);
  store.act(id, { kind: "general_comment", body: "Hm.", question: true });
  const [asked] = comments(store, id);
  assert.ok(asked !== undefined);
  store.act(id, { kind: "delete_comment", comment: asked.id });
  assert.deepEqual(comments(store, id), []);

  store.importGitHub(
    id,
    "https://github.com/example/notes/pull/7" as never,
    [
      {
        kind: "conversation",
        id: "PRRC_1",
        author: "octocat",
        url: "https://github.com/example/notes/pull/7#issuecomment-1",
        body: "From GitHub.",
        created_at: "2026-10-12T00:01:00.000Z",
      },
    ] as never,
  );
  const [imported] = comments(store, id);
  assert.ok(imported !== undefined);
  fails(
    () =>
      store.saveDraft(id, { kind: "edit", comment: imported.id, body: "x" }),
    "invalid",
    /imported from the git host/,
  );
  for (const action of [
    { kind: "edit_comment", comment: imported.id, body: "Mine now." },
    { kind: "delete_comment", comment: imported.id },
  ] as const)
    fails(() => store.act(id, action), "invalid", /imported from the git host/);
  fails(
    () =>
      store.act(id, {
        kind: "edit_comment",
        comment: "comment-none" as CommentId,
        body: "x",
      }),
    "not_found",
    /No comment/,
  );
  store.close();
});

test("drafts survive a restart, change no revision, and sending or deleting empties their slots", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "review-canvas-drafts-")),
    "reviews.sqlite",
  );
  let store = Store.open(path);
  const { id, first } = opened(store);
  store.act(id, { kind: "general_comment", body: "Asked.", question: true });
  const [asked] = comments(store, id);
  assert.ok(asked !== undefined);
  const revision = store.review(id)?.revision;
  let announced = 0;
  store.subscribe(() => announced++);
  store.saveDraft(id, { kind: "general", body: "Overall, " });
  store.saveDraft(id, { kind: "general", body: "Overall, fine." });
  store.saveDraft(id, { kind: "reply", comment: asked.id, body: "Thanks" });
  store.saveDraft(id, {
    kind: "edit",
    comment: asked.id,
    body: "Asked, again.",
  });
  store.saveDraft(id, { kind: "finish", verdict: "approve", body: "Ship" });
  store.saveDraft(id, {
    kind: "comment",
    selection: rows(first, STORE, 1, 1),
    body: "Here",
  });
  assert.equal(store.review(id)?.revision, revision);
  store.close();

  store = Store.open(path);
  const bodies = () =>
    (store.snapshot(id)?.drafts ?? []).map(
      (saved) => `${saved.draft.kind}:${saved.draft.body}`,
    );
  assert.deepEqual(bodies(), [
    "comment:Here",
    "edit:Asked, again.",
    "finish:Ship",
    "general:Overall, fine.",
    "reply:Thanks",
  ]);
  store.act(id, {
    kind: "comment",
    selection: rows(first, STORE, 1, 1),
    body: "Here",
  });
  store.act(id, { kind: "general_comment", body: "Overall, fine." });
  store.act(id, {
    kind: "reply",
    comment: asked.id,
    action: "reply",
    body: "Thanks",
  });
  store.act(id, {
    kind: "submit",
    round: 1 as RoundNumber,
    verdict: "approve",
    body: "Ship",
  });
  assert.deepEqual(bodies(), ["edit:Asked, again."]);
  store.discardDraft(id, { kind: "edit", comment: asked.id });
  assert.deepEqual(bodies(), []);

  // Deleting a comment takes its reply and edit drafts with it.
  store.act(id, { kind: "general_comment", body: "Drop me.", question: true });
  const dropped = comments(store, id).at(-1);
  assert.ok(dropped !== undefined);
  store.saveDraft(id, { kind: "reply", comment: dropped.id, body: "x" });
  store.act(id, { kind: "delete_comment", comment: dropped.id });
  assert.deepEqual(bodies(), []);
  fails(
    () =>
      store.saveDraft(id, { kind: "reply", comment: dropped.id, body: "x" }),
    "not_found",
    /No comment/,
  );
  assert.equal(announced, 0);
  store.close();
});

test("a closed review takes no drafts and no reading", () => {
  const store = Store.open(":memory:");
  const { first, id } = opened(store);
  store.register({
    target: first.target,
    label: "Again",
    host: { kind: "codex" },
    fresh: true,
  });
  fails(
    () => store.saveDraft(id, { kind: "general", body: "x" }),
    "closed",
    /closed/,
  );
  fails(
    () => store.read(id, { kind: "read", round: 1 as RoundNumber, stop: 0 }),
    "closed",
    /closed/,
  );
  store.close();
});

const stop = (title: string, path: RepoPath) => ({
  title,
  summary: "",
  attention: null,
  excerpts: [{ path, side: "new" as const, start: 1, end: 1, caption: "" }],
  files: [],
  notes: [],
  questions: [],
});

test("stop reading is kept per review, changes no revision, and a round that changes a read stop's file marks it changed", async () => {
  const stops = [stop("Store", STORE), stop("Source", SOURCE)];
  const store = Store.open(":memory:");
  const { id, thread } = opened(store, round(firstText, "1", stops));
  const revision = store.review(id)?.revision;
  // Let the announcements of registering and publishing pass first.
  await new Promise((resolve) => setImmediate(resolve));
  const reviews: Array<string> = [];
  const pages: Array<string> = [];
  store.subscribe((review) => reviews.push(review));
  store.subscribeWorkspace((review) => pages.push(review));
  store.read(id, { kind: "read", round: 1 as RoundNumber, stop: 0 });
  const after = store.read(id, {
    kind: "read",
    round: 1 as RoundNumber,
    stop: 1,
  });
  assert.deepEqual(
    after.map((item) => item.read.state),
    ["read", "read", "unread"],
  );
  assert.equal(store.review(id)?.revision, revision);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reviews, []);
  assert.deepEqual(pages, [id, id]);
  assert.deepEqual(
    store.snapshot(id)?.stops.map((item) => item.read.state),
    ["read", "read", "unread"],
  );

  // Round 2 changes only the file the second stop owns.
  const second = round(
    firstText.map((line, at) => (at === 20 ? "line twenty-one" : line)),
    "2",
    stops,
  );
  store.publish(id, thread.id, second);
  const [kept, changed] = store.snapshot(id)?.stops ?? [];
  assert.equal(kept?.read.state, "read");
  assert.deepEqual(
    changed?.read.state === "changed" ? changed.read.files : undefined,
    [SOURCE],
  );
  // A page that still shows round 1 cannot mark it read.
  fails(
    () => store.read(id, { kind: "read", round: 1 as RoundNumber, stop: 1 }),
    "changed",
    /Round 2 was published/,
  );
  store.read(id, { kind: "read", round: 2 as RoundNumber, stop: 1 });
  assert.equal(store.snapshot(id)?.stops[1]?.read.state, "read");
  store.read(id, { kind: "unread", round: 2 as RoundNumber, stop: 1 });
  assert.equal(store.snapshot(id)?.stops[1]?.read.state, "unread");
  store.close();
});

test("a comment on lines outside the patch sits on those lines, and follows them when a round shifts them down", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  const file = first.files.find((item) => item.path === SOURCE);
  // The patch changes line 1 and shows a few lines around it; line 20 is unchanged text outside it.
  assert.ok(file?.patch !== undefined && !file.patch.includes("line 20"));
  store.act(id, {
    kind: "comment",
    selection: lines(first, 20, 21),
    body: "Unchanged, but wrong.",
    question: true,
  });
  const [placed] = comments(store, id);
  assert.ok(placed?.kind === "inline" && placed.anchor.kind === "text");
  assert.equal(placed.anchor.quote, "line 20\nline 21");
  assert.deepEqual(placed.attachment, {
    state: "attached",
    reason: "Same text.",
    start_line: 20,
    end_line: 21,
  });
  // The agent sees it like any line comment.
  const seen = status(store, id).feedback?.comments[0];
  assert.ok(seen?.kind === "inline" && seen.anchor.kind === "text");
  assert.equal(seen.anchor.start_line, 20);

  // Two lines added at the top shift it down by two.
  store.publish(id, thread.id, round(["new a", "new b", ...firstText], "2"));
  const moved = comments(store, id)[0];
  assert.ok(moved?.kind === "inline");
  assert.deepEqual(moved.attachment, {
    state: "attached",
    reason: "Found by the quoted lines.",
    start_line: 22,
    end_line: 23,
  });
  // A selection of text the page no longer shows is refused, not moved.
  fails(
    () =>
      store.act(id, {
        kind: "comment",
        selection: lines(first, 3, 3),
        body: "Old text.",
      }),
    "changed",
    /changed since the page showed it/,
  );
  store.close();
});

test("an orphaned comment can move to lines outside the patch", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: lines(first, 25, 25),
    body: "Here.",
    question: true,
  });
  const second = round(
    firstText.map((line, at) => (at === 24 ? "line 25 changed" : line)),
    "2",
  );
  store.publish(id, thread.id, second);
  const [orphan] = comments(store, id);
  assert.equal(orphan?.kind === "inline" && orphan.attachment.state, "orphan");
  assert.ok(orphan !== undefined);
  store.act(id, {
    kind: "reattach",
    comment: orphan.id,
    selection: lines(second, 25, 25),
  });
  const moved = comments(store, id)[0];
  assert.ok(moved?.kind === "inline");
  assert.equal(moved.anchor.quote, "line 25 changed");
  assert.equal(moved.history.length, 1);
  assert.equal(moved.attachment.state, "attached");
  store.close();
});

test("the agent's status lists each suggested change with its lines and replacement, and malformed ones by problem", () => {
  const store = Store.open(":memory:");
  const { id, first } = opened(store);
  // Rows 2 and 3 of the store patch are the added imports, new lines 2 and 3.
  store.act(id, {
    kind: "comment",
    selection: rows(first, STORE, 2, 3),
    body: "Fold these:\n```suggestion\nimport os, tempfile\n```",
    question: true,
  });
  store.act(id, {
    kind: "comment",
    selection: lines(first, 20, 20),
    body: "```suggestion\nline twenty",
    question: true,
  });
  store.act(id, {
    kind: "comment",
    selection: lines(first, 21, 21),
    body: "```suggestion\nnot yet\n```",
  });
  const [ready, unclosed] = comments(store, id);
  assert.ok(ready !== undefined && unclosed !== undefined);
  assert.deepEqual(status(store, id).suggestions, [
    {
      comment: ready.id,
      state: "ready",
      path: STORE,
      side: "new",
      round: 1,
      start_line: 2,
      end_line: 3,
      current: ["import os", "import tempfile"],
      replacement: ["import os, tempfile"],
    },
    { comment: unclosed.id, state: "malformed", problem: "unclosed" },
  ]);
  store.close();
});

test("a version 4 database upgrades in place: anchors gain kinds, comments their states, and drafts and reading their tables", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "review-canvas-v4-")),
    "reviews.sqlite",
  );
  const store = Store.open(path);
  const { id, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: rows(first, STORE, 1, 1),
    body: "Shown pending.",
  });
  store.act(id, { kind: "general_comment", body: "Asked.", question: true });
  store.close();
  // Write the state back as a version 4 build saved it.
  const old = new DatabaseSync(path);
  const row = old.prepare("SELECT state FROM reviews WHERE id = ?").get(id);
  const state = JSON.parse(String(row?.state));
  const published = Date.parse(state.rounds[0].published_at);
  for (const comment of state.comments) {
    delete comment.source.state;
    if (comment.kind === "inline") delete comment.anchor.kind;
    // Made a minute after the round, as a reviewer would.
    comment.created_at = comment.updated_at = new Date(
      published + 60_000,
    ).toISOString();
  }
  old
    .prepare("UPDATE reviews SET state = ? WHERE id = ?")
    .run(JSON.stringify(state), id);
  old.exec(
    "DROP TABLE review_drafts; DROP TABLE review_reading; PRAGMA user_version = 4;",
  );
  old.close();

  const upgraded = Store.open(path);
  const [held, asked] = comments(upgraded, id);
  assert.deepEqual(held?.source, { kind: "reviewer", state: "pending" });
  assert.equal(held?.kind === "inline" && held.anchor.kind, "patch");
  assert.deepEqual(asked?.source, {
    kind: "reviewer",
    state: "sent",
    question: true,
  });
  upgraded.saveDraft(id, { kind: "general", body: "Kept." });
  assert.equal(upgraded.snapshot(id)?.drafts.length, 1);
  upgraded.close();
  const version = new DatabaseSync(path);
  assert.deepEqual(
    { ...version.prepare("PRAGMA user_version").get() },
    { user_version: 5 },
  );
  version.close();
});

test("an upgrade that meets a state it cannot read leaves the database as it was", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "review-canvas-v4-bad-")),
    "reviews.sqlite",
  );
  const store = Store.open(path);
  const { id } = opened(store);
  store.close();
  const old = new DatabaseSync(path);
  old.prepare("UPDATE reviews SET state = ? WHERE id = ?").run('{"id": 1}', id);
  old.exec(
    "DROP TABLE review_drafts; DROP TABLE review_reading; PRAGMA user_version = 4;",
  );
  old.close();
  assert.throws(() => Store.open(path), /cannot be upgraded/);
  const after = new DatabaseSync(path);
  assert.deepEqual(
    { ...after.prepare("PRAGMA user_version").get() },
    { user_version: 4 },
  );
  after.close();
});
