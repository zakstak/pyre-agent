/** Walking the tour: one stop at a time, J and K to move, the rail to jump, and the files view beside it. */
import { parseHash } from "./places.ts";

type View = "tour" | "files";

const storageKey = () =>
  `review-canvas:${document.body.dataset.review}:${document.body.dataset.round}:seen`;

const stops = () => [...document.querySelectorAll<HTMLElement>("article.stop")];

const seenStops = (): Set<number> => {
  try {
    const raw = sessionStorage.getItem(storageKey());
    return new Set(raw === null ? [] : (JSON.parse(raw) as Array<number>));
  } catch {
    return new Set();
  }
};

const rememberSeen = (seen: Set<number>) => {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify([...seen]));
  } catch {
    /* Storage is optional. */
  }
};

let current = 0;
let view: View = "tour";

/** The width at which the rail stands beside the tour; below it, the rail folds into a disclosure. main.css agrees. */
const wide = matchMedia("(min-width: 64rem)");

const railDisclosure = () =>
  document.querySelector<HTMLDetailsElement>(".rail-disclosure");

/** Keeps the rail open where it stands beside the tour. A narrow page leaves it as the reviewer left it. */
export const syncRail = () => {
  const disclosure = railDisclosure();
  if (disclosure !== null && wide.matches) disclosure.open = true;
};

/** After a choice in the folded rail, fold it again, so the stop or file chosen is what shows. */
const foldRail = () => {
  const disclosure = railDisclosure();
  if (disclosure !== null && !wide.matches) disclosure.open = false;
};

const isEditing = () => {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
};

const renderRail = () => {
  const seen = seenStops();
  for (const link of document.querySelectorAll<HTMLElement>(".stop-link")) {
    const index = Number(link.dataset.stopGo);
    link.setAttribute(
      "aria-current",
      index === current && view === "tour" ? "step" : "false",
    );
    link.classList.toggle("seen", seen.has(index));
    const bullet = link.querySelector<HTMLElement>(".stop-bullet");
    if (bullet !== null)
      bullet.textContent = seen.has(index) ? "✓" : String(index + 1);
  }
  for (const place of document.querySelectorAll<HTMLElement>(
    "[data-rail-stop]",
  ))
    place.textContent = String(current + 1);
  const count = document.querySelector<HTMLElement>("[data-seen-count]");
  if (count !== null)
    count.textContent = String(
      [...seen].filter((index) => index < stops().length).length,
    );
};

/**
 * Shows one stop, remembers it as read, and keeps the location in the hash, unless the hash already names something
 * in the stop, such as a note.
 */
export const showStop = (
  index: number,
  options: { readonly scroll?: boolean; readonly keepHash?: boolean } = {},
) => {
  const all = stops();
  if (all.length === 0) return;
  current = Math.max(0, Math.min(index, all.length - 1));
  for (const [at, stop] of all.entries()) stop.hidden = at !== current;
  const seen = seenStops();
  seen.add(current);
  rememberSeen(seen);
  setView("tour", { keepHash: true });
  if (options.keepHash !== true)
    history.replaceState(null, "", `#tour/${current + 1}`);
  renderRail();
  if (options.scroll !== false) {
    const main = document.querySelector<HTMLElement>("#main");
    main?.scrollIntoView({ block: "start" });
    all[current]
      ?.querySelector<HTMLElement>("h2")
      ?.focus({ preventScroll: true });
  }
};

export const setView = (
  next: View,
  options: { readonly keepHash?: boolean; readonly file?: string } = {},
) => {
  view = next;
  const tour = document.querySelector<HTMLElement>("#tour-view");
  const files = document.querySelector<HTMLElement>("#files-view");
  if (tour !== null) tour.hidden = next !== "tour";
  if (files !== null) files.hidden = next !== "files";
  for (const button of document.querySelectorAll<HTMLElement>(
    "button[data-view]",
  ))
    button.setAttribute("aria-pressed", String(button.dataset.view === next));
  document.body.dataset.currentView = next;
  if (next === "files") {
    if (options.keepHash !== true)
      history.replaceState(
        null,
        "",
        options.file === undefined ? "#files" : `#files/${options.file}`,
      );
    if (options.file !== undefined) {
      // The files view's own panel: a stop can hold another copy of the same file, hidden with the tour.
      const panel = document.querySelector<HTMLElement>(
        `#files-view > article.file[data-path="${CSS.escape(options.file)}"]`,
      );
      panel?.scrollIntoView({ block: "start" });
      panel?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    }
  }
  renderRail();
};

/**
 * Where the hash says the page is: a stop, the files view or a file in it, or an element. A note link shows its
 * stop and keeps its hash; a link to anything else on the page, such as the skip link's target, is the browser's.
 */
export const applyHash = (
  options: { readonly scroll?: boolean; readonly initial?: boolean } = {},
) => {
  const place = parseHash(location.hash);
  switch (place.kind) {
    case "files":
      setView(
        "files",
        place.file === undefined
          ? { keepHash: true }
          : { keepHash: true, file: place.file },
      );
      return;
    case "stop":
      showStop(place.index, options);
      return;
    case "start":
      showStop(0, options);
      return;
    case "element": {
      const element = document.getElementById(place.id);
      const stop = element?.closest<HTMLElement>("article.stop");
      if (element != null && stop != null) {
        showStop(Number(stop.dataset.stop), { keepHash: true, scroll: false });
        element.scrollIntoView({ block: "center" });
      } else if (element?.closest("#files-view") != null) {
        setView("files", { keepHash: true });
        element.scrollIntoView({ block: "start" });
      } else if (options.initial === true || element === null) {
        // The page still needs a view: the current stop, with the hash left as the reader gave it.
        showStop(current, { keepHash: element !== null, scroll: false });
      }
      return;
    }
  }
};

export const currentStop = () => current;

export const installTour = () => {
  for (const heading of document.querySelectorAll<HTMLElement>(
    "article.stop h2",
  ))
    heading.tabIndex = -1;
  for (const heading of document.querySelectorAll<HTMLElement>(
    "article.file h3",
  ))
    heading.tabIndex = -1;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const go = target?.closest<HTMLElement>("[data-stop-go]");
    if (go !== null && go !== undefined) {
      event.preventDefault();
      if (go.closest(".rail") !== null) foldRail();
      showStop(Number(go.dataset.stopGo));
      return;
    }
    const viewButton = target?.closest<HTMLElement>("button[data-view]");
    if (viewButton !== null && viewButton !== undefined) {
      const next = viewButton.dataset.view === "files" ? "files" : "tour";
      if (next === "tour") showStop(current);
      else setView("files");
      return;
    }
    const open = target?.closest<HTMLElement>("[data-open-file]");
    if (open !== null && open !== undefined) {
      event.preventDefault();
      if (open.closest(".rail") !== null) foldRail();
      const file = open.dataset.openFile;
      setView("files", file === undefined ? {} : { file });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || isEditing()) return;
    if (document.querySelector("dialog[open]") !== null) return;
    if (event.key === "j" || event.key === "J") {
      event.preventDefault();
      if (view === "tour") showStop(current + 1);
    } else if (event.key === "k" || event.key === "K") {
      event.preventDefault();
      if (view === "tour") showStop(current - 1);
    }
  });
  window.addEventListener("hashchange", () => applyHash());
  wide.addEventListener("change", () => {
    const disclosure = railDisclosure();
    if (disclosure !== null) disclosure.open = wide.matches;
  });
  syncRail();
  applyHash({ scroll: false, initial: true });
};
