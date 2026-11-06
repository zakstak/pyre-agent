/**
 * A file's patch as the page lays it out: its rows, which of them show, the unchanged runs that fold behind a "Show N
 * more lines" control, the changed rows that fold behind a control of their own, and the unchanged lines between hunks
 * that the file's text supplies. Pure, so the layout can be tested without a browser.
 */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import type {
  ContentDigest,
  PatchDigest,
  RepoPath,
} from "../../schema/primitives.ts";
import type { Selection } from "../../schema/selection.ts";
import {
  attachedRows,
  parseRows,
  type Row,
  rowForLine,
} from "../../review/patch.ts";

export type InlineComment = Extract<Comment, { kind: "inline" }>;

/** An inline comment with the rows its attachment spans in the current patch. */
export interface PlacedComment {
  readonly comment: InlineComment;
  readonly start: number;
  readonly end: number;
}

/**
 * An inline comment on lines of the file's text that the patch does not show, such as unchanged lines around a hunk:
 * new-side line numbers, which a gap's lines carry. The thread goes under its last line once that gap is open.
 */
export interface ContextComment {
  readonly comment: InlineComment;
  readonly start_line: number;
  readonly end_line: number;
}

/** The inline comments of a file, placed on its rows or on lines outside them. Orphans have no place. */
export const placeComments = (
  file: ReviewFile,
  comments: ReadonlyArray<Comment>,
): {
  readonly placed: ReadonlyArray<PlacedComment>;
  readonly context: ReadonlyArray<ContextComment>;
  readonly orphans: ReadonlyArray<InlineComment>;
} => {
  const rows = parseRows(file.patch ?? "");
  const placed: Array<PlacedComment> = [];
  const context: Array<ContextComment> = [];
  const orphans: Array<InlineComment> = [];
  for (const comment of comments) {
    if (comment.kind !== "inline" || comment.anchor.path !== file.path)
      continue;
    const { attachment } = comment;
    const span = attachedRows(rows, attachment);
    if (span !== undefined) placed.push({ comment, ...span });
    else if (attachment.state === "attached" && "start_line" in attachment)
      context.push({
        comment,
        start_line: attachment.start_line,
        end_line: attachment.end_line,
      });
    else orphans.push(comment);
  }
  return { placed, context, orphans };
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
      if (row.kind === "context")
        pairs.push({ old: row, new: row, whole: undefined });
      else pairs.push({ old: undefined, new: undefined, whole: row });
    }
  }
  flush();
  return pairs;
};

/** Whether a reviewer can select a row to comment on it. */
export const changeable = (row: Row): boolean =>
  row.kind === "add" || row.kind === "del" || row.kind === "context";

/** Whether a row changes the file: an addition or a deletion. */
export const isChange = (row: Row): boolean =>
  row.kind === "add" || row.kind === "del";

/** A run of hidden rows shorter than this shows instead: a fold for two lines costs more than it saves. */
const MIN_FOLD = 4;

/** Hidden lines of one kind: unchanged rows of the patch outside the shown ranges, or unchanged lines between hunks. */
export type GapPart =
  | { readonly kind: "folded"; readonly rows: ReadonlyArray<Row> }
  | { readonly kind: "context"; readonly lines: ReadonlyArray<GapLine> };

/**
 * The patch in document order: runs of rows that show, gaps of unchanged lines, and folds of changes. Unchanged lines
 * next to each other are one gap with one control, whatever hides them. Its first activation shows the folded rows of
 * the patch, its second the unchanged lines around them; the control sits where the lines still hidden after the
 * first are, at `toggleAt`. A gap never holds a changed row: changed rows outside the shown ranges fold behind a
 * control of their own, with the few unchanged rows around and between them, and the control counts what they add and
 * delete.
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
    }
  | {
      readonly kind: "changes";
      readonly key: string;
      readonly rows: ReadonlyArray<Row>;
      readonly additions: number;
      readonly deletions: number;
    };

/** Where a row of the patch goes: it shows, or it folds with changes or with unchanged lines. */
type RowFold = "shown" | "changes" | "unchanged";

/**
 * How a run of hidden rows folds. A long run of unchanged rows folds behind the control for unchanged lines; changed
 * rows fold behind their own, together with the short unchanged runs around and between them, so the unchanged rows
 * that read with a change open with it. A fold too short to save anything shows.
 */
