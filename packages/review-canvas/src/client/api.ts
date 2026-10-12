/** The page's one way to change the review: an action with the revision it saw. */

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

/** The revision the page's markup reflects. A refresh moves it. */
export const rendered = (): number =>
  Number(document.body.dataset.revision ?? "0");

let latest = rendered();

/** The newest revision the page heard of, from an action's answer or the event stream. */
export const known = (): number => Math.max(latest, rendered());

export const heard = (value: number): void => {
  latest = Math.max(latest, value);
};

/** Sends an action. On success the body's revision moves to the server's. */
export const act = async (action: Record<string, unknown>): Promise<number> => {
  const response = await fetch(`/reviews/${reviewId()}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, revision: known() }),
  });
  const body = (await response.json()) as
    | { ok: true; revision: number }
    | { ok: false; error: Refusal };
  if (!body.ok) throw new ActionRefused(body.error);
  heard(body.revision);
  document.dispatchEvent(new CustomEvent("review:refresh"));
  return body.revision;
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

/** Runs an action and reports a refusal instead of throwing. Returns whether it succeeded. */
export const tryAct = async (
  action: Record<string, unknown>,
): Promise<boolean> => {
  try {
    await act(action);
    return true;
  } catch (error) {
    if (error instanceof ActionRefused) {
      toast(error.message, "danger");
      if (error.refusal.kind === "stale")
        document.dispatchEvent(new CustomEvent("review:refresh"));
      return false;
    }
    toast("The server did not answer. Is it still running?", "danger");
    return false;
  }
};
