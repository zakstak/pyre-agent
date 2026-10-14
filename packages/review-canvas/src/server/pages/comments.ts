/** Comment threads: the comment, every reply, and the reviewer's next move, as GitHub shows a review thread. */
import type { Comment, Disposition, Reply } from "../../schema/feedback.ts";
import type { Thread } from "../../schema/thread.ts";
import { commentElementId } from "../../review/next.ts";
import type { Standing } from "../../review/progress.ts";
import { type Turn, turnOf } from "../../review/state.ts";
import { type Html, html } from "../html.ts";
import { threadName, threadNameOf, time } from "./names.ts";

export { time } from "./names.ts";

export interface ThreadOptions {
  readonly threads: ReadonlyArray<Thread>;
  /** False on a closed review: nothing can change. */
  readonly writable: boolean;
  /** Which table or section renders the thread, which names its reply form, so a draft returns to it. */
  readonly instance: string;
  /** Whose move each comment waits for, as the review's progress counts it. */
  readonly standing: (comment: Comment) => Standing;
}

const DISPOSITION: Readonly<
  Record<Disposition, { readonly label: string; readonly tone: string }>
> = {
  fixed: { label: "Fixed", tone: "ok" },
  rejected: { label: "Rejected", tone: "warn" },
  deferred: { label: "Deferred", tone: "" },
  question: { label: "Question", tone: "" },
  answered: { label: "Answered", tone: "ok" },
};

const chip = (label: string, tone = ""): Html =>
  html`<span class="tag${tone === "" ? "" : ` ${tone}`}">${label}</span>`;

const agentName = (threads: ReadonlyArray<Thread>, id: string): Html => {
  const label = threads.find((thread) => thread.id === id)?.label ?? id;
  return html`<strong title="${label}">${threadName(label)}</strong>`;
};

const reply = (item: Reply, options: ThreadOptions): Html => {
  switch (item.actor) {
    case "agent": {
      const disposition = DISPOSITION[item.disposition];
      return html`<li class="msg reply agent" data-thread="${item.thread}">
<p class="by">${agentName(options.threads, item.thread)} ${chip(disposition.label, disposition.tone)} ${time(item.created_at)}</p>
<p class="body">${item.body}</p>
${item.disposition === "deferred" ? html`<p class="small"><strong>Blocked by:</strong> ${item.blocker}</p>` : ""}
${
  item.disposition === "fixed"
    ? html`<p class="small muted">Fixed in ${"commit" in item.fixed_in ? html`commit <code>${item.fixed_in.commit.slice(0, 7)}</code>` : html`file version <code>${item.fixed_in.fingerprint.slice(0, 7)}</code>`}</p>`
    : ""
}
</li>`;
    }
    case "reviewer":
      return html`<li class="msg reply reviewer">
<p class="by"><strong>You</strong>${item.action === "accept" ? html` <span>accepted</span>` : item.action === "reopen" ? html` <span>reopened</span>` : ""} ${time(item.created_at)}</p>
${item.body.trim() === "" ? "" : html`<p class="body">${item.body}</p>`}
</li>`;
    case "github":
      return html`<li class="msg reply github">
<p class="by"><strong>${item.github.author ?? "ghost"}</strong> <span>on GitHub</span> ${time(item.created_at)}</p>
<p class="body">${item.body}</p>
</li>`;
  }
};

/** Who the comment waits for: the agent that answered last, the only thread, or the agents. */
const waitingFor = (comment: Comment, threads: ReadonlyArray<Thread>) => {
  const answered = comment.replies.findLast((item) => item.actor === "agent");
  if (answered !== undefined) return threadNameOf(threads, answered.thread);
  const only = threads.length === 1 ? threads[0] : undefined;
  return only === undefined ? "the agents" : threadName(only.label);
};

/** What the comment's state says, when it says something: whose turn it is, or how it ended. */
const turnChip = (
  comment: Comment,
  standing: Standing,
  threads: ReadonlyArray<Thread>,
): Html => {
  switch (standing) {
    case "pending":
      return html`<span class="tag" title="Sent with your review">Pending</span>`;
    case "reviewer":
      return chip("Your turn", "turn");
    case "agent":
      return chip(`Waiting for ${waitingFor(comment, threads)}`, "wait");
    case "resolved":
      // An accept with no answer before it is the reviewer taking the comment back.
      return comment.replies.some((item) => item.actor !== "reviewer")
        ? chip("Resolved", "ok")
        : chip("Withdrawn");
  }
};

/** The reviewer's moves on a thread, under its last message. Reply opens a text box in place. */
const actions = (
  comment: Comment,
  turn: Turn,
  options: ThreadOptions,
  extra: Html,
): Html => {
  if (!options.writable) return html``;
  if (turn === "resolved")
    return html`<div class="thread-actions"><button type="button" class="small-button" data-action="reopen">Reopen</button>${extra}</div>`;
  const id = `reply-${options.instance}-${comment.id}`;
  return html`<form class="reply-form" data-action="reply">
<div class="reply-editor" hidden>
<label class="sr-only" for="${id}">Reply</label>
<textarea id="${id}" name="body" rows="3" placeholder="${turn === "agent" ? "Add to the comment" : "Reply to the answer"}"></textarea>
<div class="thread-actions"><button type="submit" class="small-button primary" data-reply="reply">Reply</button><button type="button" class="small-button quiet" data-reply-cancel>Cancel</button><span class="hint">Ctrl+Enter · Esc</span></div>
</div>
<div class="thread-actions" data-reply-actions>
${turn === "reviewer" ? html`<button type="button" class="small-button" data-reply="accept" title="The answer settles the comment">Accept</button>` : ""}
<button type="button" class="small-button quiet" data-reply-open>Reply</button>
${turn === "agent" ? html`<button type="button" class="small-button quiet" data-reply="accept" title="Take the comment back">Withdraw</button>` : ""}
${extra}
</div>
</form>`;
};

/**
 * One comment with its conversation and the reviewer's moves. `extra` adds a move, such as moving a comment whose
 * lines left the round.
 */
export const thread = (
  comment: Comment,
  options: ThreadOptions,
  extra: Html = html``,
): Html => {
  const turn = turnOf(comment);
  const standing = options.standing(comment);
  // The reattachment's reason, only where it found the lines somewhere else; the comment already sits on them.
  const moved =
    comment.kind === "inline" &&
    comment.attachment.state === "attached" &&
    comment.attachment.reason !== "Same patch."
      ? comment.attachment.reason
      : undefined;
  return html`<article class="thread turn-${turn}" id="${commentElementId(comment.id)}" data-comment="${comment.id}" data-turn="${turn}" data-standing="${standing}" aria-label="Comment" tabindex="-1">
<div class="msg">
<p class="by">${
    comment.source.kind === "github"
      ? html`<strong>${comment.source.author ?? "ghost"}</strong> <span>on GitHub</span>`
      : html`<strong>You</strong>`
  } ${time(comment.created_at)} ${turnChip(comment, standing, options.threads)}${moved === undefined ? "" : html` <span class="moved" title="${moved}">moved</span>`}</p>
<p class="body">${comment.body}</p>
</div>
${comment.replies.length === 0 ? "" : html`<ol class="replies">${comment.replies.map((item) => reply(item, options))}</ol>`}
${actions(comment, turn, options, extra)}
</article>`;
};
