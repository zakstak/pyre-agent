/**
 * A file's patch as a table, unified or split, with the comment threads under the rows they end on, the tour's notes,
 * the unchanged lines between hunks behind a control, and the composer under the rows the reviewer selects. In the
 * source view a note shows only when the reviewer presses its letter on the row.
 *
 * Every line a reviewer can select is a unit: a table row in the unified layout, one half of a row in the split
 * layout. Dragging the line numbers selects units; the + button selects one, and with Shift extends the open
 * composer's range.
 */
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Equal } from "effect";
import { Atom } from "effect/reactivity";
import { FoldVertical, UnfoldVertical } from "lucide-react";
import { Fragment, useContext, useEffect, useMemo } from "react";
import { type Row, whitespaceOnly } from "../../review/patch.ts";
import type { ReviewId } from "../../schema/primitives.ts";
import { lineRange } from "../names.ts";
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
  layoutDiff,
  nextStage,
  pairRows,
  type PlacedComment,
  type Segment,
} from "./diff-model.ts";
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

/** A drag over the line numbers of one file, from the row it started on to the row under the pointer. */
const dragAtom = Atom.make<
  | { readonly path: string; readonly from: number; readonly to: number }
  | undefined
>(undefined).pipe(Atom.keepAlive);

/**
 * What one table reads of the page-wide drag, flash, and drafts. A table re-renders only when its own part changes,
 * so dragging or typing in one file leaves every other diff alone.
 */
const dragOf = Atom.family((path: string) =>
  Atom.map(dragAtom, (drag) => (drag?.path === path ? drag : undefined)).pipe(
    Atom.withEquality(Equal.equals),
  ),
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
      drafts.filter((draft) => draft.path === path),
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

/** The ID of a unit's + button, where focus returns when its composer closes. */
const plusId = (table: string, row: number, side: "old" | "new" | "unified") =>
  `${table}-plus-${row}-${side}`;

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
  readonly reattaching: boolean;
  readonly selected:
    | { readonly start: number; readonly end: number }
    | undefined;
  readonly flash: { readonly start: number; readonly end: number } | undefined;
  readonly commented: ReadonlySet<number>;
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
  readonly threadsAt: ReadonlyMap<number, ReadonlyArray<PlacedComment>>;
  readonly drafts: ReadonlyArray<Draft>;
  readonly select: (
    row: Row,
    event: React.MouseEvent | React.KeyboardEvent,
    opener: string,
  ) => void;
  readonly startDrag: (row: Row, event: React.MouseEvent) => void;
  readonly hover: (row: Row) => void;
}

const lit = (table: TableContext, row: Row) =>
  table.selected !== undefined &&
  row.index >= table.selected.start &&
  row.index <= table.selected.end
    ? "!bg-selection"
    : table.flash !== undefined &&
        row.index >= table.flash.start &&
        row.index <= table.flash.end
      ? "!bg-highlight"
      : undefined;

/** Whether a row holds something that must not vanish: a thread, a note, a draft, or a flash. */
const anchored = (table: TableContext, index: number) =>
  table.commented.has(index) ||
  table.notesAt.has(index) ||
  table.drafts.some((draft) => index >= draft.start && index <= draft.end) ||
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

