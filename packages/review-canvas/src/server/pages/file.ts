/**
 * A changed file as one block of the review page: a header with its fold toggle, path, counts, and Viewed button, and
 * a body with its whole diff, the tour's notes in it, and its comments, including those whose lines left the round.
 */
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile } from "../../schema/input.ts";
import type { Thread } from "../../schema/thread.ts";
import { fileElementId } from "../../review/next.ts";
import type { Standing } from "../../review/progress.ts";
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

/**
 * The one status word a header shows. That the reviewer's approval lapsed comes first, then that the file changed
 * since the round before; both open what changed between the rounds when that patch exists. Then what the file is
 * (added, deleted, renamed, binary, too large). A file merely modified, or as the round before showed it, has none.
 */
type Status =
  | { readonly kind: "word"; readonly text: string; readonly warning: boolean }
  | { readonly kind: "since"; readonly text: string; readonly warning: boolean };

const statusOf = (file: ReviewFile, lapsed: boolean, changedSince: number | undefined): Status | undefined => {
  const since = (text: string, warning: boolean): Status =>
    changedSince === undefined ? { kind: "word", text, warning } : { kind: "since", text, warning };
  if (lapsed) return since("changed since you viewed it", true);
  if (changedSince !== undefined) return since(`changed since round ${changedSince}`, false);
  const word = (text: string): Status => ({ kind: "word", text, warning: false });
  if (file.status === "deleted" || file.status === "removed") return word("deleted");
  if (file.status === "renamed") return word(file.old_path === undefined ? "renamed" : `renamed from ${file.old_path}`);
  if (file.patch_note === "binary") return word("binary");
  if (file.patch_note === "too_large") return word("too large");
  if (file.status === "added" || file.status === "copied") return word(file.status);
  return undefined;
};

/** A chevron that points down while the diff shows and right while it is folded. */
const chevron = html`<svg class="chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
  /**
   * Open although the page would fold it, because the strip points at it or an answer on it waits for the reviewer.
   * The page script keeps it open from then on, until the reviewer folds it or marks it viewed.
   */
  readonly held: boolean;
}

export interface FilePage {
  readonly threads: ReadonlyArray<Thread>;
  readonly standing: (comment: Comment) => Standing;
  readonly writable: boolean;
  readonly layout: Layout;
  readonly round: number;
}

const tableId = (view: FileView) => `f${view.index}`;

const viewedButton = (view: FileView, page: FilePage): Html => {
  const { file } = view;
  if (file.fingerprint === undefined) return html``;
  // A closed review cannot change: its Viewed is a word, not a control.
  if (!page.writable)
    return view.approved ? html`<span class="viewed-state"><span aria-hidden="true">✓</span> Viewed</span>` : html``;
  return html`<button type="button" class="viewed" data-action="approve" data-path="${file.path}" data-fingerprint="${file.fingerprint}" aria-pressed="${String(view.approved)}" title="${view.approved ? "Viewed. Activate to mark it not viewed" : "Mark this version of the file viewed"}"><span class="box" aria-hidden="true">${view.approved ? "✓" : ""}</span>Viewed</button>`;
};

/** What changed since the round before, as a read-only patch between the two rounds' texts; undefined when nothing did. */
const sincePatch = (view: FileView): string | undefined => {
  const before = view.previous?.new_content;
  const after = view.file.new_content;
  if (view.unchangedSince !== undefined || before === undefined || after === undefined) return undefined;
  return unifiedDiff(before, after);
};

const sinceBlock = (view: FileView, page: FilePage, patch: string): Html =>
  html`<div class="file-extra since" id="since-${tableId(view)}" hidden>
<p class="small muted">Changes since round ${page.round - 1}</p>
${diffTable({
  // The same file with the patch between rounds, without its text, so the table shows no unchanged lines.
  file: (({ new_content: _text, ...file }) => ({ ...file, patch }))(view.file),
  comments: [],
  tableId: `${tableId(view)}-since`,
  threads: page.threads,
  writable: false,
  readOnly: true,
  standing: page.standing,
})}
</div>`;

/** The agent's notes on the whole file, which "About" opens above the diff; nothing when there are none. */
const aboutBlock = (view: FileView): Html | undefined => {
  const { file } = view;
  const callouts = file.callouts ?? [];
  if (file.summary === undefined && file.pseudocode === undefined && file.trace === undefined && callouts.length === 0)
    return undefined;
  return html`<div class="file-extra about-body" id="about-${tableId(view)}" hidden>
