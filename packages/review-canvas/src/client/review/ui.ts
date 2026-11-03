/**
 * What the reviewer chose on the page, as atoms: folds for this tab's session, the diff layout, whether whitespace
 * changes show, and whether only the changes since the last review show across visits, and in memory the gaps opened,
 * the drafts, and whether a comment is being moved. None of it is the review's state. The server keeps only the
 * drafts' text, which saving.ts sends as it is typed. What belongs to one review is keyed by it, so a page that shows
 * several reviews, such as a stack walkthrough, never carries a draft or a move from one to another.
 */
import { Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Atom } from "effect/reactivity";
import type { Verdict } from "../../schema/feedback.ts";
import type {
  CommentId,
  PatchDigest,
  RepoPath,
  ReviewId,
} from "../../schema/primitives.ts";
import type { Selection } from "../../schema/selection.ts";
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

const Layout = Schema.Literals(["unified", "split"]);
export type Layout = typeof Layout.Type;

/** Whole files split or unified, as the reviewer chose for every review. A narrow page shows unified anyway. */
export const layoutAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-layout",
  schema: Layout,
  // Before this page rendered in the browser, the choice was a cookie of the same name that the server read.
  defaultValue: (): Layout =>
    /(?:^|;\s*)review-canvas-layout=split(?:;|$)/.test(document.cookie)
      ? "split"
      : "unified",
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

/**
 * Whether the page shows each file's changes since the reviewer's last review instead of its whole change, as the
 * reviewer chose for every review. The rounds come from `sinceRound` in review/since.ts and `sinceAtom` in data.ts.
 */
export const sinceLastReviewAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-since-last-review",
  schema: Schema.Boolean,
  defaultValue: (): boolean => false,
});

/**
 * Whether a list's files unchanged since the last review show, by the list: a stop's files by its index, or the
 * source view's one list. Navigating to such a file opens its list.
 */
export const unchangedOpenAtom = Atom.family(
  (_key: { readonly review: ReviewId; readonly list: number | "source" }) =>
    Atom.make(false).pipe(Atom.keepAlive),
);

/** The widths at which a page shows the unified layout whatever the reviewer chose. */
export const NARROW_QUERY = "(width < 48rem)";

/** The widths at which the contents stand beside the page; below, they fold into a disclosure. */
export const WIDE_QUERY = "(min-width: 64rem)";

/**
 * How far the reviewer opened each gap of a patch, by file, patch, and gap, so a new snapshot of the same patch keeps
 * it. Undefined until they open or close it: `gapStage` in diff-model.ts then decides.
 */
export const gapAtom = Atom.family(
  (_key: {
    readonly path: RepoPath;
    readonly digest: PatchDigest | undefined;
    readonly gap: string;
  }) => Atom.make<GapStage | undefined>(undefined).pipe(Atom.keepAlive),
);

/** A file's About or "changed since" block, opened above its diff. */
export const extraAtom = Atom.family(
  (_key: {
    readonly review: ReviewId;
    readonly path: RepoPath;
    readonly block: "about" | "since";
  }) => Atom.make(false).pipe(Atom.keepAlive),
);

/** Rows a later stop points back at, lit for a moment. */
export const flashAtom = Atom.family((_review: ReviewId) =>
  Atom.make<
    | { readonly path: string; readonly start: number; readonly end: number }
    | undefined
  >(undefined).pipe(Atom.keepAlive),
);

/** The tour's notes the reviewer opened in the source view, by element ID; that view shows a note only on demand. */
export const openNotesAtom = Atom.family((_review: ReviewId) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive),
);

/** A comment the reviewer is moving to other lines: the next line selection places it instead of opening a composer. */
export const reattachAtom = Atom.family((_review: ReviewId) =>
  Atom.make<CommentId | undefined>(undefined).pipe(Atom.keepAlive),
);

/**
 * A comment being written on lines of a file: rows of its patch, or lines of its text such as unchanged lines around
 * a hunk. It belongs to the version its selection names: when a new round changes that version, the draft cannot
 * stay on its lines, and its text goes to the stash.
 */
export interface Draft {
  readonly id: number;
  readonly selection: Selection;
  readonly body: string;
  readonly submitting: boolean;
  /** The ID of the + button that opened it, where focus returns when it closes. */
  readonly opener: string;
  /** Until the composer first shows. It takes focus then, and not when a layout change redraws it. */
  readonly focusPending: boolean;
}

export const draftsAtom = Atom.family((_review: ReviewId) =>
  Atom.make<ReadonlyArray<Draft>>([]).pipe(Atom.keepAlive),
);

/** Text from a draft whose code changed, which fills the next composer the reviewer opens. */
export const stashAtom = Atom.family((_review: ReviewId) =>
  Atom.make("").pipe(Atom.keepAlive),
);

/** A reply being written under a comment: whether its editor is open, and its text. */
export const replyAtom = Atom.family(
  (_key: { readonly review: ReviewId; readonly comment: CommentId }) =>
    Atom.make({ open: false, body: "" }).pipe(Atom.keepAlive),
);

/** A comment of the reviewer's being changed in place: whether its editor is open, and its text. */
export const editAtom = Atom.family(
  (_key: { readonly review: ReviewId; readonly comment: CommentId }) =>
    Atom.make({ open: false, body: "" }).pipe(Atom.keepAlive),
);

/** The comment on the whole change being written. */
export const generalDraftAtom = Atom.family((_review: ReviewId) =>
  Atom.make("").pipe(Atom.keepAlive),
);

/** The verdict and summary of a finish being written, which carry over when a new round replaces the section. */
export const finishDraftAtom = Atom.family((_review: ReviewId) =>
  Atom.make<{ readonly verdict: Verdict; readonly body: string }>({
    verdict: "comment",
    body: "",
  }).pipe(Atom.keepAlive),
);

/**
 * Whether the page's single-letter shortcuts, such as J and ?, work, as the reviewer chose for every review. A reader
 * whose speech or screen reader software types letters can turn them off; keys on a focused line of a diff still work.
 */
export const shortcutsAtom = Atom.kvs({
  runtime: local,
  key: "review-canvas-shortcuts",
  schema: Schema.Boolean,
  defaultValue: (): boolean => true,
});

/**
 * Whether the key help is open, and where focus goes back to when it closes: the element that had focus when ? opened
 * it. Opened from its button, focus goes back to the button.
 */
export type KeyHelpState =
  | { readonly open: false }
  | { readonly open: true; readonly returnTo: HTMLElement | undefined };

export const keyHelpAtom = Atom.make<KeyHelpState>({ open: false }).pipe(
  Atom.keepAlive,
);
