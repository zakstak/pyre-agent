/** The review page: the tour, the files, the comments, and the reviewer's controls. */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../../schema/input.ts";
import type { ATTENTION_KINDS } from "../../schema/tour.ts";
import { unifiedDiff } from "../../review/linediff.ts";
import { parseRows } from "../../review/patch.ts";
import {
  approvalHolds,
  currentSubmission,
  turnOf,
} from "../../review/state.ts";
import { type StopView, tourView } from "../../review/tour.ts";
import type { ReviewView } from "../../store/store.ts";
import type { Assets } from "../assets.ts";
import { type Html, html } from "../html.ts";
import { anchorLabel, thread, time } from "./comments.ts";
import {
  diffTable,
  type Layout,
  placeComments,
  type PlacedComment,
} from "./diff.ts";
import { targetLine } from "./home.ts";
import { page, themeToggle } from "./layout.ts";

const ATTENTION_LABEL: Readonly<
  Record<(typeof ATTENTION_KINDS)[number], string>
> = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
};

/** The rail's short name for each kind of call a stop asks the reviewer to make. */
const ATTENTION_CHIP: Readonly<Record<(typeof ATTENTION_KINDS)[number], string>> = {
  tradeoff: "Tradeoff",
  contract: "Contract",
  product: "Product call",
  risk: "Risk",
  accessibility: "Accessibility",
};

const STATUS_LABEL: Readonly<Record<ReviewFile["status"], string>> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  removed: "Removed",
  renamed: "Renamed",
  copied: "Copied",
  changed: "Changed",
  unchanged: "Unchanged",
};

const PATCH_NOTE_TEXT: Readonly<
  Record<NonNullable<ReviewFile["patch_note"]>, string>
> = {
  binary: "Binary file; no text to show.",
  too_large: "The patch is too large to show.",
  symlink: "A symbolic link; the patch shows its target.",
  submodule: "A submodule; the patch shows the commit it points to.",
  secret: "Likely a secret, so its contents were left out.",
  no_content_change: "Only the mode changed.",
  empty: "An empty file.",
  replaced_characters:
    "Hidden or reordering characters in this patch were replaced.",
};

/** Prose from the agent: paragraphs split on blank lines, shown as text. */
const prose = (text: string): Html =>
  html`${text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => html`<p>${paragraph}</p>`)}`;

interface FileContext {
  /** The file's place in the round, which names its tables and panels: paths do not make safe IDs. */
  readonly index: number;
  readonly file: ReviewFile;
  readonly approved: boolean;
  readonly placed: ReadonlyArray<PlacedComment>;
  readonly orphans: ReadonlyArray<Extract<Comment, { kind: "inline" }>>;
  readonly open: number;
}

interface PageContext {
  readonly view: ReviewView;
  readonly input: ReviewInput;
  readonly files: ReadonlyMap<string, FileContext>;
  readonly writable: boolean;
  /** How whole files show their patch. Excerpts are always unified. */
  readonly layout: Layout;
  /** The round before this one, to show what each file changed since. */
  readonly previous:
    | {
        readonly round: number;
        readonly files: ReadonlyMap<string, ReviewFile>;
      }
    | undefined;
}

const fileContexts = (
  view: ReviewView,
  input: ReviewInput,
): ReadonlyMap<string, FileContext> =>
  new Map(
    input.files.map((file, index) => {
      const { placed, orphans } = placeComments(file, view.state.comments);
      return [
        file.path,
        {
          index,
          file,
          approved: view.state.approvals.some(
            (approval) =>
              approval.path === file.path && approvalHolds(approval, [file]),
          ),
          placed,
          orphans,
          open: [...placed.map((item) => item.comment), ...orphans].filter(
            (comment) => turnOf(comment) !== "resolved",
          ).length,
        },
      ];
    }),
  );

const stat = (file: ReviewFile): Html =>
  html`<span class="stat"><span class="added">+${file.additions}</span> <span class="deleted">−${file.deletions}</span></span>`;

