import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeBytes,
  encodeDocument,
  FeedbackDocument,
  InputDocument,
} from "../schema/document.ts";
import type { ReviewInput } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type {
  CommentId,
  Fingerprint,
  RepoPath,
  Revision,
  RoundNumber,
} from "../schema/primitives.ts";
import { fixtureBytes } from "../schema/testing.ts";
import type { RowSelection } from "../review/anchor.ts";
import { patchDigest } from "../review/patch.ts";
import { ActionError, turnOf } from "../review/state.ts";
import { feedbackOf, StaleRevision, Store } from "./store.ts";

const input = (): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return decoded.success;
};

const host = { kind: "claude-code" } as const;

/** Rows of one file as a page showing this round's patch selects them. */
const rows = (
  round: ReviewInput,
  path: string,
  start_row: number,
  end_row: number,
): RowSelection => {
  const file = round.files.find((item) => item.path === path);
  assert.ok(file?.patch !== undefined, `no patch for ${path}`);
  return {
    path: path as RepoPath,
    patch_sha256: patchDigest(file.patch),
    start_row,
    end_row,
  };
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

test("a review runs from registration through a submitted round and an answered comment", () => {
  const store = Store.open(":memory:");
  const first = input();
  const registered = store.register({
    target: first.target,
    label: "Claude Code: atomic save",
    host,
  });
  assert.ok(registered.created);
  assert.equal(registered.review.round, undefined);
  assert.equal(registered.token.length, 43);
  const id = registered.review.state.id;
  assert.deepEqual(store.authenticate(id, registered.token), registered.thread);
  assert.equal(store.authenticate(id, "x".repeat(43)), undefined);

  // A second thread joins the same open review.
  const joined = store.register({
    target: first.target,
    label: "Codex: follow-up",
    host: { kind: "codex" },
  });
  assert.equal(joined.created, false);
  assert.equal(joined.review.state.id, id);

  const published = store.publish(id, registered.thread.id, first);
  assert.equal(published.round.round, 1);
  assert.deepEqual(published.warnings, []);

  // Nothing is the agent's to answer before the reviewer comments.
  let revision = published.revision;
  revision = store.act(
    id,
    {
      kind: "comment",
      selection: rows(first, "src/notes/store.py", 13, 15),
      body: "Lock before the rename.",
    },
    revision,
  );
  const view = store.review(id);
  assert.ok(view !== undefined);
  const comment = view.state.comments[0];
  assert.ok(comment !== undefined && comment.kind === "inline");
  assert.equal(comment.anchor.side, "new");
  assert.equal(comment.anchor.start_line, 12);
  assert.equal(comment.anchor.end_line, 14);
  assert.equal(comment.attachment.state, "attached");
  assert.equal(turnOf(comment), "agent");

  // A stale page cannot act over a newer change.
  assert.throws(
    () => store.act(id, { kind: "general_comment", body: "x" }, 1 as Revision),
    (error: unknown) =>
      error instanceof StaleRevision && error.revision === revision,
  );

  // The reviewer cannot accept before an answer... but can withdraw by accepting their own comment.
  revision = store.act(id, {
    kind: "approve",
    path: "src/notes/cli.py" as RepoPath,
    fingerprint:
      "eb66c1c8de5a693b75c524a2b6ebe4763260bac93588a1bd120bafc9fd6a15b9" as Fingerprint,
  });
  fails(
    () =>
      store.act(id, {
        kind: "approve",
        path: "src/notes/cli.py" as RepoPath,
        fingerprint: "0".repeat(64) as Fingerprint,
      }),
    "fingerprint",
    /changed since the page loaded/,
  );
  fails(
    () =>
      store.act(id, {
        kind: "submit",
        round: 2 as RoundNumber,
        verdict: "approve",
        body: "",
      }),
    "changed",
    /Round 1 was published after the page showed round 2/,
  );
  revision = store.act(id, {
    kind: "submit",
    round: 1 as RoundNumber,
    verdict: "request_changes",
    body: "One lock to add.",
  });
  // The submission records the revision it made, for agents; the exported document leaves it out.
  assert.equal(store.review(id)?.state.submissions[0]?.revision, revision);

  // The agent answers on its turn, and only on its turn.
  revision = store.act(id, {
    kind: "answer",
    thread: registered.thread.id,
    comment: comment.id,
    answer: {
      disposition: "fixed",
      body: "save() now locks.",
      fixed_in: { commit: "a".repeat(40) as never },
    },
  });
  fails(
    () =>
      store.act(id, {
        kind: "answer",
        thread: joined.thread.id,
        comment: comment.id,
        answer: { disposition: "question", body: "Which lock?" },
      }),
    "not_your_turn",
    /waits for the reviewer/,
  );
  fails(
    () =>
      store.act(id, {
        kind: "reply",
        comment: "comment-missing" as CommentId,
        action: "accept",
        body: "",
      }),
    "not_found",
    /No comment/,
  );
  fails(
    () =>
      store.act(id, {
        kind: "reply",
        comment: comment.id,
        action: "reopen",
        body: "",
      }),
    "not_your_turn",
    /Only a resolved comment/,
  );
  revision = store.act(id, {
    kind: "reply",
    comment: comment.id,
    action: "accept",
    body: "",
  });
  const resolved = store.review(id)?.state.comments[0];
  assert.ok(resolved !== undefined);
  assert.equal(turnOf(resolved), "resolved");
  fails(
    () =>
      store.act(id, {
        kind: "reply",
        comment: comment.id,
        action: "reply",
        body: "More",
      }),
    "resolved",
    /Reopen it first/,
  );
  revision = store.act(id, {
    kind: "reply",
    comment: comment.id,
    action: "reopen",
    body: "Still racy.",
  });
  assert.equal(
    turnOf(store.review(id)?.state.comments[0] ?? resolved),
    "agent",
  );

  // The state is always a valid feedback document.
  const exported = store.review(id);
  assert.ok(exported !== undefined);
  const feedback = feedbackOf(exported, "2026-10-12T00:00:00.000Z" as never);
  assert.ok(feedback !== undefined);
  const encoded = encodeDocument(FeedbackDocument, feedback);
  assert.ok(
    Result.isSuccess(encoded),
    Result.isFailure(encoded) ? encoded.failure.message : "",
  );
  assert.ok(Result.isSuccess(decodeBytes(FeedbackDocument, encoded.success)));
  assert.equal(feedback.submissions?.length, 1);
  assert.equal(feedback.threads.length, 2);

  // The list page sees it.
  const [summary] = store.reviews();
  assert.ok(summary !== undefined);
  assert.equal(summary.id, id);
  assert.equal(summary.round, 1);
  assert.equal(summary.comments, 1);
  assert.equal(summary.open_comments, 1);
  assert.equal(summary.approvals, 1);
  assert.equal(summary.submitted, true);
  assert.equal(summary.revision, revision);
  store.close();
});

test("a second round reattaches comments, and a fresh start carries matching approvals", async () => {
  const store = Store.open(":memory:");
  const first = input();
  const { review, thread } = store.register({
    target: first.target,
    label: "Claude Code",
    host,
  });
  const id = review.state.id;
  store.publish(id, thread.id, first);
  store.act(id, {
    kind: "comment",
    selection: rows(first, "src/notes/store.py", 13, 15),
    body: "Lock before the rename.",
  });
  store.act(id, {
    kind: "approve",
    path: "src/notes/cli.py" as RepoPath,
    fingerprint:
      "eb66c1c8de5a693b75c524a2b6ebe4763260bac93588a1bd120bafc9fd6a15b9" as Fingerprint,
  });
  store.act(id, {
    kind: "approve",
    path: "src/notes/store.py" as RepoPath,
    fingerprint:
      "6263cfcdd401e9324557d7888e0acd3cefc846e4fc3061a127b31539b2a9df07" as Fingerprint,
  });

  // Round 2: store.py changed (a line was added above the quote), cli.py did not.
  const second: ReviewInput = {
    ...first,
    files: first.files.map((file) =>
      file.path === "src/notes/store.py"
        ? {
            ...file,
            fingerprint: "1".repeat(64) as Fingerprint,
            additions: 8,
            patch: (file.patch ?? "").replace(
              "@@ -1,13 +1,19 @@\n import json\n",
              "@@ -1,13 +1,20 @@\n import json\n+import fcntl\n",
            ),
          }
        : file,
    ),
  };
  const published = store.publish(id, thread.id, second);
  assert.equal(published.round.round, 2);
  const view = store.review(id);
  assert.ok(view !== undefined);
  const comment = view.state.comments[0];
  assert.ok(comment !== undefined && comment.kind === "inline");
  assert.equal(comment.attachment.state, "attached");
  assert.match(comment.attachment.reason, /quoted lines/);
  assert.equal(comment.anchor.snapshot.round, 1);

  // A page still showing round 1 cannot comment by its row numbers on round 2's patch.
  fails(
    () =>
      store.act(id, {
        kind: "comment",
        selection: rows(first, "src/notes/store.py", 13, 15),
        body: "Old rows",
      }),
    "changed",
    /changed since the page showed it/,
  );

  // Fresh start: the review closes, the new one has no comments and carries only the approval that still holds.
  // Closing is a change to the old review, announced to its pages and agents.
  await Promise.resolve(); // deliver the earlier transactions' announcements first
  const before = store.review(id)?.revision ?? 0;
  const announced: Array<[string, number]> = [];
  store.subscribe((review, revision) => announced.push([review, revision]));
  const fresh = store.register({
    target: first.target,
    label: "Codex",
    host: { kind: "codex" },
    fresh: true,
  });
  assert.ok(fresh.created);
  assert.notEqual(fresh.review.state.id, id);
  assert.ok(store.review(id)?.state.closed_at !== undefined);
  assert.equal(store.review(id)?.revision, before + 1);
  await Promise.resolve();
  assert.deepEqual(announced, [
    [id, before + 1],
    [fresh.review.state.id, fresh.review.revision],
  ]);
  fails(
    () => store.act(id, { kind: "general_comment", body: "late" }),
    "closed",
    /closed/,
  );
  store.publish(fresh.review.state.id, fresh.thread.id, second);
  const carried = store.review(fresh.review.state.id);
  assert.ok(carried !== undefined);
  assert.deepEqual(carried.state.comments, []);
  assert.deepEqual(
    carried.state.approvals.map((approval) => [
      approval.path,
      approval.round,
      approval.carried_from?.review,
    ]),
    [["src/notes/cli.py", 1, id]],
  );
  assert.equal(store.reviews().length, 2);
  store.close();
});

test("the database file and its folder are private", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-store-"));
  const path = join(dir, "data", "reviews.sqlite");
  const store = Store.open(path);
  store.close();
  assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Opening again reads the same schema version.
  Store.open(path).close();
});

