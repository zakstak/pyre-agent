import "./main.css";
import "../../../../skills/internal-visual-style/assets/theme.js";
import { heard, known, rendered, toast, tryAct } from "./api.ts";
import {
  composerDraft,
  generalDraft,
  installComments,
  replyDrafts,
  restoreComposer,
  restoreGeneral,
  restoreReplyDrafts,
} from "./comments.ts";
import { applyHash, installTour } from "./tour.ts";

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

/** The finish dialog is looked up on each use: a refresh replaces it. */
const installFinish = () => {
  const dialog = () => document.querySelector<HTMLDialogElement>("#finish");
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
const refresh = async () => {
  const response = await fetch(location.pathname, {
    headers: { accept: "text/html" },
  });
  if (!response.ok) return;
  const fresh = new DOMParser().parseFromString(
    await response.text(),
    "text/html",
  );
  const nextRevision = Number(fresh.body.dataset.revision ?? "0");
  if (nextRevision <= rendered()) return;
  const draft = composerDraft();
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
    return;
  }
  layout.replaceWith(freshLayout);
  if (
    dialog !== null &&
    freshDialog !== null &&
    !(dialog instanceof HTMLDialogElement && dialog.open)
  )
    dialog.replaceWith(freshDialog);
  const topbar = document.querySelector("header.topbar");
  const freshTopbar = fresh.querySelector("header.topbar");
  if (topbar !== null && freshTopbar !== null) {
    const toggle = topbar.querySelector("#theme-toggle");
    topbar.replaceWith(freshTopbar);
    // The theme script bound its button once; keep it.
    if (toggle !== null)
      freshTopbar.querySelector("#theme-toggle")?.replaceWith(toggle);
  }
  document.body.dataset.revision = String(nextRevision);
  heard(nextRevision);
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
  applyHash({ scroll: false });
  if (draft !== undefined) restoreComposer(draft);
  restoreGeneral(general);
  restoreReplyDrafts(replies);
  window.scrollTo({ top: scrollY });
  if (focused !== "")
    document.getElementById(focused)?.focus({ preventScroll: true });
};

/** Keeps the page current. A hidden page closes its stream and catches up when shown again. */
const installLive = () => {
  if (review === undefined || review === "") return;
  let source: EventSource | undefined;
  let running = false;
  let again = false;
  // One refresh at a time; a change that arrives during one queues one more.
  const schedule = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void refresh().finally(() => {
      running = false;
      if (again || known() > rendered()) {
        again = false;
        schedule();
      }
    });
  };
  const open = () => {
    if (source !== undefined) return;
    source = new EventSource(`/reviews/${review}/events`);
    source.addEventListener("change", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        revision: number;
      };
      heard(data.revision);
      if (data.revision > rendered()) schedule();
    });
    source.addEventListener("error", () => {
      // The browser retries on its own; nothing to do unless the server went away for good.
    });
  };
  const close = () => {
    source?.close();
    source = undefined;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
    else {
      open();
      schedule();
    }
  });
  document.addEventListener("review:refresh", schedule);
  open();
};

localizeTimes();
if (document.body.classList.contains("review")) {
  installTour();
  installComments();
  installFinish();
  installThreadFilter();
}
installLive();
