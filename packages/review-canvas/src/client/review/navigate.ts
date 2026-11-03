/**
 * Moving through the one-scroll review page: the hash contract (`#tour/N`, `#files`, `#files/PATH`, `#ELEMENT-ID`),
 * J and K between stops, N for the next strip's target, the other page keys in keys.ts, and the scroll-spy that marks
 * where the reviewer is. In the source view a stop is a place in the guide beside the diff: moving to it scrolls the
 * guide there and the diff to the stop's first file. Moving never reads a stop: dwell.ts reads the stops the reviewer
 * keeps on screen.
 *
 * A folded file, gap, or fold of changes renders nothing, so revealing an element is a change of state first: the
 * file unfolds and the fold opens, and the element is there to scroll to on the next frame.
 */
import { RegistryContext } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  commentElementId,
  FINISH_ELEMENT_ID,
  fileElementId,
  type Next,
} from "../../review/next.ts";
import type { CommentId, ReviewId } from "../../schema/primitives.ts";
import { announce } from "../ui/announce.ts";
import { toast } from "../ui/toast.tsx";
import type { RoundKey } from "./data.ts";
import {
  gapStage,
  heldLines,
  holdsLines,
  lastUnit,
  layoutDiff,
  nextStage,
  onVersion,
  parseUnit,
  type Unit,
} from "./diff-model.ts";
import {
  fileOrder,
  flaggedStep,
  pageCommand,
  type Step,
  stepFrom,
  threadOrder,
} from "./keys.ts";
import { hashOf, parseHash } from "./places.ts";
import {
  diffFoldsAtom,
  draftsAtom,
  flaggedOnlyAtom,
  flashAtom,
  foldsAtom,
  guideAtom,
  keyHelpAtom,
  openNotesAtom,
  reattachAtom,
  shortcutsAtom,
  unchangedOpenAtom,
  type View,
} from "./ui.ts";
import type { FileModel, PageModel } from "./view.ts";

/** The block of the file at a path, if the round has the file. A path from the hash can be any text. */
const fileAt = (page: PageModel, path: string): FileModel | undefined => {
  const files: ReadonlyMap<string, FileModel> = page.files;
  return files.get(path);
};

/**
 * The file and unit an element ID names, when the element is in a file's body: a row of the patch, or an unchanged
 * line between hunks.
 */
const placeOf = (
  page: PageModel,
  id: string,
): { readonly path: string; readonly unit?: Unit } | undefined => {
  if (id.startsWith("files/"))
    return fileAt(page, id.slice(6)) === undefined
      ? undefined
      : { path: id.slice(6) };
  for (const model of page.files.values()) {
    const path = model.file.path;
    const note = model.notes.find((item) => item.id === id);
    if (note !== undefined)
      return { path, unit: { kind: "row", index: note.row } };
    const placed = model.placed.find(
      (item) => commentElementId(item.comment.id) === id,
    );
    if (placed !== undefined)
      return { path, unit: { kind: "row", index: placed.end } };
    const context = model.context.find(
      (item) => commentElementId(item.comment.id) === id,
    );
    if (context !== undefined)
      return {
        path,
        unit: lastUnit(layoutOf(model).rows, {
          kind: "lines",
          start: context.start_line,
          end: context.end_line,
        }),
      };
    if (model.orphans.some((comment) => commentElementId(comment.id) === id))
      return { path };
    const unit = new RegExp(`^f${model.index}-([rl][0-9]+)$`).exec(id);
    const parsed = unit?.[1] === undefined ? undefined : parseUnit(unit[1]);
    if (parsed !== undefined) return { path, unit: parsed };
  }
  return undefined;
};

/** A file's diff as its table lays it out. */
const layoutOf = (model: FileModel) =>
  layoutDiff(model.file.patch ?? "", {
    shown: model.shown,
    content: model.file.new_content,
  });

