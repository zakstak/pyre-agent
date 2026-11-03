/**
 * A file's patch as a table, unified or split, with the comment threads under the rows they end on, the tour's notes,
 * the unchanged lines between hunks behind a control, and the composer under the rows the reviewer selects. In the
 * source view a note shows only when the reviewer presses its letter on the row.
 *
 * Every line a reviewer can select is a unit: a row of the patch or an unchanged line between hunks, drawn as a table
 * row in the unified layout and as one half of a row in the split layout. Dragging the line numbers selects units; the
 * + button selects one, and with Shift extends the open composer's range. A selection of rows only is rows of the
 * patch; one that takes in an unchanged line is new-side lines of the file's text.
 *
 * From the keyboard, the + buttons are the line cursor: arrows move it, Shift with an arrow selects lines from it, and
 * Enter or C opens the composer on the selection. Only the cursor's button is in the tab order.
 */
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Equal } from "effect";
import { Atom } from "effect/reactivity";
import { FoldVertical, UnfoldVertical } from "lucide-react";
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import { type Row, whitespaceOnly } from "../../review/patch.ts";
import type { ReviewId } from "../../schema/primitives.ts";
import { lineRange } from "../names.ts";
import { announce } from "../ui/announce.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Inline, Lead } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { useAct, usePage } from "./act.ts";
import { Composer, openDraft } from "./Composer.tsx";
import {
  changeable,
  type GapPart,
  gapLabel,
  type GapLine,
  gapStage,
  heldLines,
  holdsLines,
  inSpan,
  type InlineComment,
  lastUnit,
  layoutDiff,
  nextStage,
  onVersion,
  pairRows,
  parseUnit,
  readingOrder,
  type Segment,
  selectionOf,
  type Span,
  spanEnds,
  spanOf,
  spanOfSelection,
  type Unit,
  unitKey,
} from "./diff-model.ts";
import { lineCommand, stepFrom } from "./keys.ts";
import { replacedSelection } from "./suggest.ts";
import { ThreadView } from "./Thread.tsx";
import {
  type Draft,
  draftsAtom,
  flashAtom,
  gapAtom,
  openNotesAtom,
  reattachAtom,
  whitespaceAtom,
} from "./ui.ts";
import type { FileModel, InlineNote } from "./view.ts";

/** Units of one file from where a selection started to where it is now. */
interface Reach {
  readonly path: string;
  readonly from: Unit;
  readonly to: Unit;
}

/**
 * A drag over the line numbers of one file, from the unit it started on to the unit under the pointer. With Shift, it
 * keeps the lines of the open composer too, so a Shift-click extends them.
 */
const dragAtom = Atom.make<
  (Reach & { readonly keep: ReadonlyArray<Unit> }) | undefined
>(undefined).pipe(Atom.keepAlive);

/**
 * Lines selected from the keyboard in one file of a review, from the line Shift and an arrow started on to the line
 * cursor. Enter or C opens the composer on them; a plain arrow or Esc lets them go.
 */
const markAtom = Atom.family((_review: ReviewId) =>
  Atom.make<Reach | undefined>(undefined).pipe(Atom.keepAlive),
);

/**
 * What one table reads of the page-wide drag, flash, and drafts. A table re-renders only when its own part changes,
 * so dragging or typing in one file leaves every other diff alone.
 */
const dragOf = Atom.family((path: string) =>
  Atom.map(dragAtom, (drag) => (drag?.path === path ? drag : undefined)).pipe(
    Atom.withEquality(Equal.equals),
  ),
);
const markOf = Atom.family(
  ({ review, path }: { readonly review: ReviewId; readonly path: string }) =>
    Atom.map(markAtom(review), (mark) =>
      mark?.path === path ? mark : undefined,
    ).pipe(Atom.withEquality(Equal.equals)),
);
const flashOf = Atom.family(
  ({ review, path }: { readonly review: ReviewId; readonly path: string }) =>
    Atom.map(flashAtom(review), (flash) =>
      flash?.path === path ? flash : undefined,
    ).pipe(Atom.withEquality(Equal.equals)),
);
const draftsOf = Atom.family(
  ({ review, path }: { readonly review: ReviewId; readonly path: string }) =>
    Atom.map(draftsAtom(review), (drafts) =>
      drafts.filter((draft) => draft.selection.path === path),
    ).pipe(Atom.withEquality(Equal.equals)),
);

/** The selected lines as the server will anchor them: old-side when only deleted lines are selected, else new-side. */
const lineLabel = (
  rows: ReadonlyArray<Row>,
  start: number,
  end: number,
): string => {
  const units = rows.filter(
    (row) => row.index >= start && row.index <= end && changeable(row),
  );
  const old =
    units.some((row) => row.kind === "del") &&
    !units.some((row) => row.kind === "add");
  const numbers = [
    ...new Set(
      units
        .map((row) => (old ? row.old : row.new))
        .filter((line) => line !== undefined),
    ),
  ];
  const first = numbers[0];
  const last = numbers.at(-1);
  if (first === undefined || last === undefined) return "the selected rows";
  return `${old ? "old " : ""}${lineRange(first, last, "line")}`;
};

/** The selected lines as words: rows as `lineLabel` names them, lines of the text by their numbers. */
const spanLabel = (rows: ReadonlyArray<Row>, span: Span): string =>
  span.kind === "rows"
    ? lineLabel(rows, span.start, span.end)
    : lineRange(span.start, span.end, "line");

type Side = "old" | "new" | "unified";

/** The ID of a unit's + button, where focus returns when its composer closes. */
const plusId = (table: string, unit: Unit, side: Side) =>
  `${table}-plus-${unitKey(unit)}-${side}`;

