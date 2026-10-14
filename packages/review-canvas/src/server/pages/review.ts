/**
 * The review page: one scroll in the order the agent's stops tell the story. Each stop is a section with the agent's
 * prose and the files it owns as whole diffs, the notes in the code; the conversation sits under the rows it is about;
 * the whole change and the finish come last. A strip under the title always names the one thing to do next.
 */
import type { Comment, Verdict } from "../../schema/feedback.ts";
import type { ReviewInput } from "../../schema/input.ts";
import type { ATTENTION_KINDS } from "../../schema/tour.ts";
import {
  FINISH_ELEMENT_ID,
  fileElementId,
  type Next,
  nextStep,
} from "../../review/next.ts";
import { parseRows } from "../../review/patch.ts";
import {
  approvalHolds,
  currentSubmission,
  type SubmissionRecord,
  turnOf,
} from "../../review/state.ts";
import { type StopView, tourView } from "../../review/tour.ts";
import type { ReviewView } from "../../store/store.ts";
import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";
import { thread } from "./comments.ts";
import { type InlineNote, type Layout, placeComments } from "./diff.ts";
import { type FilePage, type FileView, fileBlock, orphan } from "./file.ts";
import { connection, page as pageShell, themeControl } from "./layout.ts";
import {
  count,
  shortPath,
  targetName,
  targetText,
  threadLabel,
  threadName,
  threadNameOf,
  time,
} from "./names.ts";
import { inline, lead, prose } from "./prose.ts";

const ATTENTION_LEAD: Readonly<Record<(typeof ATTENTION_KINDS)[number], string>> = {
  tradeoff: "Tradeoff",
  contract: "Contract",
  product: "Product call",
  risk: "Risk",
  accessibility: "Accessibility",
};

/** A verdict as the strip and the home page say it. */
export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  approve: "approve",
  request_changes: "request changes",
  comment: "comment only",
};

/** What the reviewer did, in the past tense. */
const VERDICT_DONE: Readonly<Record<Verdict, string>> = {
  approve: "you approved",
  request_changes: "you requested changes",
  comment: "you commented",
};

/** A fragment link to an element ID. Paths make IDs, so the few characters a fragment cannot hold are escaped. */
const fragment = (id: string) => `#${encodeURI(id).replaceAll("#", "%23")}`;

export interface ReviewPageOptions {
  readonly layout?: Layout;
  /** The input of the round before this one. */
  readonly previous?: ReviewInput | undefined;
  /** The summaries of the rounds before this one, for the rounds line. */
  readonly earlier?: ReadonlyArray<{ readonly round: number; readonly summary: string | undefined }>;
  /** The review that replaced this one with a fresh start, if this one is closed. */
  readonly replacedBy?: string | undefined;
}

interface PageContext {
  readonly view: ReviewView;
  readonly input: ReviewInput;
  readonly stops: ReadonlyArray<StopView>;
  readonly files: ReadonlyMap<string, FileView>;
  readonly next: Next;
  readonly writable: boolean;
  readonly filePage: FilePage;
  readonly round: number;
  readonly options: ReviewPageOptions;
}