/** The stop a file belongs to, as the contents count it. */
const stopOfPath = (page: PageModel, path: string) =>
  page.stops.findIndex((stop) => stop.owns.some((owned) => owned === path));

/**
 * The last of the marks whose top passed the line under the sticky bars. At the bottom of the page, the last file that
 * shows; above the first mark, the first when it shows.
 */
const markAt = (
  found: NodeListOf<HTMLElement>,
  line: number,
): HTMLElement | undefined => {
  const marks = [...found];
  const atBottom =
    innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
  let current: HTMLElement | undefined;
  for (const mark of marks)
    if (mark.getBoundingClientRect().top <= line) current = mark;
  if (atBottom) {
    const visible = marks.filter(
      (mark) =>
        mark.dataset.path !== undefined &&
        mark.getBoundingClientRect().top < innerHeight,
    );
    current = visible.at(-1) ?? current;
  }
  if (current === undefined) {
    const first = marks[0];
    if (first !== undefined && first.getBoundingClientRect().top < innerHeight)
      current = first;
  }
  return current;
};

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

/**
 * Shows that a jump landed on a thread: it arrives tinted, and a frame later the tint fades. The attribute goes after
 * the fade, so a test or a style can read where the page landed.
 */
const land = (element: HTMLElement) => {
  element.dataset.landed = "arrived";
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (element.dataset.landed === "arrived")
        element.dataset.landed = "fading";
    }),
  );
  setTimeout(() => {
    if (element.dataset.landed === "fading")
      element.removeAttribute("data-landed");
  }, 1500);
};

/**
 * Scrolls the rail's own scroller so an element of it shows, and nothing else: the page around the rail stays where
 * it is. Only a wide page's rail scrolls on its own and carries `data-rail-scroll`; false for one in a disclosure.
 */
const scrollRail = (
  element: HTMLElement,
  block: "start" | "nearest",
): boolean => {
  const scroller = element.closest<HTMLElement>("[data-rail-scroll]");
  if (scroller === null) return false;
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (block === "start") scroller.scrollTop += rect.top - box.top;
  else if (rect.top < box.top) scroller.scrollTop += rect.top - box.top;
  else if (rect.bottom > box.bottom)
    scroller.scrollTop += Math.min(
      rect.top - box.top,
      rect.bottom - box.bottom,
    );
  return true;
};

/** Brings a stop of the guide to the top of its scroller and focuses its heading. False when the guide does not scroll. */
export const showGuideStop = (index: number): boolean => {
  const stop = document.getElementById(`guide-stop-${index + 1}`);
  if (stop === null || !scrollRail(stop, "start")) return false;
  stop.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  return true;
};

/** Puts focus on a file's line cursor, or its first line: where an arrow from the file's heading goes. */
const focusLines = (article: Element): boolean => {
  const table = article.querySelector("table[data-patch]");
  const button =
    table?.querySelector<HTMLElement>("[data-add-comment][tabindex='0']") ??
    table?.querySelector<HTMLElement>("[data-unit] [data-add-comment]");
  if (button === null || button === undefined) return false;
  button.closest("[data-unit]")?.scrollIntoView({ block: "nearest" });
  button.focus({ preventScroll: true });
  return true;
};

/** Keeps an element of the rail in its scroller's view, moving it as little as it can. */
export const keepInRail = (element: HTMLElement) => {
  scrollRail(element, "nearest");
};

/**
 * Whether the page has left its top since it opened. Until then the rail stays at its own top, whatever it marks: the
 * reviewer has not moved yet, and a list that opens scrolled reads as broken.
 */
export const useMoved = (): boolean => {
  const [moved, setMoved] = useState(() => scrollY > 0);
  useEffect(() => {
    if (moved) return;
    const look = () => {
      if (scrollY > 0) setMoved(true);
    };
    addEventListener("scroll", look, { passive: true });
    return () => removeEventListener("scroll", look);
  }, [moved]);
  return moved;
};

