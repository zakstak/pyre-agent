/**
 * A file's patch as a table, unified or split, with the comment threads under the rows they end on, the tour's notes,
 * the unchanged lines between hunks behind a control, and the composer under the rows the reviewer selects.
 *
 * Every line a reviewer can select is a unit: a table row in the unified layout, one half of a row in the split
 * layout. Dragging the line numbers selects units; the + button selects one, and with Shift extends the open
 * composer's range.
 */
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Equal } from "effect";
import { Atom } from "effect/reactivity";
import { Fragment, useContext, useEffect, useMemo, useRef } from "react";
import type { Row } from "../../review/patch.ts";
import { Button, TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Inline, Lead } from "../ui/text.tsx";
import { toast } from "../ui/toast.tsx";
import { type Outcome, useAct, usePage } from "./act.ts";
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
import { ACTIONS_CLASS, submitOnModEnter, ThreadView } from "./Thread.tsx";
import { type Draft, draftsAtom, flashAtom, gapAtom, reattachAtom, stashAtom } from "./ui.ts";
import type { FileModel, InlineNote } from "./view.ts";

// ------------------------------------------------------------------------------------------------------- selection

/** A drag over the line numbers of one file, from the row it started on to the row under the pointer. */
const dragAtom = Atom.make<{ readonly path: string; readonly from: number; readonly to: number } | undefined>(undefined).pipe(
  Atom.keepAlive,
);

/**
 * What one table reads of the page-wide drag, flash, and drafts. A table re-renders only when its own part changes,
 * so dragging or typing in one file leaves every other diff alone.
 */
const dragOf = Atom.family((path: string) =>
  Atom.map(dragAtom, (drag) => (drag?.path === path ? drag : undefined)).pipe(Atom.withEquality(Equal.equals)),
);
const flashOf = Atom.family((path: string) =>
  Atom.map(flashAtom, (flash) => (flash?.path === path ? flash : undefined)).pipe(Atom.withEquality(Equal.equals)),
);
const draftsOf = Atom.family((path: string) =>
  Atom.map(draftsAtom, (drafts) => drafts.filter((draft) => draft.path === path)).pipe(Atom.withEquality(Equal.equals)),
);

let nextDraft = 0;

type Registry = NonNullable<React.ContextType<typeof RegistryContext>>;

/**
 * Opens the composer under rows. An unsent draft in another composer moves into it, so picking other lines never
 * loses text, and so does text kept from a draft whose code changed.
 */
const openDraft = (registry: Registry, draft: Omit<Draft, "id" | "body" | "submitting">) => {
  const drafts = registry.get(draftsAtom);
  let body = drafts.find((item) => !item.submitting)?.body ?? "";
  if (body === "") {
    body = registry.get(stashAtom);
    registry.set(stashAtom, "");
  }
  registry.set(draftsAtom, [...drafts.filter((item) => item.submitting), { ...draft, id: ++nextDraft, body, submitting: false }]);
};

/** The selected lines as the server will anchor them: old-side when only deleted lines are selected, else new-side. */
export const lineLabel = (rows: ReadonlyArray<Row>, start: number, end: number): string => {
  const units = rows.filter((row) => row.index >= start && row.index <= end && changeable(row));
  const old = units.some((row) => row.kind === "del") && !units.some((row) => row.kind === "add");
  const numbers = [...new Set(units.map((row) => (old ? row.old : row.new)).filter((line) => line !== undefined))];
  const first = numbers[0];
  const last = numbers.at(-1);
  const side = old ? "old " : "";
  return first === undefined ? "the selected rows" : first === last ? `${side}line ${first}` : `${side}lines ${first}–${last}`;
};

/** The ID of a unit's + button, where focus returns when its composer closes. */
const plusId = (table: string, row: number, side: "old" | "new" | "unified") => `${table}-plus-${row}-${side}`;

// ---------------------------------------------------------------------------------------------------------- pieces

const ROW_TONE: Readonly<Record<Row["kind"], string>> = {
  add: "bg-diff-addition",
  del: "bg-diff-deletion",
  context: "",
  hunk: "bg-surface text-accent",
  meta: "bg-surface text-muted",
};

const MARKER: Readonly<Record<Row["kind"], string>> = { add: "+", del: "−", context: " ", hunk: "", meta: "" };

