/**
 * A changed file as one block of the review page: a header with its path, counts, fold toggle, and Viewed button, and
 * a body with its whole diff, the tour's notes in it, and its comments, including those whose lines left the round.
 */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import type { Thread } from "../../schema/thread.ts";
import { fileElementId } from "../../review/next.ts";
import { unifiedDiff } from "../../review/linediff.ts";
import { type Html, html } from "../html.ts";
import { thread } from "./comments.ts";
import { diffTable, type InlineNote, type Layout, type PlacedComment } from "./diff.ts";
import { count, pathParts } from "./names.ts";
import { inline, prose } from "./prose.ts";

const PATCH_NOTE_TEXT: Readonly<Record<NonNullable<ReviewFile["patch_note"]>, string>> = {
  binary: "A binary file; there is no text to show.",
  too_large: "The patch is too large to show.",
  symlink: "A symbolic link; the patch shows its target.",
  submodule: "A submodule; the patch shows the commit it points to.",
  secret: "Likely a secret, so its contents were left out.",
  no_content_change: "Only the mode changed.",
  empty: "An empty file.",
  replaced_characters: "Hidden or reordering characters in this patch were replaced.",
};

/** The status word a header shows, only when it says more than "modified". */
const statusWord = (file: ReviewFile, unchangedSince: number | undefined): string | undefined => {
  if (file.patch_note === "binary") return "binary";
  if (file.patch_note === "too_large") return "too large";
  if (file.status === "renamed" && file.old_path !== undefined) return `renamed from ${file.old_path}`;
  if (unchangedSince !== undefined) return `unchanged since round ${unchangedSince}`;
  switch (file.status) {
    case "added":
    case "copied":
      return file.status;
    case "deleted":
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return undefined;
  }
};

export interface FileView {
  /** The file's place in the round, which names its table and body. */
  readonly index: number;
  readonly file: ReviewFile;
  /** An approval of this version of the file holds. */
  readonly approved: boolean;
  /** The reviewer viewed an earlier version, which changed since. */
  readonly lapsed: boolean;
  readonly placed: ReadonlyArray<PlacedComment>;
  readonly orphans: ReadonlyArray<Extract<Comment, { kind: "inline" }>>;
  /** Comments not yet resolved, and those whose turn is the reviewer's. */
  readonly open: number;
  readonly forYou: number;
  /** The round before this one when the file is the same as it was there. */
  readonly unchangedSince: number | undefined;
  /** The file as the round before showed it, if it was in that round. */
  readonly previous: ReviewFile | undefined;
  /** The first excerpt's caption, when the owning stop excerpts the file. */
  readonly caption: string | undefined;
  /** The rows the tour excerpts; the rest fold. Undefined shows every row. */
  readonly shown: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined;
  readonly notes: ReadonlyArray<InlineNote>;
  /** The header alone shows until the reviewer opens the file. */
  readonly folded: boolean;
}

export interface FilePage {
  readonly threads: ReadonlyArray<Thread>;
  readonly writable: boolean;
  readonly layout: Layout;
  readonly round: number;
}

const tableId = (view: FileView) => `f${view.index}`;

const viewedButton = (view: FileView, page: FilePage): Html => {
  const { file } = view;
  if (file.fingerprint === undefined) return html``;
  if (!page.writable)
    return view.approved ? html`<span class="viewed-state"><span class="box" aria-hidden="true">✓</span>Viewed</span>` : html``;
  return html`<button type="button" class="viewed" data-action="approve" data-path="${file.path}" data-fingerprint="${file.fingerprint}" aria-pressed="${String(view.approved)}" title="${view.approved ? "Viewed. Activate to mark it not viewed" : "Mark this version of the file viewed"}"><span class="box" aria-hidden="true">${view.approved ? "✓" : ""}</span>Viewed</button>`;
};

/** What changed since the round before, as a read-only patch between the two rounds' texts. */
const sinceRound = (view: FileView, page: FilePage): Html => {
  const before = view.previous?.new_content;
  const after = view.file.new_content;
  if (view.unchangedSince !== undefined || before === undefined || after === undefined) return html``;
  const patch = unifiedDiff(before, after);
  if (patch === undefined) return html``;
  return html`<details class="about-part" id="since-${tableId(view)}"><summary>Changes since round ${page.round - 1}</summary>${diffTable({
    // The same file with the patch between rounds, without its text, so the table shows no unchanged lines.
    file: (({ new_content: _text, ...file }) => ({ ...file, patch }))(view.file),
    comments: [],
    tableId: `${tableId(view)}-since`,
    threads: page.threads,
    writable: false,
    readOnly: true,
  })}</details>`;
};