/** Each file's block as the page shows it: its approval, comments, the tour's excerpts and notes, and its fold. */
const fileViews = (
  view: ReviewView,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
  next: Next,
  previous: ReviewInput | undefined,
  round: number,
): ReadonlyMap<string, FileView> => {
  const owner = new Map<string, StopView>();
  for (const stop of stops) for (const path of stop.owns) owner.set(path, stop);
  const before = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  // The page unfolds what the strip points at.
  const target =
    next.kind === "file"
      ? next.path
      : next.kind === "answer" && next.place.kind === "inline"
        ? next.place.path
        : undefined;
  return new Map(
    input.files.map((file, index) => {
      const { placed, orphans } = placeComments(file, view.state.comments);
      const comments = [...placed.map((item) => item.comment), ...orphans];
      const approved = view.state.approvals.some(
        (approval) => approval.path === file.path && approvalHolds(approval, [file]),
      );
      const stop = owner.get(file.path);
      const excerpts = stops.flatMap((item) =>
        item.excerpts
          .map((excerpt, at) => ({ excerpt, at, stop: item }))
          .filter(({ excerpt }) => excerpt.path === file.path),
      );
      const notes: Array<InlineNote> = excerpts.flatMap(({ excerpt, at, stop: from }) =>
        excerpt.notes.map((note) => ({
          id: `s${from.index}e${at}-note-${note.letter}`,
          row: note.row,
          letter: note.letter,
          title: lead(note.title),
          body: note.body === "" ? html`` : inline(note.body),
          stop: from === stop ? undefined : from.index + 1,
        })),
      );
      const owned = excerpts.filter((item) => item.stop === stop);
      const earlier = before.get(file.path);
      const unchangedSince =
        earlier !== undefined && earlier.fingerprint !== undefined && earlier.fingerprint === file.fingerprint
          ? round - 1
          : undefined;
      const folded =
        target !== file.path &&
        (approved ||
          file.group === "mechanical" ||
          stop?.closing === true ||
          unchangedSince !== undefined ||
          owned.length === 0);
      return [
        file.path,
        {
          index,
          file,
          approved,
          lapsed: !approved && view.state.approvals.some((approval) => approval.path === file.path),
          placed,
          orphans,
          open: comments.filter((comment) => turnOf(comment) !== "resolved").length,
          forYou: comments.filter((comment) => turnOf(comment) === "reviewer").length,
          unchangedSince,
          previous: earlier,
          caption: owned[0]?.excerpt.caption,
          shown:
            excerpts.length === 0
              ? undefined
              : [
                  ...excerpts.map(({ excerpt }) => ({ start: excerpt.start_row, end: excerpt.end_row })),
                  ...placed.map((item) => ({ start: item.start, end: item.end })),
                ],
          notes,
          folded,
        } satisfies FileView,
      ];
    }),
  );
};

const viewedCount = (page: PageContext) => [...page.files.values()].filter((item) => item.approved).length;

const turnCount = (page: PageContext, turn: "reviewer" | "agent") =>
  page.view.state.comments.filter((comment) => turnOf(comment) === turn).length;

// ---------------------------------------------------------------------------------------------------------- title

const roundsLine = (page: PageContext): Html => {
  const { state } = page.view;
  const submissionOf = (round: number): SubmissionRecord | undefined =>
    state.submissions.findLast((item) => item.round === round);
  const earlier = new Map((page.options.earlier ?? []).map((item) => [item.round, item.summary]));
  const entries = state.rounds.map((round) => {
    const submission = submissionOf(round.round);
    const done = submission === undefined ? undefined : VERDICT_DONE[submission.verdict];
    if (round.round === page.round)
      return {
        line: html`<span class="round current" aria-current="true">Round ${round.round} · ${done ?? (state.closed_at === undefined ? "open" : "closed")}</span>`,
        detail: html``,
      };
    const id = `round-${round.round}-detail`;
    const summary = earlier.get(round.round);
    return {
      line: html`<button type="button" class="round" data-round-toggle aria-expanded="false" aria-controls="${id}">Round ${round.round} · ${done ?? "not finished"} · ${time(submission?.submitted_at ?? round.published_at)}</button>`,
      detail: html`<div class="round-detail" id="${id}" hidden>
<p class="round-detail-title small muted">Round ${round.round}, published ${time(round.published_at)} by ${threadNameOf(page.view.threads, round.thread)}</p>
${summary === undefined ? html`<p class="muted">No summary.</p>` : html`<div class="reading">${prose(summary)}</div>`}
${submission === undefined ? "" : html`<p class="reading"><strong>You</strong> <span class="muted">· ${VERDICT_TEXT[submission.verdict]} · ${time(submission.submitted_at)}</span>${submission.body.trim() === "" ? "" : html`<br>${submission.body}`}</p>`}
</div>`,
    };
  });
  return html`<div class="rounds">${entries.map((entry) => entry.line)}</div>${entries.map((entry) => entry.detail)}`;
};

/** What an agent found changed since this round, as one line until the next round replaces it. */
const driftLine = (page: PageContext): Html => {
  const drift = page.view.state.drift;
  if (drift === undefined || drift.round !== page.round) return html``;
  const shown = drift.paths.slice(0, 4);
  return html`<p class="drift" id="drift" tabindex="-1"><strong>Changed since this round.</strong> ${
    drift.paths.length === 0
      ? ""
      : html`${shown.map((path, at) => html`${at === 0 ? "" : ", "}<code>${path}</code>`)}${drift.paths.length > shown.length ? ` and ${drift.paths.length - shown.length} more` : ""}. `
  }${drift.head_sha === undefined ? "" : html`The head is now <code>${drift.head_sha.slice(0, 7)}</code>. `}The agents publish a new round with the change; comments still apply to what this round shows. <span class="muted">Checked ${time(drift.checked_at)}.</span></p>`;
};