const approveButton = (context: FileContext, writable: boolean): Html =>
  !writable
    ? context.approved
      ? html`<span class="chip success">Approved</span>`
      : html``
    : context.file.fingerprint === undefined
      ? html`<span class="chip" title="This file has no fingerprint, so it cannot be approved">Cannot approve</span>`
      : html`<button type="button" class="approve${context.approved ? " approved" : ""}" data-action="approve" data-path="${context.file.path}" data-fingerprint="${context.file.fingerprint}" aria-pressed="${context.approved}">${context.approved ? "Approved" : "Approve"}</button>`;

/** Whether a file is new in this round, or changed since the round before; undefined when it is as it was. */
const sinceRound = (
  context: FileContext,
  page: PageContext,
): "new" | "changed" | undefined => {
  if (page.previous === undefined) return undefined;
  const before = page.previous.files.get(context.file.path);
  if (before === undefined) return "new";
  return before.fingerprint !== context.file.fingerprint
    ? "changed"
    : undefined;
};

const sinceChip = (context: FileContext, page: PageContext): Html => {
  const since = sinceRound(context, page);
  return since === undefined
    ? html``
    : html`<span class="chip">${since === "new" ? "New" : "Changed"} in round ${(page.previous?.round ?? 0) + 1}</span>`;
};

/**
 * What a file changed since the round before, as a read-only patch between the two rounds' texts. Each round's patch
 * compares with the base, so for a file changed again, or one new to the repository, only this shows the latest work.
 */
const sinceSection = (
  context: FileContext,
  page: PageContext,
  tableId: string,
): Html => {
  if (sinceRound(context, page) !== "changed") return html``;
  const before = page.previous?.files.get(context.file.path)?.new_content;
  const after = context.file.new_content;
  if (before === undefined || after === undefined) return html``;
  const patch = unifiedDiff(before, after);
  if (patch === undefined) return html``;
  return html`<details class="file-detail since" id="since-${tableId}"><summary>Changes since round ${page.previous?.round}</summary>${diffTable(
    {
      // The same file with the patch between rounds; without its text, so the table shows no unchanged lines.
      file: (({ new_content: _text, ...file }) => ({ ...file, patch }))(
        context.file,
      ),
      comments: [],
      tableId: `${tableId}-since`,
      threads: page.view.threads,
      writable: false,
      readOnly: true,
    },
  )}</details>`;
};

/** A file's panel: its header, the agent's notes on it, and its whole patch. */
const filePanel = (
  context: FileContext,
  page: PageContext,
  tableId: string,
): Html => {
  const { file } = context;
  return html`<article class="panel file${context.approved ? " approved" : ""}" id="file-${tableId}" data-path="${file.path}">
<header class="file-head">
<h3 class="file-path"><code>${file.path}</code>${file.old_path === undefined ? "" : html` <span class="muted small">from <code>${file.old_path}</code></span>`}</h3>
<p class="cluster small">
<span class="chip">${STATUS_LABEL[file.status]}</span>
${file.group === "core" ? "" : html`<span class="chip">${file.group === "wiring" ? "Wiring" : "Mechanical"}</span>`}
${stat(file)}
${context.open > 0 ? html`<span class="chip warning">${context.open} open</span>` : ""}
${sinceChip(context, page)}
${approveButton(context, page.writable)}
</p>
</header>
<details class="file-body" id="body-${tableId}-${context.approved ? "approved" : "open"}"${context.approved ? "" : " open"}>
<summary class="file-toggle"><span class="when-closed">${context.approved ? "Approved. Show the change" : "Show the change"}</span><span class="when-open">Hide the change</span></summary>
${file.summary === undefined ? "" : html`<div class="file-summary">${prose(file.summary)}</div>`}
${
  file.callouts === undefined || file.callouts.length === 0
    ? ""
    : html`<ul class="callouts">${file.callouts.map((callout) => html`<li class="notice warning"><strong>${callout.tag}</strong> ${callout.text}</li>`)}</ul>`
}
${sinceSection(context, page, tableId)}
${
  file.pseudocode === undefined
    ? ""
    : html`<details class="file-detail"><summary>Pseudocode</summary><div class="code-region"><pre>${file.pseudocode}</pre></div></details>`
}
${
  file.trace === undefined
    ? ""
    : html`<details class="file-detail"><summary>Trace</summary><dl class="trace"><dt>Input</dt><dd><pre>${file.trace.input}</pre></dd><dt>Before</dt><dd><pre>${file.trace.before}</pre></dd><dt>After</dt><dd><pre>${file.trace.after}</pre></dd></dl></details>`
}
${
  file.patch === undefined
    ? html`<p class="muted small patch-note">${PATCH_NOTE_TEXT[file.patch_note ?? "empty"]}</p>`
    : html`${file.patch_note === undefined ? "" : html`<p class="muted small patch-note">${PATCH_NOTE_TEXT[file.patch_note]}</p>`}${diffTable(
        {
          file,
          comments: context.placed,
          tableId,
          threads: page.view.threads,
          writable: page.writable,
          layout: page.layout,
        },
      )}`
}
${
  context.orphans.length === 0
    ? ""
    : html`<section class="orphans">
<h4 class="small">Comments that no longer attach</h4>
${context.orphans.map((comment) => orphan(comment, page, `${tableId}-orphan`))}
</section>`
}
</details>
</article>`;
};

