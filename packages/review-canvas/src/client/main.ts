import "./main.css";
import "../../../../skills/internal-visual-style/assets/theme.js";
import {
  behind,
  heard,
  importFeedback,
  refreshed,
  rendered,
  toast,
  tryAct,
} from "./api.ts";
import {
  composerDrafts,
  generalDraft,
  installComments,
  replyDrafts,
  restoreComposers,
  restoreGeneral,
  restoreReplyDrafts,
} from "./comments.ts";
import { openFiles, restoreFolds, restoreGaps } from "./folds.ts";
import {
  LAYOUT_COOKIE,
  NARROW_HEADER,
  NARROW_QUERY,
} from "../review/layout.ts";
import { retryDelay } from "./revisions.ts";
import { afterRefresh, installTour } from "./tour.ts";
import { installRepositories } from "./repositories.ts";

/** A page too narrow for two halves side by side, which shows the unified layout whatever the cookie says. */
const narrow = matchMedia(NARROW_QUERY);

const review = document.body.dataset.review;

/** Times as the reader's clock shows them: the time alone today, with the date otherwise. The server writes UTC. */
const localizeTimes = () => {
  const now = new Date();
  const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const full = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  for (const time of document.querySelectorAll<HTMLTimeElement>(
    "time[datetime]",
  )) {
    const at = new Date(time.dateTime);
    if (!Number.isFinite(at.getTime())) continue;
    const format =
      at.toDateString() === now.toDateString()
        ? clock
        : at.getFullYear() === now.getFullYear()
          ? day
          : full;
    time.textContent = format.format(at);
    time.title = full.format(at);
  }
};

/**
 * The theme, chosen in the footer: the system's, light, or dark. The shared style's script applies a saved choice
 * when the page loads; this keeps the same storage and attribute.
 */
const THEME_KEY = "internal-visual-style-theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");

const themeChoice = (): "system" | "light" | "dark" => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
};

const syncTheme = () => {
  const choice = themeChoice();
  document.documentElement.dataset.theme =
    choice === "system" ? (systemDark.matches ? "dark" : "light") : choice;
  for (const button of document.querySelectorAll<HTMLElement>(
    "[data-theme-choice]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.themeChoice === choice),
    );
};

const installTheme = () => {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLElement>("[data-theme-choice]");
    if (button == null) return;
    try {
      if (button.dataset.themeChoice === "system")
        localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, button.dataset.themeChoice ?? "");
    } catch {
      /* The choice holds for this page. */
    }
    syncTheme();
  });
  systemDark.addEventListener("change", syncTheme);
  syncTheme();
};

/**
 * A finish section a refresh brought while the reviewer was in the old one. The old one stays, so the verdict covers
 * the round the reviewer was reading; the newer one takes its place once focus leaves it or the server refuses it.
 */
let deferredFinish: HTMLElement | undefined;

const finishSection = () => document.querySelector<HTMLElement>("#finish");

/** Swaps in the newer finish section, carrying over the verdict and summary the reviewer chose. */
const catchUpFinish = () => {
  const old = finishSection();
  const fresh = deferredFinish;
  deferredFinish = undefined;
  if (old === null || fresh === undefined) return;
  const verdict = old.querySelector<HTMLInputElement>(
    "input[name='verdict']:checked",
  )?.value;
  const body = old.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
  const focused = old.contains(document.activeElement);
  old.replaceWith(fresh);
  if (verdict !== undefined) {
    const input = fresh.querySelector<HTMLInputElement>(
      `input[name='verdict'][value='${CSS.escape(verdict)}']`,
    );
    if (input !== null) input.checked = true;
  }
  const textarea = fresh.querySelector<HTMLTextAreaElement>("textarea");
  if (textarea !== null) textarea.value = body;
  if (focused)
    (
      fresh.querySelector<HTMLElement>("input[name='verdict']:checked") ??
      fresh.querySelector<HTMLElement>("h2")
    )?.focus();
  localizeTimes();
};

const installFinish = () => {
  document.addEventListener("focusout", (event) => {
    const finish = finishSection();
    if (deferredFinish === undefined || finish === null) return;
    const next =
      event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (
      event.target instanceof Node &&
      finish.contains(event.target) &&
      next !== null &&
      !finish.contains(next)
    )
      queueMicrotask(catchUpFinish);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null || form.dataset.action !== "submit") return;
    event.preventDefault();
    const data = new FormData(form);
    void tryAct({
      kind: "submit",
      // The round the section was rendered for: a verdict never covers a round the reviewer has not read.
      round: Number(form.dataset.round),
      verdict: String(data.get("verdict") ?? "comment"),
      body: String(data.get("body") ?? ""),
    }).then((done) => {
      if (done) {
        toast("Review finished. The agents have the turn.");
        // The form goes when the refresh shows the finish; its heading keeps the reviewer in the section.
        finishSection()?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
      } else catchUpFinish();
    });
  });
};

