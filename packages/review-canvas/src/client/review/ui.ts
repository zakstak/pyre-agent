/**
 * What the reviewer chose on the page, as atoms: folds and read stops for this tab's session, the diff layout and
 * whether whitespace changes show across visits, and in memory the gaps opened, the drafts, and whether a comment is
 * being moved. None of it is the review's state; the server never sees it.
 */
import { Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Atom } from "effect/reactivity";
import type { Verdict } from "../../schema/feedback.ts";
import type { CommentId, PatchDigest, RepoPath } from "../../schema/primitives.ts";
import type { GapStage } from "./diff-model.ts";
import type { RoundKey } from "./data.ts";

const session = Atom.runtime(KeyValueStore.layerStorage(() => sessionStorage));
const local = Atom.runtime(KeyValueStore.layerStorage(() => localStorage));

const Fold = Schema.Literals(["open", "closed"]);
export type Fold = typeof Fold.Type;

/**
 * The files the reviewer opened or closed in a round, which hold over the page's own fold until they mark the file
 * viewed. Per round: a new round starts from the page's folds.
 */
export const foldsAtom = Atom.family(({ id, round }: RoundKey) =>
  Atom.kvs({
    runtime: session,
    key: `review-canvas:${id}:${round}:folds`,
    schema: Schema.Record(Schema.String, Fold),
    defaultValue: (): Readonly<Record<string, Fold>> => ({}),
  }),
);

/** The stops of a round the reviewer moved to or scrolled past, which the contents mark read. */
export const seenAtom = Atom.family(({ id, round }: RoundKey) =>
  Atom.kvs({
    runtime: session,
    key: `review-canvas:${id}:${round}:seen`,
    schema: Schema.Array(Schema.Int),
    defaultValue: (): ReadonlyArray<number> => [],
  }),
);

const Layout = Schema.Literals(["unified", "split"]);
export type Layout = typeof Layout.Type;

/** Whole files split or unified, as the reviewer chose for every review. A narrow page shows unified anyway. */
export const layoutAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-layout",
  schema: Layout,
  // Before this page rendered in the browser, the choice was a cookie of the same name that the server read.
  defaultValue: (): Layout => (/(?:^|;\s*)review-canvas-layout=split(?:;|$)/.test(document.cookie) ? "split" : "unified"),
});

const Whitespace = Schema.Literals(["show", "hide"]);
export type Whitespace = typeof Whitespace.Type;

/** Whether changes of whitespace alone show as changes, as the reviewer chose for every review. */
export const whitespaceAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-whitespace",
  schema: Whitespace,
  defaultValue: (): Whitespace => "show",
});

const View = Schema.Literals(["guided", "source"]);
export type View = typeof View.Type;

/**
 * How a review reads, as the reviewer chose for every review: guided, the stops in tour order each with its files, or
 * source, the walkthrough beside one plain diff of every file in path order. A narrow page reads guided anyway.
 */
export const viewAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-view",
  schema: View,
  defaultValue: (): View => "guided",
});

/** The widths at which a page shows the unified layout whatever the reviewer chose. */
export const NARROW_QUERY = "(width < 48rem)";

/** The widths at which the contents stand beside the page; below, they fold into a disclosure. */
export const WIDE_QUERY = "(min-width: 64rem)";

/** How far each gap of a patch is open, by file, patch, and gap, so a new snapshot of the same patch keeps it. */
export const gapAtom = Atom.family((_key: { readonly path: RepoPath; readonly digest: PatchDigest | undefined; readonly gap: string }) =>
  Atom.make<GapStage>(0).pipe(Atom.keepAlive),
);

/** A file's About or "changed since" block, opened above its diff. */
export const extraAtom = Atom.family((_key: { readonly path: RepoPath; readonly block: "about" | "since" }) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/** Rows a later stop points back at, lit for a moment. */
export const flashAtom = Atom.make<{ readonly path: string; readonly start: number; readonly end: number } | undefined>(
  undefined,
).pipe(Atom.keepAlive);

/** The tour's notes the reviewer opened in the source view, by element ID; that view shows a note only on demand. */
export const openNotesAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

/** A comment the reviewer is moving to other lines: the next line selection places it instead of opening a composer. */
export const reattachAtom = Atom.make<CommentId | undefined>(undefined).pipe(Atom.keepAlive);

/**
 * A comment being written on lines of a patch. It belongs to the patch it was opened on: when a new round changes
 * that patch, the draft cannot stay on its rows, and its text goes to the stash.
 */
export interface Draft {
  readonly id: number;
  readonly path: RepoPath;
  readonly digest: PatchDigest;
  readonly start: number;
  readonly end: number;
  readonly body: string;
  readonly submitting: boolean;
  /** The ID of the + button that opened it, where focus returns when it closes. */
  readonly opener: string;
  /** Until the composer first shows. It takes focus then, and not when a layout change redraws it. */
  readonly focusPending: boolean;
}

export const draftsAtom = Atom.make<ReadonlyArray<Draft>>([]).pipe(Atom.keepAlive);

/** Text from a draft whose code changed, which fills the next composer the reviewer opens. */
export const stashAtom = Atom.make("").pipe(Atom.keepAlive);

/** A reply being written under a comment: whether its editor is open, and its text. */
export const replyAtom = Atom.family((_comment: CommentId) => Atom.make({ open: false, body: "" }).pipe(Atom.keepAlive));

/** The comment on the whole change being written. */
export const generalDraftAtom = Atom.make("").pipe(Atom.keepAlive);

/** The verdict and summary of a finish being written, which carry over when a new round replaces the section. */
export const finishDraftAtom = Atom.make<{ readonly verdict: Verdict; readonly body: string }>({
  verdict: "comment",
  body: "",
}).pipe(Atom.keepAlive);