/** The side of the split layout a unit's button is on, by default: a deletion's old half, else the new. */
const sideOf = (rows: ReadonlyArray<Row>, unit: Unit, split: boolean): Side =>
  !split
    ? "unified"
    : unit.kind === "row" && rows[unit.index]?.kind === "del"
      ? "old"
      : "new";

const ROW_TONE: Readonly<Record<Row["kind"], string>> = {
  add: "bg-diff-addition",
  del: "bg-diff-deletion",
  context: "",
  hunk: "bg-surface text-muted",
  meta: "bg-surface text-muted",
};

/** The marker alone carries a change's colour; the line numbers stay muted. */
const MARKER_TONE: Readonly<Record<Row["kind"], string>> = {
  add: "font-semibold text-success",
  del: "font-semibold text-danger",
  context: "",
  hunk: "",
  meta: "",
};

const MARKER: Readonly<Record<Row["kind"], string>> = {
  add: "+",
  del: "−",
  context: " ",
  hunk: "",
  meta: "",
};

/** What the marker means, for a reader who hears the table instead of seeing its colours. */
const SPOKEN: Readonly<Record<Row["kind"], string>> = {
  add: "Added",
  del: "Deleted",
  context: "",
  hunk: "",
  meta: "",
};

export const Marker = ({ kind }: { readonly kind: Row["kind"] }) => (
  <>
    <span
      aria-hidden="true"
      className={cn("inline-block w-[1em] text-center", MARKER_TONE[kind])}
    >
      {MARKER[kind]}
    </span>
    {SPOKEN[kind] === "" ? null : (
      <span className="sr-only">{SPOKEN[kind]}</span>
    )}
  </>
);

const ROW_BODY = "sticky left-0 box-border max-w-[100cqi] px-3 py-1.5 pl-11";

const UNDER =
  "bg-surface p-0 font-sans text-small leading-[1.45] whitespace-normal";

const NOTE_MARKER =
  "mr-0.5 inline-grid h-4.5 min-w-4.5 place-items-center rounded-full border border-current px-0.5 align-[0.125rem] font-mono text-xs leading-none font-bold text-accent max-md:hidden";

/**
 * The letters of the notes on a row. Where notes show on demand, it is the button that shows and hides them; pressing
 * it starts no selection.
 */
const NoteMarker = ({
  table,
  index,
}: {
  readonly table: TableContext;
  readonly index: number;
}) => {
  const notes = table.notesAt.get(index);
  if (notes === undefined || notes.length === 0) return null;
  const letters = notes.map((note) => note.letter).join("");
  if (table.openNotes === undefined)
    return (
      <span aria-hidden="true" className={NOTE_MARKER}>
        {letters}
      </span>
    );
  const open = notes.every((note) => table.openNotes?.has(note.id) === true);
  return (
    <button
      type="button"
      data-note-marker
      aria-expanded={open}
      aria-controls={notes.map((note) => note.id).join(" ")}
      aria-label={`Note ${letters}`}
      title={notes.map((note) => note.title).join(" · ")}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => table.toggleNotes(notes, !open)}
      className={cn(
        NOTE_MARKER,
        "cursor-pointer",
        open ? "border-accent bg-accent text-on-accent" : "hover:bg-subtle",
      )}
    >
      {letters}
    </button>
  );
};

const NoteRow = ({
  note,
  columns,
}: {
  readonly note: InlineNote;
  readonly columns: number;
}) => (
  <tr id={note.id} data-note className="scroll-my-(--scroll-top)">
    <td colSpan={columns} className={cn(UNDER, "border-l-2 border-accent")}>
      <div className={ROW_BODY}>
        <span className="sr-only">Note </span>
        <span className="mr-2 inline-grid size-4.5 place-items-center rounded-full bg-accent align-[0.0625rem] font-mono text-xs leading-none font-bold text-on-accent">
          {note.letter}
        </span>
        {note.stop === undefined ? null : (
          <span className="text-muted">Stop {note.stop} · </span>
        )}
        <strong className="font-semibold">
          <Lead title={note.title} />
        </strong>{" "}
        {note.body === "" ? null : <Inline text={note.body} />}
      </div>
    </td>
  </tr>
);

interface TableContext {
  readonly model: FileModel;
  readonly id: string;
  readonly rows: ReadonlyArray<Row>;
  readonly split: boolean;
  readonly columns: number;
  /** Whether units take selections: a writable review, not a read-only patch. */
  readonly selectable: boolean;
  /** Whether unchanged lines take selections too: the page has the digest of the file's text. */
  readonly linesSelectable: boolean;
  readonly reattaching: boolean;
  readonly selected: Span | undefined;
  readonly flash: { readonly start: number; readonly end: number } | undefined;
  /** Rows and unchanged lines a thread sits on. */
  readonly commentedRows: ReadonlySet<number>;
  readonly commentedLines: ReadonlySet<number>;
  /** Rows whose change is whitespace only, when the reviewer hides such changes; else none. */
  readonly quiet: ReadonlySet<number>;
  /** Hunk headers a gap's control shows instead of a row of their own. */
  readonly absorbed: ReadonlySet<number>;
  readonly notesAt: ReadonlyMap<number, ReadonlyArray<InlineNote>>;
  /** Where notes show only on demand, the IDs of those the reviewer opened; undefined where every note shows. */
  readonly openNotes: ReadonlySet<string> | undefined;
  readonly toggleNotes: (
    notes: ReadonlyArray<InlineNote>,
    open: boolean,
  ) => void;
  /** The threads by the key of the unit they end on. */
  readonly threadsAt: ReadonlyMap<string, ReadonlyArray<InlineComment>>;
  readonly drafts: ReadonlyArray<Draft>;
  /** The ID of the + button in the tab order: the line cursor's, once a line had focus. */
  readonly cursor: string | undefined;
  readonly select: (
    unit: Unit,
    event: React.MouseEvent | React.KeyboardEvent,
    opener: string,
  ) => void;
  readonly startDrag: (unit: Unit, event: React.MouseEvent) => void;
  readonly hover: (unit: Unit) => void;
}

