// How the page lays out a patch: unchanged lines between hunks, split pairs, folded rows, and their one control.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import { parseRows } from "../../review/patch.ts";
import type {
  ContentDigest,
  PatchDigest,
  RepoPath,
} from "../../schema/primitives.ts";
import {
  gapLabel,
  gapStage,
  gaps,
  heldLines,
  holdsLines,
  inSpan,
  lastUnit,
  layoutDiff,
  nextStage,
  onVersion,
  pairRows,
  parseUnit,
  placeComments,
  readingOrder,
  type Segment,
  selectionOf,
  spanEnds,
  spanOf,
  spanOfSelection,
  type Unit,
  unitKey,
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

test("a comment on lines of the text sits on the patch rows that show them, or under unchanged lines outside the patch", () => {
  const file = { path: "a.txt", patch, new_content: content } as ReviewFile;
  const comment = (id: string, attachment: object) =>
    ({
      kind: "inline",
      id,
      anchor: { kind: "text", path: "a.txt" },
      attachment,
    }) as unknown as Comment;
  const lines = (start_line: number, end_line: number) => ({
    state: "attached",
    reason: "Same text.",
    start_line,
    end_line,
  });
  const { placed, context, orphans } = placeComments(file, [
    // Lines 3 and 4 are the added "three!" and the context after it: rows 3 and 4.
    comment("in-patch", lines(3, 4)),
    // Line 6 is between the hunks, which only the file's text shows.
    comment("outside", lines(6, 6)),
    comment("gone", { state: "orphan", reason: "Gone." }),
  ]);
  assert.deepEqual(
    placed.map((item) => [item.comment.id, item.start, item.end]),
    [["in-patch", 3, 4]],
  );
  assert.deepEqual(
    context.map((item) => [item.comment.id, item.start_line, item.end_line]),
    [["outside", 6, 6]],
  );
  assert.deepEqual(
    orphans.map((item) => item.id),
    ["gone"],
  );
});

// The units of `patch` above: row 0 is the first header, rows 1-4 are lines 2-4 with "line 3" deleted and "three!"
// added, row 5 the second header, rows 6-9 lines 7-9 with "line 8" deleted and "eight!" added. Lines 1, 5, 6, and 10
// are unchanged lines outside the patch.
const rows = parseRows(patch);
const row = (index: number): Unit => ({ kind: "row", index });
const line = (number: number): Unit => ({ kind: "line", line: number });

test("a unit's name in the page reads back as the unit, and nothing else does", () => {
  for (const unit of [row(0), row(12), line(1), line(40)])
    assert.deepEqual(parseUnit(unitKey(unit)), unit);
  assert.equal(unitKey(row(3)), "r3");
  assert.equal(unitKey(line(6)), "l6");
  for (const text of ["", "r", "x3", "r-1", "l1.5", "r03", "r3 ", "lines"])
    assert.equal(parseUnit(text), undefined, text);
});

test("rows alone span rows of the patch; with an unchanged line, the span is new-side lines", () => {
  assert.deepEqual(spanOf(rows, [row(4), row(2)]), {
    kind: "rows",
    start: 2,
    end: 4,
  });
  assert.deepEqual(spanOf(rows, [line(5), line(6)]), {
    kind: "lines",
    start: 5,
    end: 6,
  });
  // From line 1, above the first hunk, to "three!" (row 3, line 3).
  assert.deepEqual(spanOf(rows, [line(1), row(3)]), {
    kind: "lines",
    start: 1,
    end: 3,
  });
  // A deletion adds no new line at either end: "line 8" (row 7) sits after line 7.
  assert.deepEqual(spanOf(rows, [line(5), row(7)]), {
    kind: "lines",
    start: 5,
    end: 7,
  });
  assert.deepEqual(spanOf(rows, [row(7), line(10)]), {
    kind: "lines",
    start: 8,
    end: 10,
  });
  // A single unit spans itself.
  assert.deepEqual(spanOf(rows, [line(6)]), {
    kind: "lines",
    start: 6,
    end: 6,
  });
  assert.deepEqual(spanEnds({ kind: "lines", start: 5, end: 7 }), [
    line(5),
    line(7),
  ]);
  assert.deepEqual(spanEnds({ kind: "rows", start: 2, end: 4 }), [
    row(2),
    row(4),
  ]);
});

test("a lines span covers the rows that show its lines but no deletion, and ends under its last line", () => {
  const lines = { kind: "lines", start: 1, end: 3 } as const;
  assert.deepEqual(
    [line(1), row(1), row(2), row(3), row(4), line(5)].map((unit) =>
      inSpan(rows, lines, unit),
    ),
    [true, true, false, true, false, false],
  );
  const rowSpan = { kind: "rows", start: 2, end: 3 } as const;
  assert.deepEqual(
    [row(1), row(2), row(3), line(3)].map((unit) =>
      inSpan(rows, rowSpan, unit),
    ),
    [false, true, true, false],
  );
  // The thread goes under the row that shows the last line, or under the unchanged line itself.
  assert.deepEqual(lastUnit(rows, lines), row(3));
  assert.deepEqual(
    lastUnit(rows, { kind: "lines", start: 5, end: 6 }),
    line(6),
  );
  assert.deepEqual(lastUnit(rows, rowSpan), row(3));
});

test("a span is sent with the digest of what it spans, and a selection holds while that digest is the file's", () => {
  const file = {
    path: "a.txt" as RepoPath,
    digest: "p".repeat(64) as PatchDigest,
    text: "t".repeat(64) as ContentDigest,
  };
  const rowsSelection = selectionOf(file, { kind: "rows", start: 2, end: 4 });
  assert.deepEqual(rowsSelection, {
    kind: "rows",
    path: "a.txt",
    patch_sha256: file.digest,
    start_row: 2,
    end_row: 4,
  });
  const textSelection = selectionOf(file, { kind: "lines", start: 5, end: 6 });
  assert.deepEqual(textSelection, {
    kind: "text",
    path: "a.txt",
    content_sha256: file.text,
    start_line: 5,
    end_line: 6,
  });
  // Without the digest, nothing can be sent.
  assert.equal(
    selectionOf(
      { ...file, text: undefined },
      { kind: "lines", start: 5, end: 6 },
    ),
    undefined,
  );
  assert.equal(
    selectionOf(
      { ...file, digest: undefined },
      { kind: "rows", start: 2, end: 4 },
    ),
    undefined,
  );
  if (rowsSelection === undefined || textSelection === undefined)
    return assert.fail("both selections exist");
  assert.deepEqual(spanOfSelection(textSelection), {
    kind: "lines",
    start: 5,
    end: 6,
  });
  assert.equal(onVersion(rowsSelection, file), true);
  assert.equal(onVersion(textSelection, file), true);
  // A new round's patch leaves a text selection where it was, and the other way round.
  const newPatch = { ...file, digest: "q".repeat(64) as PatchDigest };
  assert.equal(onVersion(rowsSelection, newPatch), false);
  assert.equal(onVersion(textSelection, newPatch), true);
  assert.equal(
    onVersion(textSelection, {
      ...file,
      text: "u".repeat(64) as ContentDigest,
    }),
    false,
  );
  assert.equal(onVersion(textSelection, undefined), false);
});

test("a gap holding a thread's lines shows open until the reviewer chooses", () => {
  const layout = layoutDiff(patch, { content });
  const middle = layout.segments[2];
  if (middle?.kind !== "gap") return assert.fail("the gap between the hunks");
  const held = heldLines(
    [{ start_line: 6, end_line: 6 }],
    [
      {
        kind: "rows",
        path: "a.txt" as RepoPath,
        patch_sha256: "p".repeat(64) as PatchDigest,
        start_row: 1,
        end_row: 1,
      },
      {
        kind: "text",
        path: "a.txt" as RepoPath,
        content_sha256: "t".repeat(64) as ContentDigest,
        start_line: 10,
        end_line: 10,
      },
    ],
  );
  assert.deepEqual(held, [
    { start: 6, end: 6 },
    { start: 10, end: 10 },
  ]);
  assert.equal(holdsLines(middle, held), true);
  assert.equal(holdsLines(middle, [{ start: 1, end: 1 }]), false);
  assert.equal(gapStage(undefined, middle, true), 2);
  assert.equal(gapStage(undefined, middle, false), 0);
  // The reviewer's choice wins, held or not.
  assert.equal(gapStage(0, middle, true), 0);
  // A gap with only one kind of hidden line has no first stage.
  assert.equal(gapStage(1, middle, false), 2);
  assert.equal(gapStage(1, { folded: 3, context: 2 }, false), 1);
});

test("the line cursor reads units in patch order, even where the split layout lists a deletion after an addition", () => {
  // Split pairs list their halves on one line: deletions 5-7 beside additions 8-9, so 6 comes after 8. Context rows
  // and unchanged lines are listed twice, once per half.
  assert.deepEqual(
    readingOrder([
      line(1),
      line(1),
      row(4),
      row(4),
      row(5),
      row(8),
      row(6),
      row(9),
      row(7),
      row(10),
      row(10),
      line(20),
      line(20),
    ]).map(unitKey),
    ["l1", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "l20"],
  );
});