const stopFiles = (stop: StopView, page: PageContext): Html =>
  stop.files.length === 0
    ? html``
    : html`<section class="stop-files">
<h3 class="small">${stop.excerpts.length === 0 ? "Files in this stop" : "Also in this stop"}</h3>
<ul class="file-list">${stop.files.map((item) => {
        const context = page.files.get(item.path);
        if (context === undefined) return "";
        return html`<li class="file-row"${context.approved ? html` data-approved` : ""}>
<details class="file-disclosure">
<summary><code class="file-path">${item.path}</code> ${stat(context.file)} ${context.approved ? html`<span class="chip success">Approved</span>` : ""}${context.open > 0 ? html`<span class="chip warning">${context.open} open</span>` : ""}</summary>
${item.note === undefined ? "" : html`<p class="small muted">${item.note}</p>`}
<div class="file-disclosure-body">${filePanel(context, page, `s${stop.index}f${context.index}`)}</div>
</details>
</li>`;
      })}</ul>
</section>`;

const stopArticle = (
  stop: StopView,
  total: number,
  page: PageContext,
  stops: ReadonlyArray<StopView>,
): Html => {
  const next = stops[stop.index + 1];
  const previous = stops[stop.index - 1];
  return html`<article class="stop" id="stop-${stop.index + 1}" data-stop="${stop.index}" aria-labelledby="stop-${stop.index + 1}-title" hidden>
<header class="stop-head">
<p class="small muted">Stop ${stop.index + 1} of ${total}</p>
<div class="stop-nav cluster">
<button type="button" class="quiet" data-stop-go="${stop.index - 1}" ${previous === undefined ? "disabled" : ""} aria-label="Previous stop">←</button>
<button type="button" class="quiet" data-stop-go="${stop.index + 1}" ${next === undefined ? "disabled" : ""} aria-label="Next stop">→</button>
<span class="hint"><kbd>J</kbd> next · <kbd>K</kbd> previous</span>
</div>
</header>
<h2 id="stop-${stop.index + 1}-title">${stop.title}</h2>
<div class="stop-summary">${prose(stop.summary)}</div>
${
  stop.attention === null
    ? ""
    : html`<div class="notice warning attention"><strong>${ATTENTION_LABEL[stop.attention.kind]}</strong> ${stop.attention.note}</div>`
}
${stop.excerpts.map((excerpt, index) => {
  const context = page.files.get(excerpt.path);
  if (context === undefined) return "";
  const tableId = `s${stop.index}e${index}`;
  const rows = parseRows(context.file.patch ?? "").length;
  return html`<figure class="excerpt">
<figcaption>
<span class="excerpt-path"><code>${excerpt.path}</code>${context.approved ? html` <span class="chip success">Approved</span>` : ""}</span>
${excerpt.caption === "" ? "" : html`<span class="excerpt-caption">${excerpt.caption}</span>`}
<span class="muted small">${excerpt.end_row - excerpt.start_row + 1} of ${rows} rows · <a href="#files/${excerpt.path}" data-open-file="${excerpt.path}">Open file</a></span>
</figcaption>
${diffTable({
  file: context.file,
  range: { start: excerpt.start_row, end: excerpt.end_row },
  comments: context.placed,
  notes: excerpt.notes,
  tableId,
  threads: page.view.threads,
  writable: page.writable,
})}
${
  excerpt.notes.length === 0
    ? ""
    : html`<ol class="notes">${excerpt.notes.map(
        (note) =>
          html`<li id="${tableId}-note-${note.letter}"><span class="note-marker" aria-hidden="true">${note.letter}</span> <strong>${note.title}</strong>${note.body === "" ? "" : html` <span>${note.body}</span>`}</li>`,
      )}</ol>`
}
</figure>`;
})}
${stopFiles(stop, page)}
${
  stop.questions.length === 0
    ? ""
    : html`<section class="questions">
<h3 class="small">Questions to consider</h3>
<ul class="cluster">${stop.questions.map((question) => html`<li><button type="button" class="quiet question" data-question="${question}">${question}</button></li>`)}</ul>
</section>`
}
${
  page.writable
    ? html`<p><button type="button" class="quiet" data-ask-stop="${stop.title}">Ask about this stop</button></p>`
    : ""
}
<footer class="stop-foot">
${previous === undefined ? html`<span></span>` : html`<button type="button" class="quiet" data-stop-go="${stop.index - 1}">← ${previous.title}</button>`}
${
  next === undefined
    ? page.writable
      ? html`<button type="button" class="primary" data-open-finish>Finish review</button>`
      : ""
    : html`<button type="button" data-stop-go="${stop.index + 1}">Next: ${next.title} →</button>`
}
</footer>
</article>`;
};

