import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile } from "../../schema/input.ts";
import { parseRows } from "../../review/patch.ts";
import { turnOf } from "../../review/state.ts";
import { diffTable, gaps, pairRows } from "./diff.ts";

// Lines 1-10 of a file; the patch changes line 3 and line 8.
const content = `${Array.from({ length: 10 }, (_, at) => (at === 2 ? "three!" : at === 7 ? "eight!" : `line ${at + 1}`)).join("\n")}\n`;
const patch =
  "@@ -2,3 +2,3 @@\n line 2\n-line 3\n+three!\n line 4\n@@ -7,3 +7,3 @@\n line 7\n-line 8\n+eight!\n line 9\n";

const file = (extra: Partial<ReviewFile> = {}): ReviewFile =>
  ({
    path: "f.txt",
    status: "modified",
    group: "core",
    additions: 2,
    deletions: 2,
    patch,
    ...extra,
  }) as ReviewFile;

test("the unchanged lines around the hunks come from the file's text, with both line numbers", () => {
  const found = gaps(patch, content);
  assert.deepEqual(
    found.map((gap) => [
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

const render = (layout: "unified" | "split", extra: Partial<ReviewFile> = {}) =>
  diffTable({
    file: file(extra),
    comments: [],
    tableId: "f0",
    threads: [],
    writable: true,
    layout,
    standing: turnOf,
  }).value;

test("a whole file renders its lines as selectable units in either layout", () => {
  const unified = render("unified");
  assert.match(unified, /<table class="diff unified"/);
  assert.match(
    unified,
    /<tr id="f0-r2" class="deletion" data-row="2" data-selectable data-old="3" data-new="" data-side="old">/,
  );
  const split = render("split");
  assert.match(split, /<table class="diff split"/);
  // The changed line pairs its old and new halves; a context line is one row index on both sides.
  assert.match(
    split,
    /<td class="half old deletion" data-row="2" data-selectable data-old="3" data-new="" data-side="old">/,
  );
  assert.match(
    split,
    /<td class="half new addition" data-row="3" data-selectable data-old="" data-new="3" data-side="new">/,
  );
  assert.equal(split.match(/data-row="1" data-selectable/g)?.length, 2);
});

test("with the file's text, unchanged lines sit between the hunks, hidden until asked for", () => {
  const page = render("unified", { new_content: content });
  assert.match(
    page,
    /data-expand="0" data-folded="0" data-context="1" aria-expanded="false">Show 1 more line</,
  );
  assert.match(
    page,
    /data-expand="1" data-folded="0" data-context="2" aria-expanded="false">Show 2 more lines</,
  );
  assert.match(
    page,
    /<tbody class="gap-lines" data-gap-lines="1" data-gap="1" hidden><tr class="unchanged"><td class="line-number"><span class="ln-old">5<\/span><span class="ln-new">5<\/span><\/td>/,
  );
  // Without the text, there is nothing to expand.
  assert.doesNotMatch(render("unified"), /data-expand/);
});

test("rows outside the shown ranges fold behind a toggle, with no + button until revealed", () => {
  const rows = "@@ -1,8 +1,8 @@\n a\n b\n c\n d\n-e\n+E\n f\n g\n h\n";
  const table = diffTable({
    file: file({ patch: rows }),
    shown: [{ start: 5, end: 6 }],
    comments: [],
    tableId: "f0",
    threads: [],
    writable: true,
    layout: "split",
    standing: turnOf,
  }).value;
  assert.match(table, /<table class="diff split"/);
  // Rows 0-4 fold (five rows); rows 7-9 are too few to fold, so they show.
  assert.match(table, /data-expand="r0" data-folded="5" data-context="0" aria-expanded="false">Show 5 more lines</);
  assert.match(table, /<tbody class="gap-lines folded" data-gap-lines="r0" data-gap="r0" hidden>/);
  const folded = table.slice(table.indexOf('data-gap-lines="r0"'), table.indexOf("</tbody>", table.indexOf('data-gap-lines="r0"')));
  assert.doesNotMatch(folded, /add-comment/);
  assert.match(folded, /data-selectable/);
  assert.equal(table.match(/data-expand="r/g)?.length, 1);
});

test("folded rows next to unchanged lines are one gap with one control, which shows the folded rows first", () => {
  // Three unchanged lines before the hunk, whose first rows fold: one control counts both.
  const text = Array.from({ length: 12 }, (_, at) => `l${at + 1}`);
  const patch = "@@ -4,8 +4,8 @@\n l4\n l5\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n";
  const table = diffTable({
    file: file({ patch, new_content: `${text.map((line, at) => (at === 8 ? "L9" : line)).join("\n")}\n` }),
    shown: [{ start: 6, end: 7 }],
    comments: [],
    tableId: "f0",
    threads: [],
    writable: true,
    layout: "unified",
    standing: turnOf,
  }).value;
  // Before the hunk: lines 1-3 unchanged and rows 0-5 (the header and l4-l8) folded, as one gap of nine lines.
  assert.equal(table.match(/data-expand=/g)?.length, 2);
  assert.match(table, /data-expand="0" data-folded="6" data-context="3" aria-expanded="false">Show 9 more lines</);
  // The control sits right above the unchanged lines it leaves for its second activation.
  assert.match(table, /Show 9 more lines<\/button><\/td><\/tr><\/tbody><tbody class="gap-lines" data-gap-lines="0" data-gap="0" hidden>/);
  assert.match(table, /<tbody class="gap-lines folded" data-gap-lines="r0" data-gap="0" hidden>/);
});
