/**
 * Reading a stop by having it on screen. A stop is read once most of its body stayed in view for a dwell time; moving
 * never reads one, so a jump, a link, or a fast scroll passes stops by without reading them. The body is cut into
 * bands, each seen once it stayed in view for the dwell time, so a stop taller than the screen is read as the reviewer
 * scrolls through it at a reading pace.
 *
 * The tracker is pure, so tests drive it with numbers. `useDwellRead` measures the page and marks on the server the
 * stops the tracker reads.
 */
import { useAtomValue } from "@effect/atom-react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";
import { type RoundKey, workspaceAtom } from "./data.ts";
import type { View } from "./ui.ts";
import { autoRead, type PageModel } from "./view.ts";

/** How long part of a stop must stay in view to count as seen. */
export const DWELL_MS = 2000;

/** How many bands a stop's body is cut into. */
export const BANDS = 20;

/** How many of a stop's bands must be seen to read it: most of its body. */
const MOST = Math.ceil(BANDS * 0.6);

/**
 * A band of a stop's body in view or seen: in view since a time; in view while the stop was read, when it counts only
 * once it left the view and came back; or seen, and whether it is in view now. A band out of view and not seen has no
 * entry.
 */
type Band =
  | { readonly kind: "viewing"; readonly since: number }
  | { readonly kind: "held" }
  | { readonly kind: "seen"; readonly inView: boolean };

/** What the page saw of each stop, by the stop's index: its bands, by their number. */
export type Sights = ReadonlyMap<number, ReadonlyMap<number, Band>>;

/** The part of a stop's body in view, as fractions of its height from its top. */
export interface InView {
  readonly from: number;
  readonly to: number;
}

/** A box's top and bottom, or a view's, in the same coordinates. */
export interface Span {
  readonly top: number;
  readonly bottom: number;
}

/** The part of a box inside a view, as fractions of the box's height; none when nothing of it is in view. */
export const inView = (box: Span, view: Span): InView | undefined => {
  const height = box.bottom - box.top;
  const top = Math.max(box.top, view.top);
  const bottom = Math.min(box.bottom, view.bottom);
  if (height <= 0 || bottom <= top) return undefined;
  return { from: (top - box.top) / height, to: (bottom - box.top) / height };
};

/** The bands whose middle is in view. */
const bandsIn = (part: InView): ReadonlyArray<number> =>
  Array.from({ length: BANDS }, (_, band) => band).filter((band) => {
    const middle = (band + 0.5) / BANDS;
    return middle >= part.from && middle <= part.to;
  });

/**
 * One look at the page: what part of each stop is in view at a time. A band seen stays seen; a band in view long
 * enough becomes seen; a band that left the view starts again. Returns what the page saw, and the stops most of whose
 * bands it has seen.
 */
export const look = (
  sights: Sights,
  views: ReadonlyMap<number, InView>,
  now: number,
): { readonly sights: Sights; readonly read: ReadonlyArray<number> } => {
  const next = new Map<number, ReadonlyMap<number, Band>>();
  for (const stop of new Set([...sights.keys(), ...views.keys()])) {
    const before = sights.get(stop) ?? new Map<number, Band>();
    const part = views.get(stop);
    const shown = new Set(part === undefined ? [] : bandsIn(part));
    const bands = new Map<number, Band>();
    for (const band of new Set([...before.keys(), ...shown])) {
      const was = before.get(band);
      const inView = shown.has(band);
      if (was?.kind === "seen") bands.set(band, { kind: "seen", inView });
      else if (!inView) continue;
      else if (was === undefined)
        bands.set(band, { kind: "viewing", since: now });
      else if (was.kind === "held") bands.set(band, was);
      else
        bands.set(
          band,
          now - was.since >= DWELL_MS ? { kind: "seen", inView } : was,
        );
    }
    if (bands.size > 0) next.set(stop, bands);
  }
  const read = [...next]
    .filter(
      ([, bands]) =>
        [...bands.values()].filter((band) => band.kind === "seen").length >=
        MOST,
    )
    .map(([stop]) => stop);
  return { sights: next, read };
};