/** A path as the rail shows it: the file's name first, and the folder it is in below, so long paths stay readable. */
const pathParts = (path: string): Html => {
  const at = path.lastIndexOf("/");
  return at === -1
    ? html`<code class="file-base">${path}</code>`
    : html`<code class="file-base">${path.slice(at + 1)}</code><code class="file-dir">${path.slice(0, at + 1)}</code>`;
};

const rail = (stops: ReadonlyArray<StopView>, page: PageContext): Html => {
  const groups = ["core", "wiring", "mechanical"] as const;
  const label = {
    core: "Core",
    wiring: "Wiring",
    mechanical: "Mechanical",
  } as const;
  return html`<aside class="rail" aria-label="Review navigation">
<nav class="tour-nav" aria-label="Review tour">
<p class="small muted rail-count"><span data-seen-count>0</span> of ${stops.length} read</p>
<ol class="stops">${stops.map(
    (
      stop,
    ) => html`<li><button type="button" class="stop-link" data-stop-go="${stop.index}" aria-current="false">
<span class="stop-bullet" aria-hidden="true">${stop.index + 1}</span>
<span class="stop-text"><span class="stop-title">${stop.title}</span>
<span class="small muted">${stop.files.length === 0 ? "Context, no code" : `${stop.files.length} file${stop.files.length === 1 ? "" : "s"}`}${stop.attention === null ? "" : html` · <span class="chip warning">${ATTENTION_CHIP[stop.attention.kind]}</span>`}</span></span>
</button></li>`,
  )}</ol>
</nav>
<nav class="files-nav" aria-label="Changed files">
<p class="small muted rail-count">${[...page.files.values()].filter((item) => item.approved).length} of ${page.files.size} approved</p>
${groups.map((group) => {
  const files = [...page.files.values()].filter(
    (item) => item.file.group === group,
  );
  return files.length === 0
    ? ""
    : html`<p class="small rail-group">${label[group]}</p>
<ul class="file-links">${files.map(
        (
          item,
        ) => html`<li><a class="file-link${item.approved ? " approved" : ""}" href="#files/${item.file.path}" data-open-file="${item.file.path}" title="${item.file.path}">
<span class="file-link-name">${pathParts(item.file.path)}</span>
<span class="file-link-meta small">${item.open > 0 ? html`<span class="open-count" title="${item.open} open comments">${item.open}</span>` : ""}${item.approved ? html`<span class="check" aria-label="approved">✓</span>` : ""}</span>
</a></li>`,
      )}</ul>`;
})}
</nav>
</aside>`;
};