/** Elements a reviewer can be focused on. */
const FOCUSABLE = "a[href], button, input, textarea, select, summary, [tabindex]";

/** Attributes that name a control better than its place among its neighbours. */
const NAMING = [
  "data-action",
  "data-path",
  "data-reply",
  "data-reply-open",
  "data-fold",
  "data-layout",
  "data-theme-choice",
  "data-next-go",
  "data-stop-link",
  "data-toc-file",
];

/**
 * What the reviewer is focused on, as a refresh can find it again: an ID, or a control inside an element with one,
 * and the elements with IDs around it, outermost last, for when the control itself is gone.
 */
interface FocusKey {
  readonly id: string;
  readonly match?: string;
  readonly index?: number;
  readonly around: ReadonlyArray<string>;
}

const idsAround = (element: Element): ReadonlyArray<string> => {
  const ids: Array<string> = [];
  for (let at = element.parentElement?.closest("[id]"); at != null; at = at.parentElement?.closest("[id]"))
    ids.push(at.id);
  return ids;
};

const focusKey = (): FocusKey | undefined => {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body)
    return undefined;
  const around = idsAround(element);
  if (element.id !== "") return { id: element.id, around };
  const anchor = element.parentElement?.closest<HTMLElement>("[id]");
  if (anchor == null) return undefined;
  const match = NAMING.filter((name) => element.hasAttribute(name))
    .map((name) => `[${name}="${CSS.escape(element.getAttribute(name) ?? "")}"]`)
    .join("");
  return {
    id: anchor.id,
    match,
    index: [...anchor.querySelectorAll(FOCUSABLE)].indexOf(element),
    around,
  };
};

const shown = (element: Element) => element.closest("[hidden]") === null;

/**
 * Where focus goes when what had it is gone or hidden, as after Accept, a sent reply, Withdraw, Reopen, or a finish:
 * a thread's next action, or the thread itself; a section's heading; or the element, when it takes focus.
 */
const focusWithin = (container: HTMLElement): HTMLElement | null => {
  if (container.matches("article.thread"))
    return (
      [...container.querySelectorAll<HTMLElement>(".thread-actions button")].find(shown) ?? container
    );
  if (container.hasAttribute("tabindex")) return container;
  return container.querySelector<HTMLElement>(":scope > h2[tabindex], :scope > .stop-head > h2[tabindex]");
};

