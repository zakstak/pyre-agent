/**
 * Moving through the one-scroll review page: the hash contract (`#tour/N`, `#files`, `#files/PATH`, `#ELEMENT-ID`),
 * J and K between stops, N for the next strip's target, and the scroll-spy that marks where the reviewer is.
 *
 * A folded file or gap renders nothing, so revealing an element is a change of state first: the file unfolds and the
 * gap opens, and the element is there to scroll to on the next frame.
 */
import { RegistryContext } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef } from "react";
import { commentElementId, FINISH_ELEMENT_ID, fileElementId } from "../../review/next.ts";
import { toast } from "../ui/toast.tsx";
import type { RoundKey } from "./data.ts";
import { layoutDiff, nextStage } from "./diff-model.ts";
import { parseHash } from "./places.ts";
import { flashAtom, foldsAtom, gapAtom, reattachAtom, seenAtom } from "./ui.ts";
import type { FileModel, PageModel } from "./view.ts";

/** The block of the file at a path, if the round has the file. A path from the hash can be any text. */
const fileAt = (page: PageModel, path: string): FileModel | undefined => {
  const files: ReadonlyMap<string, FileModel> = page.files;
  return files.get(path);
};

/** The file and row an element ID names, when the element is in a file's body. */
const placeOf = (page: PageModel, id: string): { readonly path: string; readonly row?: number } | undefined => {
  if (id.startsWith("files/")) return fileAt(page, id.slice(6)) === undefined ? undefined : { path: id.slice(6) };
  for (const model of page.files.values()) {
    const note = model.notes.find((item) => item.id === id);
    if (note !== undefined) return { path: model.file.path, row: note.row };
    const placed = model.placed.find((item) => commentElementId(item.comment.id) === id);
    if (placed !== undefined) return { path: model.file.path, row: placed.end };
    if (model.orphans.some((comment) => commentElementId(comment.id) === id)) return { path: model.file.path };
    const row = new RegExp(`^f${model.index}-r([0-9]+)$`).exec(id);
    if (row !== null) return { path: model.file.path, row: Number(row[1]) };
  }
  return undefined;
};

/** The stop a file belongs to, as the contents count it. */
const stopOfPath = (page: PageModel, path: string) => page.stops.findIndex((stop) => stop.owns.some((owned) => owned === path));

/** Waits until the page shows an element, for a few frames at most. */
const shown = (id: string): Promise<HTMLElement | null> =>
  new Promise((resolve) => {
    let frames = 0;
    const look = () => {
      const element = document.getElementById(id);
      if (element !== null || frames++ > 10) resolve(element);
      else requestAnimationFrame(look);
    };
    look();
  });

/** The contents row the scroll-spy marks: `file:PATH` or `stop:N`. Only the contents read it, so scrolling redraws them alone. */
export const spiedAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

