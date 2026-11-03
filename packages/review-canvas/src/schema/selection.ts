/**
 * What a page selects to comment on: whole rows of a file's patch, or whole lines of its new text, such as unchanged
 * lines the reviewer revealed around a hunk. Each names the version the page showed, so a selection cannot land on
 * other code.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import { ContentDigest, integer, PatchDigest, RepoPath } from "./primitives.ts";

const Row = integer(0, Limits.MAX_ROW);
const SourceLine = integer(1, Limits.MAX_LINE);

/** Whole rows of one file's patch. The digest names the patch the page showed, so rows cannot land on another. */
export const RowsSelection = Schema.Struct({
  /** Pages built before text selections send no kind. */
  kind: Schema.Literal("rows").pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("rows")),
  ),
  path: RepoPath,
  patch_sha256: PatchDigest,
  start_row: Row,
  end_row: Row,
});
export type RowsSelection = typeof RowsSelection.Type;

/**
 * Whole new-side lines of one file's text, inside the patch or outside it. The digest names the text the page
 * showed, which `review.round` gives for each file that has one.
 */
export const TextSelection = Schema.Struct({
  kind: Schema.Literal("text"),
  path: RepoPath,
  content_sha256: ContentDigest,
  start_line: SourceLine,
  end_line: SourceLine,
});
export type TextSelection = typeof TextSelection.Type;

export const Selection = Schema.Union([RowsSelection, TextSelection]).annotate({
  expected: "a selection whose kind is rows or text",
});
export type Selection = typeof Selection.Type;