const titleBlock = (page: PageContext): Html => {
  const { input, view } = page;
  const round = view.round;
  const publisher = view.threads.find((item) => item.id === round?.thread);
  const additions = input.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = input.files.reduce((sum, file) => sum + file.deletions, 0);
  const sha = input.target.head_sha;
  return html`<header class="head">
<h1>${input.target.title}</h1>
<p class="meta"><span class="who"><span class="dot" aria-hidden="true"></span><strong>${publisher === undefined ? round?.thread ?? "" : threadLabel(publisher)}</strong> published round ${page.round} at ${round === undefined ? "" : time(round.published_at)}</span>
<span><strong>${count(input.files.length, "file")}</strong> · <code class="stat"><span class="added">+${additions}</span> <span class="deleted">−${deletions}</span></code></span>
<code class="sha" title="${sha}">${sha.slice(0, 7)}</code></p>
${roundsLine(page)}
${input.files_complete ? "" : html`<p class="incomplete small muted">The file list may be incomplete.</p>`}
${driftLine(page)}
</header>`;
};

// ------------------------------------------------------------------------------------------------------- next strip

const placeText = (next: Extract<Next, { kind: "answer" }>): string =>
  next.place.kind === "general"
    ? "on the whole change"
    : `${next.place.path}:${next.place.start === next.place.end ? next.place.start : `${next.place.start}–${next.place.end}`}`;

const nextText = (page: PageContext): { readonly what: Html; readonly why: string } | undefined => {
  const { next } = page;
  switch (next.kind) {
    case "answer":
      return {
        what: next.github
          ? html`Read the reply`
          : html`Read ${threadNameOf(page.view.threads, next.thread ?? "")}’s answer`,
        why: [placeText(next), ...(next.more > 0 ? [`${next.more} more after this`] : [])].join(" · "),
      };
    case "drift":
      return { what: html`Look at what changed`, why: `${count(next.files, "file")} changed since this round` };
    case "file":
      return { what: html`Review <code>${next.path}</code>`, why: `stop ${next.stop} · ${count(next.left, "file")} left` };
    case "finish":
      return {
        what: html`Finish round ${next.round}`,
        why: `everything viewed, ${next.waiting === 0 ? "nothing waiting" : `${next.waiting} waiting for agents`}`,
      };
    default:
      return undefined;
  }
};

const nextStrip = (page: PageContext): Html => {
  const { next } = page;
  const total = page.files.size;
  const viewed = viewedCount(page);
  const forYou = turnCount(page, "reviewer");
  const waiting = turnCount(page, "agent");
  const text = nextText(page);
  const lead =
    text !== undefined && "target" in next
      ? html`<a class="next-go" href="${fragment(next.target)}" data-next-go data-target="${next.target}" data-kind="${next.kind}"><span class="next-arrow" aria-hidden="true">→</span><span class="next-what">${text.what}</span> <span class="next-why"><span class="sep">· </span>${text.why}</span></a>`
      : next.kind === "finished"
        ? html`<p class="next-state"><strong>You finished round ${next.round}</strong> <span class="next-why"><span class="sep">· </span>${VERDICT_TEXT[next.verdict]} · the agents have the turn</span></p>`
        : html`<p class="next-state"><strong>Closed</strong> <span class="next-why"><span class="sep">· </span>replaced by a fresh start</span>${page.options.replacedBy === undefined ? "" : html` · <a href="/reviews/${page.options.replacedBy}">Open the newer review</a>`}</p>`;
  return html`<section class="next" id="next" aria-label="Next">
${lead}
${text === undefined ? "" : html`<span class="keys-hint small muted" aria-hidden="true"><kbd>n</kbd> next · <kbd>j</kbd> <kbd>k</kbd> stops</span>`}
<div class="next-stats small">
<progress class="progress" value="${viewed}" max="${Math.max(total, 1)}" aria-label="Files viewed">${viewed} of ${total}</progress>
<span class="viewed-count"><strong>${viewed}</strong> of ${total} viewed</span>
${forYou === 0 ? "" : html`<span class="for-you"><strong>${forYou}</strong> for you</span>`}
${waiting === 0 ? "" : html`<span class="waiting">${waiting} waiting for agents</span>`}
</div>
</section>`;
};

// ---------------------------------------------------------------------------------------------------------- contents

