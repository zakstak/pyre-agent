/**
 * Comments: selecting rows of a diff, the composer that opens under them, replies, and approvals.
 *
 * A composer is one draft. Its row holds everything about it: a draft ID, the file, the digest of the patch the rows
 * belong to, the table, and the selected rows. A refresh rebuilds it from those, and a submission finishes only the
 * draft it sent, so neither can move a draft onto other code or clear a newer one.
 */
import { attempt, toast, tryAct } from "./api.ts";
import { followViewed, reveal, stepGap } from "./folds.ts";

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

/**
 * The lines of a table the reviewer can select: rows in the unified layout, halves of rows in the split layout. A
 * context line in the split layout is two units of one row index.
 */
const UNIT = "[data-row][data-selectable]";

const unitsOf = (table: HTMLTableElement) => [
  ...table.querySelectorAll<HTMLElement>(UNIT),
];

const inRange = (unit: HTMLElement, where: Selection) => {
  const index = Number(unit.dataset.row);
  return index >= where.start && index <= where.end;
};

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
  for (const unit of document.querySelectorAll<HTMLElement>(".selected"))
    unit.classList.remove("selected");
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
  for (const unit of unitsOf(where.table))
    if (inRange(unit, where)) unit.classList.add("selected");
};

/** The + button each composer was opened from by keyboard, which gets focus back when the composer closes. */
const openers = new WeakMap<HTMLElement, HTMLElement>();

/**
 * The + button of the composer's last selected line, for a composer a refresh rebuilt: its opener went with the old
 * markup, and this is the line the reviewer was on.
 */
const lineButton = (composer: HTMLElement): HTMLElement | null => {
  const table = tableOf(composer);
  if (table === null) return null;
  const unit = unitsOf(table)
    .filter((candidate) => candidate.dataset.row === composer.dataset.end)
    .at(-1);
  return unit?.querySelector<HTMLElement>("button.add-comment") ?? null;
};

/**
 * Closes a composer. One that is being submitted is left for its submission to finish. Focus inside it returns to the
 * button that opened it, or to its last line's + button, so a keyboard reviewer stays on the line they were on. A
 * reviewer's own close, with Esc or Cancel, also counts focus left on the page itself, where some browsers put it
 * after a click on a button.
 */
const closeComposer = (
  composer: HTMLElement | null = composerRow(),
  options: { readonly byReviewer?: boolean } = {},
) => {
  const opened = composer === null ? undefined : openers.get(composer);
  const opener = opened?.isConnected === true ? opened : composer === null ? null : lineButton(composer);
  const focused =
    composer !== null &&
    (composer.contains(document.activeElement) ||
      (options.byReviewer === true &&
        document.activeElement === document.body));
  composer?.remove();
  paintSelection();
  if (focused) opener?.focus();
};

/** The table row the composer goes under: the one holding the last selected line, in document order. */
const lastSelectedRow = (where: Selection): HTMLTableRowElement | undefined =>
  unitsOf(where.table)
    .filter((unit) => inRange(unit, where))
    .at(-1)
    ?.closest<HTMLTableRowElement>("tr") ?? undefined;

