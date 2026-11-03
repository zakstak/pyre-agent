import { createHash } from "node:crypto";
import type {
  Anchor,
  Attachment,
  PatchAnchor,
  RoundSnapshot,
  TextAnchor,
} from "../schema/feedback.ts";
import type { ReviewFile } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type { ContentDigest, PatchDigest } from "../schema/primitives.ts";
import type {
  RowsSelection,
  Selection,
  TextSelection,
} from "../schema/selection.ts";
import { joinedRows, parseRows, type Row, textLines } from "./patch.ts";

/** A patch's digest, which names the version of the file row numbers refer to. */
export const patchDigest = (patch: string): PatchDigest =>
  createHash("sha256").update(patch, "utf8").digest("hex") as PatchDigest;

/** A new text's digest, which names the version of the file line numbers outside the patch refer to. */
export const contentDigest = (content: string): ContentDigest =>
  createHash("sha256").update(content, "utf8").digest("hex") as ContentDigest;

/**
 * A selection of whole rows in one file's patch, as the page sends it. Row numbers mean something only in the patch
 * the page showed, so the selection names that patch by its digest.
 */
export type RowSelection = Omit<RowsSelection, "kind">;

/** Why a selection makes no anchor. */
export type AnchorProblem =
  | { readonly problem: "no_patch" }
  | { readonly problem: "no_text" }
  | { readonly problem: "changed" }
  | { readonly problem: "out_of_range" }
  | { readonly problem: "no_source_line" }
  | { readonly problem: "blank" };

/** Whether an anchor could not be made, and why. */
export const isAnchorProblem = (
  made: Anchor | AnchorProblem,
): made is AnchorProblem => "problem" in made;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Up to {@link Limits.MAX_CONTEXT_UNITS} units before `start`, starting on a character boundary: a cut through a
 * surrogate pair would leave half a character, which no text field accepts.
 */
export const contextBefore = (text: string, start: number): string => {
  let from = Math.max(0, start - Limits.MAX_CONTEXT_UNITS);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from++;
  return text.slice(from, start);
};

/** Up to {@link Limits.MAX_CONTEXT_UNITS} units after `end`, ending on a character boundary. */
export const contextAfter = (text: string, end: number): string => {
  let to = Math.min(text.length, end + Limits.MAX_CONTEXT_UNITS);
  if (to > end && to < text.length && isHighSurrogate(text.charCodeAt(to - 1)))
    to--;
  return text.slice(end, to);
};

/**
 * The anchor for a row selection in a file of the given round: the selected rows as the quote, with context on each
 * side. The side is old when the selection holds deleted lines and no added ones; otherwise new.
 */
export const anchorForRows = (
  file: ReviewFile,
  snapshot: RoundSnapshot,
  selection: RowSelection,
): PatchAnchor | AnchorProblem => {
  if (file.patch === undefined) return { problem: "no_patch" };
  const digest = patchDigest(file.patch);
  if (digest !== selection.patch_sha256) return { problem: "changed" };
  const rows = parseRows(file.patch);
  const { start_row, end_row } = selection;
  if (
    start_row < 0 ||
    end_row < start_row ||
    end_row >= rows.length ||
    end_row > Limits.MAX_ROW
  )
    return { problem: "out_of_range" };
  const selected = rows.slice(start_row, end_row + 1);
  const side: "old" | "new" =
    selected.some((row) => row.kind === "del") &&
    !selected.some((row) => row.kind === "add")
      ? "old"
      : "new";
  const lines = selected
    .map((row) => row[side])
    .filter((line): line is number => line !== undefined);
  const start_line = lines[0];
  const end_line = lines.at(-1);
  if (start_line === undefined || end_line === undefined)
    return { problem: "no_source_line" };
  // A quote of only blank lines would match everywhere, so it could never find its place in a later round.
  if (selected.every((row) => row.content.trim() === ""))
    return { problem: "blank" };
  const first = selected[0] as Row;
  const last = selected.at(-1) as Row;
  return anchorAt(file.patch, file.path, snapshot, {
    start: first.offset,
    end: last.offset + last.text.length,
    side,
  });
};

/**
 * The anchor for a span of a patch's rows joined with LF, which may start or end inside a row, as an imported or
 * found selection can. The rows and source lines are those the span touches on the given side.
 */