/** The agent's notes on the whole file, behind one quiet disclosure; nothing when there are none. */
const about = (view: FileView, page: FilePage): Html => {
  const { file } = view;
  const since = sinceRound(view, page);
  const callouts = file.callouts ?? [];
  if (file.summary === undefined && file.pseudocode === undefined && file.trace === undefined && callouts.length === 0 && since.value === "")
    return html``;
  return html`<details class="about" id="about-${tableId(view)}"><summary>About this file</summary><div class="about-body">
${file.summary === undefined ? "" : html`<div class="reading">${prose(file.summary)}</div>`}
${callouts.map((callout) => html`<p class="callout"><strong>${callout.tag}.</strong> ${inline(callout.text)}</p>`)}
${file.pseudocode === undefined ? "" : html`<details class="about-part"><summary>Pseudocode</summary><div class="code-region"><pre>${file.pseudocode}</pre></div></details>`}
${file.trace === undefined ? "" : html`<details class="about-part"><summary>Trace</summary><dl class="trace"><dt>Input</dt><dd><pre>${file.trace.input}</pre></dd><dt>Before</dt><dd><pre>${file.trace.before}</pre></dd><dt>After</dt><dd><pre>${file.trace.after}</pre></dd></dl></details>`}
${since}
</div></details>`;
};

/** Where an orphaned comment pointed, in the round it was made in. */
const orphanPlace = (comment: Extract<Comment, { kind: "inline" }>, round: number): string => {
  const { anchor } = comment;
  const lines =
    anchor.start_line === anchor.end_line ? `Line ${anchor.start_line}` : `Lines ${anchor.start_line}–${anchor.end_line}`;
  const side = anchor.side === "old" ? " (old side)" : "";
  const when = anchor.snapshot.round === round - 1 ? "the previous round" : `round ${anchor.snapshot.round}`;
  return `${lines}${side} of ${when}`;
};

/** An inline comment whose lines are not in this round, with where it pointed and a way to move it. */
export const orphan = (
  comment: Extract<Comment, { kind: "inline" }>,
  page: FilePage,
  instance: string,
  withPath = false,
): Html =>
  html`<div class="orphan">
<p class="orphan-where small muted">${withPath ? html`<code>${comment.anchor.path}</code> · ` : ""}${orphanPlace(comment, page.round)}${comment.attachment.state === "orphan" ? ` · ${comment.attachment.reason}` : ""}</p>
<pre class="orphan-quote"><code>${comment.anchor.quote}</code></pre>
${thread(
  comment,
  { threads: page.threads, writable: page.writable, instance },
  page.writable ? html`<button type="button" class="small-button quiet" data-reattach="${comment.id}">Move to other lines</button>` : html``,
)}
</div>`;

export const fileBlock = (view: FileView, page: FilePage): Html => {
  const { file } = view;
  const status = statusWord(file, view.unchangedSince);
  const hasBody = file.patch !== undefined || file.patch_note !== undefined || view.orphans.length > 0;
  const body = `body-${tableId(view)}`;
  const talk =
    view.open === 0
      ? ""
      : `${count(view.open, "comment")}${view.forYou > 0 ? ` · ${view.forYou} for you` : ""}`;
  return html`<article class="file${view.approved ? " is-viewed" : ""}" id="${fileElementId(file.path)}" data-path="${file.path}" data-file="${view.index}" data-folded="${String(view.folded)}" aria-labelledby="title-${tableId(view)}">
<header class="file-head">
<div class="file-line">
<h3 class="file-path" id="title-${tableId(view)}" tabindex="-1"><code title="${file.path}">${pathParts(file.path)}</code></h3>
${view.caption === undefined || view.caption === "" ? "" : html`<span class="file-caption">${inline(view.caption)}</span>`}
${status === undefined ? "" : html`<span class="file-status">${status}</span>`}
${talk === "" ? "" : html`<span class="file-talk">${talk}</span>`}
<span class="file-end">
${file.patch === undefined ? "" : html`<span class="stat"><span class="added">+${file.additions}</span> <span class="deleted">−${file.deletions}</span></span>`}
${view.lapsed ? html`<span class="file-lapsed">changed since you viewed it</span>` : ""}
${hasBody ? html`<button type="button" class="small-button quiet fold-toggle" data-fold aria-controls="${body}" aria-expanded="${String(!view.folded)}">${view.folded ? "Show diff" : "Hide diff"}</button>` : ""}
${viewedButton(view, page)}
</span>
</div>
${about(view, page)}
</header>
${
  !hasBody
    ? ""
    : html`<div class="file-body" id="${body}"${view.folded ? html` hidden` : ""}>
${file.patch_note === undefined ? "" : html`<p class="patch-note small muted">${PATCH_NOTE_TEXT[file.patch_note]}</p>`}
${
  file.patch === undefined
    ? ""
    : diffTable({
        file,
        shown: view.shown,
        comments: view.placed,
        notes: view.notes,
        tableId: tableId(view),
        threads: page.threads,
        writable: page.writable,
        layout: page.layout,
      })
}
${view.orphans.length === 0 ? "" : html`<div class="orphans">${view.orphans.map((comment) => orphan(comment, page, `${tableId(view)}-orphan`))}</div>`}
</div>`
}
</article>`;
};
