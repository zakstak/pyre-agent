// How the page lays out a patch: unchanged lines between hunks, split pairs, folded rows, and their one control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRows } from "../../review/patch.ts";
import {
  gapLabel,
  gaps,
  layoutDiff,
  nextStage,
  pairRows,
  type Segment,
} from "./diff-model.ts";

// Lines 1-10 of a file; the patch changes line 3 and line 8.
const content = `${Array.from({ length: 10 }, (_, at) => (at === 2 ? "three!" : at === 7 ? "eight!" : `line ${at + 1}`)).join("\n")}\n`;
const patch =
  "@@ -2,3 +2,3 @@\n line 2\n-line 3\n+three!\n line 4\n@@ -7,3 +7,3 @@\n line 7\n-line 8\n+eight!\n line 9\n";

const shape = (segments: ReadonlyArray<Segment>) =>
  segments.map((segment) =>
    segment.kind === "rows"
      ? ["rows", segment.rows.map((row) => row.index)]
      : [
          "gap",
          segment.key,
          segment.folded,
          segment.context,
          segment.toggleAt,
          segment.parts.map((part) => part.kind),
        ],
  );

test("the unchanged lines around the hunks come from the file's text, with both line numbers", () => {
  assert.deepEqual(
    gaps(patch, content).map((gap) => [
      gap.before,
      gap.lines.map((line) => [line.old, line.new, line.text]),
    ]),
    [
      [0, [[1, 1, "line 1"]]],
      [
        5,
        [
          [5, 5, "line 5"],
          [6, 6, "line 6"],
        ],
      ],
      [-1, [[10, 10, "line 10"]]],
    ],
  );
});

test("the split layout pairs each run of deletions with the additions after it", () => {
  const rows = parseRows("@@ -1,3 +1,2 @@\n a\n-b\n-c\n+B\n d\n");
  assert.deepEqual(
    pairRows(rows).map((pair) => [
      pair.whole?.index ?? null,
      pair.old?.index ?? null,
      pair.new?.index ?? null,
    ]),
    [
      [0, null, null],
      [null, 1, 1],
      [null, 2, 4],
      [null, 3, null],
      [null, 5, 5],
    ],
  );
});

test("with the file's text, unchanged lines sit between the hunks; without it there is nothing to expand", () => {
  assert.deepEqual(shape(layoutDiff(patch, { content }).segments), [
    ["gap", "0", 0, 1, 0, ["context"]],
    ["rows", [0, 1, 2, 3, 4]],
    ["gap", "1", 0, 2, 0, ["context"]],
    ["rows", [5, 6, 7, 8, 9]],
    ["gap", "2", 0, 1, 0, ["context"]],
  ]);
  assert.deepEqual(shape(layoutDiff(patch).segments), [
    ["rows", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ]);
});

test("rows outside the shown ranges fold behind one control; runs too short to fold show", () => {
  const rows = "@@ -1,8 +1,8 @@\n a\n b\n c\n d\n-e\n+E\n f\n g\n h\n";
  // Rows 0-4 fold (five rows); rows 7-9 are too few to fold, so they show.
  assert.deepEqual(
    shape(layoutDiff(rows, { shown: [{ start: 5, end: 6 }] }).segments),
    [
      ["gap", "r0", 5, 0, 0, ["folded"]],
      ["rows", [5, 6, 7, 8, 9]],
    ],
  );
});

test("folded rows next to unchanged lines are one gap, whose control sits above the unchanged lines", () => {
  const text = Array.from({ length: 12 }, (_, at) =>
    at === 8 ? "L9" : `l${at + 1}`,
  );
  const hunk =
    "@@ -4,8 +4,8 @@\n l4\n l5\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n";
  const layout = layoutDiff(hunk, {
    shown: [{ start: 6, end: 7 }],
    content: `${text.join("\n")}\n`,
  });
  // Lines 1-3 unchanged and rows 0-5 (the header and l4-l8) folded, as one gap of nine lines.
  assert.deepEqual(shape(layout.segments), [
    ["gap", "0", 6, 3, 0, ["context", "folded"]],
    ["rows", [6, 7, 8, 9]],
    ["gap", "1", 0, 1, 0, ["context"]],
  ]);
});

test("a gap's control shows the folded rows, then the unchanged lines, then hides them all", () => {
  const both = { folded: 6, context: 3 };
  assert.equal(gapLabel(0, both), "Show 9 more lines");
  assert.equal(nextStage(0, both), 1);
  assert.equal(gapLabel(1, both), "Show 3 more lines");
  assert.equal(nextStage(1, both), 2);
  assert.equal(gapLabel(2, both), "Hide 9 lines");
  assert.equal(nextStage(2, both), 0);
  // With one kind of hidden line there is no middle step.
  assert.equal(nextStage(0, { folded: 0, context: 1 }), 2);
  assert.equal(gapLabel(0, { folded: 0, context: 1 }), "Show 1 more line");
});