/** What the marker means, for a reader who hears the table instead of seeing its colours. */
const SPOKEN: Readonly<Record<Row["kind"], string>> = { add: "Added", del: "Deleted", context: "", hunk: "", meta: "" };

const Marker = ({ kind }: { readonly kind: Row["kind"] }) => (
  <>
    <span aria-hidden="true" className="inline-block w-[1em] text-center">
      {MARKER[kind]}
    </span>
    {SPOKEN[kind] === "" ? null : <span className="sr-only">{SPOKEN[kind]}</span>}
  </>
);

const ROW_BODY = "sticky left-0 box-border max-w-[100cqi] px-3 py-1.5 pl-11";

const UNDER = "border-y border-separator bg-surface p-0 font-sans text-small leading-[1.45] whitespace-normal";

const NoteMarker = ({ notes }: { readonly notes: ReadonlyArray<InlineNote> | undefined }) =>
  notes === undefined || notes.length === 0 ? null : (
    <span
      aria-hidden="true"
      className="mr-0.5 inline-grid h-4.5 min-w-4.5 place-items-center rounded-full border border-current px-0.5 align-[0.125rem] font-mono text-xs leading-none font-bold text-accent max-md:hidden"
    >
      {notes.map((note) => note.letter).join("")}
    </span>
  );

const NoteRow = ({ note, columns }: { readonly note: InlineNote; readonly columns: number }) => (
  <tr id={note.id} data-note className="scroll-my-(--sticky-top)">
    <td colSpan={columns} className={UNDER}>
      <div className={ROW_BODY}>
        <span className="sr-only">Note </span>
        <span className="mr-2 inline-grid size-4.5 place-items-center rounded-full border border-current align-[0.0625rem] font-mono text-xs leading-none font-bold text-accent">
          {note.letter}
        </span>
        {note.stop === undefined ? null : <span className="text-muted">Stop {note.stop} · </span>}
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
  readonly selected: { readonly start: number; readonly end: number } | undefined;
  readonly flash: { readonly start: number; readonly end: number } | undefined;
  readonly commented: ReadonlySet<number>;
  readonly notesAt: ReadonlyMap<number, ReadonlyArray<InlineNote>>;
  readonly threadsAt: ReadonlyMap<number, ReadonlyArray<PlacedComment>>;
  readonly drafts: ReadonlyArray<Draft>;
  readonly select: (row: Row, event: React.MouseEvent | React.KeyboardEvent, opener: string) => void;
  readonly startDrag: (row: Row, event: React.MouseEvent) => void;
  readonly hover: (row: Row) => void;
}

const lit = (table: TableContext, row: Row) =>
  table.selected !== undefined && row.index >= table.selected.start && row.index <= table.selected.end
    ? "!bg-selection"
    : table.flash !== undefined && row.index >= table.flash.start && row.index <= table.flash.end
      ? "!bg-highlight"
      : undefined;

const Plus = ({ table, row, side }: { readonly table: TableContext; readonly row: Row; readonly side: "old" | "new" | "unified" }) => {
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
        "absolute top-0 left-0.5 z-[1] inline-grid size-6 max-md:left-0 cursor-pointer place-items-center rounded-sm bg-accent font-sans text-sm leading-none font-bold text-on-accent",
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
        "data-old": row.old ?? "",
        "data-new": row.new ?? "",
        ...(row.kind === "del" ? { "data-side": "old" } : row.kind === "add" ? { "data-side": "new" } : {}),
        onMouseEnter: () => table.hover(row),
      }
    : { "data-row": row.index };

const gutterProps = (table: TableContext, row: Row) =>
  table.selectable && changeable(row)
    ? {
        "data-gutter": "",
        onMouseDown: (event: React.MouseEvent) => table.startDrag(row, event),
        className: table.reattaching ? "cursor-crosshair" : "cursor-pointer",
      }
    : {};

