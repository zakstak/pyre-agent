import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Anchor } from "../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type {
  InputDigest,
  RepoPath,
  RoundNumber,
} from "../schema/primitives.ts";
import { anchorForRows } from "./anchor.ts";
import { patchDigest } from "./patch.ts";
import { tourView } from "./tour.ts";

const file = (patch: string): ReviewFile =>
  ({
    path: "emoji.txt",
    status: "modified",
    group: "core",
    additions: 0,
    deletions: 0,
    patch,
  }) as ReviewFile;

const snapshot = {
  round: 1 as RoundNumber,
  input_sha256: "a".repeat(64) as InputDigest,
};

const anchorOn = (patch: string, row: number) => {
  const anchor = anchorForRows(file(patch), snapshot, {
    path: "emoji.txt" as RepoPath,
    patch_sha256: patchDigest(patch),
    start_row: row,
    end_row: row,
  });
  assert.ok(!("kind" in anchor), JSON.stringify(anchor));
  return anchor;
};

test("anchor context never splits a character made of two UTF-16 units", () => {
  // The 80-unit prefix of the last row would start on the emoji's second unit.
  const before = `@@ -0,0 +1,2 @@\n+😀${"a".repeat(78)}\n+second\n`;
  const prefixed = anchorOn(before, 2);
  assert.ok(prefixed.prefix.isWellFormed());
  assert.equal(prefixed.prefix, `${"a".repeat(78)}\n`);
  assert.ok(Result.isSuccess(Schema.decodeUnknownResult(Anchor)(prefixed)));

  // The 80-unit suffix of the first row would end on the emoji's first unit.
  const after = `@@ -0,0 +1,2 @@\n+first\n+${"b".repeat(77)}😀\n`;
  const suffixed = anchorOn(after, 1);
  assert.ok(suffixed.suffix.isWellFormed());
  assert.equal(suffixed.suffix, `\n+${"b".repeat(77)}`);
  assert.ok(Result.isSuccess(Schema.decodeUnknownResult(Anchor)(suffixed)));
});

test("a selection of another version of the patch is refused, not moved", () => {
  const patch = "@@ -1 +1 @@\n-old\n+new\n";
  const anchor = anchorForRows(file(patch), snapshot, {
    path: "emoji.txt" as RepoPath,
    patch_sha256: patchDigest("@@ -1 +1 @@\n-older\n+new\n"),
    start_row: 1,
    end_row: 1,
  });
  assert.deepEqual(anchor, { kind: "changed" });
});

test("a note on an old-side excerpt pins to the old line number, not a new one", () => {
  // Context "a" is old line 1 and new line 2, so old line 2 is the deleted "b".
  const patch = "@@ -1,3 +1,3 @@\n+inserted\n a\n-b\n c\n";
  const input = {
    format: "review-canvas.input/1",
    target: {
      kind: "worktree",
      title: "t",
      root: "/r",
      head_sha: "d".repeat(40),
    },
    files_complete: false,
    files: [{ ...file(patch), path: "f.txt" }],
    stops: [
      {
        title: "The removal",
        summary: "",
        attention: null,
        excerpts: [
          { path: "f.txt", side: "old", start: 1, end: 3, caption: "" },
        ],
        files: [],
        notes: [{ path: "f.txt", line: 2, title: "Gone", body: "" }],
        questions: [],
      },
    ],
  } as unknown as ReviewInput;
  const { stops, warnings } = tourView(input);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    stops[0]?.excerpts[0]?.notes.map((note) => [note.letter, note.row]),
    [["A", 3]],
  );
});

test("a selection of only blank lines is refused with a reason, not a schema error", () => {
  const patch = "@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n";
  const anchor = anchorForRows(file(patch), snapshot, {
    path: "emoji.txt" as RepoPath,
    patch_sha256: patchDigest(patch),
    start_row: 2,
    end_row: 2,
  });
  assert.deepEqual(anchor, { kind: "blank" });
  // The same blank line with a line of code beside it is fine.
  const withCode = anchorForRows(file(patch), snapshot, {
    path: "emoji.txt" as RepoPath,
    patch_sha256: patchDigest(patch),
    start_row: 1,
    end_row: 2,
  });
  assert.ok(!("kind" in withCode), JSON.stringify(withCode));
});
