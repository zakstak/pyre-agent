import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../schema/feedback.ts";
import { parseRows } from "./patch.ts";
import {
  anchoredLines,
  isRun,
  parseSuggestion,
  replacedLines,
  rowsLines,
  suggestionBlock,
  suggestionDiff,
  suggestionParts,
  textRange,
} from "./suggestion.ts";

type InlineAnchor = Extract<Comment, { kind: "inline" }>["anchor"];

test("a body without a suggestion block proposes nothing, though it may hold other code", () => {
  assert.deepEqual(parseSuggestion("Rename this."), { kind: "none" });
  assert.deepEqual(parseSuggestion("Like this:\n```ts\nconst a = 1;\n```"), {
    kind: "none",
  });
  // Indented four spaces, a fence is code, not a fence.
  assert.deepEqual(parseSuggestion("    ```suggestion\n    x\n    ```"), {
    kind: "none",
  });
});

test("one suggestion block proposes its lines, with the text around it left as prose", () => {
  assert.deepEqual(
    parseSuggestion(
      "Use a constant:\n```suggestion\nconst LIMIT = 10;\nuse(LIMIT);\n```\nThanks.",
    ),
    { kind: "suggestion", lines: ["const LIMIT = 10;", "use(LIMIT);"] },
  );
  // An empty block proposes deleting the lines; a block of one blank line proposes a blank line.
  assert.deepEqual(parseSuggestion("```suggestion\n```"), {
    kind: "suggestion",
    lines: [],
  });
  assert.deepEqual(parseSuggestion("```suggestion\n\n```"), {
    kind: "suggestion",
    lines: [""],
  });
});

test("fences follow CommonMark: tildes, longer fences, closing length, trailing spaces, and CRLF", () => {
  assert.deepEqual(parseSuggestion("~~~suggestion\na\n~~~"), {
    kind: "suggestion",
    lines: ["a"],
  });
  // A longer fence holds a shorter one as text, and closes only on one at least as long.
  assert.deepEqual(parseSuggestion("````suggestion\nx = ```\n```\n````  "), {
    kind: "suggestion",
    lines: ["x = ```", "```"],
  });
  assert.deepEqual(parseSuggestion("```suggestion\r\na\r\nb\r\n```\r\n"), {
    kind: "suggestion",
    lines: ["a", "b"],
  });
  // Up to three spaces of indent still make a fence; the info string may say more after the word.
  assert.deepEqual(parseSuggestion("   ```suggestion extra\na\n   ```"), {
    kind: "suggestion",
    lines: ["a"],
  });
  // A tilde fence does not close a backtick one.
  assert.deepEqual(parseSuggestion("```suggestion\na\n~~~\n```"), {
    kind: "suggestion",
    lines: ["a", "~~~"],
  });
});

test("a suggestion fence inside another code block is code", () => {
  assert.deepEqual(parseSuggestion("````md\n```suggestion\na\n```\n````"), {
    kind: "none",
  });
  // A word that only starts with suggestion is another language.
  assert.deepEqual(parseSuggestion("```suggestions\na\n```"), {
    kind: "none",
  });
});

test("an unclosed suggestion block and several blocks are malformed, whatever else the body holds", () => {
  assert.deepEqual(parseSuggestion("```suggestion\nconst a = 1;"), {
    kind: "malformed",
    problem: "unclosed",
  });
  assert.deepEqual(
    parseSuggestion("```suggestion\na\n```\nand\n```suggestion\nb\n```"),
    { kind: "malformed", problem: "several" },
  );
  // One closed block and a second one left open: the open one is the problem the reviewer must fix.
  assert.deepEqual(parseSuggestion("```suggestion\na\n```\n```suggestion\nb"), {
    kind: "malformed",
    problem: "unclosed",
  });
  // An unclosed block of another language swallows the rest, as CommonMark reads it.
  assert.deepEqual(parseSuggestion("```ts\na\n```suggestion\nb\n```x"), {
    kind: "none",
  });
});

test("the composer's block holds the lines as they are, with a fence no line can close", () => {
  const plain = suggestionBlock(["a", "  b"]);
  assert.equal(plain, "```suggestion\na\n  b\n```");
  assert.deepEqual(parseSuggestion(plain), {
    kind: "suggestion",
    lines: ["a", "  b"],
  });
  const fenced = suggestionBlock(["```", "x ```` y"]);
  assert.equal(fenced.split("\n")[0], "`````suggestion");
  assert.deepEqual(parseSuggestion(`Try:\n${fenced}`), {
    kind: "suggestion",
    lines: ["```", "x ```` y"],
  });
  assert.deepEqual(parseSuggestion(suggestionBlock([])), {
    kind: "suggestion",
    lines: [],
  });
});

