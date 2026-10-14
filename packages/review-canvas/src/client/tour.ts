/**
 * Moving through the one-scroll review page: the hash contract (`#tour/N`, `#files`, `#files/PATH`, `#ELEMENT-ID`),
 * J and K between stops, N for the next strip's target, the contents sidebar with its scroll-spy, and read-stop
 * memory.
 */
import { reveal, setExtra, setFolded } from "./folds.ts";
import { parseHash } from "./places.ts";

const storageKey = () =>
  `review-canvas:${document.body.dataset.review}:${document.body.dataset.round}:seen`;

const stops = () => [...document.querySelectorAll<HTMLElement>("section.stop")];

const seenStops = (): Set<number> => {
  try {
    const raw = sessionStorage.getItem(storageKey());
    return new Set(raw === null ? [] : (JSON.parse(raw) as Array<number>));
  } catch {
    return new Set();
  }
};

const markRead = (indexes: Iterable<number>) => {
  const seen = seenStops();
  const before = seen.size;
  for (const index of indexes) seen.add(index);
  if (seen.size !== before)
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify([...seen]));
    } catch {
      /* Storage is optional. */
    }
  renderRead(seen);
};

const renderRead = (seen = seenStops()) => {
  for (const link of document.querySelectorAll<HTMLElement>(".toc-stop"))
    link.classList.toggle("read", seen.has(Number(link.dataset.stopLink)));
};

/** The stop J and K move from: the last one moved to, or the one scrolled to; -1 above the first stop. */
let current = -1;
/** Until this time, scrolling is the page's own, and does not move `current`. */
let steering = 0;

const steer = () => {
  steering = performance.now() + 900;
};

/** The width at which the contents stand beside the page; below it, they fold into a disclosure. main.css agrees. */
const wide = matchMedia("(min-width: 64rem)");

/** Whether the reviewer opened the folded contents. The server renders them open; a narrow page starts them folded. */
let contentsOpen = false;

/** Keeps the contents open where they stand beside the page, and as the reviewer left them where they fold. */
export const syncContents = () => {
  const disclosure = document.querySelector<HTMLDetailsElement>(".contents-disclosure");
  if (disclosure !== null) disclosure.open = wide.matches || contentsOpen;
};