const foldRun = (
  run: ReadonlyArray<Row>,
): ReadonlyArray<{
  readonly fold: RowFold;
  readonly rows: ReadonlyArray<Row>;
}> => {
  // The run as alternating stretches of changed and unchanged rows.
  const stretches: Array<{ changed: boolean; rows: Array<Row> }> = [];
  for (const row of run) {
    const last = stretches.at(-1);
    if (last?.changed === isChange(row)) last.rows.push(row);
    else stretches.push({ changed: isChange(row), rows: [row] });
  }
  // Changed stretches and the short unchanged ones beside them join; a long unchanged stretch stands alone. Stretches
  // alternate, so a fold that holds no change is one short unchanged stretch: the whole run, too short to fold.
  const folds: Array<{ changes: boolean; rows: Array<Row> }> = [];
  for (const stretch of stretches) {
    const joins = stretch.changed || stretch.rows.length < MIN_FOLD;
    const last = folds.at(-1);
    if (joins && last?.changes === true) last.rows.push(...stretch.rows);
    else folds.push({ changes: joins, rows: [...stretch.rows] });
  }
  return folds.map(({ changes, rows }) => ({
    fold: rows.length < MIN_FOLD ? "shown" : changes ? "changes" : "unchanged",
    rows,
  }));
};

/** Where each row of a patch goes, given the rows that show. */
const foldRows = (
  rows: ReadonlyArray<Row>,
  visible: ReadonlySet<number>,
): ReadonlyMap<number, RowFold> => {
  const folds = new Map<number, RowFold>();
  let run: Array<Row> = [];
  const flush = () => {
    for (const { fold, rows: part } of foldRun(run))
      for (const row of part) folds.set(row.index, fold);
    run = [];
  };
  for (const row of rows) {
    if (!visible.has(row.index)) {
      run.push(row);
      continue;
    }
    flush();
    folds.set(row.index, "shown");
  }
  flush();
  return folds;
};

export interface DiffLayout {
  readonly rows: ReadonlyArray<Row>;
  readonly segments: ReadonlyArray<Segment>;
}

/**
 * Lays out a patch. `shown` are the row ranges to show, such as a stop's excerpts and the rows comments sit on; the
 * other rows fold, changed rows apart from unchanged ones. Every row shows when it is absent. `content` is the file's
 * text, which fills the gaps between hunks; a read-only patch, such as the changes between rounds, has none.
 */
export const layoutDiff = (
  patch: string,
  options: {
    readonly shown?:
      | ReadonlyArray<{ readonly start: number; readonly end: number }>
      | undefined;
    readonly content?: string | undefined;
  } = {},
): DiffLayout => {
  const rows = parseRows(patch);
  const visible = new Set<number>();
  if (options.shown === undefined)
    for (const row of rows) visible.add(row.index);
  else
    for (const range of options.shown)
      for (let at = range.start; at <= range.end; at++) visible.add(at);
  const folds = foldRows(rows, visible);

  type Piece =
    | { readonly kind: "shown"; readonly rows: ReadonlyArray<Row> }
    | {
        readonly kind: "folded";
        readonly key: string;
        readonly rows: ReadonlyArray<Row>;
      }
    | {
        readonly kind: "changes";
        readonly key: string;
        readonly rows: ReadonlyArray<Row>;
      }
    | { readonly kind: "context"; readonly key: string; readonly gap: Gap };
  const pieces: Array<Piece> = [];
  const cut = (piece: ReadonlyArray<Row>) => {
    let run: Array<Row> = [];
    let fold: RowFold = "shown";
    const flush = () => {
      const first = run[0];
      if (first !== undefined)
        pieces.push(
          fold === "shown"
            ? { kind: "shown", rows: run }
            : fold === "changes"
              ? { kind: "changes", key: `c${first.index}`, rows: run }
              : { kind: "folded", key: `r${first.index}`, rows: run },
        );
      run = [];
    };
    for (const row of piece) {
      const now = folds.get(row.index) ?? "shown";
      if (now !== fold) {
        flush();
        fold = now;
      }
      run.push(row);
    }
    flush();
  };
  const found =
    options.content === undefined ? [] : gaps(patch, options.content);
  // With the file's text, the patch is cut into a piece per hunk, so the unchanged lines go between them.
  if (found.length === 0) cut(rows);
  else {
    const starts = rows
      .filter((row) => row.kind === "hunk")
      .map((row) => row.index);
    if ((starts[0] ?? 0) > 0) cut(rows.slice(0, starts[0]));
    starts.forEach((start, hunk) => {
      const at = found.findIndex((gap) => gap.before === start);
      const gap = found[at];
      if (gap !== undefined)
        pieces.push({ kind: "context", key: String(at), gap });
      cut(rows.slice(start, starts[hunk + 1] ?? rows.length));
    });
    const at = found.findIndex((gap) => gap.before === -1);
    const trailing = found[at];
    if (trailing !== undefined)
      pieces.push({ kind: "context", key: String(at), gap: trailing });
  }

  const segments: Array<Segment> = [];
  let hidden: Array<Extract<Piece, { kind: "folded" | "context" }>> = [];
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
        folded: hidden.reduce(
          (sum, piece) =>
            sum + (piece.kind === "folded" ? piece.rows.length : 0),
          0,
        ),
        context: hidden.reduce(
          (sum, piece) =>
            sum + (piece.kind === "context" ? piece.gap.lines.length : 0),
          0,
        ),
        toggleAt: Math.max(
          0,
          hidden.findIndex((piece) => piece.kind === "context"),
        ),
      });
    hidden = [];
  };
  for (const piece of pieces) {
    switch (piece.kind) {
      case "folded":
      case "context":
        hidden.push(piece);
        continue;
      case "changes":
        closeGap();
        segments.push({
          kind: "changes",
          key: piece.key,
          rows: piece.rows,
          additions: piece.rows.filter((row) => row.kind === "add").length,
          deletions: piece.rows.filter((row) => row.kind === "del").length,
        });
        continue;
      case "shown":
        closeGap();
        segments.push({ kind: "rows", rows: piece.rows });
        continue;
    }
  }
  closeGap();
  return { rows, segments };
};

