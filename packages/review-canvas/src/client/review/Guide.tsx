/**
 * The guide: the source view's left column, which keeps the walkthrough beside the plain diff. It tells the stops in
 * tour order as prose with small excerpts that link into the code, or lists the files as the contents do. A wide page
 * keeps it beside the diff, scrolling on its own; a narrower one folds it into a disclosure above the diff.
 */
import { useAtomValue } from "@effect/atom-react";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RepoPath } from "../../schema/primitives.ts";
import { parseRows } from "../../review/patch.ts";
import type { ExcerptView, StopView } from "../../review/tour.ts";
import { count, lineRange, splitPath } from "../names.ts";
import { cn } from "../ui/cn.ts";
import { useMedia } from "../ui/media.ts";
import { Segmented } from "../ui/segmented.tsx";
import { Stat } from "../ui/stat.tsx";
import { Inline, Lead, Prose, Time } from "../ui/text.tsx";
import { usePage } from "./act.ts";
import { DiffChoices, FileList } from "./Contents.tsx";
import { Marker } from "./Diff.tsx";
import { Narration } from "./Header.tsx";
import { fileElementId } from "../../review/next.ts";
import {
  type ExcerptTarget,
  keepInRail,
  spiedAtom,
  spiedPlace,
  useMoved,
} from "./navigate.ts";
import { hashOf } from "./places.ts";
import { Rail } from "./Rail.tsx";
import { Attention, Questions, StopProse } from "./Sections.tsx";
import { seenAtom, WIDE_QUERY } from "./ui.ts";
import { noteElementId } from "./view.ts";

/** How many rows of an excerpt the guide shows; the diff has the rest. */
const EXCERPT_ROWS = 8;

type Tab = "walkthrough" | "files";

/** An excerpt as a caption that links to its rows, the first of its rows as code, and its notes. */
const Excerpt = ({
  stop,
  excerpt,
  at,
  onExcerpt,
}: {
  readonly stop: StopView;
  readonly excerpt: ExcerptView;
  readonly at: number;
  readonly onExcerpt: (target: ExcerptTarget) => void;
}) => {
  const { page } = usePage();
  const model = page.files.get(excerpt.path);
  if (model === undefined) return null;
  const rows = parseRows(model.file.patch ?? "").slice(
    excerpt.start_row,
    excerpt.end_row + 1,
  );
  const lines = rows
    .map((row) => row[excerpt.side])
    .filter((line) => line !== undefined);
  const first = lines[0];
  const last = lines.at(-1);
  const target: ExcerptTarget = {
    path: excerpt.path,
    index: model.index,
    start: excerpt.start_row,
    end: excerpt.end_row,
  };
  const more = rows.length - EXCERPT_ROWS;
  return (
    <div data-excerpt className="mt-3">
      <a
        href={`#f${model.index}-r${excerpt.start_row}`}
        data-excerpt-link
        onClick={(event) => {
          event.preventDefault();
          onExcerpt(target);
        }}
        className="font-mono text-technical break-all text-link no-underline hover:underline"
      >
        {excerpt.path}
        {first === undefined || last === undefined
          ? ""
          : ` · ${lineRange(first, last, "line")}`}
      </a>
      {/* The caption is the keyboard's way to the rows; a click anywhere on them goes there too. */}
      <pre
        onClick={() => onExcerpt(target)}
        className="mt-1 cursor-pointer overflow-x-auto rounded-control bg-code px-2 py-1.5 font-mono text-technical leading-5"
      >
        {rows.slice(0, EXCERPT_ROWS).map((row) => (
          <div
            key={row.index}
            className={
              row.kind === "hunk" || row.kind === "meta"
                ? "text-muted"
                : "text-ink"
            }
          >
            <Marker kind={row.kind} />
            {row.content}
          </div>
        ))}
        {more > 0 ? <div className="text-muted">… {more} more</div> : null}
      </pre>
      {excerpt.notes.map((note) => {
        const id = noteElementId(stop.index, at, note.letter);
        return (
          <a
            key={id}
            href={`#${id}`}
            data-guide-note={id}
            onClick={(event) => {
              event.preventDefault();
              onExcerpt({ ...target, note: id });
            }}
            className="mt-1.5 block rounded-control text-ink no-underline hover:bg-subtle"
          >
            <span className="sr-only">Note </span>
            <span className="mr-1.5 inline-grid size-4.5 place-items-center rounded-full bg-accent align-[0.0625rem] font-mono text-xs leading-none font-bold text-on-accent">
              {note.letter}
            </span>
            <strong className="font-semibold">
              <Lead title={note.title} />
            </strong>
            {note.body === "" ? null : (
              <>
                {" "}
                <Inline text={note.body} />
              </>
            )}
          </a>
        );
      })}
    </div>
  );
};

