/**
 * Suggested changes on the page: the button that writes a `suggestion` block of the selected lines, and the small
 * diff of those lines against the proposed ones, under a box while it is written and in the comment once it is sent.
 */
import { FileDiff } from "lucide-react";
import { flushSync } from "react-dom";
import type { Comment } from "../../schema/feedback.ts";
import {
  replacedLines,
  type SuggestionProblem,
  suggestionParts,
} from "../../review/suggestion.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Marker } from "./Diff.tsx";
import type { InlineComment } from "./diff-model.ts";
import {
  insertSuggestion,
  type Replaced,
  type ReplacedLines,
  suggestionRows,
} from "./suggest.ts";

const OP_KIND = { " ": "context", "-": "del", "+": "add" } as const;

const OP_TONE = {
  " ": "",
  "-": "bg-diff-deletion",
  "+": "bg-diff-addition",
} as const;

const NUMBER = "w-px px-2 text-right align-top whitespace-nowrap text-muted";

/** The diff of the lines a suggestion replaces against the lines it proposes, numbered before and after. */
const SuggestionDiff = ({
  replaced,
  proposed,
  caption,
}: {
  readonly replaced: ReplacedLines;
  readonly proposed: ReadonlyArray<string>;
  readonly caption: string;
}) => {
  const rows = suggestionRows(replaced.lines, proposed, replaced.first);
  return (
    <figure
      data-suggestion
      className="mt-2 overflow-hidden rounded-control border border-separator text-ink"
    >
      <figcaption className="border-b border-separator bg-surface px-3 py-1 text-small font-semibold">
        {caption}
      </figcaption>
      <div className="overflow-x-auto bg-code">
        <table className="w-full border-collapse font-mono text-technical leading-6">
          <thead className="sr-only">
            <tr>
              <th>Line now</th>
              <th>Line after</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, at) => (
              <tr key={at} data-op={row.kind} className={OP_TONE[row.kind]}>
                <td className={NUMBER}>{row.before ?? ""}</td>
                <td className={NUMBER}>{row.after ?? ""}</td>
                <td className="pr-3 whitespace-pre">
                  <Marker kind={OP_KIND[row.kind]} />
                  {row.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
};

const PROBLEM: Readonly<Record<SuggestionProblem, string>> = {
  unclosed:
    "The suggestion block has no closing fence, so the agents read it as text.",
  several:
    "A comment holds one suggestion block; with several, the agents read them as text.",
  not_contiguous:
    "These lines skip the hidden lines between two hunks, so the agents read the suggestion as text. Comment on one hunk's lines to suggest a change.",
};

const Problem = ({ problem }: { readonly problem: SuggestionProblem }) => (
  <p data-suggestion-problem={problem} className="mt-2 text-small text-warning">
    {PROBLEM[problem]}
  </p>
);

/** Under a box being written: the diff its suggestion proposes, or why its block is not one. */
export const SuggestionPreview = ({
  body,
  replaced,
}: {
  readonly body: string;
  readonly replaced: Replaced | undefined;
}) => {
  const parts = suggestionParts(body);
  switch (parts.kind) {
    case "text":
      return null;
    case "malformed":
      return <Problem problem={parts.problem} />;
    case "suggestion":
      if (replaced === undefined) return null;
      switch (replaced.kind) {
        case "not_contiguous":
          return <Problem problem="not_contiguous" />;
        case "lines":
          return (
            <SuggestionDiff
              replaced={replaced}
              proposed={parts.lines}
              caption="Suggested change · preview"
            />
          );
      }
  }
};

/**
 * Puts a suggestion block of the lines in the box, in place of what is selected in it, and the caret at the end of
 * the block's last line. `onBody` sets the box's text; the caret moves once the box shows it.
 */
export const SuggestButton = ({
  area,
  replaced,
  onBody,
  disabled,
}: {
  readonly area: React.RefObject<HTMLTextAreaElement | null>;
  readonly replaced: ReplacedLines;
  readonly onBody: (body: string) => void;
  readonly disabled?: boolean;
}) => (
  <Button
    size="sm"
    variant="quiet"
    data-suggest
    disabled={disabled}
    title="Propose new text for these lines"
    onClick={() => {
      const box = area.current;
      if (box === null) return;
      const { text, caret } = insertSuggestion({
        text: box.value,
        start: box.selectionStart,
        end: box.selectionEnd,
        lines: replaced.lines,
      });
      flushSync(() => onBody(text));
      box.focus();
      box.setSelectionRange(caret, caret);
    }}
  >
    <FileDiff aria-hidden="true" className="size-3.5" />
    Suggest change
  </Button>
);

/** The lines a sent inline comment's suggestion replaces: those it was written on, as the reviewer saw them. */
export const replacedBy = (comment: InlineComment): Replaced => {
  const lines = replacedLines(comment.anchor);
  return lines === undefined
    ? { kind: "not_contiguous" }
    : {
        kind: "lines",
        side: comment.anchor.side,
        first: comment.anchor.start_line,
        lines,
      };
};

const Text = ({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) =>
  text.trim() === "" ? null : (
    <p
      className={cn("mt-1 whitespace-pre-wrap break-words text-ink", className)}
    >
      {text}
    </p>
  );

/**
 * A comment's body: its text, with a suggestion of an inline comment shown as its diff between the text around it. A
 * general comment, which is on no lines, keeps its block as text.
 */
export const CommentBody = ({ comment }: { readonly comment: Comment }) => {
  if (comment.kind !== "inline") return <Text text={comment.body} />;
  const parts = suggestionParts(comment.body);
  switch (parts.kind) {
    case "text":
      return <Text text={parts.text} />;
    case "malformed":
      return (
        <>
          <Text text={parts.text} />
          <Problem problem={parts.problem} />
        </>
      );
    case "suggestion": {
      const replaced = replacedBy(comment);
      switch (replaced.kind) {
        case "not_contiguous":
          return (
            <>
              <Text text={comment.body} />
              <Problem problem="not_contiguous" />
            </>
          );
        case "lines":
          return (
            <>
              <Text text={parts.before} />
              <SuggestionDiff
                replaced={replaced}
                proposed={parts.lines}
                caption="Suggested change"
              />
              <Text text={parts.after} className="mt-2" />
            </>
          );
      }
    }
  }
};
