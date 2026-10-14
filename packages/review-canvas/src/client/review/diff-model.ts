/**
 * A file's patch as the page lays it out: its rows, which of them show, the runs that fold behind a "Show N more
 * lines" control, and the unchanged lines between hunks that the file's text supplies. Pure, so the layout can be
 * tested without a browser.
 */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import { attachedRows, parseRows, type Row } from "../../review/patch.ts";

export type InlineComment = Extract<Comment, { kind: "inline" }>;

/** An inline comment with the rows its attachment spans in the current patch. */
export interface PlacedComment {
  readonly comment: InlineComment;
  readonly start: number;
  readonly end: number;
}

/** The inline comments of a file, placed on its rows. Orphans have no place. */
export const placeComments = (
  file: ReviewFile,
  comments: ReadonlyArray<Comment>,
): { readonly placed: ReadonlyArray<PlacedComment>; readonly orphans: ReadonlyArray<InlineComment> } => {
  const rows = parseRows(file.patch ?? "");
  const placed: Array<PlacedComment> = [];
  const orphans: Array<InlineComment> = [];
  for (const comment of comments) {
    if (comment.kind !== "inline" || comment.anchor.path !== file.path) continue;
    const span = attachedRows(rows, comment.attachment);
    if (span === undefined) orphans.push(comment);
    else placed.push({ comment, ...span });
  }
  return { placed, orphans };
};

/** One unchanged line between hunks: the same text on both sides, at its old and new line numbers. */
export interface GapLine {
  readonly old: number;
  readonly new: number;
  readonly text: string;
}

/** Unchanged lines before a hunk, or after the last one. */
export interface Gap {
  /** The row index of the hunk header the gap comes before, or -1 for the gap after the last hunk. */
  readonly before: number;
  readonly lines: ReadonlyArray<GapLine>;
}

const HUNK = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/;

/**
 * The unchanged lines a file's text holds around its hunks. An unchanged line has the same text on both sides, so
 * the new text supplies it, and its old line number keeps the offset of the hunk next to it.
 */
export const gaps = (patch: string, content: string): ReadonlyArray<Gap> => {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const rows = parseRows(patch);
  const found: Array<Gap> = [];
  let newEnd = 0;
  let oldEnd = 0;
  const gap = (before: number, from: number, to: number, offset: number) => {
    if (to < from) return;
    found.push({
      before,
      lines: Array.from({ length: to - from + 1 }, (_, at) => ({
        new: from + at,
        old: from + at + offset,
        text: lines[from + at - 1] ?? "",
      })),
    });
  };
  for (const row of rows) {
    if (row.kind === "hunk") {
      const header = HUNK.exec(row.text);
      if (header === null) continue;
      const oldStart = Number(header[1]);
      const newStart = Number(header[2]);
      gap(row.index, newEnd + 1, newStart - 1, oldStart - newStart);
      continue;
    }
    if (row.new !== undefined) newEnd = row.new;
    if (row.old !== undefined) oldEnd = row.old;
  }
  if (rows.length > 0) gap(-1, newEnd + 1, lines.length, oldEnd - newEnd);
  return found;
};

/** One line of the split layout: an old half and a new half, either of which may be empty. */
export interface Pair {
  readonly old: Row | undefined;
  readonly new: Row | undefined;
  /** A hunk header or meta row spans both halves. */
  readonly whole: Row | undefined;
}

/** Pairs rows for the split layout: context with itself, and each run of deletions with the additions after it. */
export const pairRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Pair> => {
  const pairs: Array<Pair> = [];
  let dels: Array<Row> = [];
  let adds: Array<Row> = [];
  const flush = () => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at++)
      pairs.push({ old: dels[at], new: adds[at], whole: undefined });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(row);
    } else if (row.kind === "add") adds.push(row);
    else {
      flush();
      if (row.kind === "context") pairs.push({ old: row, new: row, whole: undefined });
      else pairs.push({ old: undefined, new: undefined, whole: row });
    }
  }
  flush();
  return pairs;
};

/** Whether a reviewer can select a row to comment on it. */
export const changeable = (row: Row): boolean => row.kind === "add" || row.kind === "del" || row.kind === "context";

/** A run of hidden rows shorter than this shows instead: a fold for two lines costs more than it saves. */
const MIN_FOLD = 4;

/** Hidden lines of one kind: rows of the patch outside the shown ranges, or unchanged lines between hunks. */
export type GapPart =
  | { readonly kind: "folded"; readonly rows: ReadonlyArray<Row> }
  | { readonly kind: "context"; readonly lines: ReadonlyArray<GapLine> };

/**
 * The patch in document order: runs of rows that show, and gaps. Hidden lines next to each other are one gap with one
 * control, whatever hides them. Its first activation shows the folded rows of the patch, its second the unchanged
 * lines around them; the control sits where the lines still hidden after the first are, at `toggleAt`.
 */