const contents = (page: PageContext): Html => {
  const viewed = viewedCount(page);
  return html`<aside class="toc-pane" aria-label="Contents">
<details class="contents-disclosure" id="contents" open>
<summary class="contents-summary">Contents · ${viewed} / ${page.files.size}</summary>
<nav class="toc" aria-label="Stops and files">
<ol class="toc-stops">${page.stops.map(
    (stop) => html`<li>
<a class="toc-stop" href="#stop-${stop.index + 1}" data-stop-link="${stop.index}"><span class="n">${stop.index + 1}</span><span class="t">${stop.title}</span><span class="c">${stop.owns.length}</span></a>
${
  stop.owns.length === 0
    ? ""
    : html`<ol class="toc-files">${stop.owns.map((path) => {
        const item = page.files.get(path);
        if (item === undefined) return "";
        return html`<li><a class="toc-file${item.approved ? " is-viewed" : ""}" href="${fragment(fileElementId(path))}" data-toc-file="${path}" title="${path}"><span class="toc-name">${shortPath(path)}</span>${
          item.approved
            ? html`<span class="toc-mark ok" aria-label="viewed">✓</span>`
            : item.open > 0
              ? html`<span class="toc-mark open" aria-label="${count(item.open, "open comment")}"><span class="toc-dot" aria-hidden="true"></span>${item.open}</span>`
              : ""
        }</a></li>`;
      })}</ol>`
}
</li>`,
  )}</ol>
</nav>
<div class="contents-foot">
<div class="layout-switch" role="group" aria-label="Diff layout">
<button type="button" data-layout="unified" aria-pressed="${String(page.filePage.layout === "unified")}">Unified</button><button type="button" data-layout="split" aria-pressed="${String(page.filePage.layout === "split")}">Split</button>
</div>
<span class="muted">${viewed} / ${page.files.size}</span>
</div>
</details>
</aside>`;
};

// ------------------------------------------------------------------------------------------------------------- stops

/** For an excerpt of a file an earlier stop owns: one line that points at those rows instead of a second diff. */
const alsoLine = (stop: StopView, page: PageContext): Html => {
  const elsewhere = stop.excerpts.filter((excerpt) => !stop.owns.includes(excerpt.path));
  if (elsewhere.length === 0) return html``;
  return html`<p class="also small">Also in this stop: ${elsewhere.map((excerpt, at) => {
    const item = page.files.get(excerpt.path);
    if (item === undefined) return "";
    const rows = parseRows(item.file.patch ?? "");
    const lines = rows
      .slice(excerpt.start_row, excerpt.end_row + 1)
      .map((row) => row[excerpt.side])
      .filter((line): line is number => line !== undefined);
    const first = lines[0];
    const last = lines.at(-1);
    const span = first === undefined ? "" : first === last ? ` line ${first}` : ` lines ${first}–${last}`;
    return html`${at === 0 ? "" : ", "}<a href="#f${item.index}-r${excerpt.start_row}" data-highlight="f${item.index}" data-start="${excerpt.start_row}" data-end="${excerpt.end_row}"><code>${excerpt.path}</code>${span} ↑</a>`;
  })}</p>`;
};

const stopSection = (stop: StopView, page: PageContext): Html => {
  const owned = stop.owns.map((path) => page.files.get(path)).filter((item) => item !== undefined);
  const viewed = owned.filter((item) => item.approved).length;
  return html`<section class="stop${stop.closing ? " closing" : ""}" id="stop-${stop.index + 1}" data-stop="${stop.index}" aria-labelledby="stop-${stop.index + 1}-title">
<h2 id="stop-${stop.index + 1}-title" tabindex="-1"><span class="stop-number">${stop.index + 1}</span> <span class="stop-title">${stop.title}</span> <span class="stop-count">${count(owned.length, "file")}${viewed === 0 ? "" : ` · ${viewed} viewed`}</span></h2>
${stop.summary.trim() === "" ? "" : html`<div class="stop-summary reading">${prose(stop.summary)}</div>`}
${stop.attention === null ? "" : html`<p class="attention reading"><strong>${ATTENTION_LEAD[stop.attention.kind]}.</strong> ${inline(stop.attention.note)}</p>`}
${alsoLine(stop, page)}
${owned.map((item) => fileBlock(item, page.filePage))}
${
  stop.questions.length === 0 || !page.writable
    ? ""
    : html`<div class="questions" role="group" aria-label="Questions to ask">${stop.questions.map((question) => html`<button type="button" class="question" data-question="${question}"><span class="q" aria-hidden="true">?</span> ${inline(question)}</button>`)}</div>`
}
</section>`;
};