/** Notes on the rows, then the threads that end there, then the composer anchored there. */
const Extras = ({ table, indexes }: { readonly table: TableContext; readonly indexes: ReadonlyArray<number> }) => {
  const unique = [...new Set(indexes)];
  const notes = unique.flatMap((index) => table.notesAt.get(index) ?? []);
  const placed = unique.flatMap((index) => table.threadsAt.get(index) ?? []);
  const drafts = table.drafts.filter((draft) => unique.includes(draft.end));
  return (
    <>
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} columns={table.columns} />
      ))}
      {placed.length === 0 ? null : (
        <tr data-thread-row>
          <td colSpan={table.columns} className={UNDER}>
            <div className={cn(ROW_BODY, "pt-2 pb-2.5")}>
              {placed.map((item) => (
                <ThreadView key={item.comment.id} comment={item.comment} />
              ))}
            </div>
          </td>
        </tr>
      )}
      {drafts.map((draft) => (
        <Composer key={draft.id} table={table} draft={draft} />
      ))}
    </>
  );
};

/**
 * Both line numbers in one gutter cell; a narrow page shows one, the old for a deletion and the new otherwise, in a
 * column no wider than the + button that covers it.
 */
const LineNumbers = ({ old, fresh, deleted = false }: { readonly old: number | undefined; readonly fresh: number | undefined; readonly deleted?: boolean }) => (
  <>
    <span data-ln="old" className={cn("inline-block min-w-11 pl-1 max-md:min-w-[2ch] max-md:pl-0", !deleted && "max-md:hidden")}>
      {old ?? ""}
    </span>
    <span data-ln="new" className={cn("inline-block min-w-11 pl-1 max-md:min-w-[2ch] max-md:pl-0", deleted && "max-md:hidden")}>
      {fresh ?? ""}
    </span>
  </>
);

/** The unified layout's gutters: line numbers, then the change marker; both narrow on a narrow page. */
const NUMBER_GUTTER = "w-px pr-1 pl-7 text-right whitespace-nowrap max-md:pr-0.5 max-md:pl-0";
const MARKER_GUTTER = "w-px min-w-9 px-1 text-right whitespace-nowrap max-md:min-w-0 max-md:px-0 max-md:text-center";
const SOURCE = "pr-4 whitespace-pre max-md:pr-3 max-md:pl-1";

const UnifiedRow = ({ table, row, plus }: { readonly table: TableContext; readonly row: Row; readonly plus: boolean }) => {
  const unit = table.selectable && changeable(row);
  return (
    <>
      <tr
        id={`${table.id}-r${row.index}`}
        {...unitProps(table, row)}
        data-kind={row.kind}
        className={cn("group/unit scroll-my-(--sticky-top)", ROW_TONE[row.kind], table.commented.has(row.index) && "shadow-mark", lit(table, row))}
      >
        <td {...gutterProps(table, row)} className={cn("relative text-muted select-none", NUMBER_GUTTER, gutterProps(table, row).className)}>
          {unit && plus ? <Plus table={table} row={row} side="unified" /> : null}
          <LineNumbers old={row.old} fresh={row.new} deleted={row.kind === "del"} />
        </td>
        <td {...gutterProps(table, row)} className={cn("relative text-muted select-none", MARKER_GUTTER, gutterProps(table, row).className)}>
          <NoteMarker notes={table.notesAt.get(row.index)} />
          <Marker kind={row.kind} />
        </td>
        <td className={SOURCE}>
          <code className="text-ink">{row.content}</code>
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
  plus,
}: {
  readonly table: TableContext;
  readonly row: Row | undefined;
  readonly side: "old" | "new";
  readonly plus: boolean;
}) => {
  if (row === undefined) return <td data-half={side} data-empty className="w-1/2 bg-surface" />;
  const unit = table.selectable && changeable(row);
  return (
    <td
      {...unitProps(table, row)}
      data-half={side}
      data-kind={row.kind}
      className={cn(
        "group/unit relative w-1/2 pr-3 align-top whitespace-pre",
        side === "new" && "border-l border-separator",
        ROW_TONE[row.kind],
        table.commented.has(row.index) && "shadow-mark",
        lit(table, row),
      )}
    >
      <span {...gutterProps(table, row)} className={cn("relative inline-block min-w-14 pr-1 pl-7 text-right text-muted select-none", gutterProps(table, row).className)}>
        {unit && plus ? <Plus table={table} row={row} side={side} /> : null}
        {row[side] ?? ""}
      </span>
      <span {...gutterProps(table, row)} className={cn("inline-block min-w-7 px-1 text-right text-muted select-none", gutterProps(table, row).className)}>
        {side === "new" || row.kind === "del" ? <NoteMarker notes={table.notesAt.get(row.index)} /> : null}
        <Marker kind={row.kind} />
      </span>
      <code className="text-ink">{row.content}</code>
    </td>
  );
};

