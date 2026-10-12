/**
 * Comments: selecting rows of a diff, the composer that opens under them, replies, and approvals.
 *
 * A composer is one draft. Its row holds everything about it: a draft ID, the file, the digest of the patch the rows
 * belong to, the table, and the selected rows. A refresh rebuilds it from those, and a submission finishes only the
 * draft it sent, so neither can move a draft onto other code or clear a newer one.
 */
import { attempt, toast, tryAct } from "./api.ts";

interface Selection {
  readonly table: HTMLTableElement;
  readonly start: number;
  readonly end: number;
}

/** A composer's draft, as a refresh carries it from the old markup to the new. */
export interface ComposerDraft {
  readonly draft: string;
  readonly path: string;
  readonly patch: string;
  readonly table: string;
  readonly start: number;
  readonly end: number;
  readonly body: string;
  readonly submitting: boolean;
}

let dragging:
  | { readonly table: HTMLTableElement; readonly from: number; end: number }
  | undefined;

/** Text of a draft whose code changed, kept for the next composer the reviewer opens. */
let stash = "";

let draftCount = 0;
const newDraftId = () => `draft-${Date.now().toString(36)}-${draftCount++}`;

const rowsOf = (table: HTMLTableElement) => [
  ...table.querySelectorAll<HTMLTableRowElement>("tr[data-row]"),
];

/**
 * The composer the reviewer is writing in. Another composer can be on the page at the same time, waiting for its
 * submission to finish; that one is no longer editable.
 */
const composerRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".composer-row:not([data-submitting])");

const composerById = (draft: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `.composer-row[data-draft="${CSS.escape(draft)}"]`,
  );

const tableOf = (row: HTMLElement): HTMLTableElement | null =>
  row.closest<HTMLTableElement>("table.diff");

/** Tints the rows being dragged over, or else the rows of the open composer. */
const paintSelection = () => {
  for (const row of document.querySelectorAll<HTMLElement>("tr.selected"))
    row.classList.remove("selected");
  const composer = composerRow();
  const where: Selection | undefined =
    dragging !== undefined
      ? {
          table: dragging.table,
          start: Math.min(dragging.from, dragging.end),
          end: Math.max(dragging.from, dragging.end),
        }
      : composer !== null && tableOf(composer) !== null
        ? {
            table: tableOf(composer) as HTMLTableElement,
            start: Number(composer.dataset.start),
            end: Number(composer.dataset.end),
          }
        : undefined;
  if (where === undefined) return;
  for (const row of rowsOf(where.table)) {
    const index = Number(row.dataset.row);
    if (index >= where.start && index <= where.end)
      row.classList.add("selected");
  }
};

/** Closes a composer. One that is being submitted is left for its submission to finish. */
const closeComposer = (composer: HTMLElement | null = composerRow()) => {
  composer?.remove();
  paintSelection();
};

const lastSelectedRow = (where: Selection): HTMLTableRowElement | undefined =>
  rowsOf(where.table)
    .filter((row) => {
      const index = Number(row.dataset.row);
      return index >= where.start && index <= where.end;
    })
    .at(-1);

const lineLabel = (where: Selection): string => {
  const rows = rowsOf(where.table).filter((row) => {
    const index = Number(row.dataset.row);
    return (
      index >= where.start &&
      index <= where.end &&
      row.dataset.selectable !== undefined
    );
  });
  const hasDel = rows.some((row) => row.dataset.side === "old");
  const hasAdd = rows.some((row) => row.dataset.side === "new");
  const column = hasDel && !hasAdd ? 0 : 1;
  const numbers = rows
    .map((row) => row.cells[column]?.textContent?.replace("+", "").trim() ?? "")
    .filter((text) => text !== "");
  const first = numbers[0];
  const last = numbers.at(-1);
  const side = column === 0 ? "old " : "";
  return first === undefined
    ? "the selected rows"
    : first === last
      ? `${side}line ${first}`
      : `${side}lines ${first}–${last}`;
};