const rowUnit = (row: Row): Unit => ({ kind: "row", index: row.index });

/** Whether the selection covers a unit; `data-selected` says so to tests and styles. */
const isSelected = (table: TableContext, unit: Unit) =>
  table.selected !== undefined && inSpan(table.rows, table.selected, unit);

const lit = (table: TableContext, unit: Unit) =>
  isSelected(table, unit)
    ? "!bg-selection"
    : unit.kind === "row" &&
        table.flash !== undefined &&
        unit.index >= table.flash.start &&
        unit.index <= table.flash.end
      ? "!bg-highlight"
      : undefined;

const isCommented = (table: TableContext, unit: Unit) =>
  unit.kind === "row"
    ? table.commentedRows.has(unit.index)
    : table.commentedLines.has(unit.line);

/** Whether a row holds something that must not vanish: a thread, a note, a draft, or a flash. */
const anchored = (table: TableContext, index: number) =>
  table.commentedRows.has(index) ||
  table.notesAt.has(index) ||
  table.drafts.some((draft) =>
    inSpan(table.rows, spanOfSelection(draft.selection), {
      kind: "row",
      index,
    }),
  ) ||
  (table.flash !== undefined &&
    index >= table.flash.start &&
    index <= table.flash.end);

/**
 * How a row shows. A whitespace-only change the reviewer hides shows as unchanged: its addition always, its deletion
 * in the split layout or when something is anchored on it as it is, and otherwise not at all.
 */
const look = (table: TableContext, row: Row): Row["kind"] | "hidden" => {
  if (!table.quiet.has(row.index)) return row.kind;
  if (row.kind === "add") return "context";
  if (anchored(table, row.index)) return row.kind;
  return table.split ? "context" : "hidden";
};

/** The line cursor shows on the unit whose + button has keyboard focus: a frame inside the line. */
const CURSOR =
  "has-[[data-add-comment]:focus-visible]:outline-2 has-[[data-add-comment]:focus-visible]:-outline-offset-2 has-[[data-add-comment]:focus-visible]:outline-focus";

/**
 * A unit's + button, which is also the line cursor. Its description is the line's code, so moving the cursor reads
 * the line.
 */
const Plus = ({
  table,
  unit,
  line,
  side,
}: {
  readonly table: TableContext;
  readonly unit: Unit;
  /** The line number it names: new-side, unless the unit is a deletion. */
  readonly line: number | undefined;
  readonly side: Side;
}) => {
  const id = plusId(table.id, unit, side);
  return (
    <button
      type="button"
      id={id}
      tabIndex={table.cursor === id ? 0 : -1}
      title="Comment on this line"
      aria-label={`Comment on line ${line}`}
      aria-describedby={`${id}-code`}
      data-add-comment
      onClick={(event) => {
        // The mouse goes through the drag; a click with no pointer is Enter or Space.
        if (event.detail === 0) table.select(unit, event, id);
      }}
      className={cn(
        "absolute top-0 left-0.5 z-[1] inline-grid size-6 max-md:left-0 place-items-center rounded-sm bg-accent font-sans text-sm leading-none font-bold text-on-accent",
        "opacity-0 group-hover/unit:opacity-100 focus-visible:opacity-100",
        table.reattaching && "opacity-100",
      )}
    >
      +
    </button>
  );
};

/** What a selectable unit carries: its key, its new-side line, its selection, and the drag passing over it. */
const unitProps = (
  table: TableContext,
  unit: Unit,
  line: number | undefined,
) => ({
  "data-unit": unitKey(unit),
  "data-selectable": "",
  "data-new": line ?? "",
  "data-selected": isSelected(table, unit) ? "" : undefined,
  onMouseEnter: () => table.hover(unit),
});

const rowProps = (table: TableContext, row: Row) =>
  table.selectable && changeable(row)
    ? { "data-row": row.index, ...unitProps(table, rowUnit(row), row.new) }
    : { "data-row": row.index };

interface GutterProps {
  readonly onMouseDown?: (event: React.MouseEvent) => void;
  readonly className?: string;
}

/** A selectable unit's line numbers and marker: a drag starts there. Nothing for any other. */
const gutterProps = (
  table: TableContext,
  unit: Unit,
  selectable: boolean,
): GutterProps =>
  selectable
    ? {
        onMouseDown: (event) => table.startDrag(unit, event),
        className: table.reattaching ? "cursor-crosshair" : "cursor-pointer",
      }
    : {};

const rowGutterProps = (table: TableContext, row: Row): GutterProps =>
  gutterProps(table, rowUnit(row), table.selectable && changeable(row));