export const useNavigate = (key: RoundKey, page: PageModel) => {
  const registry = useContext(RegistryContext);
  /** The tour position: the stop J and K move from, and until when scrolling is the page's own and moves nothing. */
  const tour = useRef({ stop: -1, steeringUntil: 0 });
  return useMemo(() => {
    const steer = () => {
      tour.current.steeringUntil = Date.now() + 900;
    };

    const markRead = (indexes: ReadonlyArray<number>) => {
      const seen = registry.get(seenAtom(key));
      const next = [...new Set([...seen, ...indexes])].sort((a, b) => a - b);
      if (next.length !== seen.length) registry.set(seenAtom(key), next);
    };

    /** Unfolds what holds an element and opens the gap its row is in, so the element renders. */
    const revealState = (id: string) => {
      const place = placeOf(page, id);
      if (place === undefined) return;
      const model = fileAt(page, place.path);
      if (model === undefined) return;
      const folds = registry.get(foldsAtom(key));
      if (folds[place.path] !== "open") registry.set(foldsAtom(key), { ...folds, [place.path]: "open" });
      if (place.row === undefined || model.file.patch === undefined) return;
      const row = place.row;
      const layout = layoutDiff(model.file.patch, { shown: model.shown, content: model.file.new_content });
      for (const segment of layout.segments) {
        if (segment.kind !== "gap") continue;
        const holds = segment.parts.some((part) => part.kind === "folded" && part.rows.some((item) => item.index === row));
        if (!holds) continue;
        const gap = gapAtom({ path: model.file.path, digest: model.digest, gap: segment.key });
        if (registry.get(gap) === 0) registry.set(gap, nextStage(0, segment));
      }
    };

    const reveal = async (id: string) => {
      revealState(id);
      return shown(id);
    };

    const showStop = async (index: number, options: { readonly keepHash?: boolean; readonly scroll?: boolean } = {}) => {
      if (page.stops.length === 0) return;
      const stop = Math.max(0, Math.min(index, page.stops.length - 1));
      tour.current.stop = stop;
      markRead([stop]);
      if (options.keepHash !== true) history.replaceState(null, "", `#tour/${stop + 1}`);
      if (options.scroll === false) return;
      const heading = await shown(`stop-${stop + 1}-title`);
      steer();
      heading?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
    };

    const showFile = async (path: string) => {
      const article = await reveal(fileElementId(path));
      if (article === null) return;
      const stop = stopOfPath(page, path);
      if (stop !== -1) tour.current.stop = stop;
      steer();
      article.scrollIntoView({ block: "start" });
      article.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    };

    const goFinish = async () => {
      const section = await shown(FINISH_ELEMENT_ID);
      if (section === null) return;
      steer();
      section.scrollIntoView({ block: "start" });
      (section.querySelector<HTMLElement>("input[name='verdict']") ?? section.querySelector<HTMLElement>("h2"))?.focus({
        preventScroll: true,
      });
    };

    /** Brings the next strip's target into view and focuses what acts on it. */
    const goNext = async () => {
      if (page.strip.kind !== "go") return;
      const { next } = page.strip;
      if (next.kind === "finish") return goFinish();
      const target = await reveal(next.target);
      if (target === null) return;
      if (next.kind === "file") {
        const stop = stopOfPath(page, next.path);
        if (stop !== -1) tour.current.stop = stop;
      }
      const focus =
        next.kind === "answer"
          ? (target.querySelector<HTMLElement>("[data-accept]") ?? target)
          : (target.querySelector<HTMLElement>("[data-viewed]") ?? target.querySelector<HTMLElement>("h3") ?? target);
      steer();
      target.scrollIntoView({ block: next.kind === "file" ? "start" : "center" });
      focus.focus({ preventScroll: true });
    };

    /** Where the hash says the page is. */
    const applyHash = async () => {
      const place = parseHash(location.hash);
      switch (place.kind) {
        case "files": {
          // The first file the page shows, in tour order.
          const path = place.file ?? page.stops.flatMap((stop) => stop.owns)[0];
          if (path !== undefined) await showFile(path);
          return;
        }
        case "stop":
          return showStop(place.index, { keepHash: true });
        case "start":
          return;
        case "element": {
          const element = await reveal(place.id);
          if (element === null) return;
          const section = element.closest<HTMLElement>("section[data-stop]");
          if (section !== null) {
            tour.current.stop = Number(section.dataset.stop);
            if (element === section) markRead([tour.current.stop]);
          }
          if (element.id === "main") return;
          steer();
          element.scrollIntoView({ block: element.matches("section, article") ? "start" : "center" });
          return;
        }
      }
    };

    /** Lights the rows a later stop points back at, for a moment, after bringing the first into view. */
    const flash = async (path: string, index: number, start: number, end: number) => {
      revealState(`f${index}-r${start}`);
      // Lit before the scroll: a whitespace-only deletion the reviewer hides shows while it is lit.
      registry.set(flashAtom, { path, start, end });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.querySelector(`table[data-table="f${index}"] [data-row="${start}"]`)?.scrollIntoView({ block: "center" });
      setTimeout(() => {
        const now = registry.get(flashAtom);
        if (now?.path === path && now.start === start) registry.set(flashAtom, undefined);
      }, 2000);
    };

    /**
     * Marks where the reviewer is: the stops whose headings passed under the sticky bars are read, and, when the
     * reviewer scrolled rather than the page, the stop J and K count from. Returns the file or stop row the contents
     * mark as current.
     */
    const spy = (): string | undefined => {
      const line = (document.querySelector("[data-next]")?.getBoundingClientRect().bottom ?? 0) + 12;
      const heads = page.stops.map((_, at) => document.getElementById(`stop-${at + 1}-title`));
      const passed = heads.flatMap((head, at) => (head !== null && head.getBoundingClientRect().top <= line ? [at] : []));
      if (passed.length > 0) markRead(passed);
      if (Date.now() > tour.current.steeringUntil) {
        const first = heads[0];
        tour.current.stop =
          passed.at(-1) ??
          (first !== null && first !== undefined && first.getBoundingClientRect().top < innerHeight ? 0 : -1);
      }
      const end = document.querySelector("[data-end-section]");
      if (end !== null && end.getBoundingClientRect().top <= line) return undefined;
      const marks = [...document.querySelectorAll<HTMLElement>("[data-stop] > [data-stop-head], [data-stop] article[data-path]")];
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      let current: HTMLElement | undefined;
      for (const mark of marks) if (mark.getBoundingClientRect().top <= line) current = mark;
      if (atBottom) {
        const visible = marks.filter((mark) => mark.dataset.path !== undefined && mark.getBoundingClientRect().top < innerHeight);
        current = visible.at(-1) ?? current;
      }
      if (current === undefined) {
        const first = marks[0];
        if (first !== undefined && first.getBoundingClientRect().top < innerHeight) current = first;
      }
      if (current === undefined) return undefined;
      if (current.dataset.path !== undefined) return `file:${current.dataset.path}`;
      const stop = Number(current.closest<HTMLElement>("[data-stop]")?.dataset.stop ?? -1);
      const owned = page.stops[stop]?.owns[0];
      return owned === undefined ? `stop:${stop}` : `file:${owned}`;
    };

    return {
      reveal,
      showStop,
      showFile,
      goNext,
      goFinish,
      applyHash,
      flash,
      spy,
      next: () => showStop(tour.current.stop + 1),
      previous: () => showStop(tour.current.stop - 1),
    };
  }, [registry, key, page]);
};

