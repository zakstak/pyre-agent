import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Anchor, type TextAnchor } from "../schema/feedback.ts";
import type { ReviewFile } from "../schema/input.ts";
import type {
  InputDigest,
  RepoPath,
  RoundNumber,
} from "../schema/primitives.ts";
import {
  anchorFor,
  anchorForText,
  attach,
  contentDigest,
  isAnchorProblem,
  patchDigest,
  textAnchorAt,
} from "./anchor.ts";
import { unifiedDiff } from "./linediff.ts";
import { attachedRows, parseRows } from "./patch.ts";

const BASE = [
  "import a",
  "",
  "function one() {",
  "  return 1;",
  "}",
  "",
  "function two() {",
  "  return 2;",
  "}",
  "",
  "function three() {",
  "  return 3;",
  "}",
].join("\n");

/** A file changed from `before` to `after`, with its whole new text, as the collector writes one. */
const changed = (before: string, after: string): ReviewFile => {
  const patch = unifiedDiff(`${before}\n`, `${after}\n`, { context: 1 });
  assert.ok(patch !== undefined);
  return {
    path: "src/a.ts" as RepoPath,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch,
    new_content: `${after}\n`,
  } as ReviewFile;
};

const snapshot = (round: number) => ({
  round: round as RoundNumber,
  input_sha256: String(round).repeat(64) as InputDigest,
});

const anchored = (file: ReviewFile, start: number, end: number) => {
  const made = textAnchorAt(file, snapshot(1), start, end);
  if (isAnchorProblem(made)) assert.fail(JSON.stringify(made));
  return made;
};

test("a text anchor quotes whole lines of the new text, outside the patch, with context to find them again", () => {
  // The change is on line 1; lines 7 through 9 are unchanged context the patch does not show.
  const file = changed(BASE, BASE.replace("import a", "import b"));
  assert.ok(file.patch !== undefined && !file.patch.includes("function two"));
  const anchor = anchored(file, 7, 8);
  assert.equal(anchor.kind, "text");
  assert.equal(anchor.quote, "function two() {\n  return 2;");
  assert.equal(anchor.side, "new");
  assert.ok(anchor.prefix.endsWith("}\n\n"));
  assert.ok(anchor.suffix.startsWith("\n}\n"));
  assert.equal(anchor.content_sha256, contentDigest(file.new_content ?? ""));
  assert.ok(Result.isSuccess(Schema.decodeUnknownResult(Anchor)(anchor)));
  assert.deepEqual(attach(anchor, file), {
    state: "attached",
    reason: "Same text.",
    start_line: 7,
    end_line: 8,
  });
});

test("a text selection names the text the page showed, and refuses blank lines, other text, and lines past the end", () => {
  const file = changed(BASE, BASE.replace("import a", "import b"));
  const selection = {
    kind: "text" as const,
    path: file.path,
    content_sha256: contentDigest(file.new_content ?? ""),
    start_line: 11,
    end_line: 13,
  };
  const made = anchorFor(file, snapshot(1), selection);
  assert.ok(!isAnchorProblem(made) && made.kind === "text");
  assert.deepEqual(
    anchorForText(file, snapshot(1), {
      ...selection,
      content_sha256: contentDigest("other"),
    }),
    { problem: "changed" },
  );
  assert.deepEqual(
    anchorForText(file, snapshot(1), {
      ...selection,
      start_line: 2,
      end_line: 2,
    }),
    { problem: "blank" },
  );
  assert.deepEqual(
    anchorForText(file, snapshot(1), {
      ...selection,
      start_line: 13,
      end_line: 14,
    }),
    { problem: "out_of_range" },
  );
  const { new_content: _, ...withoutText } = file;
  assert.deepEqual(
    anchorForText(withoutText as ReviewFile, snapshot(1), selection),
    { problem: "no_text" },
  );
});

test("a text anchor follows its lines by quote when a later round moves them", () => {
  const first = changed(BASE, BASE.replace("import a", "import b"));
  const anchor = anchored(first, 7, 8);
  // Two lines added above shift "function two" down by two.
  const later = changed(
    BASE,
    BASE.replace("import a", "import b\nimport c\nimport d"),
  );
  assert.deepEqual(attach(anchor, later), {
    state: "attached",
    reason: "Found by the quoted lines.",
    start_line: 9,
    end_line: 10,
  });
});

test("a text anchor is an orphan when its lines are gone, ambiguous, or the text is missing", () => {
  const first = changed(BASE, BASE.replace("import a", "import b"));
  const anchor = anchored(first, 7, 8);
  const gone = changed(BASE, BASE.replace("  return 2;", "  return 20;"));
  assert.deepEqual(attach(anchor, gone), {
    state: "orphan",
    reason: "The quoted lines are no longer in the file.",
  });
  // The quote twice, with the same context around both: no way to choose.
  const block = "x\nfunction two() {\n  return 2;\n}\n";
  const twice = changed(BASE, `${block}${block}`.trimEnd());
  const quoted: TextAnchor = {
    ...anchor,
    prefix: "",
    suffix: "",
    content_sha256: contentDigest("other"),
  };
  const found = attach(quoted, twice);
  assert.equal(found.state, "orphan");
  assert.match(found.reason, /appear 2 times/);
  const { new_content: _, ...withoutText } = first;
  assert.deepEqual(attach(anchor, withoutText as ReviewFile), {
    state: "orphan",
    reason: "The file's text is not in this round.",
  });
  assert.deepEqual(attach(anchor, undefined), {
    state: "orphan",
    reason: "The file is not in this round.",
  });
});

test("a quote matches only whole lines: a line that merely contains it is not a place", () => {
  const first = changed(BASE, BASE.replace("import a", "import b"));
  const anchor = anchored(first, 8, 8);
  const longer = changed(
    BASE,
    BASE.replace("import a", "import b").replace("  return 2;", "  return 2;;"),
  );
  assert.equal(attach(anchor, longer).state, "orphan");
});

test("lines of the text that the patch shows attach to its rows; others span no rows", () => {
  const file = changed(BASE, BASE.replace("import a", "import b"));
  const rows = parseRows(file.patch ?? "");
  // Line 1 is the changed line, line 2 the context after it.
  assert.deepEqual(
    attachedRows(rows, {
      state: "attached",
      reason: "Same text.",
      start_line: 1,
      end_line: 2,
    }),
    { start: 2, end: 3 },
  );
  assert.equal(
    attachedRows(rows, {
      state: "attached",
      reason: "Same text.",
      start_line: 7,
      end_line: 8,
    }),
    undefined,
  );
  assert.equal(patchDigest(file.patch ?? "").length, 64);
});
