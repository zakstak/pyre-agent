/** The page's one way to change the review: an action with the revision its markup reflects. */
import {
  afterEvent,
  afterOwnAction,
  afterRefresh,
  initial,
  isBehind,
  type Revisions,
} from "./revisions.ts";

export interface Refusal {
  readonly kind: string;
  readonly message: string;
  readonly revision?: number;
}

export class ActionRefused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

export const reviewId = (): string => document.body.dataset.review ?? "";

let revisions: Revisions = initial(
  Number(document.body.dataset.revision ?? "0"),
);

/** The revision the page's markup shows. */
export const rendered = (): number => revisions.rendered;

/** Whether the page heard of a revision its markup does not show yet. */
export const behind = (): boolean => isBehind(revisions);

export const heard = (revision: number): void => {
  revisions = afterEvent(revisions, revision);
};

export const refreshed = (revision: number): void => {
  revisions = afterRefresh(revisions, revision);
};

const askRefresh = () =>
  document.dispatchEvent(new CustomEvent("review:refresh"));

const send = async (action: Record<string, unknown>): Promise<number> => {
  const sentWith = revisions.basis;
  const response = await fetch(`/reviews/${reviewId()}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, revision: sentWith }),
  });
  const body = (await response.json()) as
    | { ok: true; revision: number }
    | { ok: false; error: Refusal };
  if (!body.ok) {
    if (body.error.revision !== undefined) heard(body.error.revision);
    throw new ActionRefused(body.error);
  }
  revisions = afterOwnAction(revisions, sentWith, body.revision);
  askRefresh();
  return body.revision;
};

export interface ImportReport {
  readonly comments: number;
  readonly replies: number;
  readonly approvals: number;
  readonly already: number;
  readonly skipped: ReadonlyArray<string>;
}

const sendImport = async (text: string): Promise<ImportReport> => {
  const sentWith = revisions.basis;
  const response = await fetch(
    `/reviews/${reviewId()}/import?revision=${sentWith}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    },
  );
  const body = (await response.json()) as
    | { ok: true; revision: number; report: ImportReport }
    | { ok: false; error: Refusal };
  if (!body.ok) {
    if (body.error.revision !== undefined) heard(body.error.revision);
    throw new ActionRefused(body.error);
  }
  revisions = afterOwnAction(revisions, sentWith, body.revision);
  askRefresh();
  return body.report;
};

// One action at a time, so each is sent on the basis the one before it left.
let queue: Promise<unknown> = Promise.resolve();

/** Sends an action after the ones before it. */
export const act = (action: Record<string, unknown>): Promise<number> => {
  const next = queue.then(() => send(action));
  queue = next.catch(() => undefined);
  return next;
};

/** Imports a feedback file's text after the actions before it. */
export const importFeedback = (text: string): Promise<ImportReport> => {
  const next = queue.then(() => sendImport(text));
  queue = next.catch(() => undefined);
  return next;
};

let toastTimer: number | undefined;

/** A short message at the bottom of the page. */
export const toast = (
  message: string,
  kind: "info" | "danger" = "info",
): void => {
  const box = document.querySelector<HTMLElement>("[data-toast]");
  if (box === null) return;
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => {
      box.hidden = true;
    },
    kind === "danger" ? 8000 : 3500,
  );
};

export type Attempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Runs an action and returns why it failed instead of throwing. A stale refusal starts a refresh. */
export const attempt = async (
  action: Record<string, unknown>,
): Promise<Attempt> => {
  try {
    await act(action);
    return { ok: true };
  } catch (error) {
    if (error instanceof ActionRefused) {
      if (error.refusal.kind === "stale" || error.refusal.kind === "changed")
        askRefresh();
      return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: "The server did not answer. Is it still running?",
    };
  }
};

/** Runs an action and shows a refusal. Returns whether it succeeded. */
export const tryAct = async (
  action: Record<string, unknown>,
): Promise<boolean> => {
  const result = await attempt(action);
  if (!result.ok) toast(result.message, "danger");
  return result.ok;
};
