/**
 * What is folded on the review page: a file's body behind its header, runs of hidden lines behind a "Show N more
 * lines" control, and a file's "About" and "changed since" blocks. The server renders each file folded or open; once
 * the reviewer opens or closes a file, or the page opens one for them, that choice holds across live refreshes and
 * reloads, remembered per round in sessionStorage, until they mark the file viewed.
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
  if (all[path] === state) return;
  if (state === undefined) delete all[path];
  else all[path] = state;
  try {
    sessionStorage.setItem(foldKey(), JSON.stringify(all));
  } catch {
    /* Storage is optional. */
  }
};

/**
 * Files whose Viewed the reviewer just toggled, with the state they asked for. Until the server's markup shows it,
 * the file stays as it is; then the server's fold applies, so marking a file viewed folds it.
 */
const following = new Map<string, boolean>();

/** Marking a file viewed, or not, hands its fold back to the server. */
export const followViewed = (path: string, viewed: boolean) => {
  remember(path, undefined);
  following.set(path, viewed);
};

/** Folds or opens a file block. `keep` remembers the choice across refreshes and reloads. */
export const setFolded = (article: HTMLElement, folded: boolean, keep = true) => {
  const body = article.querySelector<HTMLElement>(":scope > .file-body");
  const toggle = article.querySelector<HTMLElement>(":scope > .file-head [data-fold]");
  if (body !== null) body.hidden = folded;
  article.dataset.folded = String(folded);
  if (toggle !== null) {
    toggle.setAttribute("aria-label", folded ? "Show diff" : "Hide diff");
    toggle.setAttribute("aria-expanded", String(!folded));
  }
  if (keep && article.dataset.path !== undefined) remember(article.dataset.path, folded ? "closed" : "open");
};

/** The files open on the page, which a refresh keeps open. */
export const openFiles = (): ReadonlySet<string> =>
  new Set(
    [...document.querySelectorAll<HTMLElement>("article.file[data-folded='false']")].map(
      (article) => article.dataset.path ?? "",
    ),
  );

/**
 * Applies the reviewer's choices to the markup the server rendered: what they opened or closed, what was open before
 * a refresh, and what the server held open for them, which stays open from now on.
 */
export const restoreFolds = (openBefore: ReadonlySet<string> = new Set()) => {
  const all = overrides();
  for (const article of document.querySelectorAll<HTMLElement>("article.file[data-path]")) {
    const path = article.dataset.path ?? "";
    const viewed = following.get(path);
    if (viewed !== undefined) {
      if (article.classList.contains("is-viewed") === viewed) following.delete(path);
      else if (openBefore.has(path)) setFolded(article, false, false);
      continue;
    }
    const state = all[path];
    if (state !== undefined) setFolded(article, state === "closed", false);
    else if (openBefore.has(path) || article.hasAttribute("data-held")) setFolded(article, false);
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

/**
 * How far a gap is open: 0 hides it all, 1 shows its folded patch rows, 2 shows its unchanged lines too. A gap with
 * only one kind of hidden line goes from 0 to 2.
 */
type Stage = 0 | 1 | 2;

/** Gaps the reviewer opened, by table, patch, and gap, so a refresh keeps them open. */
const openGaps = new Map<string, Stage>();

const gapKey = (table: HTMLTableElement, button: HTMLElement) =>
  `${table.dataset.table}:${table.dataset.patch}:${button.dataset.expand}`;

const stageOf = (button: HTMLElement): Stage => {
  const table = button.closest<HTMLTableElement>("table.diff");
  return table === null ? 0 : (openGaps.get(gapKey(table, button)) ?? 0);
};

export const setGap = (button: HTMLElement, stage: Stage) => {
  const table = button.closest<HTMLTableElement>("table.diff");
  if (table === null) return;
  const folded = Number(button.dataset.folded ?? "0");
  const context = Number(button.dataset.context ?? "0");
  // A gap without folded rows has no first stage.
  const shown: Stage = stage === 1 && (folded === 0 || context === 0) ? 2 : stage;
  for (const lines of table.querySelectorAll<HTMLElement>(`[data-gap="${CSS.escape(button.dataset.expand ?? "")}"]`)) {
    const open = shown === 2 || (shown === 1 && lines.classList.contains("folded"));
    lines.hidden = !open;
    if (open) ensurePlusButtons(lines);
  }
  const total = folded + context;
  button.setAttribute("aria-expanded", String(shown === 2));
  button.textContent =
    shown === 0
      ? `Show ${total} more line${total === 1 ? "" : "s"}`
      : shown === 1
        ? `Show ${context} more line${context === 1 ? "" : "s"}`
        : `Hide ${total} line${total === 1 ? "" : "s"}`;
  const key = gapKey(table, button);
  if (shown === 0) openGaps.delete(key);
  else openGaps.set(key, shown);
};

/** One activation of a gap's control: its folded rows first, then the unchanged lines, then hide them all. */
export const stepGap = (button: HTMLElement) => {
  const stage = stageOf(button);
  setGap(button, stage === 2 ? 0 : stage === 0 ? 1 : 2);
};

/** A file's "About" or "changed since" block, opened or closed by its header control. */
export const setExtra = (button: HTMLElement, open: boolean) => {
  const block = document.getElementById(button.getAttribute("aria-controls") ?? "");
  if (block === null) return;
  block.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) openExtras.add(block.id);
  else openExtras.delete(block.id);
};

/** File blocks the reviewer opened above their diffs, so a refresh keeps them open. */
const openExtras = new Set<string>();

/** Opens again the gaps and blocks the reviewer had open, where the same patch still shows them. */
export const restoreGaps = () => {
  for (const button of document.querySelectorAll<HTMLElement>("[data-expand]")) {
    const stage = stageOf(button);
    if (stage !== 0) setGap(button, stage);
  }
  for (const button of document.querySelectorAll<HTMLElement>("[data-extra]"))
    if (openExtras.has(button.getAttribute("aria-controls") ?? "")) setExtra(button, true);
};

/**
 * Opens whatever hides an element: its file's fold, the gap it is in, its file's block, a closed disclosure. A file
 * the page opens this way stays open, as if the reviewer had opened it.
 */
export const reveal = (element: Element) => {
  const article = element.closest<HTMLElement>("article.file");
  if (article !== null && (article.dataset.folded === "true" || element.closest(".file-body") !== null || element === article))
    setFolded(article, false);
  const run = element.closest<HTMLElement>("tbody[data-gap][hidden]");
  const button =
    run === null
      ? null
      : run.closest("table")?.querySelector<HTMLElement>(`[data-expand="${CSS.escape(run.dataset.gap ?? "")}"]`);
  if (run !== null && button != null) setGap(button, run.classList.contains("folded") && stageOf(button) !== 2 ? 1 : 2);
  const extra = element.closest<HTMLElement>(".file-extra[hidden]");
  const control =
    extra === null ? null : document.querySelector<HTMLElement>(`[data-extra][aria-controls="${CSS.escape(extra.id)}"]`);
  if (control !== null) setExtra(control, true);
  for (let details = element.closest("details"); details !== null; details = details.parentElement?.closest("details") ?? null)
    details.open = true;
};
