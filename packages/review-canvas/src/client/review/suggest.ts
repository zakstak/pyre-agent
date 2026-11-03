/**
 * Suggested changes as the page writes and shows them: "Suggest change" puts a block where the caret is, and a
 * suggestion's diff gets line numbers. Pure, so tests need no browser; the block's format is review/suggestion.ts's.
 */
import { type Row, rowsSide } from "../../review/patch.ts";
import {
  isRun,
  rowsLines,
  suggestionBlock,
  suggestionDiff,
  textRange,
} from "../../review/suggestion.ts";
import type { Selection } from "../../schema/selection.ts";

/**
 * A text box's text with a suggestion block of `lines` in place of its selection, from `start` to `end`, on lines of
 * its own, and where the caret goes: at the end of the block's last line, ready to change it.
 */
export const insertSuggestion = ({
  text,
  start,
  end,
  lines,
}: {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlyArray<string>;
}): { readonly text: string; readonly caret: number } => {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const block = suggestionBlock(lines);
  // The closing fence is the block's last line; the caret goes before the line end that leads to it.
  const caret = before.length + lead.length + block.lastIndexOf("\n");
  return { text: `${before}${lead}${block}${trail}${after}`, caret };
};

/** The lines a suggestion replaces: on one side, from the line numbered `first`. */
export interface ReplacedLines {
  readonly kind: "lines";
  readonly side: "old" | "new";
  readonly first: number;
  readonly lines: ReadonlyArray<string>;
}

/**
 * What a suggestion on some lines replaces: those lines, or none when they are `not_contiguous`, as on a selection
 * across a hunk header, whose range holds the unshown lines between the hunks.
 */
export type Replaced = ReplacedLines | { readonly kind: "not_contiguous" };

/**
 * What a suggestion on rows of a patch replaces: the lines on the side the anchor takes, and the first one's number.
 * A selection of a hunk header alone has no lines.
 */
export const replacedRows = (
  rows: ReadonlyArray<Row>,
  start: number,
  end: number,
): Replaced | undefined => {
  const side = rowsSide(rows, start, end);
  const numbers = rows.slice(start, end + 1).flatMap((row) => {
    const line = row[side];
    return line === undefined ? [] : [line];
  });
  const first = numbers[0];
  if (first === undefined) return undefined;
  if (!isRun(numbers)) return { kind: "not_contiguous" };
  return { kind: "lines", side, first, lines: rowsLines(rows, start, end) };
};

/**
 * What a suggestion on a composer's selection replaces. Rows of the patch take their side's lines; lines of the file's
 * new text, as expanded context gives, are those lines of `content`, which a page without the text cannot read.
 */
export const replacedSelection = (
  selection: Selection,
  rows: ReadonlyArray<Row>,
  content: string | undefined,
): Replaced | undefined => {
  switch (selection.kind) {
    case "rows":
      return replacedRows(rows, selection.start_row, selection.end_row);
    case "text":
      return content === undefined
        ? undefined
        : {
            kind: "lines",
            side: "new",
            first: selection.start_line,
            lines: textRange(content, selection.start_line, selection.end_line),
          };
  }
};

/**
 * Whether "Suggest change" is offered on the lines: on one run of new-side lines only. No change can be proposed for
 * lines the change already removes, nor in place of lines the page did not show.
 */
export const canSuggest = (
  replaced: Replaced | undefined,
): replaced is ReplacedLines =>
  replaced?.kind === "lines" && replaced.side === "new";

/** A row of a suggestion's diff, with its line's number before the change and after it, where it has one. */
export interface SuggestionRow {
  readonly kind: " " | "-" | "+";
  readonly text: string;
  readonly before: number | undefined;
  readonly after: number | undefined;
}

/** The diff of the current lines, from line `first`, against the proposed lines, numbered on both sides. */
export const suggestionRows = (
  current: ReadonlyArray<string>,
  proposed: ReadonlyArray<string>,
  first: number,
): ReadonlyArray<SuggestionRow> => {
  let before = first;
  let after = first;
  return suggestionDiff(current, proposed).map((op): SuggestionRow => {
    switch (op.kind) {
      case " ":
        return { ...op, before: before++, after: after++ };
      case "-":
        return { ...op, before: before++, after: undefined };
      case "+":
        return { ...op, before: undefined, after: after++ };
    }
  });
};