/** Focuses an element after a refresh, or else the nearest thing around it that the reviewer can act on. */
const restoreFocus = (key: FocusKey | undefined) => {
  if (key === undefined) return;
  const anchor = document.getElementById(key.id);
  const found =
    anchor === null
      ? null
      : key.index === undefined
        ? anchor
        : ((key.match === undefined || key.match === ""
            ? null
            : anchor.querySelector<HTMLElement>(key.match)) ??
          (key.match === undefined || key.match === ""
            ? (anchor.querySelectorAll<HTMLElement>(FOCUSABLE)[key.index] ?? null)
            : null));
  if (found !== null && shown(found)) {
    found.focus({ preventScroll: true });
    if (document.activeElement === found) return;
  }
  for (const id of [key.id, ...key.around]) {
    const container = document.getElementById(id);
    if (container === null || !shown(container)) continue;
    const target = focusWithin(container);
    if (target === null) continue;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
};

/** Set when the page needs the server's markup even at the same revision, as after a layout change. */
let redraw = false;

/**
 * Replaces the page's content with the server's current rendering, keeping what the reviewer was doing: drafts,
 * folds and open disclosures, a finish in progress, the scroll position, and focus.
 */
const refresh = async (): Promise<"updated" | "current" | "failed"> => {
  const force = redraw;
  redraw = false;
  let text: string;
  try {
    const response = await fetch(location.pathname, {
      headers: {
        accept: "text/html",
        ...(narrow.matches ? { [NARROW_HEADER]: "1" } : {}),
      },
    });
    if (!response.ok) return "failed";
    text = await response.text();
  } catch {
    return "failed";
  }
  const fresh = new DOMParser().parseFromString(text, "text/html");
  const nextRevision = Number(fresh.body.dataset.revision ?? "0");
  if (nextRevision < rendered() || (nextRevision === rendered() && !force))
    return "current";
  const previousRound = document.body.dataset.round;
  const frame = document.querySelector<HTMLElement>(".frame");
  const freshFrame = fresh.querySelector<HTMLElement>(".frame");
  // A review that got its first round is a page of another kind; load it whole.
  if (
    frame === null ||
    freshFrame === null ||
    frame.dataset.frame !== freshFrame.dataset.frame
  ) {
    location.reload();
    return "updated";
  }
  const drafts = composerDrafts();
  const general = generalDraft();
  const replies = replyDrafts();
  const disclosures = new Set(
    [
      ...document.querySelectorAll<HTMLDetailsElement>(
        "details[open]:not(.contents-disclosure)",
      ),
    ].map(
      (details) =>
        details.id ||
        details.querySelector("summary")?.textContent?.trim() ||
        "",
    ),
  );
  const scrollY = window.scrollY;
  const focused = focusKey();
  const open = openFiles();
  // A new round while the reviewer is choosing a verdict or writing a summary: keep that section until they leave it.
  const finish = finishSection();
  const engaged =
    finish !== null &&
    (fresh.body.dataset.round !== previousRound || deferredFinish !== undefined) &&
    (finish.contains(document.activeElement) ||
      (finish.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "") !==
        "" ||
      deferredFinish !== undefined);
  frame.replaceWith(freshFrame);
  const freshFinish = finishSection();
  if (engaged && finish !== null && freshFinish !== null) {
    deferredFinish = freshFinish;
    freshFinish.replaceWith(finish);
  } else deferredFinish = undefined;
  const topbar = document.querySelector("header.topbar");
  const freshTopbar = fresh.querySelector("header.topbar");
  if (topbar !== null && freshTopbar !== null) {
    // The connection's live region keeps its state; the live code owns it.
    const status = topbar.querySelector("[data-connection]");
    topbar.replaceWith(freshTopbar);
    if (status !== null)
      freshTopbar.querySelector("[data-connection]")?.replaceWith(status);
  }
  // The markup's facts travel with it: its revision, round, and whether it can change.
  for (const key of Object.keys(document.body.dataset))
    if (!(key in fresh.body.dataset)) delete document.body.dataset[key];
  Object.assign(document.body.dataset, fresh.body.dataset);
  document.body.className = fresh.body.className;
  refreshed(nextRevision);
  // Announced before drafts come back, so a notice about a draft whose code changed is the one left showing.
  if (document.body.dataset.round !== previousRound) {
    const kept = finishSection()?.dataset.round;
    toast(
      kept !== undefined && kept !== document.body.dataset.round
        ? `Round ${document.body.dataset.round ?? ""} was published. Your finish still names round ${kept}.`
        : `Round ${document.body.dataset.round ?? ""} was published.`,
    );
  }
  for (const details of document.querySelectorAll<HTMLDetailsElement>(
    "details:not(.contents-disclosure)",
  )) {
    const key =
      details.id || details.querySelector("summary")?.textContent?.trim() || "";
    if (disclosures.has(key)) details.open = true;
  }
  localizeTimes();
  syncTheme();
  restoreFolds(open);
  restoreGaps();
  afterRefresh();
  restoreComposers(drafts);
  restoreGeneral(general);
  restoreReplyDrafts(replies);
  window.scrollTo({ top: scrollY });
  restoreFocus(focused);
  return "updated";
};

/** The live region in the top bar that says the connection is lost. Looked up on each use: a refresh moves it. */
const connectionStatus = () =>
  document.querySelector<HTMLElement>("[data-connection]");

const LOST =
  "Lost connection to the review server. It stops after a long idle time; ask the agent to run any review-canvas command, such as review-canvas status, to start it again. This page reconnects on its own when the server returns on this port; otherwise open the URL that command prints.";

/**
 * Keeps the page current. A page that is hidden, including one opened in a background tab, holds no event stream,
 * so background reviews never use up the browser's connections; it catches up when shown. A failed refresh waits
 * longer each time instead of retrying at once.
 */
const installLive = () => {
  if (review === undefined || review === "") return;
  let source: EventSource | undefined;
  let running = false;
  let again = false;
  let failures = 0;
  let retry: number | undefined;
  // One refresh at a time; a change that arrives during one queues one more.
  const schedule = () => {
    if (running) {
      again = true;
      return;
    }
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    running = true;
    void refresh()
      .catch(() => "failed" as const)
      .then((outcome) => {
        running = false;
        if (outcome === "failed") {
          failures++;
          again = false;
          retry = window.setTimeout(schedule, retryDelay(failures));
          return;
        }
        failures = 0;
        if (again || (outcome === "updated" && behind())) {
          again = false;
          schedule();
        } else if (behind()) {
          // The server answered with markup older than an announced change; ask again shortly.
          retry = window.setTimeout(schedule, retryDelay(1));
        }
      });
  };
  let streamFailures = 0;
  let reopen: number | undefined;
  // Errors since the stream last opened. The browser retries a dropped stream every few seconds; two failed tries in
  // a row mean the server is gone, not a blip: the page says it is reconnecting, and once the browser gives the
  // stream up, that it is disconnected, with what to do in the toast and the status's title.
  let unanswered = 0;
  const say = (text: string) => {
    const status = connectionStatus();
    if (status === null || status.textContent === text) return;
    status.textContent = text;
    status.title = text === "" ? "" : LOST;
    if (text === "Disconnected") toast(LOST, "danger");
  };
  const open = () => {
    if (source !== undefined || document.hidden) return;
    const stream = new EventSource(`/reviews/${review}/events`);
    source = stream;
    stream.addEventListener("open", () => {
      streamFailures = 0;
      unanswered = 0;
      say("");
    });
    // The first event names the current revision, so a stream that reconnects catches up on what it missed.
    stream.addEventListener("change", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        revision: number;
      };
      heard(data.revision);
      if (behind()) schedule();
    });
    // The browser retries a dropped stream on its own, but gives up for good on some failures, such as a server
    // that restarted on another port. Then open a new one, waiting longer each time.
    stream.addEventListener("error", () => {
      if (source !== stream) return;
      unanswered++;
      if (unanswered >= 2)
        say(streamFailures >= 1 || unanswered >= 4 ? "Disconnected" : "Reconnecting…");
      if (stream.readyState !== EventSource.CLOSED) return;
      source = undefined;
      streamFailures++;
      reopen = window.setTimeout(() => {
        reopen = undefined;
        open();
      }, retryDelay(streamFailures));
    });
  };
  const close = () => {
    source?.close();
    source = undefined;
    if (reopen !== undefined) clearTimeout(reopen);
    reopen = undefined;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
    else {
      open();
      schedule();
    }
  });
  document.addEventListener("review:refresh", schedule);
  document.addEventListener("review:redraw", () => {
    redraw = true;
    schedule();
  });
  open();
};