/** The contents row the scroll-spy marks: `file:PATH` or `stop:N`. Only the contents read it, so scrolling redraws them alone. */
export const spiedAtom = Atom.make<string | undefined>(undefined).pipe(
  Atom.keepAlive,
);

/** The file the spy marks and the stop that owns it, or the stop it marks when it marks no file. */
export const spiedPlace = (
  page: PageModel,
  spied: string | undefined,
): { readonly file: string | undefined; readonly stop: number | undefined } => {
  const file =
    spied?.startsWith("file:") === true
      ? spied.slice("file:".length)
      : undefined;
  if (file !== undefined) {
    const stop = stopOfPath(page, file);
    return { file, stop: stop === -1 ? undefined : stop };
  }
  return {
    file: undefined,
    stop:
      spied?.startsWith("stop:") === true
        ? Number(spied.slice("stop:".length))
        : undefined,
  };
};

/** An excerpt's rows in a file's diff, or one note on them, as the guide links to them. */
export interface ExcerptTarget {
  readonly path: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** The note's element ID, when the link is to one. */
  readonly note?: string;
}

export const useNavigate = (key: RoundKey, page: PageModel, view: View) => {
  const registry = useContext(RegistryContext);
  /** The tour position: the stop J and K move from, and until when scrolling is the page's own and moves nothing. */
  const tour = useRef({ stop: -1, steeringUntil: 0 });
  /** The thread T last went to, which it moves from when focus is in no thread. */
  const thread = useRef<CommentId | undefined>(undefined);
  return useMemo(() => {
    const steer = () => {
      tour.current.steeringUntil = Date.now() + 900;
    };
    /** Whether the page scrolled itself a moment ago, so scrolling now is not the reviewer's. */
    const steering = () => Date.now() <= tour.current.steeringUntil;

    /**
     * Unfolds what holds an element and opens the gap or the fold of changes its row is in, so the element renders.
     * In the source view a note shows only when opened, so it opens.
     */
    const revealState = (id: string) => {
      // The source view shows a stop's comments in the guide's walkthrough, which a narrower page folds away, and
      // which lists an unflagged stop only while Flagged only is off.
      const onStop =
        view === "source"
          ? [...page.stopComments].find(([, comments]) =>
              comments.some((comment) => commentElementId(comment.id) === id),
            )?.[0]
          : undefined;
      if (onStop !== undefined) {
        const guide = registry.get(guideAtom(key.id));
        if (guide.tab !== "walkthrough" || !guide.open)
          registry.set(guideAtom(key.id), { tab: "walkthrough", open: true });
        if (
          page.stops[onStop]?.attention === null &&
          registry.get(flaggedOnlyAtom(key.id))
        )
          registry.set(flaggedOnlyAtom(key.id), false);
        return;
      }
      const place = placeOf(page, id);
      if (place === undefined) return;
      if (
        view === "source" &&
        fileAt(page, place.path)?.notes.some((note) => note.id === id) === true
      ) {
        const notes = registry.get(openNotesAtom(key.id));
        if (!notes.has(id))
          registry.set(openNotesAtom(key.id), new Set([...notes, id]));
      }
      const model = fileAt(page, place.path);
      if (model === undefined) return;
      // A file unchanged since the last review shows once its list's disclosure opens.
      const list = view === "source" ? "source" : stopOfPath(page, place.path);
      if (model.since?.kind === "unchanged" && list !== -1) {
        const disclosure = unchangedOpenAtom({ review: key.id, list });
        if (!registry.get(disclosure)) registry.set(disclosure, true);
      }
      const folds = registry.get(foldsAtom(key));
      if (folds[place.path] !== "open")
        registry.set(foldsAtom(key), { ...folds, [place.path]: "open" });
      const unit = place.unit;
      if (unit === undefined || model.file.patch === undefined) return;
      const held = heldLines(
        model.context,
        registry
          .get(draftsAtom(key.id))
          .map((draft) => draft.selection)
          .filter(
            (selection) =>
              selection.path === model.file.path && onVersion(selection, model),
          ),
      );
      const foldsOfFile = diffFoldsAtom({
        path: model.file.path,
        digest: model.digest,
      });
      const before = registry.get(foldsOfFile);
      let opened = before;
      for (const segment of layoutOf(model).segments) {
        switch (segment.kind) {
          case "rows":
            continue;
          case "changes":
            if (
              unit.kind === "row" &&
              segment.rows.some((item) => item.index === unit.index)
            )
              opened = {
                ...opened,
                changes: { ...opened.changes, [segment.key]: true },
              };
            continue;
          case "gap": {
            const stage = gapStage(
              opened.gaps[segment.key],
              segment,
              holdsLines(segment, held),
            );
            // A folded row shows from the gap's first stage, an unchanged line only from its last.
            const holds = segment.parts.some((part) =>
              unit.kind === "row"
                ? part.kind === "folded" &&
                  part.rows.some((item) => item.index === unit.index)
                : part.kind === "context" &&
                  part.lines.some((line) => line.new === unit.line),
            );
            if (!holds) continue;
            const stageNow =
              unit.kind === "line"
                ? 2
                : stage === 0
                  ? nextStage(0, segment)
                  : stage;
            if (stageNow !== stage)
              opened = {
                ...opened,
                gaps: { ...opened.gaps, [segment.key]: stageNow },
              };
            continue;
          }
        }
      }
      if (opened !== before) registry.set(foldsOfFile, opened);
    };

    const reveal = async (id: string) => {
      revealState(id);
      return shown(id);
    };

    const showStop = async (
      index: number,
      options: { readonly keepHash?: boolean; readonly scroll?: boolean } = {},
    ) => {
      if (page.stops.length === 0) return;
      const stop = Math.max(0, Math.min(index, page.stops.length - 1));
      tour.current.stop = stop;
      if (options.keepHash !== true)
        history.replaceState(null, "", `#tour/${stop + 1}`);
      if (options.scroll === false) return;
      if (view === "source") {
        // The guide goes to the stop and the diff to the stop's first file; the hash stays the stop's.
        steer();
        const guided = showGuideStop(stop);
        const path = page.stops[stop]?.owns[0];
        const article =
          path === undefined ? null : await reveal(fileElementId(path));
        steer();
        article?.scrollIntoView({ block: "start" });
        if (!guided)
          article
            ?.querySelector<HTMLElement>("h3")
            ?.focus({ preventScroll: true });
        return;
      }
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
      (
        section.querySelector<HTMLElement>("input[name='verdict']") ??
        section.querySelector<HTMLElement>("h2")
      )?.focus({
        preventScroll: true,
      });
    };

    /** Brings an answer or a file into view and focuses what acts on it: Accept, or Viewed. */
    const go = async (next: Extract<Next, { kind: "answer" | "file" }>) => {
      const target = await reveal(next.target);
      if (target === null) return;
      if (next.kind === "file") {
        const stop = stopOfPath(page, next.path);
        if (stop !== -1) tour.current.stop = stop;
      }
      const focus =
        next.kind === "answer"
          ? (target.querySelector<HTMLElement>("[data-accept]") ?? target)
          : (target.querySelector<HTMLElement>("[data-viewed]") ??
            target.querySelector<HTMLElement>("h3") ??
            target);
      steer();
      target.scrollIntoView({ block: "start" });
      focus.focus({ preventScroll: true });
      if (next.kind === "answer") land(target);
    };

    /** Brings a comment into view and focuses it, as a row of the pending list does, and shows where it landed. */
    const goComment = async (comment: CommentId) => {
      const target = await reveal(commentElementId(comment));
      if (target === null) return;
      const section = target.closest<HTMLElement>("section[data-stop]");
      if (section !== null) tour.current.stop = Number(section.dataset.stop);
      steer();
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
      land(target);
    };

    /** Brings the next strip's target into view and focuses what acts on it. */
    const goNext = async () => {
      if (page.strip.kind !== "go") return;
      const { next } = page.strip;
      return next.kind === "finish" ? goFinish() : go(next);
    };

    /** Goes where one of the strip's steps points: the first answer to read, or the first file not viewed. */
    const goStep = async (step: "answer" | "file") => {
      const next = page.steps[step];
      if (next !== undefined) await go(next);
    };

    /**
     * The file focus is in, or else the last whose top passed the line under the sticky bars. Above the first file,
     * none: F then goes to the first.
     */
    const currentFile = () => {
      const line =
        (document.querySelector("[data-next]")?.getBoundingClientRect()
          .bottom ?? 0) + 12;
      const path =
        document.activeElement?.closest<HTMLElement>("main article[data-path]")
          ?.dataset.path ??
        [...document.querySelectorAll<HTMLElement>("main article[data-path]")]
          .filter((article) => article.getBoundingClientRect().top <= line)
          .at(-1)?.dataset.path;
      return [...page.files.keys()].find((item) => item === path);
    };

    /** F and Shift+F: the next or previous file in the page's order, from the current one. */
    const stepFile = async (step: Step) => {
      const path = stepFrom(fileOrder(page, view), currentFile(), step);
      if (path === undefined)
        return toast(
          step === 1 ? "This is the last file." : "This is the first file.",
        );
      history.replaceState(null, "", hashOf(fileElementId(path)));
      await showFile(path);
    };

    /**
     * T and Shift+T: the next or previous thread in the page's order, from the one focus is in or else the one T last
     * went to. The thread's file unfolds and its gap opens.
     */
    const stepThread = async (step: Step) => {
      const order = threadOrder(page, view);
      const focused = document.activeElement?.closest<HTMLElement>(
        "article[data-comment]",
      )?.dataset.comment;
      const current =
        order.find((id) => id === focused) ??
        order.find((id) => id === thread.current);
      const next = stepFrom(order, current, step);
      if (next === undefined)
        return toast(
          order.length === 0
            ? "There are no threads yet."
            : step === 1
              ? "This is the last thread."
              : "This is the first thread.",
        );
      thread.current = next;
      const target = await reveal(commentElementId(next));
      if (target === null) return;
      steer();
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
      land(target);
      announce(`Thread ${order.indexOf(next) + 1} of ${order.length}.`);
    };

    /**
     * V: marks the current file viewed, or not viewed, through its Viewed control. Focus on the file's lines goes to its
     * heading first, since viewing folds the file. While some of its changes were never shown, the control asks first,
     * and its dialog speaks instead.
     */
    const toggleViewed = () => {
      const path = currentFile();
      const article =
        path === undefined
          ? null
          : document.getElementById(fileElementId(path));
      const button = article?.querySelector<HTMLElement>("button[data-viewed]");
      if (
        path === undefined ||
        article === null ||
        button === null ||
        button === undefined
      )
        return toast(
          path === undefined
            ? "Move to a file first."
            : "This file cannot be marked viewed.",
        );
      const viewed = button.getAttribute("aria-pressed") !== "true";
      if (article.contains(document.activeElement))
        article
          .querySelector<HTMLElement>("h3")
          ?.focus({ preventScroll: true });
      const asks = viewed && button.dataset.unseen !== undefined;
      button.click();
      if (!asks) announce(`${path} ${viewed ? "viewed" : "not viewed"}.`);
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
          if (section !== null)
            tour.current.stop = Number(section.dataset.stop);
          if (element.id === "main") return;
          steer();
          element.scrollIntoView({
            block: element.matches("section, article") ? "start" : "center",
          });
          if (element.matches("article[data-comment]")) land(element);
          return;
        }
      }
    };

    /** Lights the rows a later stop points back at, for a moment, after bringing the first into view. */
    const flash = async (
      path: string,
      index: number,
      start: number,
      end: number,
    ) => {
      revealState(`f${index}-r${start}`);
      // Lit before the scroll: a whitespace-only deletion the reviewer hides shows while it is lit.
      registry.set(flashAtom(key.id), { path, start, end });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      document
        .querySelector(`table[data-table="f${index}"] [data-row="${start}"]`)
        ?.scrollIntoView({ block: "center" });
      setTimeout(() => {
        const now = registry.get(flashAtom(key.id));
        if (now?.path === path && now.start === start)
          registry.set(flashAtom(key.id), undefined);
      }, 2000);
    };

    /**
     * Goes to an excerpt's rows in the diff from the guide, or to a note on them, and lights the rows for a moment.
     * Focus goes to the note, or to the first row's line numbers.
     */
    const showExcerpt = async (target: ExcerptTarget) => {
      const { path, index, start, end, note } = target;
      const stop = stopOfPath(page, path);
      if (stop !== -1) tour.current.stop = stop;
      revealState(note ?? `f${index}-r${start}`);
      // Lit before the scroll: a whitespace-only deletion the reviewer hides shows while it is lit.
      registry.set(flashAtom(key.id), { path, start, end });
      const found =
        note === undefined
          ? await new Promise<HTMLElement | null>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  resolve(
                    document.querySelector<HTMLElement>(
                      `table[data-table="f${index}"] [data-row="${start}"]`,
                    ),
                  ),
                ),
              ),
            )
          : await shown(note);
      // Showing only the changes since the last review, a changed file has no rows of the round's patch: the excerpt
      // lands on the file.
      const landing =
        found ??
        (note === undefined
          ? document.getElementById(fileElementId(path))
          : null);
      if (landing !== null) {
        steer();
        landing.scrollIntoView({ block: "start" });
        const focus =
          landing instanceof HTMLTableRowElement && note === undefined
            ? (landing.cells[0] ?? landing)
            : landing;
        focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
      setTimeout(() => {
        const now = registry.get(flashAtom(key.id));
        if (now?.path === path && now.start === start)
          registry.set(flashAtom(key.id), undefined);
      }, 2000);
    };

    /**
     * Marks where the reviewer is: when the reviewer scrolled rather than the page, the stop J and K count from, the
     * last whose heading passed under the sticky bars. Returns the file or stop row the contents mark as current.
     */
    const spy = (): string | undefined => {
      if (view === "source") return spySource();
      const line =
        (document.querySelector("[data-next]")?.getBoundingClientRect()
          .bottom ?? 0) + 12;
      const heads = page.stops.map((_, at) =>
        document.getElementById(`stop-${at + 1}-title`),
      );
      const passed = heads.flatMap((head, at) =>
        head !== null && head.getBoundingClientRect().top <= line ? [at] : [],
      );
      if (!steering()) {
        const first = heads[0];
        tour.current.stop =
          passed.at(-1) ??
          (first !== null &&
          first !== undefined &&
          first.getBoundingClientRect().top < innerHeight
            ? 0
            : -1);
      }
      const end = document.querySelector("[data-end-section]");
      if (end !== null && end.getBoundingClientRect().top <= line)
        return undefined;
      const current = markAt(
        document.querySelectorAll<HTMLElement>(
          "[data-stop] > [data-stop-head], [data-stop] article[data-path]",
        ),
        line,
      );
      if (current === undefined) return undefined;
      if (current.dataset.path !== undefined)
        return `file:${current.dataset.path}`;
      const stop = Number(
        current.closest<HTMLElement>("[data-stop]")?.dataset.stop ?? -1,
      );
      const owned = page.stops[stop]?.owns[0];
      return owned === undefined ? `stop:${stop}` : `file:${owned}`;
    };

    /**
     * The spy in the source view, where the diff is in path order: the file at the line, and when the reviewer scrolled
     * rather than the page, the stop that owns it is the one J and K count from. Before the first file reaches the
     * line, nothing is marked and J and K count from before the first stop.
     */
    const spySource = (): string | undefined => {
      const line =
        (document.querySelector("[data-next]")?.getBoundingClientRect()
          .bottom ?? 0) + 12;
      const end = document.querySelector("[data-end-section]");
      if (end !== null && end.getBoundingClientRect().top <= line)
        return undefined;
      const articles = document.querySelectorAll<HTMLElement>(
        "main article[data-path]",
      );
      // Above the first file the reviewer has read nothing yet, and J goes to the first stop.
      const first = articles[0];
      if (first === undefined || first.getBoundingClientRect().top > line) {
        if (!steering()) tour.current.stop = -1;
        return undefined;
      }
      const path = markAt(articles, line)?.dataset.path;
      if (path === undefined) return undefined;
      const stop = stopOfPath(page, path);
      if (stop !== -1 && !steering()) tour.current.stop = stop;
      return `file:${path}`;
    };

    /**
     * J and K: the next or previous stop, or while the stop lists show only flagged stops, the next or previous of
     * those.
     */
    const stepStop = async (step: Step) => {
      if (!registry.get(flaggedOnlyAtom(key.id)))
        return showStop(tour.current.stop + step);
      const target = flaggedStep(page.stops, tour.current.stop, step);
      if (target === undefined)
        return toast(
          page.stops.every((stop) => stop.attention === null)
            ? "No stop is flagged."
            : step === 1
              ? "This is the last flagged stop."
              : "This is the first flagged stop.",
        );
      return showStop(target);
    };

    return {
      reveal,
      showExcerpt,
      steering,
      showStop,
      showFile,
      stepFile,
      stepThread,
      toggleViewed,
      goNext,
      goStep,
      goComment,
      goFinish,
      applyHash,
      flash,
      spy,
      stepStop,
    };
  }, [registry, key, page, view]);
};