const Plus = ({
  table,
  row,
  side,
}: {
  readonly table: TableContext;
  readonly row: Row;
  readonly side: "old" | "new" | "unified";
}) => {
  const id = plusId(table.id, row.index, side);
  return (
    <button
      type="button"
      id={id}
      title="Comment on this line"
      aria-label={`Comment on line ${row.new ?? row.old}`}
      data-add-comment
      onClick={(event) => {
        // The mouse goes through the drag; a click with no pointer is Enter or Space.
        if (event.detail === 0) table.select(row, event, id);
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

const unitProps = (table: TableContext, row: Row) =>
  table.selectable && changeable(row)
    ? {
        "data-row": row.index,
        "data-selectable": "",
        "data-new": row.new ?? "",
        onMouseEnter: () => table.hover(row),
      }
    : { "data-row": row.index };

const gutterProps = (table: TableContext, row: Row) =>
  table.selectable && changeable(row)
    ? {
        onMouseDown: (event: React.MouseEvent) => table.startDrag(row, event),
        className: table.reattaching ? "cursor-crosshair" : "cursor-pointer",
      }
    : {};

/** Notes on the rows, then the threads that end there, then the composer anchored there. */
const Extras = ({
  table,
  indexes,
}: {
  readonly table: TableContext;
  readonly indexes: ReadonlyArray<number>;
}) => {
  const unique = [...new Set(indexes)];
  const notes = unique
    .flatMap((index) => table.notesAt.get(index) ?? [])
    .filter(
      (note) => table.openNotes === undefined || table.openNotes.has(note.id),
    );
  const placed = unique.flatMap((index) => table.threadsAt.get(index) ?? []);
  const drafts = table.drafts.filter((draft) => unique.includes(draft.end));
  return (
    <>
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} columns={table.columns} />
      ))}
      {placed.length === 0 ? null : (
        <tr>
          <td colSpan={table.columns} className={UNDER}>
            <div className={cn(ROW_BODY, "py-1")}>
              {placed.map((item) => (
                <ThreadView key={item.comment.id} comment={item.comment} />
              ))}
            </div>
          </td>
        </tr>
      )}
      {drafts.map((draft) => (
        <tr key={draft.id} data-composer>
          <td colSpan={table.columns} className={UNDER}>
            <div className={cn(ROW_BODY, "pt-2.5 pb-3")}>
              <Composer
                draft={draft}
                table={table.id}
                range={lineLabel(table.rows, draft.start, draft.end)}
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

/** The source of a row: code in ink, a hunk header or meta row in the row's muted tone. */
const Source = ({ row }: { readonly row: Row }) => (
  <code
    className={
      row.kind === "hunk" || row.kind === "meta" ? "text-technical" : "text-ink"
    }
  >
    {row.content}
  </code>
);

const UnifiedRow = ({
  table,
  row,
}: {
  readonly table: TableContext;
  readonly row: Row;
}) => {
  const unit = table.selectable && changeable(row);
  const shown = look(table, row);
  if (shown === "hidden") return null;
  return (
    <>
      <tr
        id={`${table.id}-r${row.index}`}
        {...unitProps(table, row)}
        data-kind={row.kind}
        data-whitespace={shown === row.kind ? undefined : "hidden"}
        className={cn(
          "group/unit scroll-my-(--scroll-top)",
          ROW_TONE[shown],
          table.commented.has(row.index) && "shadow-mark",
          lit(table, row),
        )}
      >
        <td
          {...gutterProps(table, row)}
          className={cn(
            "relative select-none",
            NUMBER_GUTTER,
            gutterProps(table, row).className,
          )}
        >
          {unit ? <Plus table={table} row={row} side="unified" /> : null}
          <LineNumbers
            old={row.old}
            fresh={row.new}
            deleted={row.kind === "del"}
          />
        </td>
        <td
          {...gutterProps(table, row)}
          className={cn(
            "relative select-none",
            MARKER_GUTTER,
            gutterProps(table, row).className,
          )}
        >
          <NoteMarker table={table} index={row.index} />
          <Marker kind={shown} />
        </td>
        <td className={SOURCE}>
          <Source row={row} />
        </td>
      </tr>
      <Extras table={table} indexes={[row.index]} />
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
  const unit = table.selectable && changeable(row);
  // A half is never hidden: the split layout shows a whitespace-only deletion as the old side of an unchanged pair.
  const shown = look(table, row) === "context" ? "context" : row.kind;
  return (
    <td
      {...unitProps(table, row)}
      data-half={side}
      data-kind={row.kind}
      data-whitespace={shown === row.kind ? undefined : "hidden"}
      className={cn(
        "group/unit relative w-1/2 overflow-hidden pr-3 align-top text-ellipsis whitespace-pre",
        side === "new" && "border-l border-separator",
        ROW_TONE[shown],
        table.commented.has(row.index) && "shadow-mark",
        lit(table, row),
      )}
    >
      <span
        {...gutterProps(table, row)}
        className={cn(
          "relative select-none",
          HALF_NUMBER_GUTTER,
          gutterProps(table, row).className,
        )}
      >
        {unit ? <Plus table={table} row={row} side={side} /> : null}
        {row[side] ?? ""}
      </span>
      <span
        {...gutterProps(table, row)}
        className={cn(
          "select-none",
          HALF_MARKER_GUTTER,
          gutterProps(table, row).className,
        )}
      >
        {side === "new" || row.kind === "del" ? (
          <NoteMarker table={table} index={row.index} />
        ) : null}
        <Marker kind={shown} />
      </span>
      <Source row={row} />
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
          <Extras table={table} indexes={[pair.whole.index]} />
        </Fragment>
      );
    const indexes = [pair.old?.index, pair.new?.index].filter(
      (index): index is number => index !== undefined,
    );
    return (
      <Fragment key={`p${Math.min(...indexes)}`}>
        <tr
          id={`${table.id}-p${Math.min(...indexes)}`}
          className="scroll-my-(--scroll-top)"
        >
          <Half table={table} row={pair.old} side="old" />
          <Half table={table} row={pair.new} side="new" />
        </tr>
        <Extras table={table} indexes={indexes} />
      </Fragment>
    );
  });
};

const UnchangedLine = ({
  table,
  line,
}: {
  readonly table: TableContext;
  readonly line: GapLine;
}) =>
  table.split ? (
    <tr data-unchanged className="text-muted">
      <td className={SPLIT_UNCHANGED}>
        <span className={HALF_NUMBER_GUTTER}>{line.old}</span>
        <span className={HALF_MARKER_GUTTER} />
        <code className="text-ink">{line.text}</code>
      </td>
      <td className={cn(SPLIT_UNCHANGED, "border-l border-separator")}>
        <span className={HALF_NUMBER_GUTTER}>{line.new}</span>
        <span className={HALF_MARKER_GUTTER} />
        <code className="text-ink">{line.text}</code>
      </td>
    </tr>
  ) : (
    <tr data-unchanged className="text-muted">
      <td className={NUMBER_GUTTER}>
        <LineNumbers old={line.old} fresh={line.new} />
      </td>
      <td className={MARKER_GUTTER} />
      <td className={SOURCE}>
        <code className="text-ink">{line.text}</code>
      </td>
    </tr>
  );

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
 * in the line-number gutter, and beside it the header of the hunk that follows, which then has no row of its own.
 */
const GapGroup = ({
  table,
  gap,
  header,
}: {
  readonly table: TableContext;
  readonly gap: Extract<Segment, { kind: "gap" }>;
  readonly header: Row | undefined;
}) => {
  const [stage, setStage] = useAtom(
    gapAtom({
      path: table.model.file.path,
      digest: table.model.digest,
      gap: gap.key,
    }),
  );
  // A gap with only one kind of hidden line has no first stage.
  const shown =
    stage === 1 && (gap.folded === 0 || gap.context === 0) ? 2 : stage;
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
        <Extras table={table} indexes={[header.index]} />
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

/**
 * Selecting rows of one table: a drag over its line numbers, or a + button, which with Shift extends the open
 * composer's range. A selection moves the comment being moved, or opens a composer on the rows. `table` is the
 * table's ID and `rows` its rows.
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
  const drag = useAtomValue(dragOf(model.file.path));

  const choose = async (start: number, end: number, opener: string) => {
    const digest = model.digest;
    if (digest === undefined) return;
    const moving = registry.get(reattachAtom(review));
    if (moving !== undefined) {
      registry.set(reattachAtom(review), undefined);
      const outcome = await act({
        kind: "reattach",
        comment: moving,
        selection: {
          path: model.file.path,
          patch_sha256: digest,
          start_row: start,
          end_row: end,
        },
      });
      if (outcome.ok) toast("The comment moved to the lines you chose.");
      return;
    }
    openDraft(registry, review, {
      path: model.file.path,
      digest,
      start,
      end,
      opener,
    });
  };

  // A drag ends wherever the pointer is released. The read-only patch above the diff takes no selection.
  useEffect(() => {
    if (readOnly) return;
    const release = () => {
      const now = registry.get(dragAtom);
      if (now === undefined || now.path !== model.file.path) return;
      registry.set(dragAtom, undefined);
      const end = Math.max(now.from, now.to);
      const side = !split
        ? "unified"
        : rows[end]?.kind === "del"
          ? "old"
          : "new";
      void choose(Math.min(now.from, now.to), end, plusId(table, end, side));
    };
    document.addEventListener("mouseup", release);
    return () => document.removeEventListener("mouseup", release);
  });

  return {
    /** The rows the drag under way covers. */
    dragged:
      drag === undefined
        ? undefined
        : {
            start: Math.min(drag.from, drag.to),
            end: Math.max(drag.from, drag.to),
          },
    select: (
      row: Row,
      event: React.MouseEvent | React.KeyboardEvent,
      opener: string,
    ) => {
      const open = registry
        .get(draftsAtom(review))
        .find((draft) => !draft.submitting && draft.path === model.file.path);
      if (event.shiftKey && open !== undefined)
        void choose(
          Math.min(open.start, row.index),
          Math.max(open.end, row.index),
          open.opener,
        );
      else void choose(row.index, row.index, opener);
    },
    startDrag: (row: Row, event: React.MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      registry.set(dragAtom, {
        path: model.file.path,
        from: row.index,
        to: row.index,
      });
    },
    hover: (row: Row) => {
      const now = registry.get(dragAtom);
      if (
        now !== undefined &&
        now.path === model.file.path &&
        now.to !== row.index
      )
        registry.set(dragAtom, { ...now, to: row.index });
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
  ).filter((draft) => !readOnly && draft.digest === model.digest);
  const reattaching = useAtomValue(reattachAtom(review));
  const flash = useAtomValue(flashOf({ review, path: model.file.path }));
  const { dragged, select, startDrag, hover } = useSelection(
    model,
    id,
    layout.rows,
    split,
    readOnly,
  );
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

  const table: TableContext = {
    model,
    id,
    rows: layout.rows,
    split,
    columns: split ? 2 : 3,
    selectable: page.writable && !readOnly && model.digest !== undefined,
    reattaching: reattaching !== undefined,
    selected:
      dragged ??
      (editable === undefined
        ? undefined
        : { start: editable.start, end: editable.end }),
    flash: readOnly ? undefined : flash,
    quiet,
    absorbed,
    commented: new Set(
      model.placed.flatMap((item) =>
        Array.from(
          { length: item.end - item.start + 1 },
          (_, at) => item.start + at,
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
    threadsAt: readOnly ? new Map() : groupBy(model.placed, (item) => item.end),
    drafts,
    select,
    startDrag,
    hover,
  };

  return (
    <div
      role="group"
      aria-label={`Diff of ${model.file.path}`}
      tabIndex={0}
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