/** Notes on the rows, then the threads that end there, then the composer anchored there. */
const Extras = ({
  table,
  units,
}: {
  readonly table: TableContext;
  readonly units: ReadonlyArray<Unit>;
}) => {
  const keys = [...new Set(units.map(unitKey))];
  const notes = [
    ...new Set(
      units.flatMap((unit) => (unit.kind === "row" ? [unit.index] : [])),
    ),
  ]
    .flatMap((index) => table.notesAt.get(index) ?? [])
    .filter(
      (note) => table.openNotes === undefined || table.openNotes.has(note.id),
    );
  const placed = keys.flatMap((key) => table.threadsAt.get(key) ?? []);
  const drafts = table.drafts.flatMap((draft) => {
    const span = spanOfSelection(draft.selection);
    return keys.includes(unitKey(lastUnit(table.rows, span)))
      ? [{ draft, span }]
      : [];
  });
  return (
    <>
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} columns={table.columns} />
      ))}
      {placed.length === 0 ? null : (
        <tr>
          <td colSpan={table.columns} className={UNDER}>
            <div className={cn(ROW_BODY, "py-1")}>
              {placed.map((comment) => (
                <ThreadView key={comment.id} comment={comment} />
              ))}
            </div>
          </td>
        </tr>
      )}
      {drafts.map(({ draft, span }) => (
        <tr key={draft.id} data-composer>
          <td colSpan={table.columns} className={UNDER}>
            <div className={cn(ROW_BODY, "pt-2.5 pb-3")}>
              <Composer
                draft={draft}
                table={table.id}
                range={spanLabel(table.rows, span)}
                replaced={replacedSelection(
                  draft.selection,
                  table.rows,
                  table.model.file.new_content,
                )}
              />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
};

/**
 * Both line numbers in one gutter cell; a narrow page shows one, the old for a deletion and the new otherwise, in a
 * column no wider than the + button that covers it.
 */
const LineNumbers = ({
  old,
  fresh,
  deleted = false,
}: {
  readonly old: number | undefined;
  readonly fresh: number | undefined;
  readonly deleted?: boolean;
}) => (
  <>
    <span
      data-ln="old"
      className={cn(
        "inline-block min-w-9 pl-1 max-md:min-w-[2ch] max-md:pl-0",
        !deleted && "max-md:hidden",
      )}
    >
      {old ?? ""}
    </span>
    <span
      data-ln="new"
      className={cn(
        "inline-block min-w-9 pl-1 max-md:min-w-[2ch] max-md:pl-0",
        deleted && "max-md:hidden",
      )}
    >
      {fresh ?? ""}
    </span>
  </>
);

/**
 * The gutters: line numbers, then the change marker. In the unified layout each is a cell, and both narrow on a
 * narrow page; in the split layout each is a box at the start of its half.
 */
const NUMBER_GUTTER =
  "w-px pr-1 pl-3 text-right whitespace-nowrap text-muted max-md:pr-0.5 max-md:pl-0";
const MARKER_GUTTER =
  "w-px min-w-7 px-1 text-right whitespace-nowrap text-muted max-md:min-w-0 max-md:px-0 max-md:text-center";
const HALF_NUMBER_GUTTER =
  "inline-block min-w-12 pr-1 pl-3 text-right text-muted";
const HALF_MARKER_GUTTER = "inline-block min-w-6 px-1 text-right text-muted";
const SOURCE = "pr-4 whitespace-pre max-md:pr-3 max-md:pl-1";
/** A split half keeps a long line to itself: the table is fixed, so it clips with an ellipsis instead of spilling. */
const SPLIT_UNCHANGED =
  "w-1/2 overflow-hidden pr-3 text-ellipsis whitespace-pre";

/** The source of a row: code in ink, a hunk header or meta row in the row's muted tone. `id` names it for its + button. */
const Source = ({
  row,
  id,
}: {
  readonly row: Row;
  readonly id?: string | undefined;
}) => (
  <code
    id={id}
    className={
      row.kind === "hunk" || row.kind === "meta" ? "text-technical" : "text-ink"
    }
  >
    {row.content}
  </code>
);

/** The ID of the code a unit's + button reads as its description. */
const codeId = (table: TableContext, unit: Unit, side: Side) =>
  `${plusId(table.id, unit, side)}-code`;

const UnifiedRow = ({
  table,
  row,
}: {
  readonly table: TableContext;
  readonly row: Row;
}) => {
  const unit = rowUnit(row);
  const selectable = table.selectable && changeable(row);
  const shown = look(table, row);
  if (shown === "hidden") return null;
  return (
    <>
      <tr
        id={`${table.id}-r${row.index}`}
        {...rowProps(table, row)}
        data-kind={row.kind}
        data-whitespace={shown === row.kind ? undefined : "hidden"}
        className={cn(
          "group/unit scroll-my-(--scroll-top)",
          ROW_TONE[shown],
          isCommented(table, unit) && "shadow-mark",
          selectable && CURSOR,
          lit(table, unit),
        )}
      >
        <td
          {...rowGutterProps(table, row)}
          className={cn(
            "relative select-none",
            NUMBER_GUTTER,
            rowGutterProps(table, row).className,
          )}
        >
          {selectable ? (
            <Plus
              table={table}
              unit={unit}
              line={row.new ?? row.old}
              side="unified"
            />
          ) : null}
          <LineNumbers
            old={row.old}
            fresh={row.new}
            deleted={row.kind === "del"}
          />
        </td>
        <td
          {...rowGutterProps(table, row)}
          className={cn(
            "relative select-none",
            MARKER_GUTTER,
            rowGutterProps(table, row).className,
          )}
        >
          <NoteMarker table={table} index={row.index} />
          <Marker kind={shown} />
        </td>
        <td className={SOURCE}>
          <Source
            row={row}
            id={selectable ? codeId(table, unit, "unified") : undefined}
          />
        </td>
      </tr>
      <Extras table={table} units={[unit]} />
    </>
  );
};

const Half = ({
  table,
  row,
  side,
}: {
  readonly table: TableContext;
  readonly row: Row | undefined;
  readonly side: "old" | "new";
}) => {
  if (row === undefined)
    return <td data-half={side} className="w-1/2 bg-surface" />;
  const unit = rowUnit(row);
  const selectable = table.selectable && changeable(row);
  // A half is never hidden: the split layout shows a whitespace-only deletion as the old side of an unchanged pair.
  const shown = look(table, row) === "context" ? "context" : row.kind;
  return (
    <td
      {...rowProps(table, row)}
      data-half={side}
      data-kind={row.kind}
      data-whitespace={shown === row.kind ? undefined : "hidden"}
      className={cn(
        "group/unit relative w-1/2 scroll-my-(--scroll-top) overflow-hidden pr-3 align-top text-ellipsis whitespace-pre",
        side === "new" && "border-l border-separator",
        ROW_TONE[shown],
        isCommented(table, unit) && "shadow-mark",
        selectable && CURSOR,
        lit(table, unit),
      )}
    >
      <span
        {...rowGutterProps(table, row)}
        className={cn(
          "relative select-none",
          HALF_NUMBER_GUTTER,
          rowGutterProps(table, row).className,
        )}
      >
        {selectable ? (
          <Plus
            table={table}
            unit={unit}
            line={row.new ?? row.old}
            side={side}
          />
        ) : null}
        {row[side] ?? ""}
      </span>
      <span
        {...rowGutterProps(table, row)}
        className={cn(
          "select-none",
          HALF_MARKER_GUTTER,
          rowGutterProps(table, row).className,
        )}
      >
        {side === "new" || row.kind === "del" ? (
          <NoteMarker table={table} index={row.index} />
        ) : null}
        <Marker kind={shown} />
      </span>
      <Source
        row={row}
        id={selectable ? codeId(table, unit, side) : undefined}
      />
    </td>
  );
};

const RowsOf = ({
  table,
  rows: all,
}: {
  readonly table: TableContext;
  readonly rows: ReadonlyArray<Row>;
}) => {
  const rows = all.filter((row) => !table.absorbed.has(row.index));
  if (!table.split)
    return rows.map((row) => (
      <UnifiedRow key={row.index} table={table} row={row} />
    ));
  return pairRows(rows).map((pair) => {
    if (pair.whole !== undefined)
      return (
        <Fragment key={`w${pair.whole.index}`}>
          <tr
            data-row={pair.whole.index}
            data-kind={pair.whole.kind}
            className={ROW_TONE[pair.whole.kind]}
          >
            <td colSpan={2} className="px-3 whitespace-pre">
              <code className="text-technical">{pair.whole.content}</code>
            </td>
          </tr>
          <Extras table={table} units={[rowUnit(pair.whole)]} />
        </Fragment>
      );
    const halves = [pair.old, pair.new].filter(
      (row): row is Row => row !== undefined,
    );
    const first = Math.min(...halves.map((row) => row.index));
    return (
      <Fragment key={`p${first}`}>
        <tr id={`${table.id}-p${first}`} className="scroll-my-(--scroll-top)">
          <Half table={table} row={pair.old} side="old" />
          <Half table={table} row={pair.new} side="new" />
        </tr>
        <Extras table={table} units={halves.map(rowUnit)} />
      </Fragment>
    );
  });
};

/**
 * One half of an unchanged line in the split layout: both halves show the same line of the text, and either selects
 * it.
 */
const UnchangedHalf = ({
  table,
  line,
  side,
}: {
  readonly table: TableContext;
  readonly line: GapLine;
  readonly side: "old" | "new";
}) => {
  const unit: Unit = { kind: "line", line: line.new };
  const selectable = table.linesSelectable;
  return (
    <td
      {...(selectable ? unitProps(table, unit, line.new) : {})}
      data-half={side}
      className={cn(
        SPLIT_UNCHANGED,
        "group/unit relative scroll-my-(--scroll-top) align-top",
        side === "new" && "border-l border-separator",
        isCommented(table, unit) && "shadow-mark",
        selectable && CURSOR,
        lit(table, unit),
      )}
    >
      <span
        {...gutterProps(table, unit, selectable)}
        className={cn(
          "relative select-none",
          HALF_NUMBER_GUTTER,
          gutterProps(table, unit, selectable).className,
        )}
      >
        {selectable ? (
          <Plus table={table} unit={unit} line={line.new} side={side} />
        ) : null}
        {line[side]}
      </span>
      <span className={HALF_MARKER_GUTTER} />
      <code
        id={selectable ? codeId(table, unit, side) : undefined}
        className="text-ink"
      >
        {line.text}
      </code>
    </td>
  );
};

/**
 * An unchanged line between hunks. Where the page has the digest of the file's text, it takes comments as a patch
 * row does: they anchor to its new-side line number and its text.
 */
const UnchangedLine = ({
  table,
  line,
}: {
  readonly table: TableContext;
  readonly line: GapLine;
}) => {
  const unit: Unit = { kind: "line", line: line.new };
  const selectable = table.linesSelectable;
  if (table.split)
    return (
      <>
        <tr
          id={`${table.id}-l${line.new}`}
          data-unchanged
          className="scroll-my-(--scroll-top) text-muted"
        >
          <UnchangedHalf table={table} line={line} side="old" />
          <UnchangedHalf table={table} line={line} side="new" />
        </tr>
        <Extras table={table} units={[unit]} />
      </>
    );
  return (
    <>
      <tr
        id={`${table.id}-l${line.new}`}
        data-unchanged
        {...(selectable ? unitProps(table, unit, line.new) : {})}
        className={cn(
          "group/unit scroll-my-(--scroll-top) text-muted",
          isCommented(table, unit) && "shadow-mark",
          selectable && CURSOR,
          lit(table, unit),
        )}
      >
        <td
          {...gutterProps(table, unit, selectable)}
          className={cn(
            "relative select-none",
            NUMBER_GUTTER,
            gutterProps(table, unit, selectable).className,
          )}
        >
          {selectable ? (
            <Plus table={table} unit={unit} line={line.new} side="unified" />
          ) : null}
          <LineNumbers old={line.old} fresh={line.new} />
        </td>
        <td
          {...gutterProps(table, unit, selectable)}
          className={cn(
            "select-none",
            MARKER_GUTTER,
            gutterProps(table, unit, selectable).className,
          )}
        />
        <td className={SOURCE}>
          <code
            id={selectable ? codeId(table, unit, "unified") : undefined}
            className="text-ink"
          >
            {line.text}
          </code>
        </td>
      </tr>
      <Extras table={table} units={[unit]} />
    </>
  );
};

const GapPartRows = ({
  table,
  part,
}: {
  readonly table: TableContext;
  readonly part: GapPart;
}) =>
  part.kind === "folded" ? (
    <RowsOf table={table} rows={part.rows} />
  ) : (
    part.lines.map((line) => (
      <UnchangedLine key={line.new} table={table} line={line} />
    ))
  );

/**
 * One control for hidden lines next to each other: the folded rows first, then the unchanged lines, then none. It sits
 * in the line-number gutter, and beside it the header of the hunk that follows, which then has no row of its own. A
 * gap whose unchanged lines hold a thread or a comment being written shows open until the reviewer chooses.
 */
const GapGroup = ({
  table,
  gap,
  header,
  held,
}: {
  readonly table: TableContext;
  readonly gap: Extract<Segment, { kind: "gap" }>;
  readonly header: Row | undefined;
  readonly held: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
}) => {
  const [stage, setStage] = useAtom(
    gapAtom({
      path: table.model.file.path,
      digest: table.model.digest,
      gap: gap.key,
    }),
  );
  const shown = gapStage(stage, gap, holdsLines(gap, held));
  const label = gapLabel(shown, gap);
  const Icon = shown === 2 ? FoldVertical : UnfoldVertical;
  const button = (
    <button
      type="button"
      data-expand={gap.key}
      data-folded={gap.folded}
      data-context={gap.context}
      aria-expanded={shown === 2}
      aria-label={label}
      title={label}
      onClick={() => setStage(nextStage(shown, gap))}
      className={cn(
        TOUCH_TARGET,
        "inline-grid h-6 w-full place-items-center align-top text-muted hover:text-ink",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </button>
  );
  const words =
    header === undefined ? (
      <span className="font-sans text-small text-muted">{label}</span>
    ) : (
      <code className="text-technical text-muted">{header.content}</code>
    );
  // The header's row ID stays on the row that shows it, so links to the hunk still land.
  const anchor =
    header === undefined
      ? {}
      : { id: `${table.id}-r${header.index}`, "data-row": header.index };
  const toggle = (
    <tbody data-gap={gap.key}>
      {table.split ? (
        <tr {...anchor} className="h-6 scroll-my-(--scroll-top) bg-surface">
          <td colSpan={2} className="pr-3 whitespace-pre">
            <span className={cn(HALF_NUMBER_GUTTER, "align-top")}>
              {button}
            </span>
            <span className={HALF_MARKER_GUTTER} />
            {words}
          </td>
        </tr>
      ) : (
        <tr {...anchor} className="h-6 scroll-my-(--scroll-top) bg-surface">
          <td className={NUMBER_GUTTER}>{button}</td>
          <td className={MARKER_GUTTER} />
          <td className={SOURCE}>{words}</td>
        </tr>
      )}
      {header === undefined ? null : (
        <Extras table={table} units={[rowUnit(header)]} />
      )}
    </tbody>
  );
  return gap.parts.map((part, at) => {
    const open = shown === 2 || (shown === 1 && part.kind === "folded");
    return (
      <Fragment key={at}>
        {at === gap.toggleAt ? toggle : null}
        {open ? (
          <tbody
            data-gap-lines={part.kind === "folded" ? "folded" : "unchanged"}
          >
            <GapPartRows table={table} part={part} />
          </tbody>
        ) : null}
      </Fragment>
    );
  });
};

/** A + button and the unit it selects, when the element is one. */
const lineButtonOf = (
  element: EventTarget,
): { readonly button: HTMLElement; readonly unit: Unit } | undefined => {
  if (
    !(element instanceof HTMLElement) ||
    !element.matches("[data-add-comment]")
  )
    return undefined;
  const key = element.closest<HTMLElement>("[data-unit]")?.dataset.unit;
  const unit = key === undefined ? undefined : parseUnit(key);
  return unit === undefined ? undefined : { button: element, unit };
};

/** The + buttons of a table, each with the unit it selects, in the order the page lists them. */
const lineButtons = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-add-comment]")].flatMap((element) => {
    const line = lineButtonOf(element);
    return line === undefined ? [] : [line];
  });

/**
 * Selecting lines of one table: a drag over its line numbers, a + button, which with Shift extends the open composer's
 * range, or the keyboard's line cursor. A selection moves the comment being moved, or opens a composer on the lines.
 * `table` is the table's ID and `rows` its rows.
 */
const useSelection = (
  model: FileModel,
  table: string,
  rows: ReadonlyArray<Row>,
  split: boolean,
  readOnly: boolean,
) => {
  const registry = useContext(RegistryContext);
  const { id: review } = usePage();
  const act = useAct();
  const path = model.file.path;
  const drag = useAtomValue(dragOf(path));
  const mark = useAtomValue(markOf({ review, path }));

  const choose = async (span: Span, opener: string) => {
    const selection = selectionOf(
      { path, digest: model.digest, text: model.text },
      span,
    );
    if (selection === undefined) return;
    registry.set(markAtom(review), undefined);
    const moving = registry.get(reattachAtom(review));
    if (moving !== undefined) {
      registry.set(reattachAtom(review), undefined);
      const outcome = await act({
        kind: "reattach",
        comment: moving,
        selection,
      });
      if (outcome.ok) toast("The comment moved to the lines you chose.");
      return;
    }
    openDraft(registry, review, { selection, opener });
  };

  /** The composer open on this file's lines, which Shift extends. */
  const openComposer = () =>
    registry
      .get(draftsAtom(review))
      .find((draft) => !draft.submitting && draft.selection.path === path);

  /** The keyboard selection in this file, as its ends. */
  const marked = (): ReadonlyArray<Unit> => {
    const now = registry.get(markAtom(review));
    return now?.path === path ? [now.from, now.to] : [];
  };

  // A drag ends wherever the pointer is released. The read-only patch above the diff takes no selection.
  useEffect(() => {
    if (readOnly) return;
    const release = () => {
      const now = registry.get(dragAtom);
      if (now === undefined || now.path !== path) return;
      registry.set(dragAtom, undefined);
      const span = spanOf(rows, [now.from, now.to, ...now.keep]);
      const last = lastUnit(rows, span);
      void choose(span, plusId(table, last, sideOf(rows, last, split)));
    };
    document.addEventListener("mouseup", release);
    return () => document.removeEventListener("mouseup", release);
  });

  /** Moves the line cursor to the next or previous line the table shows, extending the selection with Shift. */
  const move = (
    container: HTMLElement,
    from: ReturnType<typeof lineButtonOf>,
    step: 1 | -1,
    extend: boolean,
  ): boolean => {
    const listed = lineButtons(container);
    const current = from?.unit;
    const order = readingOrder(listed.map((item) => item.unit)).map(unitKey);
    const next = stepFrom(
      order,
      current === undefined ? undefined : unitKey(current),
      step,
    );
    if (next === undefined) return false;
    const candidates = listed.filter((item) => unitKey(item.unit) === next);
    const half = from?.button.closest<HTMLElement>("[data-half]")?.dataset.half;
    const target =
      candidates.find(
        (item) =>
          item.button.closest<HTMLElement>("[data-half]")?.dataset.half ===
          half,
      ) ?? candidates.at(-1);
    if (target === undefined) return false;
    if (extend) {
      const anchor = marked()[0] ?? current ?? target.unit;
      registry.set(markAtom(review), { path, from: anchor, to: target.unit });
      announce(
        `Selected ${spanLabel(rows, spanOf(rows, [anchor, target.unit]))}.`,
      );
    } else if (marked().length > 0) registry.set(markAtom(review), undefined);
    target.button.closest("[data-unit]")?.scrollIntoView({ block: "nearest" });
    target.button.focus({ preventScroll: true });
    return true;
  };

  return {
    /** The lines the drag under way covers, or else those the keyboard selected. */
    reaching:
      drag !== undefined
        ? spanOf(rows, [drag.from, drag.to, ...drag.keep])
        : mark !== undefined
          ? spanOf(rows, [mark.from, mark.to])
          : undefined,
    select: (
      unit: Unit,
      event: React.MouseEvent | React.KeyboardEvent,
      opener: string,
    ) => {
      const open = openComposer();
      if (event.shiftKey && open !== undefined)
        void choose(
          spanOf(rows, [
            unit,
            ...spanEnds(spanOfSelection(open.selection)),
            ...marked(),
          ]),
          open.opener,
        );
      else void choose(spanOf(rows, [unit, ...marked()]), opener);
    },
    startDrag: (unit: Unit, event: React.MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const open = event.shiftKey ? openComposer() : undefined;
      registry.set(dragAtom, {
        path,
        from: unit,
        to: unit,
        keep:
          open === undefined ? [] : spanEnds(spanOfSelection(open.selection)),
      });
    },
    hover: (unit: Unit) => {
      const now = registry.get(dragAtom);
      if (
        now !== undefined &&
        now.path === path &&
        unitKey(now.to) !== unitKey(unit)
      )
        registry.set(dragAtom, { ...now, to: unit });
    },
    /**
     * The line keys, on the table's group: arrows from a line or from the group itself, and C or Esc on a line. Keys
     * from anything else in the table, such as a thread's buttons or a composer, are theirs.
     */
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (readOnly || event.defaultPrevented) return;
      const command = lineCommand(event);
      if (command === undefined) return;
      const line = lineButtonOf(event.target);
      if (line === undefined && event.target !== event.currentTarget) return;
      switch (command.kind) {
        case "move": {
          if (move(event.currentTarget, line, command.step, command.extend))
            return event.preventDefault();
          // Up from the first line goes back to the file's heading, where Down came in.
          const heading =
            line === undefined || command.step === 1 || command.extend
              ? null
              : event.currentTarget
                  .closest("article[data-path]")
                  ?.querySelector<HTMLElement>("h3");
          if (heading === null || heading === undefined) return;
          event.preventDefault();
          heading.focus();
          return;
        }
        case "comment": {
          if (line === undefined) return;
          event.preventDefault();
          void choose(spanOf(rows, [line.unit, ...marked()]), line.button.id);
          return;
        }
        case "clear":
          if (marked().length === 0) return;
          registry.set(markAtom(review), undefined);
          announce("Selection cleared.");
          return;
      }
    },
  };
};