test("a suggestion's diff is the current lines against the proposed ones", () => {
  assert.deepEqual(suggestionDiff(["a", "b", "c"], ["a", "B", "c"]), [
    { kind: " ", text: "a" },
    { kind: "-", text: "b" },
    { kind: "+", text: "B" },
    { kind: " ", text: "c" },
  ]);
  assert.deepEqual(suggestionDiff(["a"], []), [{ kind: "-", text: "a" }]);
  assert.deepEqual(suggestionDiff(["a"], ["a"]), [{ kind: " ", text: "a" }]);
});

test("the lines a comment is on drop the diff markers and keep only the anchor's side", () => {
  const patch = {
    kind: "patch",
    side: "new",
    quote: " keep\n-gone\n+added\n\\ No newline at end of file",
  } as InlineAnchor;
  assert.deepEqual(anchoredLines(patch), ["keep", "added"]);
  assert.deepEqual(anchoredLines({ ...patch, side: "old" } as InlineAnchor), [
    "keep",
    "gone",
  ]);
  const text = {
    kind: "text",
    side: "new",
    quote: "one\n\nthree",
  } as InlineAnchor;
  assert.deepEqual(anchoredLines(text), ["one", "", "three"]);
});

test("a suggestion replaces its comment's lines only when they fill its range, which lines across a hunk header do not", () => {
  assert.equal(isRun([4, 5, 6]), true);
  assert.equal(isRun([]), true);
  assert.equal(isRun([4, 27]), false);
  const across = {
    kind: "patch",
    side: "new",
    quote: " line 4\n@@ -27,4 +27,4 @@\n line 27",
    start_line: 4,
    end_line: 27,
  } as InlineAnchor;
  // The page showed lines 4 and 27; replacing 4 through 27 with them would drop lines 5 to 26.
  assert.equal(replacedLines(across), undefined);
  const within = {
    kind: "patch",
    side: "new",
    quote: " keep\n-gone\n+added",
    start_line: 10,
    end_line: 11,
  } as InlineAnchor;
  assert.deepEqual(replacedLines(within), ["keep", "added"]);
  const text = {
    kind: "text",
    side: "new",
    quote: "one\n\nthree",
    start_line: 2,
    end_line: 4,
  } as InlineAnchor;
  assert.deepEqual(replacedLines(text), ["one", "", "three"]);
});

test("Suggest change fills its block with the selected lines' current text, on the side the anchor takes", () => {
  const rows = parseRows("@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n");
  // Context and an addition: the new side, without the deleted line.
  assert.deepEqual(rowsLines(rows, 1, 3), ["keep", "new"]);
  // Deleted lines alone: the old side.
  assert.deepEqual(rowsLines(rows, 2, 2), ["old"]);
  assert.deepEqual(rowsLines(rows, 0, 4), ["keep", "new", "tail"]);
  assert.deepEqual(textRange("a\nb\nc\n", 2, 3), ["b", "c"]);
});

test("a page shows a suggestion between the text around it, and a malformed body as text with its problem", () => {
  assert.deepEqual(
    suggestionParts(
      "Use a constant:\n```suggestion\nconst A = 1;\n```\nThanks.",
    ),
    {
      kind: "suggestion",
      before: "Use a constant:",
      lines: ["const A = 1;"],
      after: "Thanks.",
    },
  );
  // A block alone has no text around it; CRLF bodies part on the same lines.
  assert.deepEqual(suggestionParts("```suggestion\r\na\r\n```\r\n"), {
    kind: "suggestion",
    before: "",
    lines: ["a"],
    after: "",
  });
  assert.deepEqual(suggestionParts("Rename this."), {
    kind: "text",
    text: "Rename this.",
  });
  assert.deepEqual(suggestionParts("```suggestion\na"), {
    kind: "malformed",
    text: "```suggestion\na",
    problem: "unclosed",
  });
  const several = "```suggestion\na\n```\n```suggestion\nb\n```";
  assert.deepEqual(suggestionParts(several), {
    kind: "malformed",
    text: several,
    problem: "several",
  });
});