/**
 * What the page saw of a stop that is read, or was marked read a moment ago: none of it. What is in view now counts
 * only once it leaves the view and comes back, so a stop marked unread while the reviewer looks at it is not read again
 * at once.
 */
export const unsee = (sights: Sights, stop: number): Sights => {
  const bands = sights.get(stop);
  if (bands === undefined) return sights;
  const held = new Map<number, Band>();
  for (const [band, was] of bands)
    if (was.kind !== "seen" || was.inView) held.set(band, { kind: "held" });
  const next = new Map(sights);
  if (held.size === 0) next.delete(stop);
  else next.set(stop, held);
  return next;
};

/** What the page saw of a stop after a mark of it was refused or lost: nothing, so it is asked again once earned again. */
export const forget = (sights: Sights, stop: number): Sights => {
  const next = new Map(sights);
  next.delete(stop);
  return next;
};

/** The line under the sticky bars, where the page's view of the review starts. */
const viewTop = () =>
  document.querySelector("[data-next]")?.getBoundingClientRect().bottom ?? 0;

/**
 * Each stop's body in view now. In the guided view a stop's body is its section; in the source view it is its place
 * in the guide, which on a wide page scrolls on its own, so its view is the guide's scroller. A hidden tab shows none.
 */
const measure = (view: View): ReadonlyMap<number, InView> => {
  const views = new Map<number, InView>();
  if (document.visibilityState !== "visible") return views;
  const page: Span = { top: viewTop(), bottom: innerHeight };
  const bodies = document.querySelectorAll<HTMLElement>(
    view === "source" ? "li[data-guide-stop]" : "section[data-stop]",
  );
  for (const body of bodies) {
    const stop = Number(
      view === "source" ? body.dataset.guideStop : body.dataset.stop,
    );
    const scroller = body
      .closest<HTMLElement>("[data-rail-scroll]")
      ?.getBoundingClientRect();
    const clip: Span =
      scroller === undefined
        ? page
        : {
            top: Math.max(page.top, scroller.top),
            bottom: Math.min(page.bottom, scroller.bottom),
          };
    const part = inView(body.getBoundingClientRect(), clip);
    if (part !== undefined) views.set(stop, part);
  }
  return views;
};

/** How often the page looks while nothing scrolls, so a stop kept still on screen is read. */
const LOOK_EVERY_MS = 250;

/**
 * Marks on the server the stops the reviewer has kept on screen, as the tracker reads them. A stop the reading shows
 * read or changed starts again at every look, so once it is unread, whoever marked it so, it is read only after the
 * reviewer comes back to it; a changed stop stays changed until the reviewer marks it read. A refused or lost mark is
 * asked again once the stop is earned again. A closed review keeps no reading.
 */
export const useDwellRead = (key: RoundKey, page: PageModel, view: View) => {
  const workspace = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(workspaceAtom(key.id))),
  );
  const latest = useRef({ page, view, workspace });
  useEffect(() => {
    latest.current = { page, view, workspace };
  });
  useEffect(() => {
    let sights: Sights = new Map();
    // Stops whose mark is on its way to the server.
    const asking = new Set<number>();
    const tick = () => {
      const { page, view, workspace } = latest.current;
      const reading = page.reading;
      for (const [stop, read] of reading.stops)
        if (read.state !== "unread") sights = unsee(sights, stop);
      const seen = look(sights, measure(view), performance.now());
      sights = seen.sights;
      if (workspace === undefined || !page.writable) return;
      for (const stop of autoRead(reading, seen.read)) {
        if (asking.has(stop)) continue;
        asking.add(stop);
        void workspace
          .read({ kind: "read", round: key.round, stop })
          .then((exit) => {
            asking.delete(stop);
            // Read now, though the page's reading may not show it yet; refused, it must be earned again.
            sights = Exit.isSuccess(exit)
              ? unsee(sights, stop)
              : forget(sights, stop);
          });
      }
    };
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        tick();
      });
    };
    const timer = setInterval(tick, LOOK_EVERY_MS);
    // Captured, so the guide's own scroller counts as well as the page's.
    addEventListener("scroll", onScroll, { capture: true, passive: true });
    tick();
    return () => {
      clearInterval(timer);
      removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [key.id, key.round]);
};
