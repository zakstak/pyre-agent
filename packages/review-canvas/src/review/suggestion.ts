/**
 * Suggested changes: a comment body that holds one `suggestion` fenced block, as GitHub writes them, proposes those
 * lines in place of the lines the comment is on. Pure and browser-safe: the composer builds and previews a block with
 * these, and the server reads the same block for the agents.
 */
import type { Comment } from "../schema/feedback.ts";
import { diffLines, type LineOp } from "./linediff.ts";
import { type Row, textLines } from "./patch.ts";

/** What a body proposes: nothing, one replacement, or a block the agents cannot apply as it is written. */
export type SuggestionParse =
  | { readonly kind: "none" }
  | {
      readonly kind: "suggestion";
      /** The proposed lines, without line ends. No lines proposes deleting the commented lines. */
      readonly lines: ReadonlyArray<string>;
    }
  | {
      readonly kind: "malformed";
      /** A suggestion block with no closing fence, or more than one suggestion block in one comment. */
      readonly problem: "unclosed" | "several";
    };

/** A fence line: up to three spaces, then three or more backticks or tildes, then the info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const isSuggestionInfo = (info: string) =>
  /^suggestion(?:\s|$)/.test(info.trim());

/**
 * The suggestion in a body, read as CommonMark reads fences: a block opens on a fence line and closes on a line of
 * the same character, at least as long, with nothing after it but spaces. A suggestion fence inside another fenced
 * block is code, not a suggestion. A body with one closed suggestion block proposes its lines; two or more, or one that
 * never closes, are malformed, and the body stays as written.
 */
export const parseSuggestion = (body: string): SuggestionParse => {
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const found: Array<ReadonlyArray<string>> = [];
  let open:
    | {
        readonly fence: string;
        readonly suggestion: boolean;
        readonly lines: Array<string>;
      }
    | undefined;
  for (const line of lines) {
    if (open === undefined) {
      const match = FENCE.exec(line);
      const fence = match?.[1];
      const info = match?.[2] ?? "";
      // A backtick fence's info string cannot hold a backtick; such a line is text.
      if (fence === undefined || (fence.startsWith("`") && info.includes("`")))
        continue;
      open = { fence, suggestion: isSuggestionInfo(info), lines: [] };
      continue;
    }
    const match = FENCE.exec(line);
    const fence = match?.[1];
    if (
      fence !== undefined &&
      fence[0] === open.fence[0] &&
      fence.length >= open.fence.length &&
      (match?.[2] ?? "").trim() === ""
    ) {
      if (open.suggestion) found.push(open.lines);
      open = undefined;
      continue;
    }
    open.lines.push(line);
  }
  if (open?.suggestion === true)
    return { kind: "malformed", problem: "unclosed" };
  const [only, ...more] = found;
  if (only === undefined) return { kind: "none" };
  if (more.length > 0) return { kind: "malformed", problem: "several" };
  return { kind: "suggestion", lines: only };
};

/**
 * A suggestion block proposing `lines`, as the composer inserts it: its fence is longer than any run of backticks in
 * the lines, so no line can close it early.
 */
export const suggestionBlock = (lines: ReadonlyArray<string>): string => {
  const longest = Math.max(
    0,
    ...lines.map((line) =>
      Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length)),
    ),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}suggestion`, ...lines, fence].join("\n");
};

/**
 * The small diff a suggestion shows: the lines it is on against the lines it proposes. Lines too different to diff
 * show as all removed, then all added.
 */
export const suggestionDiff = (
  current: ReadonlyArray<string>,
  proposed: ReadonlyArray<string>,
): ReadonlyArray<LineOp> =>
  diffLines(current, proposed) ?? [
    ...current.map((text) => ({ kind: "-" as const, text })),
    ...proposed.map((text) => ({ kind: "+" as const, text })),
  ];

/**
 * The lines a selection of patch rows is on, as "Suggest change" fills its block with them: the new side's lines, or
 * the old side's for a selection of deleted lines alone, as the anchor the server makes picks its side.
 */
export const rowsLines = (
  rows: ReadonlyArray<Row>,
  start_row: number,
  end_row: number,
): ReadonlyArray<string> => {
  const selected = rows.slice(start_row, end_row + 1);
  const side =
    selected.some((row) => row.kind === "del") &&
    !selected.some((row) => row.kind === "add")
      ? "old"
      : "new";
  return selected
    .filter((row) => row[side] !== undefined)
    .map((row) => row.content);
};

/** Lines `start_line` through `end_line` of a file's new text, as a selection of them fills a suggestion block. */
export const textRange = (
  content: string,
  start_line: number,
  end_line: number,
): ReadonlyArray<string> =>
  textLines(content).lines.slice(start_line - 1, end_line);

/**
 * The lines an inline comment is on, as the reviewer saw them, without diff markers: for a patch anchor the rows of
 * its quote on its side, for a text anchor the quoted lines.
 */
export const anchoredLines = (
  anchor: Extract<Comment, { kind: "inline" }>["anchor"],
): ReadonlyArray<string> => {
  const rows = anchor.quote.split("\n");
  if (anchor.kind === "text") return rows;
  const skip = anchor.side === "new" ? "-" : "+";
  return rows.flatMap((row) => {
    const marker = row[0];
    if (marker === " " || marker === "+" || marker === "-")
      return marker === skip ? [] : [row.slice(1)];
    // A hunk header or a "\ No newline" marker is no line of the file.
    return [];
  });
};
