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

const opened = (store: Store) => {
  const first = input();
  const { review, thread, token } = store.register({
    target: first.target,
    label: "Claude Code",
    host,
  });
  store.publish(review.state.id, thread.id, first);
  return { id: review.state.id, thread, token, first };
};

test("a question goes to the agents at once, and they answer it", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: rows(first, "src/notes/store.py", 13, 13),
    body: "Why the same directory?",
    question: true,
  });
  store.act(id, { kind: "general_comment", body: "Rename the module." });
  const view = store.review(id);
  const [asked, review] = view?.state.comments ?? [];
  assert.ok(asked !== undefined && review !== undefined);
  assert.deepEqual(asked.source, { kind: "reviewer", question: true });
  assert.deepEqual(review.source, { kind: "reviewer" });
  store.act(id, {
    kind: "answer",
    thread: thread.id,
    comment: asked.id,
    answer: {
      disposition: "answered",
      body: "So the rename stays on one filesystem.",
    },
  });
  assert.equal(
    turnOf(store.review(id)?.state.comments[0] ?? asked),
    "reviewer",
  );
  store.close();
});

test("an agent's drift report shows until the next round, and an empty one clears it", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "drift",
    paths: ["src/notes/store.py", "src/notes/cli.py"] as Array<RepoPath>,
  });
  assert.deepEqual(store.review(id)?.state.drift?.paths, [
    "src/notes/cli.py",
    "src/notes/store.py",
  ]);
  store.act(id, { kind: "drift", paths: [] });
  assert.equal(store.review(id)?.state.drift, undefined);
  store.act(id, {
    kind: "drift",
    paths: ["src/notes/cli.py"] as Array<RepoPath>,
  });
  store.publish(id, thread.id, first);
  assert.equal(store.review(id)?.state.drift, undefined);
  store.close();
});

test("only a comment that no longer attaches can be moved", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: rows(first, "src/notes/store.py", 13, 15),
    body: "Lock before the rename.",
  });
  const comment = store.review(id)?.state.comments[0];
  assert.ok(comment !== undefined);
  fails(
    () =>
      store.act(id, {
        kind: "reattach",
        comment: comment.id,
        selection: rows(first, "src/notes/store.py", 16, 16),
      }),
    "invalid",
    /no longer attaches/,
  );
  // Round 2 drops store.py, so the comment is an orphan; it can be moved to cli.py.
  const second: ReviewInput = {
    ...first,
    files_complete: false,
    files: first.files.filter((file) => file.path !== "src/notes/store.py"),
  };
  store.publish(id, thread.id, second);
  store.act(id, {
    kind: "reattach",
    comment: comment.id,
    selection: rows(second, "src/notes/cli.py", 1, 1),
  });
  const moved = store.review(id)?.state.comments[0];
  assert.ok(moved !== undefined && moved.kind === "inline");
  assert.equal(moved.anchor.path, "src/notes/cli.py");
  assert.equal(moved.attachment.state, "attached");
  assert.equal(moved.history[0]?.path, "src/notes/store.py");
  store.close();
});

test("a feedback file imports into a fresh review once, with its answers and the approvals that still hold", () => {
  const store = Store.open(":memory:");
  const { id, thread, first } = opened(store);
  store.act(id, {
    kind: "comment",
    selection: rows(first, "src/notes/store.py", 13, 15),
    body: "Lock before the rename.",
  });
  const comment = store.review(id)?.state.comments[0];
  assert.ok(comment !== undefined);
  store.act(id, {
    kind: "answer",
    thread: thread.id,
    comment: comment.id,
    answer: { disposition: "rejected", body: "The rename is atomic already." },
  });
  store.act(id, {
    kind: "approve",
    path: "src/notes/cli.py" as RepoPath,
    fingerprint:
      "eb66c1c8de5a693b75c524a2b6ebe4763260bac93588a1bd120bafc9fd6a15b9" as Fingerprint,
  });
  store.act(id, {
    kind: "submit",
    round: 1 as RoundNumber,
    verdict: "comment",
    body: "",
  });
  const view = store.review(id);
  assert.ok(view !== undefined);
  const feedback = feedbackOf(view, "2026-10-12T00:00:00.000Z" as never);
  assert.ok(feedback !== undefined);

  const fresh = store.register({
    target: first.target,
    label: "Codex",
    host: { kind: "codex" },
    fresh: true,
  });
  const freshId = fresh.review.state.id;
  store.publish(freshId, fresh.thread.id, first);
  const imported = store.importFeedback(freshId, feedback);
  assert.deepEqual(
    {
      comments: imported.report.comments,
      replies: imported.report.replies,
      already: imported.report.already,
    },
    { comments: 1, replies: 1, already: 0 },
  );
  // The fresh start carried the approval already; the import adds nothing to it.
  assert.equal(imported.report.approvals, 0);
  assert.match(
    imported.report.skipped.join("\n"),
    /Finished rounds are not imported/,
  );
  const after = store.review(freshId);
  assert.ok(after !== undefined);
  const copy = after.state.comments[0];
  assert.ok(copy !== undefined && copy.kind === "inline");
  assert.equal(copy.attachment.state, "attached");
  assert.equal(copy.anchor.snapshot.input_sha256, after.round?.input_sha256);
  // The answering thread joined the review without a token: it is listed, and no token can act as it.
  assert.ok(after.threads.some((item) => item.id === thread.id));
  assert.equal(turnOf(copy), "reviewer");

  const again = store.importFeedback(freshId, feedback);
  assert.equal(again.report.comments, 0);
  assert.equal(again.report.already, 1);

  // Feedback for another target is refused whole.
  const other = {
    ...feedback,
    target: { ...feedback.target, root: "/elsewhere" },
  };
  fails(
    () => store.importFeedback(freshId, other as typeof feedback),
    "invalid",
    /another target/,
  );
  store.close();
});

