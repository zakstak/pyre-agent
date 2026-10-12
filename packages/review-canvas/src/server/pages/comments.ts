/** Comment threads: the comment, every reply, and the reviewer's next move. */
import type { Comment, Disposition, Reply } from "../../schema/feedback.ts";
import type { Thread } from "../../schema/thread.ts";
import { type Turn, turnOf } from "../../review/state.ts";
import { type Html, html } from "../html.ts";

export interface ThreadOptions {
  readonly threads: ReadonlyArray<Thread>;
  /** False on a closed review: nothing can change. */
  readonly writable: boolean;
  /**
   * Which rendering of the thread this is. One inline comment can show in an excerpt, a stop's file list, and the
   * files view, and each copy needs its own form IDs so a draft and focus return to the copy the reviewer used.
   */
  readonly instance: string;
}

export const time = (at: string): Html =>
  html`<time datetime="${at}" title="${at}">${at.slice(0, 16).replace("T", " ")} UTC</time>`;

const DISPOSITION_LABEL: Readonly<Record<Disposition, string>> = {
  fixed: "Fixed",
  rejected: "Not changed",
  deferred: "Deferred",
  question: "Question",
  answered: "Answered",
};

const DISPOSITION_CHIP: Readonly<Record<Disposition, string>> = {
  fixed: "success",
  rejected: "warning",
  deferred: "",
  question: "",
  answered: "success",
};

const threadLabel = (threads: ReadonlyArray<Thread>, id: string) =>
  threads.find((thread) => thread.id === id)?.label ?? id;

const reply = (item: Reply, options: ThreadOptions): Html => {
  switch (item.actor) {
    case "agent":
      return html`<li class="reply agent" data-thread="${item.thread}">
<p class="meta small"><span class="chip ${DISPOSITION_CHIP[item.disposition]}">${DISPOSITION_LABEL[item.disposition]}</span> <span class="muted">${threadLabel(options.threads, item.thread)} · ${time(item.created_at)}</span></p>
<p class="body">${item.body}</p>
${item.disposition === "deferred" ? html`<p class="small"><strong>Blocked by:</strong> ${item.blocker}</p>` : ""}
${
  item.disposition === "fixed"
    ? html`<p class="small muted">Fixed in ${"commit" in item.fixed_in ? html`commit <code>${item.fixed_in.commit.slice(0, 12)}</code>` : html`file version <code>${item.fixed_in.fingerprint.slice(0, 12)}</code>`}</p>`
    : ""
}
</li>`;
    case "reviewer":
      return html`<li class="reply reviewer">
<p class="meta small"><strong>${item.action === "accept" ? "Accepted" : item.action === "reopen" ? "Reopened" : "You"}</strong> <span class="muted">· ${time(item.created_at)}</span></p>
${item.body.trim() === "" ? "" : html`<p class="body">${item.body}</p>`}
</li>`;
    case "github":
      return html`<li class="reply github">
<p class="meta small"><strong>${item.github.author ?? "ghost"}</strong> <span class="muted">· on GitHub · <a href="${item.github.url}" rel="noopener">${time(item.created_at)}</a></span></p>
<p class="body">${item.body}</p>
</li>`;
  }
};

const TURN_LABEL: Readonly<Record<Turn, string>> = {
  agent: "Waits for the agent",
  reviewer: "Your turn",
  resolved: "Resolved",
};

const TURN_CHIP: Readonly<Record<Turn, string>> = {
  agent: "",
  reviewer: "warning",
  resolved: "success",
};

/** Where an inline comment points, for the lists that show it away from its rows. */
export const anchorLabel = (comment: Comment): Html =>
  comment.kind === "inline"
    ? html`<code>${comment.anchor.path}</code> <span class="muted">${comment.anchor.side === "old" ? "old" : ""} line${comment.anchor.start_line === comment.anchor.end_line ? ` ${comment.anchor.start_line}` : `s ${comment.anchor.start_line}–${comment.anchor.end_line}`}</span>`
    : html`<span class="muted">On the whole change</span>`;

/** One comment with its conversation and, on the reviewer's turn, the reply form. */
export const thread = (comment: Comment, options: ThreadOptions): Html => {
  const turn = turnOf(comment);
  const moved =
    comment.kind === "inline" &&
    comment.attachment.state === "attached" &&
    comment.attachment.reason !== "Same patch."
      ? comment.attachment.reason
      : undefined;
  return html`<article class="thread turn-${turn}" data-comment="${comment.id}" data-turn="${turn}" aria-label="Comment">
<header class="thread-head">
<p class="meta small">${
    comment.source.kind === "github"
      ? html`<strong>${comment.source.author ?? "ghost"}</strong> <span class="muted">· on <a href="${comment.source.url}" rel="noopener">GitHub</a></span>`
      : html`<strong>You</strong>${comment.source.question === true ? html` <span class="chip">Question</span>` : ""}`
  } <span class="muted">· ${time(comment.created_at)}</span>${moved === undefined ? "" : html` <span class="muted">· moved: ${moved}</span>`}</p>
<span class="chip ${TURN_CHIP[turn]}">${TURN_LABEL[turn]}</span>
</header>
<p class="body">${comment.body}</p>
${comment.replies.length === 0 ? "" : html`<ol class="replies">${comment.replies.map((item) => reply(item, options))}</ol>`}
${
  !options.writable
    ? ""
    : turn === "resolved"
      ? html`<div class="thread-actions"><button type="button" class="quiet" data-action="reopen">Reopen</button></div>`
      : html`<form class="reply-form" data-action="reply">
<label class="sr-only" for="reply-${options.instance}-${comment.id}">Reply</label>
<textarea id="reply-${options.instance}-${comment.id}" name="body" rows="2" placeholder="${turn === "agent" ? "Add to the comment" : "Reply to the answer"}"></textarea>
<div class="thread-actions">
<button type="submit" class="quiet" data-reply="reply">Reply</button>
<button type="button" class="${turn === "reviewer" ? "primary" : ""}" data-reply="accept" title="${turn === "reviewer" ? "The answer settles it" : "Withdraw the comment"}">${turn === "reviewer" ? "Accept" : "Withdraw"}</button>
</div>
</form>`
}
</article>`;
};