export type Navigation = ReturnType<typeof useNavigate>;

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

/** Esc stops moving a comment of the review. */
export const useCancelReattach = (review: ReviewId) => {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        registry.get(reattachAtom(review)) === undefined
      )
        return;
      registry.set(reattachAtom(review), undefined);
      toast("The comment stays where it was.");
    };
    document.addEventListener("keydown", cancel);
    return () => document.removeEventListener("keydown", cancel);
  }, [review, registry]);
};

/** Where a key is the focused element's own: text fields, dialogs and confirmations, and menus, which type ahead. */
const KEYS_OWN =
  "textarea, input, select, [role='dialog'], [role='alertdialog'], [role='menu']";

/**
 * The page keys of keys.ts: J and K between stops, N for the next thing to do, F and T between files and threads, V,
 * E, and ? for the key help. None fires from a text field, a dialog, or a menu, or when the reviewer turned them off. An arrow
 * on a file's heading goes to its lines, whatever the setting: it acts only where focus is. Esc stops moving a comment.
 */
export const useKeys = (review: ReviewId, navigate: Navigation) => {
  const registry = useContext(RegistryContext);
  useCancelReattach(review);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest(KEYS_OWN) !== null)
      )
        return;
      if (
        event.key === "ArrowDown" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        target instanceof HTMLElement
      ) {
        const article = target
          .closest("[data-file-head]")
          ?.closest("article[data-path]");
        if (article !== null && article !== undefined && focusLines(article))
          event.preventDefault();
        return;
      }
      if (!registry.get(shortcutsAtom)) return;
      const command = pageCommand(event);
      if (command === undefined) return;
      event.preventDefault();
      switch (command.kind) {
        case "stop":
          return void navigate.stepStop(command.step);
        case "next":
          return void navigate.goNext();
        case "file":
          return void navigate.stepFile(command.step);
        case "thread":
          return void navigate.stepThread(command.step);
        case "viewed":
          return navigate.toggleViewed();
        case "finish":
          return void navigate.goFinish();
        case "help":
          return registry.set(keyHelpAtom, {
            open: true,
            returnTo:
              target instanceof HTMLElement && target !== document.body
                ? target
                : undefined,
          });
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [navigate, registry]);
};