/** An inline comment that has no rows in this round, with where it pointed and why it no longer attaches. */
const orphan = (
  comment: Extract<Comment, { kind: "inline" }>,
  page: PageContext,
  instance: string,
): Html =>
  html`<div class="orphan"><p class="small muted">${anchorLabel(comment)} in round ${comment.anchor.snapshot.round}: ${comment.attachment.state === "orphan" ? comment.attachment.reason : ""}</p>
<pre class="orphan-quote code-region"><code>${comment.anchor.quote}</code></pre>
${page.writable ? html`<p><button type="button" class="quiet" data-reattach="${comment.id}">Move to other lines</button></p>` : ""}
${thread(comment, { threads: page.view.threads, writable: page.writable, instance })}</div>`;

/**
 * Inline comments on files that left the round, such as a reverted or renamed file. No file panel shows them, so
 * they get their own section in both views; otherwise their answers could never be read or accepted.
 */
const departedSection = (page: PageContext): Html => {
  const departed = page.view.state.comments.filter(
    (comment): comment is Extract<Comment, { kind: "inline" }> =>
      comment.kind === "inline" && !page.files.has(comment.anchor.path),
  );
  return departed.length === 0
    ? html``
    : html`<section class="departed stack" id="departed" aria-labelledby="departed-title">
<h2 id="departed-title">Comments on files no longer in this round</h2>
${departed.map((comment) => orphan(comment, page, "departed"))}
</section>`;
};

const generalSection = (page: PageContext): Html => {
  const comments = page.view.state.comments.filter(
    (comment) => comment.kind === "general",
  );
  return html`<section class="general stack" id="general" aria-labelledby="general-title">
<h2 id="general-title">On the whole change</h2>
${comments.length === 0 ? html`<p class="muted">No general comments yet.</p>` : comments.map((comment) => thread(comment, { threads: page.view.threads, writable: page.writable, instance: "general" }))}
${
  !page.writable
    ? ""
    : html`<form class="composer general-composer" data-action="general_comment">
<label for="general-body">Comment on the change</label>
<textarea id="general-body" name="body" rows="3" placeholder="A question, a concern, or a direction for the agents"></textarea>
<div class="cluster"><button type="submit">Add comment</button><button type="button" data-ask>Ask now</button><span class="hint">A comment waits for Finish review; a question goes to the agents now. Ctrl+Enter adds a comment.</span></div>
</form>`
}
</section>`;
};

const finishDialog = (page: PageContext, round: number): Html => {
  const open = page.view.state.comments.filter(
    (comment) => turnOf(comment) === "agent",
  ).length;
  const approved = [...page.files.values()].filter(
    (item) => item.approved,
  ).length;
  const submission = currentSubmission(page.view.state);
  return html`<dialog id="finish" class="panel" aria-labelledby="finish-title">
<form method="dialog" class="panel-body stack" data-action="submit" data-round="${round}">
<h2 id="finish-title">Finish round ${round}</h2>
<p class="small muted">${open} comment${open === 1 ? "" : "s"} wait${open === 1 ? "s" : ""} for the agents · ${approved} of ${page.files.size} file${page.files.size === 1 ? "" : "s"} approved${submission === undefined ? "" : html` · you finished this round before with <strong>${submission.verdict.replace("_", " ")}</strong>`}</p>
<fieldset class="verdicts">
<legend>Verdict</legend>
<label><input type="radio" name="verdict" value="comment" checked> Comment <span class="hint">Answers wanted; no decision yet</span></label>
<label><input type="radio" name="verdict" value="approve"> Approve <span class="hint">Good to land once open comments are answered</span></label>
<label><input type="radio" name="verdict" value="request_changes"> Request changes <span class="hint">The agents publish a new round</span></label>
</fieldset>
<div class="field"><label for="finish-body">Summary</label><textarea id="finish-body" name="body" rows="4" placeholder="What the agents should take from this round, beyond the comments"></textarea></div>
<div class="cluster"><button type="submit" class="primary">Finish review</button><button type="button" class="quiet" data-close-finish>Cancel</button></div>
</form>
</dialog>`;
};