const foldContents = () => {
  contentsOpen = false;
  syncContents();
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

/** Scrolls a stop's heading to the top, focuses it, and keeps the place in the hash unless told otherwise. */
export const showStop = (
  index: number,
  options: { readonly scroll?: boolean; readonly keepHash?: boolean } = {},
) => {
  const all = stops();
  if (all.length === 0) return;
  current = Math.max(0, Math.min(index, all.length - 1));
  markRead([current]);
  if (options.keepHash !== true) history.replaceState(null, "", `#tour/${current + 1}`);
  if (options.scroll !== false) {
    steer();
    const heading = all[current]?.querySelector<HTMLElement>("h2");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }
  spy();
};

const fileBlock = (path: string) =>
  document.querySelector<HTMLElement>(`article.file[data-path="${CSS.escape(path)}"]`);

/** Opens a file's block, scrolls its header to the top, and focuses its path. */
const showFile = (article: HTMLElement, scroll = true) => {
  reveal(article);
  const stop = article.closest<HTMLElement>("section.stop");
  if (stop !== null) current = Number(stop.dataset.stop);
  if (scroll) {
    steer();
    article.scrollIntoView({ block: "start" });
    article.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }
  spy();
};

/** Where the hash says the page is. On a refresh the page keeps its scroll, so nothing moves. */
export const applyHash = (options: { readonly scroll?: boolean } = {}) => {
  const scroll = options.scroll !== false;
  const place = parseHash(location.hash);
  switch (place.kind) {
    case "files": {
      const article =
        place.file === undefined
          ? document.querySelector<HTMLElement>("article.file")
          : fileBlock(place.file);
      if (article !== null) showFile(article, scroll);
      return;
    }
    case "stop":
      showStop(place.index, { keepHash: true, scroll });
      return;
    case "start":
      return;
    case "element": {
      const element = document.getElementById(place.id);
      if (element === null) return;
      reveal(element);
      const stop = element.closest<HTMLElement>("section.stop");
      if (stop !== null) {
        current = Number(stop.dataset.stop);
        if (element === stop) markRead([current]);
      }
      if (scroll && element.id !== "main") {
        steer();
        element.scrollIntoView({ block: element.matches("section, article.file") ? "start" : "center" });
      }
      spy();
      return;
    }
  }
};

/** Brings the next strip's target into view and focuses what acts on it. */
const goNext = () => {
  const link = document.querySelector<HTMLAnchorElement>("[data-next-go]");
  const target = link === null ? null : document.getElementById(link.dataset.target ?? "");
  if (link === null || target === null) return;
  reveal(target);
  const stop = target.closest<HTMLElement>("section.stop");
  if (stop !== null) current = Number(stop.dataset.stop);
  const focus =
    link.dataset.kind === "answer"
      ? (target.querySelector<HTMLElement>("[data-reply='accept']") ?? target)
      : link.dataset.kind === "file"
        ? (target.querySelector<HTMLElement>("[data-action='approve']") ?? target.querySelector<HTMLElement>("h3") ?? target)
        : link.dataset.kind === "finish"
          ? (target.querySelector<HTMLElement>("input[name='verdict']") ?? target)
          : target;
  steer();
  target.scrollIntoView({ block: link.dataset.kind === "file" ? "start" : "center" });
  focus.focus({ preventScroll: true });
  spy();
};

/** The finish section, scrolled to with its first verdict focused. */
const goFinish = () => {
  const finish = document.querySelector<HTMLElement>("#finish");
  if (finish === null) return;
  steer();
  finish.scrollIntoView({ block: "start" });
  (finish.querySelector<HTMLElement>("input[name='verdict']") ?? finish.querySelector<HTMLElement>("h2"))?.focus({
    preventScroll: true,
  });
};

/** Lights the rows a later stop points back at, for a moment. */
const highlight = (link: HTMLElement) => {
  const table = document.querySelector<HTMLTableElement>(`table.diff[data-table="${CSS.escape(link.dataset.highlight ?? "")}"]`);
  if (table === null) return;
  const start = Number(link.dataset.start);
  const end = Number(link.dataset.end);
  const rows = [...table.querySelectorAll<HTMLElement>("[data-row]")].filter((row) => {
    const at = Number(row.dataset.row);
    return at >= start && at <= end;
  });
  const first = rows[0];
  if (first === undefined) return;
  reveal(first);
  steer();
  first.scrollIntoView({ block: "center" });
  for (const row of rows) row.classList.add("flash");
  window.setTimeout(() => {
    for (const row of rows) row.classList.remove("flash");
  }, 2000);
};

/** Where the sticky bars end: anything above this line has been scrolled past. */
const spyLine = () => (document.querySelector(".next")?.getBoundingClientRect().bottom ?? 0) + 12;

let spyQueued = false;

/** The contents row a mark stands for: a file's row, or for a stop heading its first file's. */
const tocRow = (mark: HTMLElement): HTMLElement | null =>
  mark.matches("article.file")
    ? document.querySelector<HTMLElement>(`[data-toc-file="${CSS.escape(mark.dataset.path ?? "")}"]`)
    : document.querySelector<HTMLElement>(
        `.toc-stop[data-stop-link="${mark.closest<HTMLElement>("section.stop")?.dataset.stop ?? ""}"] + .toc-files a`,
      );

/**
 * Marks the contents row of the file in view: the last stop heading or file whose top passed the line under the
 * sticky bars. Above the first one, the first one while it is on screen; at the bottom of the page, where the last
 * files can never reach the line, the last file whose top is on screen; past the last file, at the whole change and
 * the finish, nothing. Also marks the stops scrolled past as read, squares the corners of a file header that sticks,
 * and, when the reviewer scrolled, moves the stop J and K count from.
 */
export const spy = () => {
  const line = spyLine();
  const bottom = window.innerHeight;
  const marks = [...document.querySelectorAll<HTMLElement>("section.stop > .stop-head, section.stop article.file")];
  const tops = marks.map((mark) => mark.getBoundingClientRect().top);
  let index = -1;
  tops.forEach((top, at) => {
    if (top <= line) index = at;
  });
  const end = document.querySelector<HTMLElement>(".end-section");
  const pastFiles = end !== null && end.getBoundingClientRect().top <= line;
  const atBottom = window.scrollY + bottom >= document.documentElement.scrollHeight - 2;
  if (atBottom && !pastFiles)
    tops.forEach((top, at) => {
      if (top < bottom && marks[at]?.matches("article.file") === true) index = Math.max(index, at);
    });
  if (index === -1 && (tops[0] ?? Infinity) < bottom) index = 0;
  const at = pastFiles ? undefined : marks[index];

  const headings = stops().map((stop) => stop.querySelector("h2")?.getBoundingClientRect().top ?? Infinity);
  const passed = stops()
    .filter((_, at) => (headings[at] ?? Infinity) <= line)
    .map((stop) => Number(stop.dataset.stop));
  if (passed.length > 0) markRead(passed);
  if (performance.now() > steering) {
    // Above every stop heading, the first stop is current only once its heading is on screen; J then goes to stop 2,
    // and from higher up J goes to stop 1.
    const last = passed.at(-1);
    current = last ?? ((headings[0] ?? Infinity) < bottom ? 0 : -1);
  }

  for (const article of document.querySelectorAll<HTMLElement>("article.file[data-folded='false']")) {
    const head = article.querySelector<HTMLElement>(":scope > .file-head");
    if (head === null) continue;
    const box = article.getBoundingClientRect();
    const stuck =
      getComputedStyle(head).position === "sticky" &&
      box.top < head.getBoundingClientRect().top - 0.5 &&
      box.bottom > head.getBoundingClientRect().bottom;
    article.classList.toggle("is-stuck", stuck);
  }

  const link = at === undefined ? null : tocRow(at);
  for (const other of document.querySelectorAll<HTMLElement>(".toc-file[aria-current]"))
    if (other !== link) other.removeAttribute("aria-current");
  if (link === null || link.hasAttribute("aria-current")) return;
  link.setAttribute("aria-current", "location");
  // Keep the row in sight in the contents' own scroll, without moving the page.
  const scroller = link.closest<HTMLElement>(".toc-pane");
  if (scroller !== null && wide.matches) {
    const box = scroller.getBoundingClientRect();
    const row = link.getBoundingClientRect();
    if (row.top < box.top + 8) scroller.scrollTop -= box.top + 8 - row.top;
    else if (row.bottom > box.bottom - 8) scroller.scrollTop += row.bottom - box.bottom + 8;
  }
};

const queueSpy = () => {
  if (spyQueued) return;
  spyQueued = true;
  requestAnimationFrame(() => {
    spyQueued = false;
    spy();
  });
};

export const currentStop = () => current;

/**
 * Measures the sticky bars, so what sticks under them and what the page scrolls to lands below them however they
 * wrap. The top bar is static on narrow pages, as the shared style has it.
 */
const measureBars = () => {
  const topbar = document.querySelector<HTMLElement>("header.topbar");
  const next = document.querySelector<HTMLElement>(".next");
  const top = topbar !== null && getComputedStyle(topbar).position === "sticky" ? topbar.offsetHeight : 0;
  // A strip that wraps to a fifth of the screen, as on a phone with large text, scrolls away with the page.
  const tall = next !== null && next.offsetHeight > window.innerHeight / 5;
  if (next !== null) next.classList.toggle("unstuck", tall);
  const root = document.documentElement.style;
  root.setProperty("--topbar-height", `${top}px`);
  root.setProperty("--sticky-top", `${top + (next === null || tall ? 0 : next.offsetHeight) + 8}px`);
};

const bars = new ResizeObserver(measureBars);
window.addEventListener("resize", measureBars, { passive: true });

const observeBars = () => {
  bars.disconnect();
  for (const bar of document.querySelectorAll("header.topbar, .next")) bars.observe(bar);
  measureBars();
};

export const installTour = () => {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || event.defaultPrevented) return;
    // The summary's own click opens or closes it; remember which, so a refresh's markup does not decide.
    if (target.closest(".contents-summary") !== null) {
      contentsOpen = !(document.querySelector<HTMLDetailsElement>(".contents-disclosure")?.open ?? false);
      return;
    }
    const stopLink = target.closest<HTMLElement>("[data-stop-link]");
    if (stopLink !== null) {
      event.preventDefault();
      foldContents();
      showStop(Number(stopLink.dataset.stopLink));
      return;
    }
    const fileLink = target.closest<HTMLElement>("[data-toc-file]");
    if (fileLink !== null) {
      event.preventDefault();
      foldContents();
      const article = fileBlock(fileLink.dataset.tocFile ?? "");
      if (article !== null) {
        history.replaceState(null, "", `#files/${fileLink.dataset.tocFile ?? ""}`);
        showFile(article);
      }
      return;
    }
    if (target.closest("[data-next-go]") !== null) {
      event.preventDefault();
      goNext();
      return;
    }
    if (target.closest("[data-open-finish]") !== null) {
      event.preventDefault();
      goFinish();
      return;
    }
    const fold = target.closest<HTMLElement>("[data-fold]");
    if (fold !== null) {
      const article = fold.closest<HTMLElement>("article.file");
      if (article !== null) setFolded(article, article.dataset.folded !== "true");
      return;
    }
    const extra = target.closest<HTMLElement>("[data-extra]");
    if (extra !== null) {
      setExtra(extra, extra.getAttribute("aria-expanded") !== "true");
      return;
    }
    const round = target.closest<HTMLElement>("[data-round-toggle]");
    if (round !== null) {
      const open = round.getAttribute("aria-expanded") !== "true";
      setRound(round, open);
      return;
    }
    const back = target.closest<HTMLElement>("[data-highlight]");
    if (back !== null) {
      event.preventDefault();
      highlight(back);
      return;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || isEditing()) return;
    if (event.key === "j" || event.key === "J") {
      event.preventDefault();
      showStop(current + 1);
    } else if (event.key === "k" || event.key === "K") {
      event.preventDefault();
      showStop(current - 1);
    } else if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      goNext();
    }
  });
  window.addEventListener("hashchange", () => applyHash());
  window.addEventListener("scroll", queueSpy, { passive: true });
  window.addEventListener("resize", queueSpy, { passive: true });
  wide.addEventListener("change", () => {
    contentsOpen = false;
    syncContents();
  });
  observeBars();
  syncContents();
  renderRead();
  applyHash();
  spy();
};

/** Earlier rounds the reviewer expanded in the rounds line, so a refresh keeps them open. */
const openRounds = new Set<string>();

const setRound = (button: HTMLElement, open: boolean) => {
  const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
  if (panel === null) return;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) openRounds.add(panel.id);
  else openRounds.delete(panel.id);
};

/** After a refresh: the read stops, the expanded rounds, the contents, and the scroll-spy. */
export const afterRefresh = () => {
  for (const button of document.querySelectorAll<HTMLElement>("[data-round-toggle]"))
    if (openRounds.has(button.getAttribute("aria-controls") ?? "")) setRound(button, true);
  observeBars();
  syncContents();
  renderRead();
  spy();
};