/**
 * Inline comments on files that left the round, such as a reverted or renamed file. No file block shows them, so
 * they get their own section; otherwise their answers could never be read or accepted.
 */
const departedSection = (page: PageContext): Html => {
  const departed = page.view.state.comments.filter(
    (comment): comment is Extract<Comment, { kind: "inline" }> =>
      comment.kind === "inline" && !page.files.has(comment.anchor.path),
  );
  return departed.length === 0
    ? html``
    : html`<section class="departed end-section" id="departed" aria-labelledby="departed-title">
<h2 id="departed-title">Files that left the round</h2>
${departed.map((comment) => orphan(comment, page.filePage, "departed", true))}
</section>`;
};

const generalSection = (page: PageContext): Html => {
  const comments = page.view.state.comments.filter((comment) => comment.kind === "general");
  return html`<section class="general end-section" id="general" aria-labelledby="general-title">
<h2 id="general-title">On the whole change</h2>
${comments.map((comment) => html`<div class="general-thread">${thread(comment, { threads: page.view.threads, writable: page.writable, instance: "general" })}</div>`)}
${
  !page.writable
    ? comments.length === 0
      ? html`<p class="muted">No comments on the whole change.</p>`
      : ""
    : html`<form class="general-composer" data-action="general_comment">
<label class="sr-only" for="general-body">Comment on the whole change</label>
<textarea id="general-body" name="body" rows="2" placeholder="A question, a concern, or a direction for the agents"></textarea>
<div class="thread-actions"><button type="submit" class="small-button primary">Comment</button><button type="button" class="small-button" data-ask>Ask now</button><span class="hint">A comment waits for Finish review; Ask now sends a question at once.</span></div>
</form>`
}
</section>`;
};

const finishSection = (page: PageContext): Html => {
  const submission = currentSubmission(page.view.state);
  const notViewed = [...page.files.values()].filter((item) => !item.approved && item.file.fingerprint !== undefined).length;
  const forYou = turnCount(page, "reviewer");
  const state =
    notViewed === 0 && forYou === 0
      ? "Everything viewed, nothing waiting."
      : `${[
          ...(notViewed === 0 ? [] : [`${count(notViewed, "file")} not yet viewed`]),
          ...(forYou === 0 ? [] : [`${count(forYou, "answer")} waiting for you`]),
        ].join(" · ")}. You can finish anyway.`;
  return html`<section class="finish end-section" id="${FINISH_ELEMENT_ID}" data-round="${page.round}" aria-labelledby="finish-title">
<h2 id="finish-title">Finish round ${page.round}</h2>
${
  submission !== undefined
    ? html`<p class="reading submission">${VERDICT_DONE[submission.verdict].replace(/^you/, "You")} at ${time(submission.submitted_at)}${submission.body.trim() === "" ? "." : html`: ${submission.body}`}</p>`
    : !page.writable
      ? html`<p class="muted">This review is closed, so it cannot be finished.</p>`
      : html`<p class="finish-state small muted">${state}</p>
<form class="finish-form" data-action="submit" data-round="${page.round}">
<fieldset class="verdicts"><legend class="sr-only">Verdict</legend>
<label class="verdict"><input type="radio" name="verdict" value="approve"> Approve</label>
<label class="verdict"><input type="radio" name="verdict" value="request_changes"> Request changes</label>
<label class="verdict"><input type="radio" name="verdict" value="comment" checked> Comment only</label>
</fieldset>
<label class="sr-only" for="finish-body">Summary</label>
<textarea id="finish-body" name="body" rows="3" placeholder="What the agents should do next"></textarea>
<div class="thread-actions"><button type="submit" class="primary">Finish review</button></div>
</form>`
}
</section>`;
};

const footer = (view: ReviewView, writable: boolean, round: boolean): Html =>
  html`<footer class="foot small muted">
${themeControl}
${round ? html`<a href="/reviews/${view.state.id}/feedback.json" download>Export feedback</a>` : ""}
${round && writable ? html`<label class="import-label">Import feedback<input type="file" class="sr-only" accept="application/json,.json" data-import></label>` : ""}
<code class="review-id">${view.state.id}</code>
</footer>`;

