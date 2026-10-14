/**
 * What is folded on the review page: a file's body behind its header, and runs of rows behind a "Show N more lines"
 * toggle. The server renders each file folded or open; a file the reviewer opened or closed stays so across live
 * refreshes, remembered per round in sessionStorage.
 */

const foldKey = () =>
  `review-canvas:${document.body.dataset.review}:${document.body.dataset.round}:folds`;

type Overrides = Record<string, "open" | "closed">;

const overrides = (): Overrides => {
  try {
    return JSON.parse(sessionStorage.getItem(foldKey()) ?? "{}") as Overrides;
  } catch {
    return {};
  }
};

const remember = (path: string, state: "open" | "closed" | undefined) => {
  const all = overrides();
  if (state === undefined) delete all[path];
  else all[path] = state;
  try {
    sessionStorage.setItem(foldKey(), JSON.stringify(all));
  } catch {
    /* Storage is optional. */
  }
};

/** Forgets the reviewer's choice for a file, so the server's fold applies, as after marking it viewed. */
export const forgetFold = (path: string) => remember(path, undefined);

/** Folds or opens a file block. `keep` remembers the choice across refreshes. */
export const setFolded = (article: HTMLElement, folded: boolean, keep = true) => {
  const body = article.querySelector<HTMLElement>(":scope > .file-body");
  const toggle = article.querySelector<HTMLElement>(":scope > .file-head [data-fold]");
  if (body !== null) body.hidden = folded;
  article.dataset.folded = String(folded);
  if (toggle !== null) {
    toggle.textContent = folded ? "Show diff" : "Hide diff";
    toggle.setAttribute("aria-expanded", String(!folded));
  }
  if (keep && article.dataset.path !== undefined) remember(article.dataset.path, folded ? "closed" : "open");
};

/** Applies the reviewer's remembered choices to the markup the server rendered. */
export const restoreFolds = () => {
  const all = overrides();
  for (const article of document.querySelectorAll<HTMLElement>("article.file[data-path]")) {
    const state = all[article.dataset.path ?? ""];
    if (state !== undefined) setFolded(article, state === "closed", false);
  }
};

/** A line's + button, for rows the server rendered folded without one. */
const ensurePlusButtons = (container: Element) => {
  if (document.body.dataset.writable !== "true") return;
  for (const unit of container.querySelectorAll<HTMLElement>("[data-row][data-selectable]")) {
    const gutter = unit.querySelector<HTMLElement>("[data-gutter]");
    if (gutter === null || gutter.querySelector("button.add-comment") !== null) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "add-comment";
    button.title = "Comment on this line";
    button.setAttribute("aria-label", `Comment on line ${unit.dataset.new || unit.dataset.old || ""}`);
    button.textContent = "+";
    gutter.prepend(button);
  }
};

/** Unchanged-line runs and folded rows the reviewer opened, by table and run, so a refresh keeps them open. */
const openGaps = new Set<string>();

const gapLabel = (button: HTMLElement, open: boolean) => {
  const count = Number(button.dataset.count ?? "0");
  return `${open ? "Hide" : "Show"} ${count} ${button.dataset.noun ?? "more"} line${count === 1 ? "" : "s"}`;
};

export const setGap = (button: HTMLElement, open: boolean) => {
  const table = button.closest<HTMLTableElement>("table.diff");
  const lines = table?.querySelector<HTMLElement>(`[data-gap-lines="${CSS.escape(button.dataset.expand ?? "")}"]`);
  if (table == null || lines == null) return;
  lines.hidden = !open;
  if (open) ensurePlusButtons(lines);
  button.setAttribute("aria-expanded", String(open));
  button.textContent = gapLabel(button, open);
  const key = `${table.dataset.table}:${table.dataset.patch}:${button.dataset.expand}`;
  if (open) openGaps.add(key);
  else openGaps.delete(key);
};

/** Opens again the runs the reviewer had open, where the same patch still shows them. */
export const restoreGaps = () => {
  for (const button of document.querySelectorAll<HTMLElement>("[data-expand]")) {
    const table = button.closest<HTMLTableElement>("table.diff");
    if (table != null && openGaps.has(`${table.dataset.table}:${table.dataset.patch}:${button.dataset.expand}`))
      setGap(button, true);
  }
};

/** Opens whatever hides an element: its file's fold, a run of folded rows, a closed disclosure. */
export const reveal = (element: Element) => {
  const article = element.closest<HTMLElement>("article.file");
  if (article !== null && article.dataset.folded === "true") setFolded(article, false);
  const run = element.closest<HTMLElement>("tbody.gap-lines[hidden]");
  if (run !== null) {
    const button = run
      .closest("table")
      ?.querySelector<HTMLElement>(`[data-expand="${CSS.escape(run.dataset.gapLines ?? "")}"]`);
    if (button != null) setGap(button, true);
  }
  for (let details = element.closest("details"); details !== null; details = details.parentElement?.closest("details") ?? null)
    details.open = true;
};