/** The words on a fold of changes: how many lines it hides and what they add and delete, or that it hides them. */
export const changesLabel = (
  open: boolean,
  fold: { readonly additions: number; readonly deletions: number },
): string => {
  const total = fold.additions + fold.deletions;
  const lines = `changed line${total === 1 ? "" : "s"}`;
  return open
    ? `Hide ${total} ${lines}`
    : `${total} more ${lines} (+${fold.additions} −${fold.deletions})`;
};

/**
 * How the reviewer opened a file's folds: each gap's stage, and whether each fold of changes is open, by key. A fold
 * the reviewer has not touched is not there: a gap then shows as `gapStage` decides, and a fold of changes is closed.
 */
export interface DiffFolds {
  readonly gaps: Readonly<Record<string, GapStage>>;
  readonly changes: Readonly<Record<string, boolean>>;
}

export const NO_FOLDS: DiffFolds = { gaps: {}, changes: {} };

/** Every fold of a layout open: its gaps at their last stage, its folds of changes shown. */
export const allOpen = (layout: DiffLayout): DiffFolds => ({
  gaps: Object.fromEntries(
    layout.segments.flatMap((segment) =>
      segment.kind === "gap" ? [[segment.key, 2]] : [],
    ),
  ),
  changes: Object.fromEntries(
    layout.segments.flatMap((segment) =>
      segment.kind === "changes" ? [[segment.key, true]] : [],
    ),
  ),
});

/** Whether a layout folds anything, so that opening all of it shows more. */
export const hasFolds = (layout: DiffLayout): boolean =>
  layout.segments.some((segment) => segment.kind !== "rows");

/** Whether the reviewer opened every fold of a layout. */
export const allFoldsOpen = (layout: DiffLayout, folds: DiffFolds): boolean =>
  layout.segments.every((segment) => {
    switch (segment.kind) {
      case "rows":
        return true;
      case "gap":
        return folds.gaps[segment.key] === 2;
      case "changes":
        return folds.changes[segment.key] === true;
    }
  });

/** The changed rows a layout shows at the reviewer's folds: all but those in closed folds of changes. */
export const shownChanges = (
  layout: DiffLayout,
  folds: DiffFolds,
): ReadonlyArray<number> =>
  layout.segments.flatMap((segment) => {
    switch (segment.kind) {
      case "rows":
        return segment.rows.filter(isChange).map((row) => row.index);
      case "changes":
        return folds.changes[segment.key] === true
          ? segment.rows.filter(isChange).map((row) => row.index)
          : [];
      case "gap":
        return [];
    }
  });

/**
 * The changed rows of a patch the page never showed: how many lines they add and delete, and the first of them,
 * where showing them goes. Undefined when the page showed every change.
 */