/** The top bar: the way back, the target, the connection, and the way out. */
const topbar = (view: ReviewView, updated: string, finish: boolean): Html => {
  const name = targetName(view.state.target);
  return html`<nav class="crumbs" aria-label="Breadcrumb"><a href="/" class="home-link">Review canvas</a> <span class="muted" aria-hidden="true">/</span> ${targetText(view.state.target)}${name.kind === "pr" ? html` <a class="external" href="${name.url}" rel="noopener" title="Open the pull request on GitHub" aria-label="Open the pull request on GitHub">↗</a>` : ""}</nav>
<div class="topbar-actions">${connection(time(updated))}${finish ? html`<a class="button primary finish-link" href="#${FINISH_ELEMENT_ID}" data-open-finish>Finish review</a>` : ""}</div>`;
};

/** The composer the page clones under the rows a reviewer selects. */
const composerTemplate = html`<template id="composer-template"><tr class="composer-row"><td colspan="4"><div class="row-body"><form class="composer" data-action="comment">
<p class="composer-range small muted">Comment on <span data-range></span></p>
<label class="sr-only" for="composer-body">Comment</label>
<textarea id="composer-body" name="body" rows="3" required placeholder="What should change, or what do you want to know?"></textarea>
<div class="thread-actions"><button type="submit" class="small-button primary">Comment</button><button type="button" class="small-button" data-ask>Ask now</button><button type="button" class="small-button quiet" data-cancel>Cancel</button><span class="hint">Ctrl+Enter · Esc</span></div>
</form></div></td></tr></template>`;

/** The page for a review that has a round. */
export const reviewPage = (
  assets: Assets["Service"],
  view: ReviewView,
  input: ReviewInput,
  options: ReviewPageOptions = {},
): Html => {
  const round = view.round;
  if (round === undefined) throw new Error("reviewPage needs a round");
  const writable = view.state.closed_at === undefined;
  const { stops } = tourView(input);
  const next = nextStep(view.state, input, stops);
  const previous = round.round > 1 ? options.previous : undefined;
  const filePage: FilePage = {
    threads: view.threads,
    writable,
    layout: options.layout ?? "unified",
    round: round.round,
  };
  const page: PageContext = {
    view,
    input,
    stops,
    files: fileViews(view, input, stops, next, previous, round.round),
    next,
    writable,
    filePage,
    round: round.round,
    options,
  };
  const updated = [round.published_at, ...view.state.comments.map((comment) => comment.updated_at), ...view.state.approvals.map((item) => item.approved_at), ...view.state.submissions.map((item) => item.submitted_at), view.state.drift?.checked_at ?? ""].reduce((a, b) => (b > a ? b : a));
  return pageShell(assets, {
    title: `${input.target.title} · Review canvas`,
    topbar: topbar(view, updated, writable && currentSubmission(view.state) === undefined),
    bodyClass: "review",
    data: {
      review: view.state.id,
      revision: String(view.revision),
      round: String(round.round),
      writable: String(writable),
    },
    body: html`<div class="frame" data-frame="review">
${titleBlock(page)}
${nextStrip(page)}
${contents(page)}
<main id="main" class="main" tabindex="-1">
${input.summary === undefined ? "" : html`<div class="overview reading">${prose(input.summary)}</div>`}
${stops.map((stop) => stopSection(stop, page))}
${departedSection(page)}
${generalSection(page)}
${finishSection(page)}
<noscript><p class="muted">Comments, Viewed, and Finish review need JavaScript. Enable it to review here.</p></noscript>
</main>
${footer(view, writable, true)}
</div>
${composerTemplate}`,
  });
};


/** The page for a review no thread has published a round to yet: the title, one sentence, and the footer. */
export const waitingPage = (assets: Assets["Service"], view: ReviewView): Html => {
  const names = view.threads.map((item) => threadName(item.label));
  const who = names.length === 0 ? "the agents" : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const first = view.threads[0];
  return pageShell(assets, {
    title: `Waiting for the first round · ${view.state.target.title} · Review canvas`,
    topbar: topbar(view, view.state.created_at, false),
    bodyClass: "waiting",
    data: {
      review: view.state.id,
      revision: String(view.revision),
      round: "0",
      writable: "false",
    },
    body: html`<div class="frame" data-frame="waiting">
<header class="head">
<h1>${view.state.target.title}</h1>
<p class="meta">${first === undefined ? "" : html`<span class="who"><span class="dot" aria-hidden="true"></span><strong>${threadLabel(first)}</strong> started this review at ${time(view.state.created_at)}</span>`} ${targetText(view.state.target)}</p>
</header>
<main id="main" class="main" tabindex="-1">
<p class="reading waiting-line">Waiting for ${who}’s first round. This page updates itself.</p>
</main>
${footer(view, false, false)}
</div>`,
  });
};