/**
 * The diff table. `patch` overrides the file's patch for a read-only view, such as the changes between rounds: no
 * selection, no gaps, no threads or notes.
 */
export const DiffTable = ({
  model,
  split: wantSplit,
  patch,
}: {
  readonly model: FileModel;
  readonly split: boolean;
  readonly patch?: string;
}) => {
  const { id: review, page, view } = usePage();
  const [openNotes, setOpenNotes] = useAtom(openNotesAtom(review));
  const readOnly = patch !== undefined;
  const source = patch ?? model.file.patch ?? "";
  const split = wantSplit && !readOnly;
  const id = readOnly ? `f${model.index}-since` : `f${model.index}`;
  // A new snapshot rebuilds the file's model, but the patch and the rows it shows rarely change: lay out once per both.
  const shown = readOnly ? undefined : model.shown;
  const shownKey = shown
    ?.map((range) => `${range.start}-${range.end}`)
    .join(",");
  const content = readOnly ? undefined : model.file.new_content;
  const layout = useMemo(
    () => layoutDiff(source, { shown, content }),
    [source, shownKey, content],
  );
  const drafts = useAtomValue(
    draftsOf({ review, path: model.file.path }),
  ).filter((draft) => !readOnly && onVersion(draft.selection, model));
  const reattaching = useAtomValue(reattachAtom(review));
  const flash = useAtomValue(flashOf({ review, path: model.file.path }));
  const { reaching, select, startDrag, hover, onKeyDown } = useSelection(
    model,
    id,
    layout.rows,
    split,
    readOnly,
  );
  // The + button in the tab order: the one that last had focus, so Tab comes back to the line cursor.
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const editable = drafts.find((draft) => !draft.submitting);
  const whitespace = useAtomValue(whitespaceAtom);
  const quiet = useMemo(
    () =>
      whitespace === "hide" ? whitespaceOnly(layout.rows) : new Set<number>(),
    [layout, whitespace],
  );
  // A gap's control shows the header of the hunk right after it.
  const headers = useMemo(
    () =>
      layout.segments.map((segment, at) => {
        const next = layout.segments[at + 1];
        const first =
          segment.kind === "gap" && next?.kind === "rows"
            ? next.rows[0]
            : undefined;
        return first?.kind === "hunk" ? first : undefined;
      }),
    [layout],
  );
  const absorbed = useMemo(
    () =>
      new Set(
        headers.flatMap((header) =>
          header === undefined ? [] : [header.index],
        ),
      ),
    [headers],
  );
  const context = readOnly ? [] : model.context;
  const held = heldLines(
    context,
    drafts.map((draft) => draft.selection),
  );
  const contextSpans = context.map(
    (item): Span => ({
      kind: "lines",
      start: item.start_line,
      end: item.end_line,
    }),
  );
  const threadsAt = new Map<string, Array<InlineComment>>();
  const thread = (unit: Unit, comment: InlineComment) => {
    const key = unitKey(unit);
    threadsAt.set(key, [...(threadsAt.get(key) ?? []), comment]);
  };
  if (!readOnly) {
    for (const item of model.placed)
      thread({ kind: "row", index: item.end }, item.comment);
    context.forEach((item, at) => {
      const span = contextSpans[at];
      if (span !== undefined) thread(lastUnit(layout.rows, span), item.comment);
    });
  }

  const table: TableContext = {
    model,
    id,
    rows: layout.rows,
    split,
    columns: split ? 2 : 3,
    selectable: page.writable && !readOnly && model.digest !== undefined,
    linesSelectable:
      page.writable &&
      !readOnly &&
      model.digest !== undefined &&
      model.text !== undefined,
    reattaching: reattaching !== undefined,
    selected:
      reaching ??
      (editable === undefined
        ? undefined
        : spanOfSelection(editable.selection)),
    flash: readOnly ? undefined : flash,
    quiet,
    absorbed,
    // The threads' rows are rows of the file's own patch, not of a read-only one.
    commentedRows: new Set([
      ...(readOnly ? [] : model.placed).flatMap((item) =>
        Array.from(
          { length: item.end - item.start + 1 },
          (_, at) => item.start + at,
        ),
      ),
      ...layout.rows
        .filter((row) =>
          contextSpans.some((span) => inSpan(layout.rows, span, rowUnit(row))),
        )
        .map((row) => row.index),
    ]),
    commentedLines: new Set(
      context.flatMap((item) =>
        Array.from(
          { length: item.end_line - item.start_line + 1 },
          (_, at) => item.start_line + at,
        ),
      ),
    ),
    notesAt: readOnly ? new Map() : groupBy(model.notes, (note) => note.row),
    openNotes: view === "source" ? openNotes : undefined,
    toggleNotes: (notes, open) =>
      setOpenNotes((now) => {
        const next = new Set(now);
        for (const note of notes) {
          if (open) next.add(note.id);
          else next.delete(note.id);
        }
        return next;
      }),
    threadsAt,
    drafts,
    cursor,
    select,
    startDrag,
    hover,
  };

  return (
    <div
      role="group"
      aria-label={`Diff of ${model.file.path}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const line = lineButtonOf(event.target);
        if (line !== undefined) setCursor(line.button.id);
      }}
      className="@container overflow-x-auto bg-code focus-visible:-outline-offset-2"
    >
      <table
        data-path={model.file.path}
        data-patch={readOnly ? undefined : model.digest}
        data-table={id}
        data-layout={split ? "split" : "unified"}
        className={cn(
          "w-full border-collapse font-mono text-technical leading-6",
          split && "table-fixed",
        )}
      >
        <thead className="sr-only">
          {split ? (
            <tr>
              <th>Old</th>
              <th>New</th>
            </tr>
          ) : (
            <tr>
              <th>Line</th>
              <th>Change</th>
              <th>Source</th>
            </tr>
          )}
        </thead>
        {layout.segments.map((segment, at) =>
          segment.kind === "rows" ? (
            <tbody key={at}>
              <RowsOf table={table} rows={segment.rows} />
            </tbody>
          ) : (
            <GapGroup
              key={at}
              table={table}
              gap={segment}
              header={headers[at]}
              held={held}
            />
          ),
        )}
      </table>
    </div>
  );
};

const groupBy = <A,>(
  items: ReadonlyArray<A>,
  key: (item: A) => number,
): ReadonlyMap<number, ReadonlyArray<A>> => {
  const map = new Map<number, Array<A>>();
  for (const item of items)
    map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};