export const unseenChanges = (
  rows: ReadonlyArray<Row>,
  seen: ReadonlySet<number>,
):
  | {
      readonly additions: number;
      readonly deletions: number;
      readonly first: number;
    }
  | undefined => {
  const unseen = rows.filter((row) => isChange(row) && !seen.has(row.index));
  const first = unseen[0];
  return first === undefined
    ? undefined
    : {
        additions: unseen.filter((row) => row.kind === "add").length,
        deletions: unseen.filter((row) => row.kind === "del").length,
        first: first.index,
      };
};

/**
 * How far a gap is open: 0 hides it all, 1 shows its folded patch rows, 2 shows its unchanged lines too. A gap with
 * only one kind of hidden line goes from 0 to 2.
 */
export type GapStage = 0 | 1 | 2;

export const nextStage = (
  stage: GapStage,
  gap: { readonly folded: number; readonly context: number },
): GapStage => {
  if (stage === 2) return 0;
  return stage === 0 && gap.folded > 0 && gap.context > 0 ? 1 : 2;
};

/** The words on a gap's control at a stage. */
export const gapLabel = (
  stage: GapStage,
  gap: { readonly folded: number; readonly context: number },
): string => {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const total = gap.folded + gap.context;
  return stage === 0
    ? `Show ${total} more line${total === 1 ? "" : "s"}`
    : stage === 1
      ? `Show ${gap.context} more line${gap.context === 1 ? "" : "s"}`
      : `Hide ${lines(total)}`;
};

/**
 * Whether a gap's unchanged lines hold any of `lines`, new-side ranges such as the lines comments outside the patch
 * sit on. Such a gap shows open until the reviewer opens or closes it, so its threads show.
 */
export const holdsLines = (
  gap: Extract<Segment, { kind: "gap" }>,
  lines: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): boolean =>
  gap.parts.some(
    (part) =>
      part.kind === "context" &&
      part.lines.some((line) =>
        lines.some((range) => line.new >= range.start && line.new <= range.end),
      ),
  );

/**
 * The new-side lines that hold a gap open until the reviewer chooses: those comments outside the patch sit on, and
 * those of comments being written on lines of the text.
 */
export const heldLines = (
  context: ReadonlyArray<Pick<ContextComment, "start_line" | "end_line">>,
  writing: ReadonlyArray<Selection>,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => [
  ...context.map((item) => ({ start: item.start_line, end: item.end_line })),
  ...writing.flatMap((selection) =>
    selection.kind === "text"
      ? [{ start: selection.start_line, end: selection.end_line }]
      : [],
  ),
];

/**
 * How far a gap shows open: the reviewer's choice, or until they make one, open when it holds a thread. A gap with
 * only one kind of hidden line has no first stage.
 */
export const gapStage = (
  chosen: GapStage | undefined,
  gap: { readonly folded: number; readonly context: number },
  held: boolean,
): GapStage => {
  const stage = chosen ?? (held ? 2 : 0);
  return stage === 1 && (gap.folded === 0 || gap.context === 0) ? 2 : stage;
};

/**
 * A line a reviewer can select in a table: a row of the patch, or an unchanged line between hunks, which only its
 * new-side number names.
 */
export type Unit =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "line"; readonly line: number };

/** A unit's name in the page: `r12` for row 12 of the patch, `l40` for unchanged line 40. */
export const unitKey = (unit: Unit): string =>
  unit.kind === "row" ? `r${unit.index}` : `l${unit.line}`;

/** The unit a name in the page stands for; undefined for any other text. */
export const parseUnit = (key: string): Unit | undefined => {
  const match = /^([rl])(0|[1-9][0-9]*)$/.exec(key);
  if (match === null) return undefined;
  const number = Number(match[2]);
  return match[1] === "r"
    ? { kind: "row", index: number }
    : { kind: "line", line: number };
};

/**
 * What a table selects before it is sent: rows of its patch, or new-side lines of the file's text when the selection
 * takes in unchanged lines outside the patch.
 */
export type Span =
  | { readonly kind: "rows"; readonly start: number; readonly end: number }
  | { readonly kind: "lines"; readonly start: number; readonly end: number };

/** Where a unit is on the new side: its line, or for a deletion, half a line after the new line before it. */
const newPosition = (rows: ReadonlyArray<Row>, unit: Unit): number => {
  if (unit.kind === "line") return unit.line;
  const row = rows[unit.index];
  if (row?.new !== undefined) return row.new;
  const before =
    rows.slice(0, unit.index).findLast((item) => item.new !== undefined)?.new ??
    0;
  return before + 0.5;
};