export const anchorAt = (
  patch: string,
  path: ReviewFile["path"],
  snapshot: RoundSnapshot,
  span: {
    readonly start: number;
    readonly end: number;
    readonly side: "old" | "new";
  },
): PatchAnchor | AnchorProblem => {
  const rows = parseRows(patch);
  const text = joinedRows(rows);
  const { start, end, side } = span;
  if (start < 0 || end <= start || end > text.length)
    return { problem: "out_of_range" };
  const touched = rows.filter(
    (row) => row.offset < end && row.offset + row.text.length >= start,
  );
  const first = touched[0];
  const last = touched.at(-1);
  if (first === undefined || last === undefined || last.index > Limits.MAX_ROW)
    return { problem: "out_of_range" };
  const lines = touched
    .map((row) => row[side])
    .filter((line): line is number => line !== undefined);
  const start_line = lines[0];
  const end_line = lines.at(-1);
  if (start_line === undefined || end_line === undefined)
    return { problem: "no_source_line" };
  const quote = text.slice(start, end);
  if (quote.trim() === "") return { problem: "blank" };
  return {
    kind: "patch",
    snapshot,
    path,
    patch_sha256: patchDigest(patch),
    start,
    end,
    quote,
    prefix: contextBefore(text, start),
    suffix: contextAfter(text, end),
    start_row: first.index,
    end_row: last.index,
    side,
    start_line,
    end_line,
  };
};

const indexesOf = (text: string, quote: string): Array<number> => {
  const found: Array<number> = [];
  for (
    let at = text.indexOf(quote);
    at !== -1;
    at = text.indexOf(quote, at + 1)
  )
    found.push(at);
  return found;
};

/** How many units of the context match around a candidate position. */
const contextScore = (
  text: string,
  anchor: Pick<Anchor, "prefix" | "quote" | "suffix">,
  at: number,
): number => {
  let score = 0;
  for (
    let i = 1;
    i <= anchor.prefix.length &&
    at - i >= 0 &&
    text[at - i] === anchor.prefix[anchor.prefix.length - i];
    i++
  )
    score++;
  const end = at + anchor.quote.length;
  for (
    let i = 0;
    i < anchor.suffix.length && text[end + i] === anchor.suffix[i];
    i++
  )
    score++;
  return score;
};

/**
 * Where a quote is found once among candidate places, or where its context picks one of several: the best place, or
 * why there is none.
 */