const RowsOf = ({ table, rows, plus }: { readonly table: TableContext; readonly rows: ReadonlyArray<Row>; readonly plus: boolean }) => {
  if (!table.split)
    return rows.map((row) => <UnifiedRow key={row.index} table={table} row={row} plus={plus} />);
  return pairRows(rows).map((pair) => {
    if (pair.whole !== undefined)
      return (
        <Fragment key={`w${pair.whole.index}`}>
          <tr data-row={pair.whole.index} data-kind={pair.whole.kind} className={ROW_TONE[pair.whole.kind]}>
            <td colSpan={2} className="px-3 whitespace-pre">
              <code>{pair.whole.content}</code>
            </td>
          </tr>
          <Extras table={table} indexes={[pair.whole.index]} />
        </Fragment>
      );
    const indexes = [pair.old?.index, pair.new?.index].filter((index): index is number => index !== undefined);
    return (
      <Fragment key={`p${Math.min(...indexes)}`}>
        <tr id={`${table.id}-p${Math.min(...indexes)}`} data-pair className="scroll-my-(--sticky-top)">
          <Half table={table} row={pair.old} side="old" plus={plus} />
          <Half table={table} row={pair.new} side="new" plus={plus} />
        </tr>
        <Extras table={table} indexes={indexes} />
      </Fragment>
    );
  });
};

