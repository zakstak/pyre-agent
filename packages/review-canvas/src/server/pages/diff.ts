/**
 * A file's patch as a table, unified or split, with the comment threads attached to its rows, the tour's note
 * markers, and, when the round has the file's text, the unchanged lines between hunks behind a toggle.
 *
 * Every line the reviewer can select is a unit with `data-row`, its row index in the patch, and `data-old` and
 * `data-new`, its source line numbers. In the unified layout a unit is a table row; in the split layout it is one
 * half of a row, and a context line shows as two units of the same row index. The page selects units, so it works
 * the same in both.
 */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import { attachedRows } from "../../review/anchor.ts";
import { parseRows, patchDigest, type Row } from "../../review/patch.ts";
import { type Html, html } from "../html.ts";
import { thread, type ThreadOptions } from "./comments.ts";

export type Layout = "unified" | "split";

/** An inline comment with the rows its attachment spans in the current patch. */
export interface PlacedComment {
  readonly comment: Extract<Comment, { kind: "inline" }>;
  readonly start: number;
  readonly end: number;
}

/** The inline comments of a file, placed on its rows. Orphans have no place. */
export const placeComments = (
  file: ReviewFile,
  comments: ReadonlyArray<Comment>,
): {
  readonly placed: ReadonlyArray<PlacedComment>;
  readonly orphans: ReadonlyArray<Extract<Comment, { kind: "inline" }>>;
} => {
  const rows = parseRows(file.patch ?? "");
  const placed: Array<PlacedComment> = [];
  const orphans: Array<Extract<Comment, { kind: "inline" }>> = [];
  for (const comment of comments) {
    if (comment.kind !== "inline" || comment.anchor.path !== file.path)
      continue;
    const span = attachedRows(rows, comment.attachment);
    if (span === undefined) orphans.push(comment);
    else placed.push({ comment, ...span });
  }
  return { placed, orphans };
};

const rowClass: Readonly<Record<Row["kind"], string>> = {
  add: "addition",
  del: "deletion",
  context: "context",
  hunk: "hunk",
  meta: "meta",
};

const marker: Readonly<Record<Row["kind"], string>> = {
  add: "+",
  del: "−",
  context: " ",
  hunk: "",
  meta: "",
};

/** A note of the tour, shown in the diff under the row it explains. */
export interface InlineNote {
  readonly id: string;
  readonly row: number;
  readonly letter: string;
  readonly title: Html;
  readonly body: Html;
  /** For a note of a later stop than the one that owns the file: that stop's number. */
  readonly stop?: number | undefined;
}

export interface DiffOptions extends Omit<ThreadOptions, "instance"> {
  readonly file: ReviewFile;
  /**
   * The row ranges to show, such as a stop's excerpts; the other rows fold behind a "Show N more lines" row. Every
   * row shows when absent.
   */
  readonly shown?: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  readonly comments: ReadonlyArray<PlacedComment>;
  readonly notes?: ReadonlyArray<InlineNote> | undefined;
  /** Names the table and its rows; unique on the page. */
  readonly tableId: string;
  readonly layout?: Layout | undefined;
  /** For a patch the reviewer cannot comment on, such as the changes between two rounds. */
  readonly readOnly?: boolean | undefined;
}

/**
 * The unified layout's columns: the line numbers (old and new in one gutter cell, so a narrow page can show one of
 * them and keep the + button), the change marker, and the source.
 */
export const UNIFIED_COLUMNS = 3;

/** A run of hidden rows shorter than this shows instead: a fold for two lines costs more than it saves. */
const MIN_FOLD = 4;

