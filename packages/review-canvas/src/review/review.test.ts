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
import { patchTotals } from "../schema/input.ts";
import { anchorForRows } from "./anchor.ts";
import { unifiedDiff } from "./linediff.ts";
import { applyAnalysis } from "../schema/analysis.ts";
import { patchDigest } from "./anchor.ts";
import { hunkRanges } from "./patch.ts";
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

test("a line diff of two texts is a unified patch the patch reader agrees with", () => {
  const before =
    Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join("\n") + "\n";
  const after = before
    .replace("line 3\n", "three\n")
    .replace("line 11\n", "line 11\nnew\n");
  const patch = unifiedDiff(before, after);
  assert.equal(
    patch,
    "@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+three\n line 4\n line 5\n line 6\n" +
      "@@ -9,4 +9,5 @@\n line 9\n line 10\n line 11\n+new\n line 12\n",
  );
  assert.deepEqual(patchTotals(patch ?? ""), {
    kind: "totals",
    additions: 2,
    deletions: 1,
  });
  assert.equal(unifiedDiff(before, before), undefined);
  // A new file, and a file emptied.
  assert.equal(unifiedDiff("", "a\nb\n"), "@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(unifiedDiff("a\n", ""), "@@ -1,1 +0,0 @@\n-a\n");
  // Too different to diff within the limit.
  assert.equal(unifiedDiff("a\nb\nc\n", "x\ny\nz\n", { limit: 2 }), undefined);
});

test("an analysis merges into a snapshot by path, and names the paths it could not apply", () => {
  const snapshot = {
    format: "review-canvas.input/1",
    target: {
      kind: "worktree",
      title: "t",
      root: "/r",
      head_sha: "d".repeat(40),
    },
    files_complete: false,
    files: [
      { ...file("@@ -1 +1 @@\n-a\n+b\n"), path: "a.txt" },
      { ...file("@@ -1 +1 @@\n-c\n+d\n"), path: "b.txt" },
    ],
  } as unknown as ReviewInput;
  const { input, unknownPaths } = applyAnalysis(snapshot, {
    summary: "Swaps letters.",
    files: {
      "a.txt": { group: "mechanical", summary: "a becomes b" },
      "gone.txt": { group: "wiring" },
    },
  });
  assert.equal(input.summary, "Swaps letters.");
  assert.deepEqual(
    input.files.map((item) => [item.path, item.group, item.summary]),
    [
      ["a.txt", "mechanical", "a becomes b"],
      ["b.txt", "core", undefined],
    ],
  );
  assert.deepEqual(unknownPaths, ["gone.txt"]);
});

test("hunk ranges give each hunk's lines on both sides", () => {
  assert.deepEqual(
    hunkRanges("@@ -2,3 +2,4 @@\n a\n-b\n+B\n+C\n c\n@@ -0,0 +10 @@\n+x\n"),
    [
      { old: [2, 4], new: [2, 5] },
      { old: [], new: [10, 10] },
    ],
  );
});

test("the tour says which stop owns each file, and warns about the entries it leaves out", () => {
  const input = {
    format: "review-canvas.input/1",
    target: {
      kind: "worktree",
      title: "t",
      root: "/r",
      head_sha: "d".repeat(40),
    },
    files_complete: false,
    files: [
      { ...file("@@ -1 +1 @@\n-a\n+b\n"), path: "a.txt" },
      { ...file("@@ -1 +1 @@\n-c\n+d\n"), path: "b.txt" },
      { ...file("@@ -1 +1 @@\n-e\n+f\n"), path: "c.txt" },
    ],
    stops: [
      {
        title: "First",
        summary: "",
        attention: null,
        excerpts: [
          { path: "a.txt", side: "new", start: 1, end: 1, caption: "" },
        ],
        files: [{ path: "a.txt", note: "lost" }, { path: "b.txt" }],
        notes: [],
        questions: [],
      },
      {
        title: "Second",
        summary: "",
        attention: null,
        excerpts: [
          { path: "a.txt", side: "new", start: 1, end: 1, caption: "" },
        ],
        files: [{ path: "b.txt" }],
        notes: [],
        questions: [],
      },
    ],
  } as unknown as ReviewInput;
  const { stops, warnings } = tourView(input);
  assert.deepEqual(
    stops.map((stop) => [stop.title, stop.owns]),
    [
      ["First", ["a.txt", "b.txt"]],
      ["Second", []],
      ["Other files", ["c.txt"]],
    ],
  );
  assert.deepEqual(warnings, [
    'stop 1 ("First"): left out the note on a.txt, which this stop excerpts; put it in the excerpt\'s caption',
    'stop 2 ("Second"): left out b.txt, which an earlier stop already covers',
    '1 file no stop covers went into a closing "Other files" stop: c.txt',
  ]);
});