/**
 * Opens the composer under the selection. An unsent draft in another composer moves into it, so picking other lines
 * never loses text, and so does text kept from a draft whose code changed.
 */
const openComposer = (
  where: Selection,
  options: {
    readonly body?: string;
    readonly draft?: string;
    readonly submitting?: boolean;
  } = {},
) => {
  const existing = composerRow();
  let body = options.body;
  if (existing !== null && existing.dataset.submitting === undefined) {
    body ??= existing.querySelector("textarea")?.value ?? "";
    existing.remove();
  }
  if (body === undefined || body === "") {
    body = stash;
    stash = "";
  }
  const template =
    document.querySelector<HTMLTemplateElement>("#composer-template");
  const anchorRow = lastSelectedRow(where);
  if (template === null || anchorRow === undefined) return;
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const row = fragment.querySelector<HTMLElement>(".composer-row");
  if (row === null) return;
  row.dataset.draft = options.draft ?? newDraftId();
  row.dataset.path = where.table.dataset.path ?? "";
  row.dataset.patch = where.table.dataset.patch ?? "";
  row.dataset.table = where.table.dataset.table ?? "";
  row.dataset.start = String(where.start);
  row.dataset.end = String(where.end);
  if (options.submitting === true) row.dataset.submitting = "true";
  // Under the thread row that already follows the anchor row, if any.
  const after = anchorRow.nextElementSibling?.classList.contains("thread-row")
    ? anchorRow.nextElementSibling
    : anchorRow;
  after.after(fragment);
  const range = row.querySelector<HTMLElement>("[data-range]");
  if (range !== null)
    range.textContent = `${where.table.dataset.path ?? ""}, ${lineLabel(where)}`;
  const button = row.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button !== null) button.disabled = options.submitting === true;
  const textarea = row.querySelector<HTMLTextAreaElement>("textarea");
  if (textarea !== null) {
    textarea.value = body;
    textarea.focus();
  }
  paintSelection();
};

/** What every composer holds, so a refresh can bring them back: the one being written and any being submitted. */
export const composerDrafts = (): ReadonlyArray<ComposerDraft> =>
  [...document.querySelectorAll<HTMLElement>(".composer-row")].map((row) => ({
    draft: row.dataset.draft ?? "",
    path: row.dataset.path ?? "",
    patch: row.dataset.patch ?? "",
    table: row.dataset.table ?? "",
    start: Number(row.dataset.start),
    end: Number(row.dataset.end),
    body: row.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
    submitting: row.dataset.submitting !== undefined,
  }));

const keep = (body: string, why: string) => {
  if (body.trim() === "") return;
  stash = body;
  toast(
    `${why} Your text is kept: select lines to comment on, and it fills the new comment.`,
    "danger",
  );
};

/**
 * Reopens a draft after a refresh, but only on the same patch of the same file: its row numbers mean nothing in
 * another version. The same table comes first, then any visible table of that patch. Otherwise its text is kept.
 */
const restoreComposer = (draft: ComposerDraft) => {
  const same = (table: HTMLTableElement) =>
    table.dataset.path === draft.path && table.dataset.patch === draft.patch;
  const tables = [
    ...document.querySelectorAll<HTMLTableElement>("table.diff"),
  ].filter(same);
  const table =
    tables.find((candidate) => candidate.dataset.table === draft.table) ??
    tables.find((candidate) => candidate.closest("[hidden]") === null) ??
    tables[0];
  if (table === undefined || Number(table.dataset.rows) <= draft.end) {
    // A draft being submitted is finished by its submission, which reports the outcome.
    if (!draft.submitting)
      keep(draft.body, "The code under your comment changed in a new round.");
    return;
  }
  openComposer(
    { table, start: draft.start, end: draft.end },
    { body: draft.body, draft: draft.draft, submitting: draft.submitting },
  );
};

/** Reopens every draft. Those being submitted come first, so opening the editable one never replaces them. */
export const restoreComposers = (drafts: ReadonlyArray<ComposerDraft>) => {
  for (const draft of [...drafts].sort(
    (a, b) => Number(b.submitting) - Number(a.submitting),
  ))
    restoreComposer(draft);
};