test("GitHub comments import once, inline ones found by their quote, and a refresh adds only new replies", () => {
  const store = Store.open(":memory:");
  const { id } = opened(store);
  const pr = "https://github.com/example/notes/pull/7" as never;
  const post = (n: number, kind: string, body: string) => ({
    id: `PRRC_${n}`,
    author: "octocat",
    url: `https://github.com/example/notes/pull/7#${kind}${n}`,
    body,
    created_at: `2026-10-12T00:0${n}:00.000Z`,
  });
  const hunk =
    '@@ -1,13 +1,19 @@\n import json\n+import os\n+import tempfile\n from pathlib import Path\n \n \n def load(path):\n     return json.loads(Path(path).read_text(encoding="utf-8"))\n \n \n def save(path, notes):\n-    Path(path).write_text(json.dumps(notes), encoding="utf-8")\n+    target = Path(path)\n+    handle, temporary = tempfile.mkstemp(dir=target.parent, prefix=".notes-")';
  const thread = {
    kind: "thread" as const,
    ...post(1, "discussion_r", "Why mkstemp here?"),
    resolved: false,
    path: "src/notes/store.py" as RepoPath,
    side: "RIGHT" as const,
    diff_hunk: hunk,
    replies: [post(2, "discussion_r", "Same filesystem.")],
  };
  const conversation = {
    kind: "conversation" as const,
    ...post(3, "issuecomment-", "Looks good overall."),
  };
  const first = store.importGitHub(id, pr, [thread, conversation] as never);
  assert.deepEqual(
    [first.report.comments, first.report.replies, first.report.already],
    [2, 1, 0],
  );
  const inline = store.review(id)?.state.comments[0];
  assert.ok(inline !== undefined && inline.kind === "inline");
  assert.equal(inline.attachment.state, "attached");
  assert.equal(inline.anchor.start_line, 13);
  assert.equal(turnOf(inline), "agent");

  const refreshed = store.importGitHub(id, pr, [
    {
      ...thread,
      replies: [...thread.replies, post(4, "discussion_r", "Thanks.")],
    },
    conversation,
  ] as never);
  assert.deepEqual(
    [
      refreshed.report.comments,
      refreshed.report.replies,
      refreshed.report.already,
    ],
    [0, 1, 2],
  );
  assert.equal(store.review(id)?.state.comments[0]?.replies.length, 2);
  store.close();
});

test("a GitHub thread whose quote changed on the head is placed on the line GitHub shows it on", () => {
  const pr = "https://github.com/example/notes/pull/8";
  const head = "e".repeat(40);
  // On the head, a comment line went in between the two lines the thread was written on.
  const patch =
    '@@ -1,3 +1,5 @@\n def save(path, notes):\n     target = Path(path)\n-    target.write_text(notes)\n+    handle = open(target, "w")\n+    # One write.\n+    handle.write(notes)\n';
  const decoded = decodeBytes(
    InputDocument,
    Buffer.from(
      JSON.stringify({
        format: "review-canvas.input/1",
        target: { kind: "github_pr", title: "t", url: pr, head_sha: head },
        files_complete: false,
        files: [
          {
            path: "store.py",
            status: "modified",
            group: "core",
            additions: 3,
            deletions: 1,
            patch,
          },
        ],
      }),
    ),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  // The thread as GitHub gives it: written on new lines 3-4 of an earlier commit, now ending on line 5.
  const thread = {
    kind: "thread" as const,
    id: "PRRC_1",
    author: "octocat",
    url: `${pr}#discussion_r1`,
    body: "Close the handle.",
    created_at: "2026-10-12T00:01:00.000Z",
    resolved: false,
    path: "store.py",
    side: "RIGHT" as const,
    start_line: 3,
    line: 5,
    diff_hunk:
      '@@ -1,3 +1,4 @@\n def save(path, notes):\n     target = Path(path)\n-    target.write_text(notes)\n+    handle = open(target, "w")\n+    handle.write(notes)',
    replies: [],
  };
  const imported = (headSha: string | undefined) => {
    const store = Store.open(":memory:");
    const { review, thread: agent } = store.register({
      target: decoded.success.target,
      label: "Claude Code",
      host,
    });
    store.publish(review.state.id, agent.id, decoded.success);
    store.importGitHub(
      review.state.id,
      pr as never,
      [thread] as never,
      headSha as never,
    );
    const comment = store.review(review.state.id)?.state.comments[0];
    store.close();
    assert.ok(comment !== undefined && comment.kind === "inline");
    return comment;
  };

  const placed = imported(head);
  assert.equal(placed.attachment.state, "attached");
  assert.equal(
    placed.attachment.reason,
    "Placed on the line GitHub shows it on at this head.",
  );
  // It spans as many lines as the comment did, ending on GitHub's line.
  assert.deepEqual([placed.anchor.start_line, placed.anchor.end_line], [4, 5]);

  // Without the head the threads were read at, GitHub's line means nothing here: the quote alone decides, and it
  // keeps the whole range the comment was written on.
  for (const other of [undefined, "f".repeat(40)]) {
    const quoted = imported(other);
    assert.equal(quoted.attachment.state, "orphan");
    assert.deepEqual(
      [quoted.anchor.start_line, quoted.anchor.end_line],
      [3, 4],
    );
    assert.equal(
      quoted.anchor.quote,
      '+    handle = open(target, "w")\n+    handle.write(notes)',
    );
  }
});