test("a review refuses a thread past the limit, and a refused registration changes nothing", () => {
  const store = Store.open(":memory:");
  const first = input();
  const register = () =>
    store.register({ target: first.target, label: "Thread", host });
  const { review, thread } = register();
  store.publish(review.state.id, thread.id, first);
  for (let count = 1; count < Limits.MAX_THREADS; count++) register();
  const revision = store.review(review.state.id)?.revision;
  fails(register, "invalid", /already has 100 threads/);
  const after = store.review(review.state.id);
  assert.equal(after?.threads.length, Limits.MAX_THREADS);
  assert.equal(after?.revision, revision);
  store.close();
});

test("submission summaries count toward the feedback text budget", () => {
  const store = Store.open(":memory:");
  const first = input();
  const { review, thread } = store.register({
    target: first.target,
    label: "Thread",
    host,
  });
  const id = review.state.id;
  store.publish(id, thread.id, first);
  const body = "x".repeat(Limits.MAX_TEXT_UNITS);
  const allowed = Math.floor(Limits.MAX_FEEDBACK_TEXT_UNITS / body.length);
  for (let count = 0; count < allowed; count++)
    store.act(id, {
      kind: "submit",
      round: 1 as RoundNumber,
      verdict: "comment",
      body,
    });
  const revision = store.review(id)?.revision;
  fails(
    () =>
      store.act(id, {
        kind: "submit",
        round: 1 as RoundNumber,
        verdict: "comment",
        body,
      }),
    "invalid",
    /exceed 2097152 UTF-16 code units/,
  );
  assert.equal(store.review(id)?.revision, revision);
  store.close();
});
