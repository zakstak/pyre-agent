import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { Fingerprint, RepoPath, Timestamp } from "../schema/primitives.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { patchDigest } from "../review/anchor.ts";
import { Store } from "../store/store.ts";
import { statusOf } from "./status.ts";

const PATH = "long.txt" as RepoPath;
const PATCH =
  "@@ -1,4 +1,4 @@\n line 1\n line 2\n line 3\n line 4\n@@ -27,4 +27,4 @@\n line 27\n line 28\n-line 29\n+twenty-nine\n line 30\n";

/** The fixture with a file of two hunks, lines 1-4 and 27-30, and lines 5-26 between them unshown. */
const twoHunks = (): ReviewInput => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return {
    ...decoded.success,
    files_complete: false,
    files: [
      ...decoded.success.files,
      {
        path: PATH,
        status: "modified",
        group: "core",
        additions: 1,
        deletions: 1,
        fingerprint: "2".repeat(64) as Fingerprint,
        patch: PATCH,
      },
    ],
  };
};

test("a suggestion on lines across a hunk header reaches the agents as not contiguous, not as a range to replace", () => {
  const store = Store.open(":memory:");
  const input = twoHunks();
  const { review, thread } = store.register({
    target: input.target,
    label: "Claude Code",
    host: { kind: "claude-code" },
  });
  const id = review.state.id;
  store.publish(id, thread.id, input);
  const ask = (start_row: number, end_row: number, body: string) =>
    store.act(id, {
      kind: "comment",
      selection: {
        kind: "rows",
        path: PATH,
        patch_sha256: patchDigest(PATCH),
        start_row,
        end_row,
      },
      body,
      question: true,
    });
  // Rows 4 to 6: line 4, the second hunk's header, and line 27.
  ask(4, 6, "Join these:\n```suggestion\nline 4 and 27\n```");
  ask(6, 7, "Number them:\n```suggestion\nline 27.\nline 28.\n```");
  const view = store.review(id);
  assert.ok(view !== undefined);
  const [across, within] = view.state.comments;
  assert.ok(across !== undefined && within !== undefined);
  const status = statusOf(
    view,
    "http://127.0.0.1",
    "2026-11-03T00:00:00.000Z" as Timestamp,
  );
  assert.deepEqual(status.suggestions, [
    { comment: across.id, state: "malformed", problem: "not_contiguous" },
    {
      comment: within.id,
      state: "ready",
      path: PATH,
      side: "new",
      round: 1,
      start_line: 27,
      end_line: 28,
      current: ["line 27", "line 28"],
      replacement: ["line 27.", "line 28."],
    },
  ]);
  store.close();
});
