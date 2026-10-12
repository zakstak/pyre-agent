/** Walking the tour: one stop at a time, J and K to move, the rail to jump, and the files view beside it. */

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
  const count = document.querySelector<HTMLElement>("[data-seen-count]");
  if (count !== null)
    count.textContent = String(
      [...seen].filter((index) => index < stops().length).length,
    );
};

/** Shows one stop, remembers it as read, and keeps the location in the hash. */
export const showStop = (
  index: number,
  options: { readonly scroll?: boolean } = {},
) => {
  const all = stops();
  if (all.length === 0) return;
  current = Math.max(0, Math.min(index, all.length - 1));
  for (const [at, stop] of all.entries()) stop.hidden = at !== current;
  const seen = seenStops();
  seen.add(current);
  rememberSeen(seen);
  setView("tour", { keepHash: true });
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
  for (const button of document.querySelectorAll<HTMLElement>("[data-view]"))
    button.setAttribute("aria-pressed", String(button.dataset.view === next));
  document.body.dataset.view = next;
  if (next === "files") {
    if (options.keepHash !== true)
      history.replaceState(
        null,
        "",
        options.file === undefined ? "#files" : `#files/${options.file}`,
      );
    if (options.file !== undefined) {
      const panel = document.getElementById(
        `file-${options.file.replace(/[^A-Za-z0-9]+/g, "-")}`,
      );
      panel?.scrollIntoView({ block: "start" });
      panel?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    }
  }
  renderRail();
};

/** Where the hash says the page is: a stop, the files view, or a file in it. */
export const applyHash = (options: { readonly scroll?: boolean } = {}) => {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === "files") setView("files", { keepHash: true });
  else if (hash.startsWith("files/"))
    setView("files", { keepHash: true, file: hash.slice(6) });
  else {
    const match = /^tour\/([0-9]+)$/.exec(hash);
    showStop(match === null ? 0 : Number(match[1]) - 1, options);
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
      showStop(Number(go.dataset.stopGo));
      return;
    }
    const viewButton = target?.closest<HTMLElement>("[data-view]");
    if (viewButton !== null && viewButton !== undefined) {
      const next = viewButton.dataset.view === "files" ? "files" : "tour";
      if (next === "tour") showStop(current);
      else setView("files");
      return;
    }
    const open = target?.closest<HTMLElement>("[data-open-file]");
    if (open !== null && open !== undefined) {
      event.preventDefault();
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
  applyHash({ scroll: false });
};