export type Segment =
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Row> }
  | {
      readonly kind: "gap";
      readonly key: string;
      readonly parts: ReadonlyArray<GapPart>;
      readonly folded: number;
      readonly context: number;
      readonly toggleAt: number;
    };

export interface DiffLayout {
  readonly rows: ReadonlyArray<Row>;
  readonly segments: ReadonlyArray<Segment>;
}

/**
 * Lays out a patch. `shown` are the row ranges to show, such as a stop's excerpts and the rows comments sit on; the
 * other rows fold. Every row shows when it is absent. `content` is the file's text, which fills the gaps between
 * hunks; a read-only patch, such as the changes between rounds, has none.
 */
export const layoutDiff = (
  patch: string,
  options: {
    readonly shown?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
    readonly content?: string | undefined;
  } = {},
): DiffLayout => {
  const rows = parseRows(patch);
  const visible = new Set<number>();
  if (options.shown === undefined) for (const row of rows) visible.add(row.index);
  else {
    for (const range of options.shown) for (let at = range.start; at <= range.end; at++) visible.add(at);
    let run: Array<number> = [];
    const flush = () => {
      if (run.length < MIN_FOLD) for (const at of run) visible.add(at);
      run = [];
    };
    for (const row of rows) {
      if (visible.has(row.index)) flush();
      else run.push(row.index);
    }
    flush();
  }

  type Piece =
    | { readonly kind: "shown"; readonly rows: ReadonlyArray<Row> }
    | { readonly kind: "folded"; readonly key: string; readonly rows: ReadonlyArray<Row> }
    | { readonly kind: "context"; readonly key: string; readonly gap: Gap };
  const pieces: Array<Piece> = [];
  const cut = (piece: ReadonlyArray<Row>) => {
    let run: Array<Row> = [];
    let shown = true;
    const flush = () => {
      const first = run[0];
      if (first !== undefined)
        pieces.push(shown ? { kind: "shown", rows: run } : { kind: "folded", key: `r${first.index}`, rows: run });
      run = [];
    };
    for (const row of piece) {
      if (visible.has(row.index) !== shown) {
        flush();
        shown = visible.has(row.index);
      }
      run.push(row);
    }
    flush();
  };
  const found = options.content === undefined ? [] : gaps(patch, options.content);
  // With the file's text, the patch is cut into a piece per hunk, so the unchanged lines go between them.
  if (found.length === 0) cut(rows);
  else {
    const starts = rows.filter((row) => row.kind === "hunk").map((row) => row.index);
    if ((starts[0] ?? 0) > 0) cut(rows.slice(0, starts[0]));
    starts.forEach((start, hunk) => {
      const at = found.findIndex((gap) => gap.before === start);
      const gap = found[at];
      if (gap !== undefined) pieces.push({ kind: "context", key: String(at), gap });
      cut(rows.slice(start, starts[hunk + 1] ?? rows.length));
    });
    const at = found.findIndex((gap) => gap.before === -1);
    const trailing = found[at];
    if (trailing !== undefined) pieces.push({ kind: "context", key: String(at), gap: trailing });
  }

  const segments: Array<Segment> = [];
  let hidden: Array<Exclude<Piece, { kind: "shown" }>> = [];
  const closeGap = () => {
    const first = hidden[0];
    if (first !== undefined)
      segments.push({
        kind: "gap",
        key: first.key,
        parts: hidden.map((piece) =>
          piece.kind === "folded"
            ? { kind: "folded", rows: piece.rows }
            : { kind: "context", lines: piece.gap.lines },
        ),
        folded: hidden.reduce((sum, piece) => sum + (piece.kind === "folded" ? piece.rows.length : 0), 0),
        context: hidden.reduce((sum, piece) => sum + (piece.kind === "context" ? piece.gap.lines.length : 0), 0),
        toggleAt: Math.max(0, hidden.findIndex((piece) => piece.kind === "context")),
      });
    hidden = [];
  };
  for (const piece of pieces) {
    if (piece.kind !== "shown") {
      hidden.push(piece);
      continue;
    }
    closeGap();
    segments.push({ kind: "rows", rows: piece.rows });
  }
  closeGap();
  return { rows, segments };
};

/**
 * How far a gap is open: 0 hides it all, 1 shows its folded patch rows, 2 shows its unchanged lines too. A gap with
 * only one kind of hidden line goes from 0 to 2.
 */
export type GapStage = 0 | 1 | 2;

export const nextStage = (stage: GapStage, gap: { readonly folded: number; readonly context: number }): GapStage => {
  if (stage === 2) return 0;
  return stage === 0 && gap.folded > 0 && gap.context > 0 ? 1 : 2;
};

/** The words on a gap's control at a stage. */
export const gapLabel = (stage: GapStage, gap: { readonly folded: number; readonly context: number }): string => {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const total = gap.folded + gap.context;
  return stage === 0
    ? `Show ${total} more line${total === 1 ? "" : "s"}`
    : stage === 1
      ? `Show ${gap.context} more line${gap.context === 1 ? "" : "s"}`
      : `Hide ${lines(total)}`;
};
