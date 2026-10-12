/** A file's patch as a table of rows, with the comment threads attached to them and the tour's note markers. */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import { attachedRows } from "../../review/anchor.ts";
import { parseRows, patchDigest, type Row } from "../../review/patch.ts";
import type { NoteView } from "../../review/tour.ts";
import { type Html, html } from "../html.ts";
import { thread, type ThreadOptions } from "./comments.ts";

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
  /** The rows to show; the whole patch when absent. */
  readonly range?: { readonly start: number; readonly end: number } | undefined;
  readonly comments: ReadonlyArray<PlacedComment>;
  readonly notes?: ReadonlyArray<NoteView> | undefined;
  /** Distinguishes several tables of one file on a page, so row IDs stay unique. */
  readonly tableId: string;
}

/**
 * The rows of a patch, or a slice of them. Each row carries its index for selection, and a comment thread renders
 * under the last row it spans. A note marker sits on its row, and its text is in the stop's notes list.
 */
export const diffTable = (options: DiffOptions): Html => {
  const { file, comments, tableId } = options;
  const rows = parseRows(file.patch ?? "");
  const range = options.range ?? { start: 0, end: rows.length - 1 };
  const shown = rows.slice(range.start, range.end + 1);
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
  return html`<div class="diff-scroll" role="region" aria-label="${file.path}" tabindex="0">
<table class="diff" data-path="${file.path}" data-patch="${patchDigest(file.patch ?? "")}" data-table="${tableId}" data-rows="${rows.length}">
<thead><tr><th>Old line</th><th>New line</th><th>Change</th><th>Source</th></tr></thead>
<tbody>${shown.map((row) => {
    const note = notesAt.get(row.index);
    const threads = threadsEndingAt.get(row.index);
    const selectable =
      row.kind === "add" || row.kind === "del" || row.kind === "context";
    return html`<tr id="${tableId}-r${row.index}" class="${rowClass[row.kind]}${commented.has(row.index) ? " commented" : ""}" data-row="${row.index}"${selectable ? html` data-selectable` : ""}${row.kind === "del" ? html` data-side="old"` : row.kind === "add" ? html` data-side="new"` : ""}>
<td class="line-number">${
      selectable
        ? html`<button type="button" class="add-comment" title="Comment on this line" aria-label="Comment on line ${row.new ?? row.old}">+</button>`
        : ""
    }${row.old ?? ""}</td><td class="line-number">${row.new ?? ""}</td><td class="marker">${
      note === undefined
        ? ""
        : html`<a class="note-marker" href="#${tableId}-note-${note.letter}" title="${note.title}" aria-label="Note ${note.letter}: ${note.title}">${note.letter}</a>`
    }<span aria-hidden="true">${marker[row.kind]}</span></td><td class="source"><code>${row.content}</code></td></tr>${
      threads === undefined
        ? ""
        : html`<tr class="thread-row" data-after="${row.index}"><td colspan="4">${threads.map(
            (placed) =>
              thread(placed.comment, { ...options, instance: tableId }),
          )}</td></tr>`
    }`;
  })}</tbody>
</table>
</div>`;
};
