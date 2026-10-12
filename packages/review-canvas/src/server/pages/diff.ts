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
import type { NoteView } from "../../review/tour.ts";
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

export interface DiffOptions extends Omit<ThreadOptions, "instance"> {
  readonly file: ReviewFile;
  /** The rows to show; the whole patch when absent. Only a whole patch splits and shows unchanged lines. */
  readonly range?: { readonly start: number; readonly end: number } | undefined;
  readonly comments: ReadonlyArray<PlacedComment>;
  readonly notes?: ReadonlyArray<NoteView> | undefined;
  /** Distinguishes several tables of one file on a page, so row IDs stay unique. */
  readonly tableId: string;
  readonly layout?: Layout | undefined;
}

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

const selectable = (row: Row) =>
  row.kind === "add" || row.kind === "del" || row.kind === "context";

/** The attributes of a selectable unit: its row, its source lines, and the side of a changed line. */
const unitData = (row: Row): Html =>
  html` data-row="${row.index}" data-selectable data-old="${row.old ?? ""}" data-new="${row.new ?? ""}"${row.kind === "del" ? html` data-side="old"` : row.kind === "add" ? html` data-side="new"` : ""}`;

const addButton = (row: Row): Html =>
  html`<button type="button" class="add-comment" title="Comment on this line" aria-label="Comment on line ${row.new ?? row.old}">+</button>`;

const noteMarker = (note: NoteView | undefined, tableId: string): Html =>
  note === undefined
    ? html``
    : html`<a class="note-marker" href="#${tableId}-note-${note.letter}" title="${note.title}" aria-label="Note ${note.letter}: ${note.title}">${note.letter}</a>`;

/**
 * The rows of a patch, or a slice of them. A comment thread renders under the last row it spans. A note marker sits
 * on its row, and its text is in the stop's notes list.
 */