type Navigation = ReturnType<typeof useNavigate>;

/** Goes where the hash says once the page first shows, and again whenever the hash changes. */
export const useHash = (navigate: Navigation) => {
  const applied = useRef(false);
  useEffect(() => {
    if (!applied.current) {
      applied.current = true;
      void navigate.applyHash();
    }
    const change = () => void navigate.applyHash();
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, [navigate]);
};

/** Runs the scroll-spy on scroll and resize, a frame at a time, and marks the contents row it finds. */
export const useScrollSpy = (navigate: Navigation) => {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const spied = navigate.spy();
        if (registry.get(spiedAtom) !== spied) registry.set(spiedAtom, spied);
      });
    };
    run();
    addEventListener("scroll", run, { passive: true });
    addEventListener("resize", run);
    return () => {
      removeEventListener("scroll", run);
      removeEventListener("resize", run);
    };
  }, [navigate, registry]);
};

/** J and K between stops, N for the next thing to do, Esc to stop moving a comment. */
export const useKeys = (navigate: Navigation) => {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && registry.get(reattachAtom) !== undefined) {
        registry.set(reattachAtom, undefined);
        toast("The comment stays where it was.");
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("textarea, input, select, [contenteditable='true']") !== null) return;
      const key = event.key.toLowerCase();
      if (key === "j") void navigate.next();
      else if (key === "k") void navigate.previous();
      else if (key === "n") void navigate.goNext();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [navigate, registry]);
};