const GuideStop = ({
  stop,
  current,
  read,
  onFile,
  onExcerpt,
  onAsk,
}: {
  readonly stop: StopView;
  readonly current: boolean;
  readonly read: boolean;
  readonly onFile: (path: RepoPath) => void;
  readonly onExcerpt: (target: ExcerptTarget) => void;
  readonly onAsk: (question: string) => void;
}) => {
  const { page } = usePage();
  const owned = stop.owns.flatMap((path) => {
    const model = page.files.get(path);
    return model === undefined ? [] : [model];
  });
  const viewed = owned.filter((model) => model.approved).length;
  return (
    <li
      id={`guide-stop-${stop.index + 1}`}
      data-guide-stop={stop.index}
      aria-current={current ? "location" : undefined}
      className="m-0 border-t border-separator px-2 pt-3 pb-4 aria-[current]:bg-selected"
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-technical",
            read ? "text-accent" : "text-muted",
          )}
        >
          {stop.index + 1}
        </span>
        <h2 tabIndex={-1} className="min-w-0 flex-1 font-semibold text-ink">
          {stop.title}
        </h2>
        <Stat
          icon={Check}
          title={`${viewed} of ${count(owned.length, "file")} viewed`}
        >
          {viewed}/{owned.length}
        </Stat>
      </div>
      <StopProse stop={stop} />
      <Attention stop={stop} />
      {stop.excerpts.map((excerpt, at) => (
        <Excerpt
          key={at}
          stop={stop}
          excerpt={excerpt}
          at={at}
          onExcerpt={onExcerpt}
        />
      ))}
      <Questions stop={stop} onAsk={onAsk} />
      {owned.length === 0 ? null : (
        <p data-guide-files className="mt-3 font-mono text-technical">
          {owned.map((model, at) => (
            <span key={model.file.path}>
              {at === 0 ? null : <span className="text-muted"> · </span>}
              <a
                href={hashOf(fileElementId(model.file.path))}
                data-guide-file={model.file.path}
                title={model.file.path}
                onClick={(event) => {
                  event.preventDefault();
                  onFile(model.file.path);
                }}
                className="text-link no-underline hover:underline"
              >
                {splitPath(model.file.path).base}
              </a>
              {model.approved ? (
                <Check
                  role="img"
                  aria-label="viewed"
                  className="ml-0.5 inline size-3.5 align-[-0.125em] text-ink"
                />
              ) : null}
            </span>
          ))}
        </p>
      )}
    </li>
  );
};

export const Guide = ({
  onFile,
  onExcerpt,
  onAsk,
  steering,
}: {
  readonly onFile: (path: RepoPath) => void;
  readonly onExcerpt: (target: ExcerptTarget) => void;
  readonly onAsk: (question: string) => void;
  /** Whether the page is scrolling itself, when the guide leaves its scroller where the page put it. */
  readonly steering: () => boolean;
}) => {
  const { id, page } = usePage();
  const wide = useMedia(WIDE_QUERY);
  const [tab, setTab] = useState<Tab>("walkthrough");
  const [open, setOpen] = useState(false);
  const read = new Set(useAtomValue(seenAtom({ id, round: page.round.round })));
  const spied = useAtomValue(spiedAtom);
  const { file: spiedFile, stop: spiedStop } = spiedPlace(page, spied);
  const scroller = useRef<HTMLDivElement>(null);
  const moved = useMoved();
  // Once the reviewer has moved, a wide page keeps the marked stop, or in the files the marked file, in the guide's
  // view, unless the page put it somewhere itself.
  useEffect(() => {
    if (!wide || !moved || steering()) return;
    const marked = scroller.current?.querySelector<HTMLElement>(
      "[aria-current='location']",
    );
    if (marked !== null && marked !== undefined) keepInRail(marked);
  }, [spiedStop, spiedFile, tab, wide, moved, steering]);
  const pick = (path: RepoPath) => {
    setOpen(false);
    onFile(path);
  };
  const tabs = (
    <Segmented
      label="Guide"
      attribute="data-guide-tab"
      choices={[
        ["walkthrough", "Walkthrough"],
        ["files", "Files"],
      ]}
      value={tab}
      onChange={setTab}
      className="self-start"
    />
  );
  const body =
    tab === "files" ? (
      <nav aria-label="Files">
        <FileList spiedFile={spiedFile} onFile={pick} />
      </nav>
    ) : (
      <div data-walkthrough>
        {page.input.summary === undefined ? null : (
          <div className="px-2 pb-4">
            <Narration className="mb-1.5">
              · Round {page.round.round} · published{" "}
              <Time at={page.round.published_at} />
            </Narration>
            <Prose text={page.input.summary} />
          </div>
        )}
        <ol aria-label="Walkthrough" className="m-0 list-none p-0">
          {page.stops.map((stop) => (
            <GuideStop
              key={stop.index}
              stop={stop}
              current={spiedStop === stop.index}
              read={read.has(stop.index)}
              onFile={pick}
              onExcerpt={onExcerpt}
              onAsk={onAsk}
            />
          ))}
        </ol>
      </div>
    );
  return (
    <Rail
      data-guide
      className="text-small"
      wide={wide}
      open={open}
      onOpen={setOpen}
      summary="Walkthrough"
      head={tabs}
      foot={tab === "files" ? <DiffChoices wide={wide} /> : undefined}
      scroller={scroller}
    >
      {body}
    </Rail>
  );
};
