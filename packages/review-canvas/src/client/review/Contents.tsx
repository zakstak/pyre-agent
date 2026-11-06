/**
 * The contents: the walkthrough's stops, then every file of the round by folder, each list marking where the reviewer
 * is, what they read and viewed, and which stops carry an attention flag, with the diff choices under them: the
 * layout, whitespace, and opening or folding every file. A wide page keeps them beside the review; a narrower one
 * folds them into a disclosure. The source view's guide shows the same file list and choices.
 */
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RepoPath } from "../../schema/primitives.ts";
import { fileElementId } from "../../review/next.ts";
import { count, splitPath } from "../names.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useMedia } from "../ui/media.ts";
import { Segmented } from "../ui/segmented.tsx";
import { Stat } from "../ui/stat.tsx";
import { usePage } from "./act.ts";
import { DriftFiles } from "./Drift.tsx";
import { keepInRail, spiedAtom, spiedPlace, useMoved } from "./navigate.ts";
import { hashOf } from "./places.ts";
import { Rail } from "./Rail.tsx";
import {
  changedNames,
  READ_TEXT,
  ReadCount,
  ReadMark,
  readOf,
} from "./Reading.tsx";
import { FlagLine } from "./Sections.tsx";
import {
  filtersFlagged,
  flaggedOnlyAtom,
  foldsAtom,
  layoutAtom,
  whitespaceAtom,
  WIDE_QUERY,
} from "./ui.ts";
import { byDirectory } from "./view.ts";

const KICKER =
  "text-technical font-semibold tracking-wide text-muted uppercase";