const bestPlace = (
  text: string,
  anchor: Pick<Anchor, "prefix" | "quote" | "suffix">,
  places: ReadonlyArray<number>,
  gone: string,
):
  | { readonly at: number; readonly reason: string }
  | { readonly orphan: string } => {
  if (places.length === 0) return { orphan: gone };
  const scored = places
    .map((at) => ({ at, score: contextScore(text, anchor, at) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best === undefined) return { orphan: gone };
  if (second !== undefined && second.score === best.score)
    return {
      orphan: `The quoted lines appear ${places.length} times, and their context does not pick one.`,
    };
  return {
    at: best.at,
    reason:
      places.length === 1
        ? "Found by the quoted lines."
        : "Found by the quoted lines and their context.",
  };
};

/**
 * Where a patch anchor lands in a file of the current round. The same patch attaches at the anchor's own offsets;
 * another patch attaches where the quote is found once, or where its context picks one of several places; otherwise
 * the comment is an orphan, and the reason says why.
 */
const attachPatch = (
  anchor: PatchAnchor,
  file: ReviewFile | undefined,
): Attachment => {
  if (file === undefined)
    return { state: "orphan", reason: "The file is not in this round." };
  if (file.patch === undefined)
    return { state: "orphan", reason: "The file has no patch in this round." };
  if (patchDigest(file.patch) === anchor.patch_sha256) {
    return {
      state: "attached",
      reason: "Same patch.",
      start: anchor.start,
      end: anchor.end,
    };
  }
  const text = joinedRows(parseRows(file.patch));
  if (text.slice(anchor.start, anchor.end) === anchor.quote) {
    return {
      state: "attached",
      reason: "Found at the same offsets in a changed patch.",
      start: anchor.start,
      end: anchor.end,
    };
  }
  const found = bestPlace(
    text,
    anchor,
    indexesOf(text, anchor.quote),
    "The quoted lines are no longer in the patch.",
  );
  return "orphan" in found
    ? { state: "orphan", reason: found.orphan }
    : {
        state: "attached",
        reason: found.reason,
        start: found.at,
        end: found.at + anchor.quote.length,
      };
};

/** The offset in the joined lines where a 1-based line starts. */
const lineOffset = (lines: ReadonlyArray<string>, line: number): number => {
  let offset = 0;
  for (let at = 0; at < line - 1; at++) offset += (lines[at]?.length ?? 0) + 1;
  return offset;
};

/** The anchor for whole lines of a file's new text in the given round, from `start_line` through `end_line`. */
export const textAnchorAt = (
  file: ReviewFile,
  snapshot: RoundSnapshot,
  start_line: number,
  end_line: number,
): TextAnchor | AnchorProblem => {
  if (file.new_content === undefined) return { problem: "no_text" };
  const { lines, text } = textLines(file.new_content);
  if (start_line < 1 || end_line < start_line || end_line > lines.length)
    return { problem: "out_of_range" };
  const selected = lines.slice(start_line - 1, end_line);
  // A quote of only blank lines would match everywhere, so it could never find its place in a later round.
  if (selected.every((line) => line.trim() === "")) return { problem: "blank" };
  const quote = selected.join("\n");
  const start = lineOffset(lines, start_line);
  return {
    kind: "text",
    snapshot,
    path: file.path,
    content_sha256: contentDigest(file.new_content),
    quote,
    prefix: contextBefore(text, start),
    suffix: contextAfter(text, start + quote.length),
    side: "new",
    start_line,
    end_line,
  };
};

/** The anchor for a text selection: the lines of the new text the page showed, which must still be the file's. */
export const anchorForText = (
  file: ReviewFile,
  snapshot: RoundSnapshot,
  selection: Omit<TextSelection, "kind">,
): TextAnchor | AnchorProblem => {
  if (file.new_content === undefined) return { problem: "no_text" };
  if (contentDigest(file.new_content) !== selection.content_sha256)
    return { problem: "changed" };
  return textAnchorAt(file, snapshot, selection.start_line, selection.end_line);
};

/** The anchor for a selection of either kind. */
export const anchorFor = (
  file: ReviewFile,
  snapshot: RoundSnapshot,
  selection: Selection,
): Anchor | AnchorProblem =>
  selection.kind === "rows"
    ? anchorForRows(file, snapshot, selection)
    : anchorForText(file, snapshot, selection);

/**
 * Where a text anchor lands in a file of the current round. The same text attaches at the anchor's own lines; another
 * text attaches where the quoted lines are found once as whole lines, or where their context picks one of several.
 */
const attachText = (
  anchor: TextAnchor,
  file: ReviewFile | undefined,
): Attachment => {
  if (file === undefined)
    return { state: "orphan", reason: "The file is not in this round." };
  if (file.new_content === undefined)
    return {
      state: "orphan",
      reason: "The file's text is not in this round.",
    };
  const span = anchor.end_line - anchor.start_line;
  if (contentDigest(file.new_content) === anchor.content_sha256)
    return {
      state: "attached",
      reason: "Same text.",
      start_line: anchor.start_line,
      end_line: anchor.end_line,
    };
  const { text } = textLines(file.new_content);
  const whole = indexesOf(text, anchor.quote).filter(
    (at) =>
      (at === 0 || text[at - 1] === "\n") &&
      (at + anchor.quote.length === text.length ||
        text[at + anchor.quote.length] === "\n"),
  );
  const found = bestPlace(
    text,
    anchor,
    whole,
    "The quoted lines are no longer in the file.",
  );
  if ("orphan" in found) return { state: "orphan", reason: found.orphan };
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < found.at; ) {
    line++;
    at = text.indexOf("\n", at + 1);
  }
  return {
    state: "attached",
    reason: found.reason,
    start_line: line,
    end_line: line + span,
  };
};

/** Where an anchor lands in a file of the current round, as an attachment of its kind, or an orphan. */
export const attach = (
  anchor: Anchor,
  file: ReviewFile | undefined,
): Attachment =>
  anchor.kind === "patch"
    ? attachPatch(anchor, file)
    : attachText(anchor, file);