/**
 * The span from the first to the last of some units. Rows alone are rows; with an unchanged line among them, the
 * span is the new-side lines they cover, so a deletion at either end adds no line.
 */
export const spanOf = (
  rows: ReadonlyArray<Row>,
  units: readonly [Unit, ...ReadonlyArray<Unit>],
): Span => {
  const indexes = units.flatMap((unit) =>
    unit.kind === "row" ? [unit.index] : [],
  );
  if (indexes.length === units.length)
    return {
      kind: "rows",
      start: Math.min(...indexes),
      end: Math.max(...indexes),
    };
  const positions = units.map((unit) => newPosition(rows, unit));
  return {
    kind: "lines",
    start: Math.ceil(Math.min(...positions)),
    end: Math.floor(Math.max(...positions)),
  };
};

/** A span's first and last unit, which a further unit extends it from. */
export const spanEnds = (span: Span): readonly [Unit, Unit] =>
  span.kind === "rows"
    ? [
        { kind: "row", index: span.start },
        { kind: "row", index: span.end },
      ]
    : [
        { kind: "line", line: span.start },
        { kind: "line", line: span.end },
      ];

/** Whether a unit is in a span. A lines span takes in the rows that show its lines, and no deletion. */
export const inSpan = (
  rows: ReadonlyArray<Row>,
  span: Span,
  unit: Unit,
): boolean => {
  if (span.kind === "rows")
    return (
      unit.kind === "row" && unit.index >= span.start && unit.index <= span.end
    );
  const line = unit.kind === "line" ? unit.line : rows[unit.index]?.new;
  return line !== undefined && line >= span.start && line <= span.end;
};

/** The unit a span ends on, which a thread or a composer goes under: a row of the patch when it shows the line. */
export const lastUnit = (rows: ReadonlyArray<Row>, span: Span): Unit => {
  if (span.kind === "rows") return { kind: "row", index: span.end };
  const row = rowForLine(rows, "new", span.end);
  return row === undefined
    ? { kind: "line", line: span.end }
    : { kind: "row", index: row.index };
};

/** The version of a file a page shows: the digests a selection of its rows or of its lines names. */
export interface FileVersion {
  readonly path: RepoPath;
  readonly digest: PatchDigest | undefined;
  readonly text: ContentDigest | undefined;
}

/** A span as the server takes it; undefined when the page has no digest for what it spans. */
export const selectionOf = (
  file: FileVersion,
  span: Span,
): Selection | undefined => {
  if (span.kind === "rows")
    return file.digest === undefined
      ? undefined
      : {
          kind: "rows",
          path: file.path,
          patch_sha256: file.digest,
          start_row: span.start,
          end_row: span.end,
        };
  return file.text === undefined
    ? undefined
    : {
        kind: "text",
        path: file.path,
        content_sha256: file.text,
        start_line: span.start,
        end_line: span.end,
      };
};

/** What a selection spans in the table it was made in. */
export const spanOfSelection = (selection: Selection): Span =>
  selection.kind === "rows"
    ? { kind: "rows", start: selection.start_row, end: selection.end_row }
    : { kind: "lines", start: selection.start_line, end: selection.end_line };

/** Whether a selection names the version of its file the page shows, so it can stay on its lines. */
export const onVersion = (
  selection: Selection,
  file: Pick<FileVersion, "digest" | "text"> | undefined,
): boolean =>
  selection.kind === "rows"
    ? file?.digest === selection.patch_sha256
    : file?.text === selection.content_sha256;

/**
 * The units a table shows, as the page lists them, in reading order. The split layout lists a row's halves on one
 * line, so a deletion comes after the addition beside it; within each run of rows, rows go in patch order instead.
 */
export const readingOrder = (
  listed: ReadonlyArray<Unit>,
): ReadonlyArray<Unit> => {
  const seen = new Set<string>();
  const ordered: Array<Unit> = [];
  let run: Array<Extract<Unit, { kind: "row" }>> = [];
  const flush = () => {
    ordered.push(...run.toSorted((a, b) => a.index - b.index));
    run = [];
  };
  for (const unit of listed) {
    const key = unitKey(unit);
    if (seen.has(key)) continue;
    seen.add(key);
    if (unit.kind === "row") run.push(unit);
    else {
      flush();
      ordered.push(unit);
    }
  }
  flush();
  return ordered;
};
