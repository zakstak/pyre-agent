/**
 * The contents: every stop with the files it owns, where the reviewer is, and what they read and viewed, with the
 * diff layout under them. A wide page keeps them beside the review; a narrower one folds them into a disclosure.
 */
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import type { RepoPath } from "../../schema/primitives.ts";
import { fileElementId } from "../../review/next.ts";
import { count, shortPath } from "../names.ts";
import { TOUCH_TARGET } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useMedia } from "../ui/media.ts";
import { usePage } from "./act.ts";
import { spiedAtom } from "./navigate.ts";
import { layoutAtom, seenAtom, WIDE_QUERY } from "./ui.ts";

export const Contents = ({
  onStop,
  onFile,
}: {
  readonly onStop: (index: number) => void;
  readonly onFile: (path: RepoPath) => void;
}) => {
  const { id, page } = usePage();
  const current = useAtomValue(spiedAtom);
  const read = new Set(useAtomValue(seenAtom({ id, round: page.round.round })));
  const [layout, setLayout] = useAtom(layoutAtom);
  const wide = useMedia(WIDE_QUERY);
  const [open, setOpen] = useState(false);
  const viewed = page.progress.viewed.size;
  const total = page.progress.viewable;
  const nav = useRef<HTMLElement>(null);
  // A wide page keeps the spied row in view in the pane.
  useEffect(() => {
    if (!wide) return;
    nav.current?.querySelector<HTMLElement>("[aria-current='location']")?.scrollIntoView({ block: "nearest" });
  }, [current, wide]);
  const list = (
    <nav ref={nav} aria-label="Stops and files" className="text-small">
      <ol className="m-0 flex list-none flex-col p-0">
        {page.stops.map((stop) => (
          <li key={stop.index} className="mt-2 first:mt-0">
            <a
              href={`#stop-${stop.index + 1}`}
              data-stop-link={stop.index}
              data-read={read.has(stop.index) ? "" : undefined}
              aria-current={current === `stop:${stop.index}` ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                onStop(stop.index);
              }}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-1.5 rounded-control px-1 py-1 font-semibold text-ink no-underline hover:bg-subtle aria-[current]:bg-selected"
            >
              <span className={cn("font-mono text-technical font-normal", read.has(stop.index) ? "text-accent" : "text-muted")}>{stop.index + 1}</span>
              <span className="min-w-0">{stop.title}</span>
              <span className="font-normal text-muted">{stop.owns.length}</span>
            </a>
            {stop.owns.length === 0 ? null : (
              <ol className="m-0 list-none p-0">
                {stop.owns.map((path) => {
                  const model = page.files.get(path);
                  if (model === undefined) return null;
                  const name = shortPath(path);
                  return (
                    <li key={path} className="m-0">
                      <a
                        href={`#${encodeURI(fileElementId(path)).replaceAll("#", "%23")}`}
                        data-toc-file={path}
                        title={path}
                        aria-current={current === `file:${path}` ? "location" : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          setOpen(false);
                          onFile(path);
                        }}
                        className={cn(
                          "flex h-7 items-center gap-2 rounded-control pr-1 pl-7 font-mono text-technical no-underline hover:bg-subtle aria-[current]:bg-selected",
                          model.approved ? "text-muted" : "text-ink",
                        )}
                      >
                        {/*
                          The folder and name when both fit, else the name alone, cut at its end; never part of the
                          folder. The name comes first in a wrapping line laid out right to left and packed to the
                          left, so the folder is what wraps, onto a second line the row clips.
                        */}
                        <span className="flex max-h-7 min-w-0 flex-1 flex-row-reverse flex-wrap justify-end overflow-hidden leading-7 whitespace-nowrap">
                          <span className="flex-none text-muted">{name.dir}</span>
                          <span className="-order-1 min-w-0 truncate">{name.base}</span>
                        </span>
                        {model.approved ? (
                          <span aria-label="viewed" className="text-ink">
                            ✓
                          </span>
                        ) : model.open > 0 ? (
                          <span aria-label={count(model.open, "open comment")} className="inline-flex items-center gap-1 text-ink">
                            <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-accent" />
                            {model.open}
                          </span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
  const foot = (
    <div className="mt-4 flex items-center justify-between border-t border-separator pt-4 text-small">
      <div role="group" aria-label="Diff layout" className="inline-flex overflow-hidden rounded-control border border-line max-md:hidden">
        {([["unified", "Unified"], ["split", "Split"]] as const).map(([choice, label]) => (
          <button
            key={choice}
            type="button"
            data-layout={choice}
            aria-pressed={layout === choice}
            onClick={() => setLayout(choice)}
            className={cn(
              TOUCH_TARGET,
              "h-7 px-2.5 font-medium",
              layout === choice ? "bg-selected text-ink shadow-pressed" : "bg-raised text-muted hover:bg-subtle",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="text-muted">
        {viewed} / {total}
      </span>
    </div>
  );
  return (
    <div data-contents className="min-w-0 lg:sticky lg:top-(--sticky-top) lg:mt-6 lg:max-h-[calc(100vh-var(--sticky-top)-1rem)] lg:self-start lg:overflow-y-auto">
      {wide ? (
        <>
          {list}
          {foot}
        </>
      ) : (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-4 rounded-panel border border-separator bg-surface px-3">
          <summary className="flex min-h-11 items-center font-semibold">
            Contents · {viewed} / {total}
          </summary>
          <div className="pb-3">
            {list}
            {foot}
          </div>
        </details>
      )}
    </div>
  );
};