const submitComposer = async (form: HTMLFormElement) => {
  const row = form.closest<HTMLElement>(".composer-row");
  if (row === null || row.dataset.submitting !== undefined) return;
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (body === "") {
    textarea?.focus();
    return;
  }
  const draft = row.dataset.draft ?? "";
  row.dataset.submitting = "true";
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button !== null) button.disabled = true;
  const result = await attempt({
    kind: "comment",
    selection: {
      path: row.dataset.path,
      patch_sha256: row.dataset.patch,
      start_row: Number(row.dataset.start),
      end_row: Number(row.dataset.end),
    },
    body,
  });
  // A refresh may have rebuilt this draft's composer, and the reviewer may have opened another since: finish only
  // the composer that holds this draft, wherever it is now.
  const now = composerById(draft);
  if (result.ok) {
    if (now !== null) closeComposer(now);
    return;
  }
  if (now === null) {
    keep(body, `Your comment was not added: ${result.message}`);
    return;
  }
  delete now.dataset.submitting;
  const again = now.querySelector<HTMLButtonElement>("button[type=submit]");
  if (again !== null) again.disabled = false;
  toast(result.message, "danger");
};

/** Clears a textarea by ID after its text was sent. A refresh may have replaced the element, so look it up again. */
const clearSent = (id: string, sent: string) => {
  const textarea = document.getElementById(id);
  if (textarea instanceof HTMLTextAreaElement && textarea.value.trim() === sent)
    textarea.value = "";
};

const submitReply = async (
  form: HTMLFormElement,
  action: "reply" | "accept",
) => {
  const article = form.closest<HTMLElement>("[data-comment]");
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (article === null) return;
  if (action === "reply" && body === "") {
    textarea?.focus();
    return;
  }
  const done = await tryAct({
    kind: "reply",
    comment: article.dataset.comment,
    action,
    body,
  });
  if (done && textarea !== null) clearSent(textarea.id, body);
};

const submitGeneral = async (form: HTMLFormElement) => {
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (body === "") {
    textarea?.focus();
    return;
  }
  const done = await tryAct({ kind: "general_comment", body });
  if (done && textarea !== null) clearSent(textarea.id, body);
};

export const generalDraft = () =>
  document.querySelector<HTMLTextAreaElement>(".general-composer textarea")
    ?.value ?? "";

export const restoreGeneral = (draft: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".general-composer textarea",
  );
  if (textarea !== null && draft !== "") textarea.value = draft;
};

/** A reply draft: the textarea it was typed in, which names one rendering of the thread, and its comment. */
export interface ReplyDraft {
  readonly id: string;
  readonly comment: string;
  readonly value: string;
}

export const replyDrafts = (): ReadonlyArray<ReplyDraft> =>
  [...document.querySelectorAll<HTMLTextAreaElement>(".reply-form textarea")]
    .filter((textarea) => textarea.value !== "")
    .map((textarea) => ({
      id: textarea.id,
      comment:
        textarea.closest<HTMLElement>("[data-comment]")?.dataset.comment ?? "",
      value: textarea.value,
    }));

/**
 * Puts each reply draft back in the same rendering of its thread. When that rendering is gone, the draft goes to a
 * visible rendering of the same comment instead of a hidden one.
 */
export const restoreReplyDrafts = (drafts: ReadonlyArray<ReplyDraft>) => {
  for (const draft of drafts) {
    const exact = document.getElementById(draft.id);
    const fallback = [
      ...document.querySelectorAll<HTMLTextAreaElement>(
        `[data-comment="${CSS.escape(draft.comment)}"] .reply-form textarea`,
      ),
    ];
    const textarea =
      exact instanceof HTMLTextAreaElement
        ? exact
        : (fallback.find(
            (candidate) => candidate.closest("[hidden]") === null,
          ) ?? fallback[0]);
    if (textarea !== undefined) textarea.value = draft.value;
  }
};