/** The selected lines as the server will anchor them: old-side when only deleted lines are changed, else new-side. */
const lineLabel = (where: Selection): string => {
  const units = unitsOf(where.table).filter((unit) => inRange(unit, where));
  const hasDel = units.some((unit) => unit.dataset.side === "old");
  const hasAdd = units.some((unit) => unit.dataset.side === "new");
  const old = hasDel && !hasAdd;
  const numbers = [
    ...new Set(
      units
        .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
        .map((unit) => (old ? unit.dataset.old : unit.dataset.new) ?? "")
        .filter((text) => text !== ""),
    ),
  ];
  const first = numbers[0];
  const last = numbers.at(-1);
  const side = old ? "old " : "";
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
    readonly opener?: HTMLElement;
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
  reveal(anchorRow);
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const row = fragment.querySelector<HTMLElement>(".composer-row");
  if (row === null) return;
  // The template spans the unified layout's columns; a split table has fewer, and a wider span would add columns.
  const cell = row.querySelector("td");
  const columns = where.table.tHead?.rows[0]?.cells.length;
  if (cell !== null && columns !== undefined) cell.colSpan = columns;
  row.dataset.draft = options.draft ?? newDraftId();
  row.dataset.path = where.table.dataset.path ?? "";
  row.dataset.patch = where.table.dataset.patch ?? "";
  row.dataset.table = where.table.dataset.table ?? "";
  row.dataset.start = String(where.start);
  row.dataset.end = String(where.end);
  if (options.submitting === true) row.dataset.submitting = "true";
  if (options.opener !== undefined) openers.set(row, options.opener);
  // Under the notes and the thread row that already follow the anchor row, if any.
  let after: Element = anchorRow;
  while (
    after.nextElementSibling?.classList.contains("note") === true ||
    after.nextElementSibling?.classList.contains("thread-row") === true
  )
    after = after.nextElementSibling;
  after.after(fragment);
  const range = row.querySelector<HTMLElement>("[data-range]");
  if (range !== null)
    range.textContent = lineLabel(where);
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

/** Sends a composer's draft: a review comment, or with `question` a question the agents answer now. */
const submitComposer = async (form: HTMLFormElement, question = false) => {
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
    ...(question ? { question: true } : {}),
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

const submitGeneral = async (form: HTMLFormElement, question = false) => {
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (body === "") {
    textarea?.focus();
    return;
  }
  const done = await tryAct({
    kind: "general_comment",
    body,
    ...(question ? { question: true } : {}),
  });
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
    if (textarea !== undefined) {
      textarea.value = draft.value;
      const form = textarea.closest<HTMLFormElement>("form.reply-form");
      if (form !== null) setReplyEditor(form, true, false);
    }
  }
};

/**
 * Opens a thread's reply box in place of its buttons, or closes it and returns focus to Reply. Its text stays, so a
 * closed reply is not a lost one.
 */
const setReplyEditor = (form: HTMLFormElement, open: boolean, focus = true) => {
  const editor = form.querySelector<HTMLElement>(".reply-editor");
  const buttons = form.querySelector<HTMLElement>("[data-reply-actions]");
  if (editor === null) return;
  editor.hidden = !open;
  if (buttons !== null) buttons.hidden = open;
  if (!focus) return;
  if (open) {
    reveal(editor);
    editor.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  } else form.querySelector<HTMLElement>("[data-reply-open]")?.focus();
};

/** The comment being moved to other lines, while the reviewer picks them. */
let reattaching: string | undefined;

const stopReattaching = () => {
  reattaching = undefined;
  delete document.body.dataset.reattaching;
};

/**
 * What a selection of lines does: open the composer, or, while a comment is being moved, move it there. The server
 * refuses a move of a comment that still attaches, and a selection of another version of the patch.
 */
const chooseLines = (where: Selection, opener?: HTMLElement) => {
  if (reattaching === undefined) {
    openComposer(where, opener === undefined ? {} : { opener });
    return;
  }
  const comment = reattaching;
  stopReattaching();
  paintSelection();
  void tryAct({
    kind: "reattach",
    comment,
    selection: {
      path: where.table.dataset.path,
      patch_sha256: where.table.dataset.patch,
      start_row: where.start,
      end_row: where.end,
    },
  }).then((done) => {
    if (done) toast("The comment moved to the lines you chose.");
  });
};

/** Puts text in the general composer and focuses it, for a question to ask now. */
const prefillGeneral = (text: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".general-composer textarea",
  );
  if (textarea === null) return;
  if (!textarea.value.startsWith(text))
    textarea.value =
      textarea.value === "" ? text : `${text}\n\n${textarea.value}`;
  textarea.scrollIntoView({ block: "center" });
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
};