const notices = (page: PageContext): Html => {
  const { view } = page;
  const submission = currentSubmission(view.state);
  const waiting = view.state.comments.filter(
    (comment) => turnOf(comment) === "agent",
  ).length;
  const yours = view.state.comments.filter(
    (comment) => turnOf(comment) === "reviewer",
  ).length;
  return html`${view.state.closed_at === undefined ? "" : html`<div class="notice"><strong>Closed.</strong> A newer review of this target replaced it. This one is read-only.</div>`}
${
  submission === undefined
    ? ""
    : html`<div class="notice success"><strong>Finished ${time(submission.submitted_at)}</strong> with <em>${submission.verdict.replace("_", " ")}</em>.${submission.body.trim() === "" ? "" : html` ${submission.body}`} ${waiting > 0 ? `${waiting} comment${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} for the agents.` : ""}</div>`
}
${yours > 0 ? html`<div class="notice warning"><strong>${yours} answer${yours === 1 ? "" : "s"} to read.</strong> Accept each answer that settles the comment, or reply.</div>` : ""}
${driftNotice(page)}`;
};

/** What an agent found changed since this round, until the next round replaces it. */
const driftNotice = (page: PageContext): Html => {
  const drift = page.view.state.drift;
  if (drift === undefined || drift.round !== page.view.round?.round)
    return html``;
  const count = drift.paths.length;
  return html`<div class="notice warning drift"><strong>The code changed since this round.</strong> ${
    drift.head_sha === undefined
      ? ""
      : html`The pull request's head is now <code>${drift.head_sha.slice(0, 12)}</code>. `
  }${
    count === 0
      ? ""
      : html`${count} file${count === 1 ? "" : "s"} changed: ${drift.paths.slice(0, 8).map((path, at) => html`${at === 0 ? "" : ", "}<code>${path}</code>`)}${count > 8 ? ` and ${count - 8} more` : ""}. `
  }Comments still apply to what this round shows; the agents publish a new round with the change. <span class="muted">Checked ${time(drift.checked_at)}.</span></div>`;
};

/** The page for a review that has a round. */
export const reviewPage = (
  assets: Assets["Service"],
  view: ReviewView,
  input: ReviewInput,
  options: {
    readonly layout?: Layout;
    /** The input of the round before this one. */
    readonly previous?: ReviewInput | undefined;
  } = {},
): Html => {
  const layout = options.layout ?? "unified";
  const round = view.round;
  if (round === undefined) throw new Error("reviewPage needs a round");
  const writable = view.state.closed_at === undefined;
  const files = fileContexts(view, input);
  const previous =
    options.previous === undefined || round.round < 2
      ? undefined
      : {
          round: round.round - 1,
          files: new Map(
            options.previous.files.map((file) => [file.path, file]),
          ),
        };
  const page: PageContext = { view, input, files, writable, layout, previous };
  const { stops } = tourView(input);
  const title = input.target.title;
  const threads = view.threads;
  const fileEntries = [...files.values()];
  return pageShell(assets, {
    title: `${title} · Review canvas`,
    topbar: html`<p class="topbar-title"><a href="/" class="muted">Review canvas</a> <span class="muted">/</span> ${title}</p>
