import type { Attachment } from "../schema/feedback.ts";

/** What one row of a unified diff is. Rows count hunk headers, as anchors do. */
export type RowKind = "hunk" | "context" | "add" | "del" | "meta";

/** One LF-delimited row of a patch, with its source line numbers and its offset in the rows joined with LF. */
export interface Row {
  readonly index: number;
  readonly kind: RowKind;
  /** The whole row, marker included. */
  readonly text: string;
  /** The row without its marker; a hunk header keeps its text. */
  readonly content: string;
  readonly old: number | undefined;
  readonly new: number | undefined;
  /** The UTF-16 offset of the row's first unit in the joined rows. */
  readonly offset: number;
}

const HUNK = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/;

/** Splits a patch into rows. A trailing LF ends the last row; it does not add an empty one. */
export const parseRows = (patch: string): ReadonlyArray<Row> => {
  const lines = patch.split("\n");
  if (patch.endsWith("\n")) lines.pop();
  const rows: Array<Row> = [];
  let old = 0;
  let next = 0;
  let offset = 0;
  for (const [index, text] of lines.entries()) {
    const header = HUNK.exec(text);
    let row: Row;
    if (header !== null) {
      old = Number(header[1]);
      next = Number(header[2]);
      row = {
        index,
        kind: "hunk",
        text,
        content: text,
        old: undefined,
        new: undefined,
        offset,
      };
    } else if (text.startsWith("+")) {
      row = {
        index,
        kind: "add",
        text,
        content: text.slice(1),
        old: undefined,
        new: next++,
        offset,
      };
    } else if (text.startsWith("-")) {
      row = {
        index,
        kind: "del",
        text,
        content: text.slice(1),
        old: old++,
        new: undefined,
        offset,
      };
    } else if (text.startsWith(" ")) {
      row = {
        index,
        kind: "context",
        text,
        content: text.slice(1),
        old: old++,
        new: next++,
        offset,
      };
    } else {
      // A "\ No newline at end of file" marker, or anything else the patch holds.
      row = {
        index,
        kind: "meta",
        text,
        content: text,
        old: undefined,
        new: undefined,
        offset,
      };
    }
    rows.push(row);
    offset += text.length + 1;
  }
  return rows;
};

/** The rows joined with LF: the text anchor offsets index. */
export const joinedRows = (rows: ReadonlyArray<Row>): string =>
  rows.map((row) => row.text).join("\n");

/** The row that shows a source line on one side, if the patch shows it. */
export const rowForLine = (
  rows: ReadonlyArray<Row>,
  side: "old" | "new",
  line: number,
): Row | undefined => rows.find((row) => row[side] === line);

/**
 * The rows a line range names on one side: from the first row showing a line at or after `start` to the last row
 * showing a line at or before `end`, both inclusive, with the rows between them.
 */
export const rowsForLines = (
  rows: ReadonlyArray<Row>,
  side: "old" | "new",
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | undefined => {
  let first: number | undefined;
  let last: number | undefined;
  for (const row of rows) {
    const line = row[side];
    if (line === undefined || line < start || line > end) continue;
    first ??= row.index;
    last = row.index;
  }
  return first === undefined || last === undefined
    ? undefined
    : { start: first, end: last };
};

/** A hunk's lines on each side, from its header: [first, last], or empty when the side has no lines. */
export interface HunkRange {
  readonly old: readonly [number, number] | [];
  readonly new: readonly [number, number] | [];
}

const HUNK_COUNTS = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;

export const hunkRanges = (patch: string): ReadonlyArray<HunkRange> =>
  patch
    .split("\n")
    .map((line) => HUNK_COUNTS.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const span = (start: string | undefined, count: string | undefined) => {
        const first = Number(start);
        const length = count === undefined ? 1 : Number(count);
        return length === 0
          ? ([] as [])
          : ([first, first + length - 1] as const);
      };
      return { old: span(match[1], match[2]), new: span(match[3], match[4]) };
    });

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

/**
 * The rows whose change is whitespace only: each run of deletions followed at once by as many additions, when every
 * deletion and the addition in its place hold the same text once all whitespace is removed. A view of the rows, not
 * a new diff: indexes and anchors stay as they are.
 */
export const whitespaceOnly = (
  rows: ReadonlyArray<Row>,
): ReadonlySet<number> => {
  const found = new Set<number>();
  const run = (from: number, kind: RowKind) => {
    let to = from;
    while (rows[to]?.kind === kind) to++;
    return rows.slice(from, to);
  };
  const bare = (row: Row | undefined) => row?.content.replace(/\s+/g, "");
  for (let at = 0; at < rows.length; ) {
    const dels = run(at, "del");
    if (dels.length === 0) {
      at++;
      continue;
    }
    const adds = run(at + dels.length, "add");
    at += dels.length + adds.length;
    if (
      dels.length === adds.length &&
      dels.every((row, pair) => bare(row) === bare(adds[pair]))
    )
      for (const row of [...dels, ...adds]) found.add(row.index);
  }
  return found;
};