/** Unchanged lines before a hunk, or after the last one, which the file's text supplies. */
export interface Gap {
  /** The row index of the hunk header the gap comes before, or -1 for the gap after the last hunk. */
  readonly before: number;
  readonly lines: ReadonlyArray<{
    readonly old: number;
    readonly new: number;
    readonly text: string;
  }>;
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

const changeable = (row: Row) =>
  row.kind === "add" || row.kind === "del" || row.kind === "context";

/** The attributes of a selectable unit: its row, its source lines, and the side of a changed line. */
const unitData = (row: Row): Html =>
  html` data-row="${row.index}" data-selectable data-old="${row.old ?? ""}" data-new="${row.new ?? ""}"${row.kind === "del" ? html` data-side="old"` : row.kind === "add" ? html` data-side="new"` : ""}`;

const addButton = (row: Row): Html =>
  html`<button type="button" class="add-comment" title="Comment on this line" aria-label="Comment on line ${row.new ?? row.old}">+</button>`;

const noteMarker = (notes: ReadonlyArray<InlineNote> | undefined): Html =>
  notes === undefined || notes.length === 0
    ? html``
    : html`<span class="note-marker" aria-hidden="true">${notes.map((note) => note.letter).join("")}</span>`;

const noteRow = (note: InlineNote, columns: number): Html =>
  html`<tr class="note" id="${note.id}"><td colspan="${columns}"><div class="row-body"><span class="sr-only">Note </span><span class="note-letter">${note.letter}</span>${note.stop === undefined ? "" : html`<span class="muted">Stop ${note.stop} · </span>`}<strong>${note.title}</strong>${html` `}${note.body}</div></td></tr>`;

/**
 * The rows of a patch. A note renders under its row, then the comment threads that end there. Rows outside `shown`
 * fold into runs behind a toggle, and those rows have no + button until the page reveals them: a hidden button
 * cannot take focus, and the first + on the page should be one the reviewer can reach.
 */
export const diffTable = (options: DiffOptions): Html => {
  const { file, comments, tableId } = options;
  const rows = parseRows(file.patch ?? "");
  const readOnly = options.readOnly === true;
  const layout: Layout = readOnly ? "unified" : (options.layout ?? "unified");
  const selectable = (row: Row) => !readOnly && changeable(row);
  const columns = layout === "split" ? 2 : UNIFIED_COLUMNS;
  const threadsEndingAt = new Map<number, Array<PlacedComment>>();
  for (const placed of comments) {
    const list = threadsEndingAt.get(placed.end) ?? [];
    list.push(placed);
    threadsEndingAt.set(placed.end, list);
  }
  const notesAt = new Map<number, Array<InlineNote>>();
  for (const note of options.notes ?? [])
    notesAt.set(note.row, [...(notesAt.get(note.row) ?? []), note]);
  const commented = new Set<number>();
  for (const placed of comments)
    for (let at = placed.start; at <= placed.end; at++) commented.add(at);
  const mark = (row: Row) => (commented.has(row.index) ? " commented" : "");

  // Which rows show: those in `shown`, and any run of hidden rows too short to fold.
  const visible = new Set<number>();
  if (options.shown === undefined) for (const row of rows) visible.add(row.index);
  else {
    for (const range of options.shown)
      for (let at = range.start; at <= range.end; at++) visible.add(at);
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

  const extras = (indexes: ReadonlyArray<number>): Html => {
    const unique = [...new Set(indexes)];
    const notes = unique.flatMap((index) => notesAt.get(index) ?? []);
    const placed = unique.flatMap((index) => threadsEndingAt.get(index) ?? []);
    return html`${notes.map((note) => noteRow(note, columns))}${
      placed.length === 0
        ? ""
        : html`<tr class="thread-row"><td colspan="${columns}"><div class="row-body">${placed.map(
            (item) => thread(item.comment, { ...options, instance: tableId }),
          )}</div></td></tr>`
    }`;
  };

  const numbers = (old: number | undefined, fresh: number | undefined): Html =>
    html`<span class="ln-old">${old ?? ""}</span><span class="ln-new">${fresh ?? ""}</span>`;

  const unifiedRow = (row: Row, plus: boolean): Html =>
    html`<tr id="${tableId}-r${row.index}" class="${rowClass[row.kind]}${mark(row)}"${selectable(row) ? unitData(row) : html` data-row="${row.index}"`}>
<td class="line-number" data-gutter>${selectable(row) && plus ? addButton(row) : ""}${numbers(row.old, row.new)}</td><td class="marker" data-gutter>${noteMarker(notesAt.get(row.index))}<span aria-hidden="true">${marker[row.kind]}</span></td><td class="source"><code>${row.content}</code></td></tr>${extras([row.index])}`;

  const half = (row: Row | undefined, side: "old" | "new", plus: boolean): Html =>
    row === undefined
      ? html`<td class="half ${side} empty"></td>`
      : html`<td class="half ${side} ${rowClass[row.kind]}${mark(row)}"${unitData(row)}><span class="ln" data-gutter>${plus ? addButton(row) : ""}${row[side] ?? ""}</span><span class="mk" data-gutter>${side === "new" || row.kind === "del" ? noteMarker(notesAt.get(row.index)) : ""}<span aria-hidden="true">${marker[row.kind]}</span></span><code>${row.content}</code></td>`;

  const splitRows = (piece: ReadonlyArray<Row>, plus: boolean): Html =>
    html`${pairRows(piece).map((pair) => {
      if (pair.whole !== undefined)
        return html`<tr class="${rowClass[pair.whole.kind]}" data-row="${pair.whole.index}"><td colspan="2"><code>${pair.whole.content}</code></td></tr>${extras([pair.whole.index])}`;
      const indexes = [pair.old?.index, pair.new?.index].filter(
        (index): index is number => index !== undefined,
      );
      return html`<tr id="${tableId}-p${Math.min(...indexes)}" class="pair">${half(pair.old, "old", plus)}${half(pair.new, "new", plus)}</tr>${extras(indexes)}`;
    })}`;

  const rowsHtml = (piece: ReadonlyArray<Row>, plus: boolean): Html =>
    layout === "split"
      ? splitRows(piece, plus)
      : html`${piece.map((row) => unifiedRow(row, plus))}`;

  // The patch in document order: rows that show, runs of folded rows, and the unchanged lines between hunks.
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
  const found =
    !readOnly && file.patch !== undefined && file.new_content !== undefined
      ? gaps(file.patch, file.new_content)
      : [];
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

  const contextLine = (item: Gap["lines"][number]): Html =>
    layout === "split"
      ? html`<tr class="unchanged"><td class="half old context"><span class="ln">${item.old}</span><span class="mk"></span><code>${item.text}</code></td><td class="half new context"><span class="ln">${item.new}</span><span class="mk"></span><code>${item.text}</code></td></tr>`
      : html`<tr class="unchanged"><td class="line-number">${numbers(item.old, item.new)}</td><td class="marker"></td><td class="source"><code>${item.text}</code></td></tr>`;

  /**
   * Hidden lines next to each other are one gap with one control, whatever hides them. Its first activation shows the
   * folded rows of the patch, its second the unchanged lines around them; it sits where the lines still hidden after
   * the first one are, so it never ends up away from them.
   */
  const gapGroup = (group: ReadonlyArray<Extract<Piece, { kind: "folded" | "context" }>>): Html => {
    const first = group[0];
    if (first === undefined) return html``;
    const folded = group.reduce((sum, piece) => sum + (piece.kind === "folded" ? piece.rows.length : 0), 0);
    const context = group.reduce((sum, piece) => sum + (piece.kind === "context" ? piece.gap.lines.length : 0), 0);
    const total = folded + context;
    const toggle = html`<tbody class="gap"><tr class="gap-toggle"><td colspan="${columns}"><button type="button" class="quiet expand" data-expand="${first.key}" data-folded="${folded}" data-context="${context}" aria-expanded="false">Show ${total} more line${total === 1 ? "" : "s"}</button></td></tr></tbody>`;
    const at = Math.max(0, group.findIndex((piece) => piece.kind === "context"));
    return html`${group.map(
      (piece, index) =>
        html`${index === at ? toggle : ""}${
          piece.kind === "folded"
            ? html`<tbody class="gap-lines folded" data-gap-lines="${piece.key}" data-gap="${first.key}" hidden>${rowsHtml(piece.rows, false)}</tbody>`
            : html`<tbody class="gap-lines" data-gap-lines="${piece.key}" data-gap="${first.key}" hidden>${piece.gap.lines.map(contextLine)}</tbody>`
        }`,
    )}`;
  };

  const segments: Array<Html> = [];
  let hidden: Array<Extract<Piece, { kind: "folded" | "context" }>> = [];
  for (const piece of pieces) {
    if (piece.kind !== "shown") {
      hidden.push(piece);
      continue;
    }
    segments.push(gapGroup(hidden));
    hidden = [];
    segments.push(html`<tbody>${rowsHtml(piece.rows, true)}</tbody>`);
  }
  segments.push(gapGroup(hidden));

  return html`<div class="diff-scroll" role="group" aria-label="Diff of ${file.path}" tabindex="0">
<table class="diff ${layout}" data-path="${file.path}" data-patch="${patchDigest(file.patch ?? "")}" data-table="${tableId}" data-rows="${rows.length}">
<thead>${layout === "split" ? html`<tr><th>Old</th><th>New</th></tr>` : html`<tr><th>Line</th><th>Change</th><th>Source</th></tr>`}</thead>
${segments}
</table>
</div>`;
};