const UnchangedLine = ({ table, line }: { readonly table: TableContext; readonly line: GapLine }) =>
  table.split ? (
    <tr data-unchanged className="text-muted">
      <td className="w-1/2 pr-3 whitespace-pre">
        <span className="inline-block min-w-14 pr-1 pl-7 text-right">{line.old}</span>
        <span className="inline-block min-w-7 px-1" />
        <code className="text-ink">{line.text}</code>
      </td>
      <td className="w-1/2 border-l border-separator pr-3 whitespace-pre">
        <span className="inline-block min-w-14 pr-1 pl-7 text-right">{line.new}</span>
        <span className="inline-block min-w-7 px-1" />
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

const GapPartRows = ({ table, part }: { readonly table: TableContext; readonly part: GapPart }) =>
  part.kind === "folded" ? (
    <RowsOf table={table} rows={part.rows} plus />
  ) : (
    part.lines.map((line) => <UnchangedLine key={line.new} table={table} line={line} />)
  );

/** One control for hidden lines next to each other: the folded rows first, then the unchanged lines, then none. */
const GapGroup = ({ table, gap }: { readonly table: TableContext; readonly gap: Extract<Segment, { kind: "gap" }> }) => {
  const [stage, setStage] = useAtom(gapAtom({ path: table.model.file.path, digest: table.model.digest, gap: gap.key }));
  // A gap with only one kind of hidden line has no first stage.
  const shown = stage === 1 && (gap.folded === 0 || gap.context === 0) ? 2 : stage;
  const toggle = (
    <tbody data-gap={gap.key}>
      <tr>
        <td colSpan={table.columns} className="bg-surface p-0">
          <button
            type="button"
            data-expand={gap.key}
            data-folded={gap.folded}
            data-context={gap.context}
            aria-expanded={shown === 2}
            onClick={() => setStage(nextStage(shown, gap))}
            className={cn(TOUCH_TARGET, "sticky left-0 h-7 cursor-pointer px-12 font-sans text-small font-medium text-link hover:underline")}
          >
            {gapLabel(shown, gap)}
            <span aria-hidden="true"> {shown === 2 ? "▴" : "▾"}</span>
          </button>
        </td>
      </tr>
    </tbody>
  );
  return gap.parts.map((part, at) => {
    const open = shown === 2 || (shown === 1 && part.kind === "folded");
    return (
      <Fragment key={at}>
        {at === gap.toggleAt ? toggle : null}
        {open ? (
          <tbody data-gap-lines={part.kind === "folded" ? "folded" : "unchanged"}>
            <GapPartRows table={table} part={part} />
          </tbody>
        ) : null}
      </Fragment>
    );
  });
};

// -------------------------------------------------------------------------------------------------------- composer

const Composer = ({ table, draft }: { readonly table: TableContext; readonly draft: Draft }) => {
  const registry = useContext(RegistryContext);
  const act = useAct();
  const area = useRef<HTMLTextAreaElement>(null);
  const textId = `composer-${draft.id}`;
  // Only when it opens: focus stays where the reviewer puts it afterwards.
  useEffect(() => {
    if (!draft.submitting) area.current?.focus();
  }, []);
  const update = (change: (draft: Draft) => Draft | undefined) =>
    registry.set(
      draftsAtom,
      registry.get(draftsAtom).flatMap((item) => {
        if (item.id !== draft.id) return [item];
        const next = change(item);
        return next === undefined ? [] : [next];
      }),
    );
  const close = () => {
    const inside = area.current?.closest("tr")?.contains(document.activeElement) === true || document.activeElement === document.body;
    update(() => undefined);
    if (inside) requestAnimationFrame(() => document.getElementById(draft.opener)?.focus());
  };
  const send = async (question: boolean) => {
    // The atom, not this render's props: Ctrl+Enter twice must send once.
    if (registry.get(draftsAtom).find((item) => item.id === draft.id)?.submitting !== false) return;
    const body = draft.body.trim();
    if (body === "") return area.current?.focus();
    update((item) => ({ ...item, submitting: true }));
    const outcome: Outcome = await act(
      {
        kind: "comment",
        selection: { path: draft.path, patch_sha256: draft.digest, start_row: draft.start, end_row: draft.end },
        body,
        ...(question ? { question: true } : {}),
      },
      { quiet: true },
    );
    const still = registry.get(draftsAtom).some((item) => item.id === draft.id);
    if (outcome.ok) return close();
    if (still) {
      update((item) => ({ ...item, submitting: false }));
      toast(outcome.message, "danger");
    } else {
      registry.set(stashAtom, body);
      toast(
        `Your comment was not added: ${outcome.message} Your text is kept: select lines to comment on, and it fills the new comment.`,
        "danger",
      );
    }
  };
  return (
    <tr data-composer data-draft={draft.id} data-start={draft.start} data-end={draft.end}>
      <td colSpan={table.columns} className={UNDER}>
        <div className={cn(ROW_BODY, "pt-2.5 pb-3")}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(false);
            }}
          >
            <p className="mb-1.5 text-small text-muted">
              Comment on <span data-range>{lineLabel(table.rows, draft.start, draft.end)}</span>
            </p>
            <label className="sr-only" htmlFor={textId}>
              Comment
            </label>
            <textarea
              ref={area}
              id={textId}
              rows={3}
              required
              readOnly={draft.submitting}
              value={draft.body}
              placeholder="What should change, or what do you want to know?"
              onChange={(event) => {
                const body = event.currentTarget.value;
                update((item) => ({ ...item, body }));
              }}
              onKeyDown={(event) => {
                submitOnModEnter(event);
                if (event.key === "Escape" && !draft.submitting) {
                  event.preventDefault();
                  close();
                }
              }}
              className="block w-full max-w-reading resize-y rounded-control border border-line bg-code px-3 py-2 text-base"
            />
            <div className={ACTIONS_CLASS}>
              <Button type="submit" size="sm" variant="primary" disabled={draft.submitting}>
                Comment
              </Button>
              <Button size="sm" disabled={draft.submitting} onClick={() => void send(true)}>
                Ask now
              </Button>
              <Button size="sm" variant="quiet" disabled={draft.submitting} onClick={close}>
                Cancel
              </Button>
              <span className="text-small text-muted">Ctrl+Enter · Esc</span>
            </div>
          </form>
        </div>
      </td>
    </tr>
  );
};

