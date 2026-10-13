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
  restoreGaps,
  restoreGeneral,
  restoreReplyDrafts,
} from "./comments.ts";
import {
  LAYOUT_COOKIE,
  NARROW_HEADER,
  NARROW_QUERY,
} from "../review/layout.ts";
import { retryDelay } from "./revisions.ts";
import { applyHash, installTour, syncRail } from "./tour.ts";

/** A page too narrow for two halves side by side, which shows the unified layout whatever the cookie says. */
const narrow = matchMedia(NARROW_QUERY);

const review = document.body.dataset.review;

/** Times as the reader's clock shows them. The server writes UTC. */
const localizeTimes = () => {
  const format = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  for (const time of document.querySelectorAll<HTMLTimeElement>(
    "time[datetime]",
  )) {
    const at = Date.parse(time.dateTime);
    if (Number.isFinite(at)) time.textContent = format.format(at);
  }
};

/** The finish dialog a refresh brought while the old one was open. */
let deferredDialog: Element | undefined;

/** The finish dialog is looked up on each use: a refresh replaces it. */
const installFinish = () => {
  const dialog = () => document.querySelector<HTMLDialogElement>("#finish");
  // A dialog's close event does not bubble, so listen while it travels down.
  document.addEventListener(
    "close",
    (event) => {
      if (
        event.target instanceof HTMLDialogElement &&
        event.target.id === "finish" &&
        deferredDialog !== undefined
      ) {
        event.target.replaceWith(deferredDialog);
        deferredDialog = undefined;
      }
    },
    true,
  );
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-open-finish]")) dialog()?.showModal();
    else if (target?.closest("[data-close-finish]")) dialog()?.close();
  });
  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null || form.dataset.action !== "submit") return;
    event.preventDefault();
    const data = new FormData(form);
    void tryAct({
      kind: "submit",
      // The round the dialog was opened on: a verdict never covers a round the reviewer has not read.
      round: Number(form.dataset.round),
      verdict: String(data.get("verdict") ?? "comment"),
      body: String(data.get("body") ?? ""),
    }).then((done) => {
      if (done) {
        dialog()?.close();
        toast("Review finished. The agents have the turn.");
      }
    });
  });
};

const installThreadFilter = () => {
  const select = document.querySelector<HTMLSelectElement>(
    "[data-thread-filter]",
  );
  if (select === null) return;
  const apply = () => {
    const chosen = select.value;
    for (const reply of document.querySelectorAll<HTMLElement>(
      ".reply.agent[data-thread]",
    ))
      reply.hidden = chosen !== "" && reply.dataset.thread !== chosen;
  };
  select.addEventListener("change", apply);
  apply();
};

/**
 * Replaces the page's content with the server's current rendering, keeping what the reviewer was doing: the view
 * and stop in the hash, open disclosures, drafts, and the scroll position.
 */
/** Set when the page needs the server's markup even at the same revision, as after a layout change. */
let redraw = false;

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
  const drafts = composerDrafts();
  const general = generalDraft();
  const replies = replyDrafts();
  const open = new Set(
    [...document.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (details) =>
        details.id ||
        details.querySelector("summary")?.textContent?.trim() ||
        "",
    ),
  );
  const scrollY = window.scrollY;
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.id
      : "";
  const layout = document.querySelector(".layout");
  const freshLayout = fresh.querySelector(".layout");
  const dialog = document.querySelector("#finish");
  const freshDialog = fresh.querySelector("#finish");
  if (layout === null || freshLayout === null) {
    location.reload();
    return "updated";
  }
  layout.replaceWith(freshLayout);
  // An open dialog keeps the round the reviewer is finishing; the newer one takes its place once it closes.
  if (dialog instanceof HTMLDialogElement && dialog.open)
    deferredDialog = freshDialog ?? undefined;
  else if (dialog !== null && freshDialog !== null) {
    dialog.replaceWith(freshDialog);
    deferredDialog = undefined;
  }
  const topbar = document.querySelector("header.topbar");
  const freshTopbar = fresh.querySelector("header.topbar");
  if (topbar !== null && freshTopbar !== null) {
    const toggle = topbar.querySelector("#theme-toggle");
    topbar.replaceWith(freshTopbar);
    // The theme script bound its button once; keep it.
    if (toggle !== null)
      freshTopbar.querySelector("#theme-toggle")?.replaceWith(toggle);
  }
  // The markup's facts travel with it: its revision, round, and whether it can change.
  for (const key of Object.keys(document.body.dataset))
    if (!(key in fresh.body.dataset)) delete document.body.dataset[key];
  Object.assign(document.body.dataset, fresh.body.dataset);
  document.body.className = fresh.body.className;
  refreshed(nextRevision);
  // Announced before drafts come back, so a notice about a draft whose code changed is the one left showing.
  if (document.body.dataset.round !== previousRound)
    toast(`Round ${document.body.dataset.round ?? ""} was published.`);
  for (const details of document.querySelectorAll<HTMLDetailsElement>(
    "details",
  )) {
    const key =
      details.id || details.querySelector("summary")?.textContent?.trim() || "";
    if (open.has(key)) details.open = true;
  }
  for (const heading of document.querySelectorAll<HTMLElement>(
    "article.stop h2, article.file h3",
  ))
    heading.tabIndex = -1;
  localizeTimes();
  installThreadFilter();
  syncRail();
  applyHash({ scroll: false });
  restoreComposers(drafts);
  restoreGeneral(general);
  restoreReplyDrafts(replies);
  restoreGaps();
  window.scrollTo({ top: scrollY });
  if (focused !== "")
    document.getElementById(focused)?.focus({ preventScroll: true });
  return "updated";
};

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
  // a row mean the server is gone, not a blip. The live region is in the page before it says anything.
  let unanswered = 0;
  const lost = document.createElement("div");
  lost.className = "connection-lost";
  lost.setAttribute("role", "status");
  lost.dataset.connection = "";
  document.body.append(lost);
  const open = () => {
    if (source !== undefined || document.hidden) return;
    const stream = new EventSource(`/reviews/${review}/events`);
    source = stream;
    stream.addEventListener("open", () => {
      streamFailures = 0;
      unanswered = 0;
      lost.textContent = "";
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
        lost.textContent =
          "Lost connection to the review server. It stops after a long idle time; ask the agent to run any review-canvas command, such as review-canvas status, to start it again. This page reconnects on its own when the server returns on this port; otherwise open the URL that command prints.";
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
 * Whole files side by side, or unified. The choice is a cookie the server reads when it renders, so every refresh
 * keeps it.
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
    const toggle = target?.closest<HTMLElement>("[data-layout-toggle]");
    if (toggle == null) return;
    const split = toggle.getAttribute("aria-pressed") !== "true";
    document.cookie = `${LAYOUT_COOKIE}=${split ? "split" : "unified"}; path=/; samesite=strict; max-age=31536000`;
    toggle.setAttribute("aria-pressed", String(split));
    document.dispatchEvent(new CustomEvent("review:redraw"));
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
if (document.body.classList.contains("review")) {
  installTour();
  installComments();
  installFinish();
  installThreadFilter();
  installLayout();
  installImport();
}
installLive();