/** Every file of the round by folder, marking the one in view, what was viewed, and what has open comments. */
export const FileList = ({
  spiedFile,
  onFile,
  className,
}: {
  readonly spiedFile: string | undefined;
  readonly onFile: (path: RepoPath) => void;
  readonly className?: string;
}) => {
  const { page } = usePage();
  return (
    <ul className={cn("m-0 list-none p-0", className)}>
      {byDirectory(page.files.keys()).map(({ dir, paths }) => (
        <li key={dir} className="m-0">
          {dir === "" ? null : (
            <p
              title={dir}
              className="truncate px-1 pt-1.5 font-mono text-technical text-muted"
            >
              {dir}
            </p>
          )}
          <ul className={cn("m-0 list-none p-0", dir !== "" && "pl-3")}>
            {paths.map((path) => {
              const model = page.files.get(path);
              if (model === undefined) return null;
              return (
                <li key={path} className="m-0">
                  <a
                    href={hashOf(fileElementId(path))}
                    data-toc-file={path}
                    title={path}
                    aria-current={spiedFile === path ? "location" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      onFile(path);
                    }}
                    className={cn(
                      "flex h-7 items-center gap-2 rounded-control px-1 font-mono text-technical no-underline hover:bg-subtle aria-[current]:bg-selected",
                      model.approved ? "text-muted" : "text-ink",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {splitPath(path).base}
                    </span>
                    {model.approved ? (
                      <Check
                        role="img"
                        aria-label="viewed"
                        className="size-3.5 shrink-0 text-ink"
                      />
                    ) : model.open > 0 ? (
                      <Stat
                        icon={MessageSquare}
                        tone="ink"
                        title={count(model.open, "open comment")}
                      >
                        {model.open}
                      </Stat>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
};

/**
 * Opens every file of the round, or folds every one, as the reviewer's choice for each, which holds until they change
 * it or mark the file viewed.
 */
const AllFiles = () => {
  const { id, page } = usePage();
  const setFolds = useAtomSet(foldsAtom({ id, round: page.round.round }));
  const every = (fold: "open" | "closed") =>
    setFolds(
      Object.fromEntries(
        [...page.files.values()]
          .filter((model) => model.hasBody)
          .map((model) => [model.file.path, fold]),
      ),
    );
  return (
    <div className="mt-2 -ml-2.5 flex flex-col items-start">
      <Button
        size="sm"
        variant="quiet"
        data-all-files="open"
        onClick={() => every("open")}
      >
        <ChevronsUpDown aria-hidden="true" className="size-3.5" />
        Expand all files
      </Button>
      <Button
        size="sm"
        variant="quiet"
        data-all-files="closed"
        onClick={() => every("closed")}
      >
        <ChevronsDownUp aria-hidden="true" className="size-3.5" />
        Collapse all files
      </Button>
    </div>
  );
};

/**
 * The diff choices: the strip already counts what was viewed. A page too narrow for split hides the switch. Opening
 * and folding every file sit with them.
 */
export const DiffChoices = ({ wide }: { readonly wide: boolean }) => {
  const [layout, setLayout] = useAtom(layoutAtom);
  const [whitespace, setWhitespace] = useAtom(whitespaceAtom);
  return (
    <div className={cn("text-small", wide ? "mt-auto pt-3 pb-4" : "mt-4 pt-4")}>
      <Segmented
        label="Diff layout"
        attribute="data-layout"
        choices={[
          ["unified", "Unified"],
          ["split", "Split"],
        ]}
        value={layout}
        onChange={setLayout}
        className="max-md:hidden"
      />
      <label className="mt-2 flex w-fit items-center gap-2 text-small max-md:mt-0">
        <input
          type="checkbox"
          data-whitespace
          checked={whitespace === "hide"}
          onChange={(event) =>
            setWhitespace(event.currentTarget.checked ? "hide" : "show")
          }
          className="size-4 accent-accent"
        />
        Hide whitespace
      </label>
      <AllFiles />
    </div>
  );
};

/**
 * The switch that lists only the stops with an attention flag, which J and K then move between. A tour with no flagged
 * stop has none, and {@link filtersFlagged} lists all its stops whatever the switch was.
 */
export const FlaggedOnly = ({ className }: { readonly className?: string }) => {
  const { id, page } = usePage();
  const [on, setOn] = useAtom(flaggedOnlyAtom(id));
  const flagged = page.stops.filter((stop) => stop.attention !== null).length;
  if (flagged === 0) return null;
  return (
    <label
      className={cn(
        "flex w-fit items-center gap-2 text-small font-normal tracking-normal normal-case",
        className,
      )}
    >
      <input
        type="checkbox"
        data-flagged-only
        checked={on}
        onChange={(event) => setOn(event.currentTarget.checked)}
        className="size-4 accent-accent"
      />
      Flagged only{" "}
      <span className="text-muted tabular-nums">
        {flagged} of {page.stops.length}
      </span>
    </label>
  );
};

/** The stops a stop list shows: every one, or while Flagged only filters the round, those with an attention flag. */
export const useListedStops = () => {
  const { id, page } = usePage();
  const flaggedOnly = useAtomValue(flaggedOnlyAtom(id));
  return filtersFlagged(flaggedOnly, page.stops)
    ? page.stops.filter((stop) => stop.attention !== null)
    : page.stops;
};

export const Contents = ({
  onStop,
  onFile,
}: {
  readonly onStop: (index: number) => void;
  readonly onFile: (path: RepoPath) => void;
}) => {
  const { page } = usePage();
  const current = useAtomValue(spiedAtom);
  const wide = useMedia(WIDE_QUERY);
  const [open, setOpen] = useState(false);
  const viewed = page.progress.viewed.size;
  const total = page.progress.viewable;
  const nav = useRef<HTMLElement>(null);
  const moved = useMoved();
  // Once the reviewer has moved, a wide page keeps the spied row in the rail's view, the file's when a file is spied,
  // else the stop's, without moving the page: only the rail scrolls.
  useEffect(() => {
    if (!wide || !moved) return;
    const rows = nav.current?.querySelectorAll<HTMLElement>(
      "[aria-current='location']",
    );
    const last = rows?.[rows.length - 1];
    if (last !== undefined) keepInRail(last);
  }, [current, wide, moved]);
  const { file: spiedFile, stop: spiedStop } = spiedPlace(page, current);
  const stops = useListedStops();
  const list = (
    <nav ref={nav} aria-label="Stops and files" className="text-small">
      <p className={cn(KICKER, "flex items-baseline justify-between gap-2")}>
        Walkthrough
        <ReadCount className="font-normal tracking-normal normal-case" />
      </p>
      <FlaggedOnly className="mt-1.5" />
      <ol className="m-0 mt-1.5 flex list-none flex-col p-0">
        {stops.map((stop) => {
          const read = readOf(page, stop.index);
          return (
            <li key={stop.index} className="m-0">
              <a
                href={`#stop-${stop.index + 1}`}
                data-stop-link={stop.index}
                data-read={read.state}
                aria-current={spiedStop === stop.index ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  onStop(stop.index);
                }}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-1.5 rounded-control px-1 py-1 font-semibold text-ink no-underline hover:bg-subtle aria-[current]:bg-selected"
              >
                <span
                  className={cn(
                    "font-mono text-technical font-normal",
                    read.state === "read" ? "text-accent" : "text-muted",
                  )}
                >
                  {stop.index + 1}
                </span>
                <span className="min-w-0">
                  {stop.title}
                  {stop.attention === null ? null : (
                    <FlagLine flag={stop.attention} className="mt-0.5" />
                  )}
                  {read.state === "changed" ? (
                    <span
                      data-changed-files
                      className="block truncate font-mono text-technical font-normal text-warning"
                    >
                      changed: {changedNames(read)}
                    </span>
                  ) : (
                    <span className="sr-only">, {READ_TEXT[read.state]}</span>
                  )}
                  <DriftFiles stop={stop.index} />
                </span>
                <ReadMark read={read} className="self-center" />
              </a>
            </li>
          );
        })}
      </ol>
      <p className={cn(KICKER, "mt-6")}>Files</p>
      <FileList
        className="mt-1.5"
        spiedFile={spiedFile}
        onFile={(path) => {
          setOpen(false);
          onFile(path);
        }}
      />
    </nav>
  );
  return (
    <Rail
      data-contents
      wide={wide}
      open={open}
      onOpen={setOpen}
      summary={
        <>
          Contents · {viewed} / {total}
        </>
      }
      foot={<DiffChoices wide={wide} />}
    >
      {list}
    </Rail>
  );
};
