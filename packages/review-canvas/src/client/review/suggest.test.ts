import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { parseRows } from "../../review/patch.ts";
import { parseSuggestion } from "../../review/suggestion.ts";
import {
  ContentDigest,
  PatchDigest,
  RepoPath,
} from "../../schema/primitives.ts";
import type { TextSelection } from "../../schema/selection.ts";
import {
  canSuggest,
  insertSuggestion,
  replacedRows,
  replacedSelection,
  suggestionRows,
} from "./suggest.ts";

test("Suggest change puts the block on lines of its own and the caret at the end of its last line", () => {
  const empty = insertSuggestion({
    text: "",
    start: 0,
    end: 0,
    lines: ["a", "b"],
  });
  assert.equal(empty.text, "```suggestion\na\nb\n```");
  assert.equal(empty.text.slice(0, empty.caret), "```suggestion\na\nb");
  // After text on the same line, and before more: the block gets line ends of its own.
  const middle = insertSuggestion({
    text: "Try this: and thanks",
    start: 10,
    end: 10,
    lines: ["x"],
  });
  assert.equal(middle.text, "Try this: \n```suggestion\nx\n```\nand thanks");
  assert.equal(middle.text.slice(middle.caret), "\n```\nand thanks");
  assert.deepEqual(parseSuggestion(middle.text), {
    kind: "suggestion",
    lines: ["x"],
  });
  // A selection is replaced; line ends already there are kept, not doubled.
  const selected = insertSuggestion({
    text: "Before\nOLD\nAfter",
    start: 7,
    end: 10,
    lines: ["y"],
  });
  assert.equal(selected.text, "Before\n```suggestion\ny\n```\nAfter");
  // No lines proposes deleting them: the caret goes to the end of the opening fence.
  const none = insertSuggestion({ text: "", start: 0, end: 0, lines: [] });
  assert.equal(none.text.slice(0, none.caret), "```suggestion");
});

test("a suggestion replaces the lines on the anchor's side, and is offered on new-side lines only", () => {
  const rows = parseRows("@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n");
  const replaced = replacedRows(rows, 1, 4);
  assert.deepEqual(replaced, {
    side: "new",
    first: 10,
    lines: ["keep", "new", "tail"],
  });
  assert.equal(canSuggest(replaced), true);
  assert.deepEqual(replacedRows(rows, 3, 3), {
    side: "new",
    first: 11,
    lines: ["new"],
  });
  // Deleted lines alone, or with context, are old-side, as the anchor is: they show a diff but offer no suggestion.
  const deleted = replacedRows(rows, 1, 2);
  assert.deepEqual(deleted, { side: "old", first: 10, lines: ["keep", "old"] });
  assert.equal(canSuggest(deleted), false);
  assert.deepEqual(replacedRows(rows, 2, 2), {
    side: "old",
    first: 11,
    lines: ["old"],
  });
  // A hunk header alone is no line.
  assert.equal(replacedRows(rows, 0, 0), undefined);
  assert.equal(canSuggest(undefined), false);
});

test("a composer's selection replaces its rows' lines, or lines of the file's new text", () => {
  const rows = parseRows("@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n");
  const path = Schema.decodeSync(RepoPath)("a.ts");
  assert.deepEqual(
    replacedSelection(
      {
        kind: "rows",
        path,
        patch_sha256: Schema.decodeSync(PatchDigest)("a".repeat(64)),
        start_row: 1,
        end_row: 4,
      },
      rows,
      undefined,
    ),
    replacedRows(rows, 1, 4),
  );
  // Expanded context: the lines come from the text, outside the patch's rows.
  const lines: TextSelection = {
    kind: "text",
    path,
    content_sha256: Schema.decodeSync(ContentDigest)("c".repeat(64)),
    start_line: 2,
    end_line: 3,
  };
  const replaced = replacedSelection(lines, rows, "one\ntwo\nthree\nfour\n");
  assert.deepEqual(replaced, {
    side: "new",
    first: 2,
    lines: ["two", "three"],
  });
  assert.equal(canSuggest(replaced), true);
  // A page without the file's text cannot offer one.
  assert.equal(replacedSelection(lines, rows, undefined), undefined);
});

test("a suggestion's diff numbers each line before and after the change", () => {
  assert.deepEqual(suggestionRows(["a", "b", "c"], ["a", "B", "B2", "c"], 7), [
    { kind: " ", text: "a", before: 7, after: 7 },
    { kind: "-", text: "b", before: 8, after: undefined },
    { kind: "+", text: "B", before: undefined, after: 8 },
    { kind: "+", text: "B2", before: undefined, after: 9 },
    { kind: " ", text: "c", before: 9, after: 10 },
  ]);
  assert.deepEqual(suggestionRows(["a"], [], 3), [
    { kind: "-", text: "a", before: 3, after: undefined },
  ]);
});