export const installComments = () => {
  const writable = () => document.body.dataset.writable === "true";

  document.addEventListener("mousedown", (event) => {
    if (!writable() || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const gutter = target?.closest<HTMLElement>("[data-gutter]");
    const unit = gutter?.closest<HTMLElement>(UNIT);
    const table = unit?.closest<HTMLTableElement>("table.diff");
    if (gutter == null || unit == null || table == null) return;
    event.preventDefault();
    const from = Number(unit.dataset.row);
    dragging = { table, from, end: from };
    paintSelection();
  });
  document.addEventListener("mouseover", (event) => {
    if (dragging === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const unit = target?.closest<HTMLElement>(UNIT);
    if (unit == null || unit.closest("table.diff") !== dragging.table) return;
    dragging.end = Number(unit.dataset.row);
    paintSelection();
  });
  document.addEventListener("mouseup", () => {
    if (dragging === undefined) return;
    const { table, from, end } = dragging;
    dragging = undefined;
    chooseLines({
      table,
      start: Math.min(from, end),
      end: Math.max(from, end),
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    // Enter or Space on a line's + button: a click with no pointer, which mousedown and mouseup never saw. With Shift,
    // it extends the open composer's lines in the same table to this one, as a drag would.
    const add = target.closest<HTMLButtonElement>("button.add-comment");
    if (add !== null) {
      const unit = add.closest<HTMLElement>(UNIT);
      const table = unit?.closest<HTMLTableElement>("table.diff");
      if (event.detail === 0 && writable() && unit != null && table != null) {
        const at = Number(unit.dataset.row);
        const open = composerRow();
        if (event.shiftKey && open !== null && tableOf(open) === table) {
          chooseLines(
            {
              table,
              start: Math.min(Number(open.dataset.start), at),
              end: Math.max(Number(open.dataset.end), at),
            },
            openers.get(open) ?? add,
          );
        } else chooseLines({ table, start: at, end: at }, add);
      }
      return;
    }
    const expand = target.closest<HTMLElement>("[data-expand]");
    if (expand !== null) {
      stepGap(expand);
      return;
    }
    const ask = target.closest<HTMLButtonElement>("button[data-ask]");
    if (ask !== null) {
      const form = ask.closest("form");
      if (form?.dataset.action === "comment") void submitComposer(form, true);
      else if (form?.dataset.action === "general_comment")
        void submitGeneral(form, true);
      return;
    }
    const move = target.closest<HTMLElement>("[data-reattach]");
    if (move !== null) {
      reattaching = move.dataset.reattach;
      document.body.dataset.reattaching = "true";
      toast(
        "Select the lines this comment is about, with the + button or by dragging the line numbers. Esc cancels.",
      );
      return;
    }
    const openReply = target.closest<HTMLElement>("[data-reply-open]");
    if (openReply !== null) {
      const form = openReply.closest<HTMLFormElement>("form.reply-form");
      if (form !== null) setReplyEditor(form, true);
      return;
    }
    const cancelReply = target.closest<HTMLElement>("[data-reply-cancel]");
    if (cancelReply !== null) {
      const form = cancelReply.closest<HTMLFormElement>("form.reply-form");
      if (form !== null) setReplyEditor(form, false);
      return;
    }
    const cancel = target.closest("[data-cancel]");
    if (cancel !== null) {
      closeComposer(cancel.closest<HTMLElement>(".composer-row"), {
        byReviewer: true,
      });
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
      // Marking a file viewed folds it, whatever the reviewer chose before.
      followViewed(approve.dataset.path ?? "", !approved);
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
    // A question the tour suggests: the reviewer can ask it as it is, or edit it first.
    const question = target.closest<HTMLElement>("[data-question]");
    if (question !== null) prefillGeneral(question.dataset.question ?? "");
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
    if (event.key === "Escape" && reattaching !== undefined) {
      stopReattaching();
      toast("The comment stays where it was.");
      return;
    }
    const target =
      event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (target === null) return;
    const composer = target.closest<HTMLElement>(".composer-row");
    const replyForm = target.closest<HTMLFormElement>("form.reply-form");
    if (event.key === "Escape" && replyForm !== null) {
      event.preventDefault();
      setReplyEditor(replyForm, false);
    } else if (event.key === "Escape" && composer !== null) {
      event.preventDefault();
      if (composer.dataset.submitting === undefined)
        closeComposer(composer, { byReviewer: true });
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      target.form?.requestSubmit();
    }
  });
};
