import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRows, whitespaceOnly } from "./patch.ts";

const only = (patch: string) =>
  [...whitespaceOnly(parseRows(patch))].sort((a, b) => a - b);

test("a run of deletions and as many additions that differ only in whitespace is whitespace only", () => {
  assert.deepEqual(
    only("@@ -1,3 +1,3 @@\n a\n-  b(1,2)\n- c\n+\tb( 1, 2 )\n+c  \n d\n"),
    [2, 3, 4, 5],
  );
});

test("runs of different lengths are not whitespace only", () => {
  assert.deepEqual(only("@@ -1,2 +1,1 @@\n-a b\n-c\n+ab\n"), []);
  assert.deepEqual(only("@@ -1,1 +1,2 @@\n-ab\n+a b\n+\n"), []);
});

test("one pair that differs in more than whitespace keeps the whole run", () => {
  assert.deepEqual(only("@@ -1,2 +1,2 @@\n-a\n-b\n+ a\n+B\n"), []);
});

test("each run is judged alone, and a run broken by context or a header is two runs", () => {
  const patch =
    "@@ -1,4 +1,4 @@\n-x\n+ x\n y\n-z\n+Z\n@@ -9,1 +9,1 @@\n-w\n+w \n";
  assert.deepEqual(only(patch), [1, 2, 7, 8]);
  // Additions before the deletions do not pair with them.
  assert.deepEqual(only("@@ -1,1 +1,2 @@\n+ a\n-a\n"), []);
});

test("rows that change nothing else are untouched", () => {
  assert.deepEqual(only("@@ -1,2 +1,2 @@\n a\n b\n"), []);
  assert.deepEqual(only("@@ -0,0 +1,1 @@\n+a\n"), []);
});
