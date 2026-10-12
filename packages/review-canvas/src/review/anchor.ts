import type { Anchor, Attachment, RoundSnapshot } from "../schema/feedback.ts";
import type { ReviewFile } from "../schema/input.ts";
import * as Limits from "../schema/limits.ts";
import type { PatchDigest } from "../schema/primitives.ts";
import { joinedRows, parseRows, patchDigest, type Row } from "./patch.ts";

/**
 * A selection of whole rows in one file's patch, as the page sends it. Row numbers mean something only in the patch
 * the page showed, so the selection names that patch by its digest.
 */
export interface RowSelection {
  readonly path: ReviewFile["path"];
  readonly patch_sha256: PatchDigest;
  readonly start_row: number;
  readonly end_row: number;
}

export type AnchorProblem =
  | { readonly kind: "no_patch" }
  | { readonly kind: "changed" }
  | { readonly kind: "out_of_range" }
  | { readonly kind: "no_source_line" }
  | { readonly kind: "blank" };

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
): Anchor | AnchorProblem => {
  if (file.patch === undefined) return { kind: "no_patch" };
  const digest = patchDigest(file.patch);
  if (digest !== selection.patch_sha256) return { kind: "changed" };
  const rows = parseRows(file.patch);
  const { start_row, end_row } = selection;
  if (
    start_row < 0 ||
    end_row < start_row ||
    end_row >= rows.length ||
    end_row > Limits.MAX_ROW
  )
    return { kind: "out_of_range" };
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
    return { kind: "no_source_line" };
  // A quote of only blank lines would match everywhere, so it could never find its place in a later round.
  if (selected.every((row) => row.content.trim() === ""))
    return { kind: "blank" };
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
): Anchor | AnchorProblem => {
  const rows = parseRows(patch);
  const text = joinedRows(rows);
  const { start, end, side } = span;
  if (start < 0 || end <= start || end > text.length)
    return { kind: "out_of_range" };
  const touched = rows.filter(
    (row) => row.offset < end && row.offset + row.text.length >= start,
  );
  const first = touched[0];
  const last = touched.at(-1);
  if (first === undefined || last === undefined || last.index > Limits.MAX_ROW)
    return { kind: "out_of_range" };
  const lines = touched
    .map((row) => row[side])
    .filter((line): line is number => line !== undefined);
  const start_line = lines[0];
  const end_line = lines.at(-1);
  if (start_line === undefined || end_line === undefined)
    return { kind: "no_source_line" };
  const quote = text.slice(start, end);
  if (quote.trim() === "") return { kind: "blank" };
  return {
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
const contextScore = (text: string, anchor: Anchor, at: number): number => {
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
 * Where an anchor lands in a file of the current round. The same patch attaches at the anchor's own offsets; another
 * patch attaches where the quote is found once, or where its context picks one of several places; otherwise the
 * comment is an orphan, and the reason says why.
 */
export const attach = (
  anchor: Anchor,
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
  const places = indexesOf(text, anchor.quote);
  if (places.length === 0)
    return {
      state: "orphan",
      reason: "The quoted lines are no longer in the patch.",
    };
  const scored = places
    .map((at) => ({ at, score: contextScore(text, anchor, at) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best === undefined) throw new Error("unreachable: no scored place");
  if (scored.length > 1 && scored[1]?.score === best.score) {
    return {
      state: "orphan",
      reason: `The quoted lines appear ${places.length} times, and their context does not pick one.`,
    };
  }
  return {
    state: "attached",
    reason:
      places.length === 1
        ? "Found by the quoted lines."
        : "Found by the quoted lines and their context.",
    start: best.at,
    end: best.at + anchor.quote.length,
  };
};

/** The rows an attachment spans in the file's current patch. */
export const attachedRows = (
  rows: ReadonlyArray<Row>,
  attachment: Attachment,
): { readonly start: number; readonly end: number } | undefined => {
  if (attachment.state !== "attached") return undefined;
  let start: number | undefined;
  let end: number | undefined;
  for (const row of rows) {
    const rowEnd = row.offset + row.text.length;
    if (rowEnd < attachment.start) continue;
    if (row.offset >= attachment.end && attachment.end > attachment.start)
      break;
    start ??= row.index;
    end = row.index;
  }
  return start === undefined || end === undefined ? undefined : { start, end };
};