${file.summary === undefined ? "" : html`<div class="reading">${prose(file.summary)}</div>`}
${callouts.map((callout) => html`<p class="callout reading"><strong>${callout.tag}.</strong> ${inline(callout.text)}</p>`)}
${file.pseudocode === undefined ? "" : html`<details class="about-part" id="pseudocode-${tableId(view)}"><summary>Pseudocode</summary><div class="code-region"><pre>${file.pseudocode}</pre></div></details>`}
${file.trace === undefined ? "" : html`<details class="about-part" id="trace-${tableId(view)}"><summary>Trace</summary><dl class="trace"><dt>Input</dt><dd><pre>${file.trace.input}</pre></dd><dt>Before</dt><dd><pre>${file.trace.before}</pre></dd><dt>After</dt><dd><pre>${file.trace.after}</pre></dd></dl></details>`}
</div>`;
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
  { threads: page.threads, writable: page.writable, instance, standing: page.standing },
  page.writable ? html`<button type="button" class="small-button quiet" data-reattach="${comment.id}">Move to other lines</button>` : html``,
)}
</div>`;

export const fileBlock = (view: FileView, page: FilePage): Html => {
  const { file } = view;
  const patch = sincePatch(view);
  const status = statusOf(file, view.lapsed, patch === undefined ? undefined : page.round - 1);
  // The patch between the rounds shows only where the header's word can open it.
  const since = status?.kind === "since" ? patch : undefined;
  const hasBody = file.patch !== undefined || file.patch_note !== undefined || view.orphans.length > 0;
  const body = `body-${tableId(view)}`;
  const about = aboutBlock(view);
  const talk =
    view.open === 0
      ? ""
      : `${count(view.open, "comment")}${view.forYou > 0 ? ` · ${view.forYou} for you` : ""}`;
  return html`<article class="file${view.approved ? " is-viewed" : ""}" id="${fileElementId(file.path)}" data-path="${file.path}" data-file="${view.index}" data-folded="${String(view.folded)}"${view.held ? html` data-held` : ""}>
<header class="file-head">
${hasBody ? html`<button type="button" class="fold-toggle" data-fold aria-controls="${body}" aria-expanded="${String(!view.folded)}" aria-label="${view.folded ? "Show diff" : "Hide diff"}">${chevron}</button>` : ""}
<h3 class="file-path" tabindex="-1"><code title="${file.path}">${pathParts(file.path)}</code></h3>
${view.caption === undefined || view.caption === "" ? "" : html`<span class="file-caption">${inline(view.caption)}</span>`}
${
  status === undefined
    ? ""
    : status.kind === "since"
      ? html`<button type="button" class="file-word${status.warning ? " warning" : ""}" data-extra aria-expanded="false" aria-controls="since-${tableId(view)}">${status.text}</button>`
      : html`<span class="file-status${status.warning ? " warning" : ""}">${status.text}</span>`
}
${talk === "" ? "" : html`<span class="file-talk">${talk}</span>`}
<span class="file-end">
${file.patch === undefined ? "" : html`<span class="stat"><span class="added">+${file.additions}</span> <span class="deleted">−${file.deletions}</span></span>`}
${about === undefined ? "" : html`<button type="button" class="file-word" data-extra aria-expanded="false" aria-controls="about-${tableId(view)}">About</button>`}
${viewedButton(view, page)}
</span>
</header>
${about ?? ""}
${since === undefined ? "" : sinceBlock(view, page, since)}
${
  !hasBody
    ? ""
    : html`<div class="file-body" id="${body}">
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
        standing: page.standing,
      })
}
${view.orphans.length === 0 ? "" : html`<div class="orphans">${view.orphans.map((comment) => orphan(comment, page, `${tableId(view)}-orphan`))}</div>`}
</div>`
}
</article>`;
};