// ----------------------------------------------------------------------------------------------------------- table

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
  const { page } = usePage();
  const registry = useContext(RegistryContext);
  const act = useAct();
  const readOnly = patch !== undefined;
  const source = patch ?? model.file.patch ?? "";
  const split = wantSplit && !readOnly;
  const id = readOnly ? `f${model.index}-since` : `f${model.index}`;
  // A new snapshot rebuilds the file's model, but the patch and the rows it shows rarely change: lay out once per both.
  const shown = readOnly ? undefined : model.shown;
  const shownKey = shown?.map((range) => `${range.start}-${range.end}`).join(",");
  const content = readOnly ? undefined : model.file.new_content;
  const layout = useMemo(() => layoutDiff(source, { shown, content }), [source, shownKey, content]);
  const drafts = useAtomValue(draftsOf(model.file.path)).filter((draft) => !readOnly && draft.digest === model.digest);
  const reattaching = useAtomValue(reattachAtom);
  const drag = useAtomValue(dragOf(model.file.path));
  const flash = useAtomValue(flashOf(model.file.path));
  const editable = drafts.find((draft) => !draft.submitting);
  const selected =
    drag !== undefined
      ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
      : editable === undefined
        ? undefined
        : { start: editable.start, end: editable.end };

  /** A selection of rows: it moves the comment being moved, or opens a composer on them. */
  const choose = async (start: number, end: number, opener: string) => {
    const digest = model.digest;
    if (digest === undefined) return;
    const moving = registry.get(reattachAtom);
    if (moving !== undefined) {
      registry.set(reattachAtom, undefined);
      const outcome = await act({
        kind: "reattach",
        comment: moving,
        selection: { path: model.file.path, patch_sha256: digest, start_row: start, end_row: end },
      });
      if (outcome.ok) toast("The comment moved to the lines you chose.");
      return;
    }
    openDraft(registry, { path: model.file.path, digest, start, end, opener });
  };

  const table: TableContext = {
    model,
    id,
    rows: layout.rows,
    split,
    columns: split ? 2 : 3,
    selectable: page.writable && !readOnly && model.digest !== undefined,
    reattaching: reattaching !== undefined,
    selected,
    flash: readOnly ? undefined : flash,
    commented: new Set(model.placed.flatMap((item) => Array.from({ length: item.end - item.start + 1 }, (_, at) => item.start + at))),
    notesAt: readOnly ? new Map() : groupBy(model.notes, (note) => note.row),
    threadsAt: readOnly ? new Map() : groupBy(model.placed, (item) => item.end),
    drafts,
    select: (row, event, opener) => {
      const open = registry.get(draftsAtom).find((draft) => !draft.submitting && draft.path === model.file.path);
      if (event.shiftKey && open !== undefined)
        void choose(Math.min(open.start, row.index), Math.max(open.end, row.index), open.opener);
      else void choose(row.index, row.index, opener);
    },
    startDrag: (row, event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      registry.set(dragAtom, { path: model.file.path, from: row.index, to: row.index });
    },
    hover: (row) => {
      const now = registry.get(dragAtom);
      if (now !== undefined && now.path === model.file.path && now.to !== row.index) registry.set(dragAtom, { ...now, to: row.index });
    },
  };

  // A drag ends wherever the pointer is released.
  useEffect(() => {
    const release = () => {
      const now = registry.get(dragAtom);
      if (now === undefined || now.path !== model.file.path) return;
      registry.set(dragAtom, undefined);
      const end = Math.max(now.from, now.to);
      void choose(Math.min(now.from, now.to), end, plusId(id, end, split ? "new" : "unified"));
    };
    document.addEventListener("mouseup", release);
    return () => document.removeEventListener("mouseup", release);
  });

  return (
    <div role="group" aria-label={`Diff of ${model.file.path}`} tabIndex={0} className="@container overflow-x-auto bg-code focus-visible:-outline-offset-2">
      <table
        data-path={model.file.path}
        data-patch={readOnly ? undefined : model.digest}
        data-table={id}
        data-layout={split ? "split" : "unified"}
        data-rows={layout.rows.length}
        className={cn("w-full border-collapse font-mono text-technical leading-6", split && "table-fixed")}
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
              <RowsOf table={table} rows={segment.rows} plus />
            </tbody>
          ) : (
            <GapGroup key={at} table={table} gap={segment} />
          ),
        )}
      </table>
    </div>
  );
};

const groupBy = <A,>(items: ReadonlyArray<A>, key: (item: A) => number): ReadonlyMap<number, ReadonlyArray<A>> => {
  const map = new Map<number, Array<A>>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};