<div class="topbar-actions">
<span class="chip">Round ${round.round}</span>
<div class="view-switch" role="group" aria-label="View">
<button type="button" class="quiet" data-view="tour" aria-pressed="true">Tour</button>
<button type="button" class="quiet" data-view="files" aria-pressed="false">Files</button>
</div>
${
  threads.length < 2
    ? ""
    : html`<label class="sr-only" for="thread-filter">Thread</label><select id="thread-filter" data-thread-filter><option value="">All threads</option>${threads.map((thread) => html`<option value="${thread.id}">${thread.label}</option>`)}</select>`
}
<button type="button" class="quiet layout-toggle" data-layout-toggle aria-pressed="${layout === "split"}" title="Show whole files side by side">Side by side</button>
${writable ? html`<button type="button" class="primary" data-open-finish>Finish review</button>` : ""}
${themeToggle}
</div>`,
    bodyClass: "review",
    data: {
      review: view.state.id,
      revision: String(view.revision),
      round: String(round.round),
      writable: String(writable),
    },
    body: html`<div class="layout">
${rail(stops, page)}
<main id="main" class="main stack">
<section class="overview stack">
<p class="small">${targetLine(input.target)}${input.files_complete ? "" : html` <span class="chip warning">File list may be incomplete</span>`}</p>
${notices(page)}
${input.summary === undefined ? "" : html`<div class="summary reading">${prose(input.summary)}</div>`}
<p class="small muted">Published ${time(round.published_at)} by ${threads.find((thread) => thread.id === round.thread)?.label ?? round.thread} · ${fileEntries.length} file${fileEntries.length === 1 ? "" : "s"} · ${stops.length} stop${stops.length === 1 ? "" : "s"} · <a href="/reviews/${view.state.id}/feedback.json" download>Export feedback</a>${
      writable
        ? html` · <label class="import-label">Import feedback<input type="file" class="sr-only" accept="application/json,.json" data-import></label>`
        : ""
    }</p>
</section>
<section class="tour" id="tour-view" aria-label="Tour">${stops.map((stop) => stopArticle(stop, stops.length, page, stops))}</section>
<section class="files stack" id="files-view" aria-label="Changed files" hidden>
${fileEntries.map((context) => filePanel(context, page, `f${context.index}`))}
</section>
${departedSection(page)}
${generalSection(page)}
</main>
</div>
${writable ? finishDialog(page, round.round) : ""}
<template id="composer-template"><tr class="composer-row"><td colspan="4"><form class="composer" data-action="comment">
<p class="small muted">Comment on <span data-range></span></p>
<label class="sr-only" for="composer-body">Comment</label>
<textarea id="composer-body" name="body" rows="3" required placeholder="What should change, or what do you want to know?"></textarea>
<div class="cluster"><button type="submit" class="primary">Add comment</button><button type="button" data-ask>Ask now</button><button type="button" class="quiet" data-cancel>Cancel</button><span class="hint">Ctrl+Enter to add · Esc to cancel</span></div>
</form></td></tr></template>
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>`,
  });
};

const pageShell = page;

/** The page for a review no thread has published a round to yet. */
export const waitingPage = (
  assets: Assets["Service"],
  view: ReviewView,
): Html =>
  page(assets, {
    title: `${view.state.target.title} · Review canvas`,
    topbar: html`<p class="topbar-title"><a href="/" class="muted">Review canvas</a> <span class="muted">/</span> ${view.state.target.title}</p><div class="topbar-actions">${themeToggle}</div>`,
    data: {
      review: view.state.id,
      revision: String(view.revision),
      round: "0",
      writable: "false",
    },
    body: html`<main id="main" class="page stack">
<h1>${view.state.target.title}</h1>
<p class="small">${targetLine(view.state.target)}</p>
<div class="notice"><strong>Waiting for the first round.</strong> ${view.threads.map((thread) => thread.label).join(", ")} registered; the page refreshes when a round is published.</div>
</main>`,
  });
