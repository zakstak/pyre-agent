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

/** A suggestion block in a body: the lines of its opening and closing fences, and the lines between them. */
interface Block {
  readonly open: number;
  readonly close: number;
  readonly lines: ReadonlyArray<string>;
}

/**
 * A body's suggestion blocks, read as CommonMark reads fences: a block opens on a fence line and closes on a line of
 * the same character, at least as long, with nothing after it but spaces. A suggestion fence inside another fenced
 * block is code, not a suggestion. `unclosed` says a suggestion block runs to the end of the body.
 */
const scan = (
  body: string,
): {
  readonly lines: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<Block>;
  readonly unclosed: boolean;
} => {
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const blocks: Array<Block> = [];
  let open:
    | {
        readonly at: number;
        readonly fence: string;
        readonly suggestion: boolean;
        readonly lines: Array<string>;
      }
    | undefined;
  for (const [at, line] of lines.entries()) {
    if (open === undefined) {
      const match = FENCE.exec(line);
      const fence = match?.[1];
      const info = match?.[2] ?? "";
      // A backtick fence's info string cannot hold a backtick; such a line is text.
      if (fence === undefined || (fence.startsWith("`") && info.includes("`")))
        continue;
      open = { at, fence, suggestion: isSuggestionInfo(info), lines: [] };
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
      if (open.suggestion)
        blocks.push({ open: open.at, close: at, lines: open.lines });
      open = undefined;
      continue;
    }
    open.lines.push(line);
  }
  return { lines, blocks, unclosed: open?.suggestion === true };
};

/**
 * A body as a page shows it: the text, or, for a body that proposes a change, the text before the suggestion block,
 * the proposed lines, and the text after it, each without the line end that parts it from the block. A malformed body
 * is text, with what is wrong with it.
 */
export type SuggestionParts =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "malformed";
      readonly text: string;
      readonly problem: "unclosed" | "several";
    }
  | {
      readonly kind: "suggestion";
      readonly before: string;
      readonly lines: ReadonlyArray<string>;
      readonly after: string;
    };

/**
 * A body's parts. A body with one closed suggestion block proposes its lines; two or more, or one that never closes,
 * are malformed, and the body stays as written.
 */
export const suggestionParts = (body: string): SuggestionParts => {
  const { lines, blocks, unclosed } = scan(body);
  if (unclosed) return { kind: "malformed", text: body, problem: "unclosed" };
  const [only, ...more] = blocks;
  if (only === undefined) return { kind: "text", text: body };
  if (more.length > 0)
    return { kind: "malformed", text: body, problem: "several" };
  return {
    kind: "suggestion",
    before: lines.slice(0, only.open).join("\n"),
    lines: only.lines,
    after: lines.slice(only.close + 1).join("\n"),
  };
};

/** The suggestion in a body, as the agents get it. */
export const parseSuggestion = (body: string): SuggestionParse => {
  const parts = suggestionParts(body);
  switch (parts.kind) {
    case "text":
      return { kind: "none" };
    case "malformed":
      return { kind: "malformed", problem: parts.problem };
    case "suggestion":
      return { kind: "suggestion", lines: parts.lines };
  }
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
  const side = rowsSide(rows, start_row, end_row);
  return rows
    .slice(start_row, end_row + 1)
    .filter((row) => row[side] !== undefined)
    .map((row) => row.content);
};

/** The side a selection of patch rows is on: old for deleted lines with no added line among them, else new. */
export const rowsSide = (
  rows: ReadonlyArray<Row>,
  start_row: number,
  end_row: number,
): "old" | "new" => {
  const selected = rows.slice(start_row, end_row + 1);
  return selected.some((row) => row.kind === "del") &&
    !selected.some((row) => row.kind === "add")
    ? "old"
    : "new";
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
