/** Comments: selecting rows of a diff, the composer that opens under them, replies, and approvals. */
import { tryAct } from "./api.ts";

interface Selection {
  readonly table: HTMLTableElement;
  readonly start: number;
  readonly end: number;
}

let selection: Selection | undefined;
let dragging:
  | { readonly table: HTMLTableElement; readonly from: number }
  | undefined;

const rowsOf = (table: HTMLTableElement) => [
  ...table.querySelectorAll<HTMLTableRowElement>("tr[data-row]"),
];

const paintSelection = () => {
  for (const row of document.querySelectorAll<HTMLElement>("tr.selected"))
    row.classList.remove("selected");
  if (selection === undefined) return;
  for (const row of rowsOf(selection.table)) {
    const index = Number(row.dataset.row);
    if (index >= selection.start && index <= selection.end)
      row.classList.add("selected");
  }
};

const removeComposer = () => {
  document.querySelector(".composer-row")?.remove();
  selection = undefined;
  paintSelection();
};

/** The visible rows of the table that lie in the selection, so the composer sits under the last one. */
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
    .map((row) => row.cells[column]?.textContent?.trim() ?? "")
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

/** Opens the composer under the selection, with any draft text carried over. */
const openComposer = (where: Selection, draft = "") => {
  document.querySelector(".composer-row")?.remove();
  selection = where;
  paintSelection();
  const template =
    document.querySelector<HTMLTemplateElement>("#composer-template");
  const anchorRow = lastSelectedRow(where);
  if (template === null || anchorRow === undefined) return;
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const composerRow = fragment.querySelector<HTMLElement>(".composer-row");
  if (composerRow === null) return;
  // Under the thread row that already follows the anchor row, if any.
  const after = anchorRow.nextElementSibling?.classList.contains("thread-row")
    ? anchorRow.nextElementSibling
    : anchorRow;
  after.after(fragment);
  const range = composerRow.querySelector<HTMLElement>("[data-range]");
  if (range !== null)
    range.textContent = `${where.table.dataset.path ?? ""}, ${lineLabel(where)}`;
  const textarea = composerRow.querySelector<HTMLTextAreaElement>("textarea");
  if (textarea !== null) {
    textarea.value = draft;
    textarea.focus();
  }
};

/** What an open composer holds, so a refresh can bring it back. */
export const composerDraft = () => {
  const composer = document.querySelector<HTMLElement>(".composer-row");
  if (composer === null || selection === undefined) return undefined;
  return {
    path: selection.table.dataset.path ?? "",
    table: selection.table.dataset.table ?? "",
    start: selection.start,
    end: selection.end,
    body: composer.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
  };
};

export const restoreComposer = (
  draft: NonNullable<ReturnType<typeof composerDraft>>,
) => {
  const table = document.querySelector<HTMLTableElement>(
    `table.diff[data-table="${CSS.escape(draft.table)}"]`,
  );
  if (table === null) return;
  openComposer({ table, start: draft.start, end: draft.end }, draft.body);
};

const submitComposer = async (form: HTMLFormElement) => {
  if (selection === undefined) return;
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (body === "") {
    textarea?.focus();
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button !== null) button.disabled = true;
  const done = await tryAct({
    kind: "comment",
    selection: {
      path: selection.table.dataset.path,
      start_row: selection.start,
      end_row: selection.end,
    },
    body,
  });
  if (done) removeComposer();
  else if (button !== null) button.disabled = false;
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
  await tryAct({
    kind: "reply",
    comment: article.dataset.comment,
    action,
    body,
  });
};

const submitGeneral = async (form: HTMLFormElement) => {
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea");
  const body = textarea?.value.trim() ?? "";
  if (body === "") {
    textarea?.focus();
    return;
  }
  const done = await tryAct({ kind: "general_comment", body });
  if (done && textarea !== null) textarea.value = "";
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

/** Reply drafts by comment ID, so a refresh keeps what the reviewer typed. */
export const replyDrafts = (): Record<string, string> => {
  const drafts: Record<string, string> = {};
  for (const form of document.querySelectorAll<HTMLFormElement>(
    ".reply-form",
  )) {
    const id = form.closest<HTMLElement>("[data-comment]")?.dataset.comment;
    const value =
      form.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
    if (id !== undefined && value !== "") drafts[id] = value;
  }
  return drafts;
};

export const restoreReplyDrafts = (drafts: Record<string, string>) => {
  for (const [id, value] of Object.entries(drafts)) {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      `[data-comment="${CSS.escape(id)}"] .reply-form textarea`,
    );
    if (textarea !== null) textarea.value = value;
  }
};

export const installComments = () => {
  const writable = document.body.dataset.writable === "true";

  document.addEventListener("mousedown", (event) => {
    if (!writable || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest<HTMLElement>("td.line-number, td.marker");
    const row = cell?.closest<HTMLTableRowElement>("tr[data-selectable]");
    const table = row?.closest<HTMLTableElement>("table.diff");
    if (
      cell === null ||
      cell === undefined ||
      row === undefined ||
      row === null ||
      table === null ||
      table === undefined
    )
      return;
    event.preventDefault();
    dragging = { table, from: Number(row.dataset.row) };
    selection = { table, start: dragging.from, end: dragging.from };
    document.querySelector(".composer-row")?.remove();
    paintSelection();
  });
  document.addEventListener("mouseover", (event) => {
    if (dragging === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLTableRowElement>("tr[data-selectable]");
    if (
      row === null ||
      row === undefined ||
      row.closest("table.diff") !== dragging.table
    )
      return;
    const at = Number(row.dataset.row);
    selection = {
      table: dragging.table,
      start: Math.min(dragging.from, at),
      end: Math.max(dragging.from, at),
    };
    paintSelection();
  });
  document.addEventListener("mouseup", () => {
    if (dragging === undefined || selection === undefined) return;
    dragging = undefined;
    openComposer(selection);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const cancel = target.closest("[data-cancel]");
    if (cancel !== null) {
      removeComposer();
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
    if (event.key === "Escape" && target.closest(".composer-row") !== null) {
      event.preventDefault();
      removeComposer();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      target.form?.requestSubmit();
    }
  });
};