/**
 * Whole files split or unified. The choice is a cookie the server reads when it renders, so every refresh keeps it.
 */
const installLayout = () => {
  // The server renders the cookie's layout; a narrow page asks again for the unified one, and a page that crosses the
  // width asks for the layout that fits now.
  const redraw = () => document.dispatchEvent(new CustomEvent("review:redraw"));
  // After this script runs, once the live refresh listens for redraws.
  if (narrow.matches && document.querySelector("table.diff.split") !== null)
    queueMicrotask(redraw);
  narrow.addEventListener("change", redraw);
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLElement>("[data-layout]");
    if (button == null || button.getAttribute("aria-pressed") === "true") return;
    const split = button.dataset.layout === "split";
    document.cookie = `${LAYOUT_COOKIE}=${split ? "split" : "unified"}; path=/; samesite=strict; max-age=31536000`;
    for (const other of document.querySelectorAll<HTMLElement>("[data-layout]"))
      other.setAttribute("aria-pressed", String(other === button));
    redraw();
  });
};

/** A feedback file the reviewer chose, imported through the server's checks, with what it added and left out. */
const installImport = () => {
  document.addEventListener("change", (event) => {
    const input =
      event.target instanceof HTMLInputElement ? event.target : null;
    if (input === null || !input.hasAttribute("data-import")) return;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    void file
      .text()
      .then(importFeedback)
      .then((report) => {
        const added = `Imported ${report.comments} comment${report.comments === 1 ? "" : "s"}, ${report.replies} repl${report.replies === 1 ? "y" : "ies"}, and ${report.approvals} approval${report.approvals === 1 ? "" : "s"}.`;
        const already =
          report.already === 0 ? "" : ` ${report.already} already here.`;
        toast(
          `${added}${already}${report.skipped.length === 0 ? "" : ` ${report.skipped.join(" ")}`}`,
        );
      })
      .catch((error: unknown) =>
        toast(
          error instanceof Error
            ? `Not imported: ${error.message}`
            : "Not imported.",
          "danger",
        ),
      );
  });
};

localizeTimes();
installTheme();
installRepositories();
if (document.body.classList.contains("review")) {
  // The reviewer's folds come back before the hash is applied, so a hash or the strip still opens what it points at.
  restoreFolds();
  installTour();
  installComments();
  installFinish();
  installLayout();
  installImport();
}
installLive();