export const diffTable = (options: DiffOptions): Html => {
  const { file, comments, tableId } = options;
  const rows = parseRows(file.patch ?? "");
  const whole = options.range === undefined;
  const layout: Layout = whole ? (options.layout ?? "unified") : "unified";
  const columns = layout === "split" ? 2 : 4;
  const range = options.range ?? { start: 0, end: rows.length - 1 };
  const threadsEndingAt = new Map<number, Array<PlacedComment>>();
  for (const placed of comments) {
    if (placed.end < range.start || placed.start > range.end) continue;
    const at = Math.min(placed.end, range.end);
    const list = threadsEndingAt.get(at) ?? [];
    list.push(placed);
    threadsEndingAt.set(at, list);
  }
  const notesAt = new Map<number, NoteView>();
  for (const note of options.notes ?? []) notesAt.set(note.row, note);
  const commented = new Set<number>();
  for (const placed of comments)
    for (let at = placed.start; at <= placed.end; at++) commented.add(at);
  const mark = (row: Row) => (commented.has(row.index) ? " commented" : "");

  const threadRow = (indexes: ReadonlyArray<number>): Html => {
    const placed = [...new Set(indexes)].flatMap(
      (index) => threadsEndingAt.get(index) ?? [],
    );
    return placed.length === 0
      ? html``
      : html`<tr class="thread-row"><td colspan="${columns}">${placed.map(
          (item) => thread(item.comment, { ...options, instance: tableId }),
        )}</td></tr>`;
  };

  const unifiedRow = (row: Row): Html =>
    html`<tr id="${tableId}-r${row.index}" class="${rowClass[row.kind]}${mark(row)}"${selectable(row) ? unitData(row) : html` data-row="${row.index}"`}>
<td class="line-number" data-gutter>${selectable(row) ? addButton(row) : ""}${row.old ?? ""}</td><td class="line-number" data-gutter>${row.new ?? ""}</td><td class="marker" data-gutter>${noteMarker(notesAt.get(row.index), tableId)}<span aria-hidden="true">${marker[row.kind]}</span></td><td class="source"><code>${row.content}</code></td></tr>${threadRow([row.index])}`;

  const half = (row: Row | undefined, side: "old" | "new"): Html =>
    row === undefined
      ? html`<td class="half ${side} empty"></td>`
      : html`<td class="half ${side} ${rowClass[row.kind]}${mark(row)}"${unitData(row)}><span class="ln" data-gutter>${addButton(row)}${row[side] ?? ""}</span><span class="mk" data-gutter aria-hidden="true">${marker[row.kind]}</span><code>${row.content}</code></td>`;

  const splitRows = (piece: ReadonlyArray<Row>): Html =>
    html`${pairRows(piece).map((pair) => {
      if (pair.whole !== undefined)
        return html`<tr class="${rowClass[pair.whole.kind]}" data-row="${pair.whole.index}"><td colspan="2"><code>${pair.whole.content}</code></td></tr>`;
      const indexes = [pair.old?.index, pair.new?.index].filter(
        (index): index is number => index !== undefined,
      );
      return html`<tr id="${tableId}-p${Math.min(...indexes)}" class="pair">${half(pair.old, "old")}${half(pair.new, "new")}</tr>${threadRow(indexes)}`;
    })}`;

  const body = (piece: ReadonlyArray<Row>): Html =>
    html`<tbody>${layout === "split" ? splitRows(piece) : piece.map(unifiedRow)}</tbody>`;

  const gapBody = (gap: Gap, at: number): Html => {
    const count = gap.lines.length;
    const line = (item: Gap["lines"][number]): Html =>
      layout === "split"
        ? html`<tr class="unchanged"><td class="half old context"><span class="ln">${item.old}</span><span class="mk"></span><code>${item.text}</code></td><td class="half new context"><span class="ln">${item.new}</span><span class="mk"></span><code>${item.text}</code></td></tr>`
        : html`<tr class="unchanged"><td class="line-number">${item.old}</td><td class="line-number">${item.new}</td><td class="marker"></td><td class="source"><code>${item.text}</code></td></tr>`;
    return html`<tbody class="gap"><tr class="gap-toggle"><td colspan="${columns}"><button type="button" class="quiet expand" data-expand="${at}" aria-expanded="false">Show ${count} unchanged line${count === 1 ? "" : "s"}</button></td></tr></tbody><tbody class="gap-lines" data-gap-lines="${at}" hidden>${gap.lines.map(line)}</tbody>`;
  };

  const found =
    whole && file.patch !== undefined && file.new_content !== undefined
      ? gaps(file.patch, file.new_content)
      : [];
  // With the file's text, a whole patch is cut into a body per hunk, so the unchanged lines go between them.
  const segments: Array<Html> = [];
  if (found.length === 0) {
    segments.push(body(rows.slice(range.start, range.end + 1)));
  } else {
    const starts = rows
      .filter((row) => row.kind === "hunk")
      .map((row) => row.index);
    if ((starts[0] ?? 0) > 0) segments.push(body(rows.slice(0, starts[0])));
    starts.forEach((start, hunk) => {
      const at = found.findIndex((gap) => gap.before === start);
      const gap = found[at];
      if (gap !== undefined) segments.push(gapBody(gap, at));
      segments.push(body(rows.slice(start, starts[hunk + 1] ?? rows.length)));
    });
    const at = found.findIndex((gap) => gap.before === -1);
    const trailing = found[at];
    if (trailing !== undefined) segments.push(gapBody(trailing, at));
  }

  return html`<div class="diff-scroll" role="region" aria-label="${file.path}" tabindex="0">
<table class="diff ${layout}" data-path="${file.path}" data-patch="${patchDigest(file.patch ?? "")}" data-table="${tableId}" data-rows="${rows.length}">
<thead>${layout === "split" ? html`<tr><th>Old</th><th>New</th></tr>` : html`<tr><th>Old line</th><th>New line</th><th>Change</th><th>Source</th></tr>`}</thead>
${segments}
</table>
</div>`;
};