export const installComments = () => {
  const writable = () => document.body.dataset.writable === "true";

  document.addEventListener("mousedown", (event) => {
    if (!writable() || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest<HTMLElement>("td.line-number, td.marker");
    const row = cell?.closest<HTMLTableRowElement>("tr[data-selectable]");
    const table = row?.closest<HTMLTableElement>("table.diff");
    if (cell == null || row == null || table == null) return;
    event.preventDefault();
    const from = Number(row.dataset.row);
    dragging = { table, from, end: from };
    paintSelection();
  });
  document.addEventListener("mouseover", (event) => {
    if (dragging === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLTableRowElement>("tr[data-selectable]");
    if (row == null || row.closest("table.diff") !== dragging.table) return;
    dragging.end = Number(row.dataset.row);
    paintSelection();
  });
  document.addEventListener("mouseup", () => {
    if (dragging === undefined) return;
    const { table, from, end } = dragging;
    dragging = undefined;
    openComposer({
      table,
      start: Math.min(from, end),
      end: Math.max(from, end),
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    // Enter or Space on a line's + button: a click with no pointer, which mousedown and mouseup never saw.
    const add = target.closest<HTMLButtonElement>("button.add-comment");
    if (add !== null) {
      const row = add.closest<HTMLTableRowElement>("tr[data-selectable]");
      const table = row?.closest<HTMLTableElement>("table.diff");
      if (event.detail === 0 && writable() && row != null && table != null) {
        const at = Number(row.dataset.row);
        openComposer({ table, start: at, end: at });
      }
      return;
    }
    const cancel = target.closest("[data-cancel]");
    if (cancel !== null) {
      closeComposer(cancel.closest<HTMLElement>(".composer-row"));
      return;
    }
    const replyButton = target.closest<HTMLButtonElement>("button[data-reply]");
    if (replyButton !== null && replyButton.type === "button") {
      const form = replyButton.closest("form");
      if (form !== null)
        void submitReply(
          form,
          replyButton.dataset.reply === "accept" ? "accept" : "reply",
        );
      return;
    }
    const reopen = target.closest<HTMLElement>('[data-action="reopen"]');
    if (reopen !== null) {
      const article = reopen.closest<HTMLElement>("[data-comment]");
      if (article !== null)
        void tryAct({
          kind: "reply",
          comment: article.dataset.comment,
          action: "reopen",
          body: "Reopened.",
        });
      return;
    }
    const approve = target.closest<HTMLElement>('[data-action="approve"]');
    if (approve !== null) {
      const approved = approve.getAttribute("aria-pressed") === "true";
      void tryAct(
        approved
          ? { kind: "unapprove", path: approve.dataset.path }
          : {
              kind: "approve",
              path: approve.dataset.path,
              fingerprint: approve.dataset.fingerprint,
            },
      );
      return;
    }
    const question = target.closest<HTMLElement>("[data-question]");
    if (question !== null) {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".general-composer textarea",
      );
      if (textarea !== null) {
        const quoted = `> ${question.dataset.question ?? ""}\n\n`;
        textarea.value = textarea.value.startsWith(quoted)
          ? textarea.value
          : quoted + textarea.value;
        document.querySelector("#general")?.scrollIntoView({ block: "start" });
        textarea.focus();
        textarea.setSelectionRange(
          textarea.value.length,
          textarea.value.length,
        );
      }
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null) return;
    const action = form.dataset.action;
    if (action === "comment") {
      event.preventDefault();
      void submitComposer(form);
    } else if (action === "reply") {
      event.preventDefault();
      void submitReply(form, "reply");
    } else if (action === "general_comment") {
      event.preventDefault();
      void submitGeneral(form);
    }
  });

  document.addEventListener("keydown", (event) => {
    const target =
      event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (target === null) return;
    const composer = target.closest<HTMLElement>(".composer-row");
    if (event.key === "Escape" && composer !== null) {
      event.preventDefault();
      if (composer.dataset.submitting === undefined) closeComposer(composer);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      target.form?.requestSubmit();
    }
  });
};
