/**
 * The review page's keys: which key does what, the order files and threads go in, and the list the key help shows.
 * Pure, so tests read the map without a browser.
 *
 * Page keys are single letters with no modifier but Shift, which no browser or screen reader binds outside browse
 * mode, and none fires from a text field. Keys on a diff line act only while a line has focus.
 */
import { pageOrder } from "../../review/next.ts";
import { findStop } from "../../review/stop-anchor.ts";
import type { CommentId, RepoPath } from "../../schema/primitives.ts";
import type { View } from "./ui.ts";
import { type PageModel, pathOrder } from "./view.ts";

/** A key press as a handler sees it. */
export interface KeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export type Step = 1 | -1;

/** What a page key does. */
export type PageCommand =
  | { readonly kind: "stop"; readonly step: Step }
  | { readonly kind: "next" }
  | { readonly kind: "file"; readonly step: Step }
  | { readonly kind: "thread"; readonly step: Step }
  | { readonly kind: "viewed" }
  | { readonly kind: "finish" }
  | { readonly kind: "help" };

const plain = (press: KeyPress) =>
  !press.altKey && !press.ctrlKey && !press.metaKey;

/**
 * The page key pressed, if any. Shift reverses F and T; J, K, and N ignore it, as they always did. Caps Lock alone
 * reverses nothing: the letter's case is not read.
 */
export const pageCommand = (press: KeyPress): PageCommand | undefined => {
  if (!plain(press)) return undefined;
  if (press.key === "?") return { kind: "help" };
  const step: Step = press.shiftKey ? -1 : 1;
  switch (press.key.toLowerCase()) {
    case "j":
      return { kind: "stop", step: 1 };
    case "k":
      return { kind: "stop", step: -1 };
    case "n":
      return { kind: "next" };
    case "f":
      return { kind: "file", step };
    case "t":
      return { kind: "thread", step };
    case "v":
      return { kind: "viewed" };
    case "e":
      return { kind: "finish" };
    default:
      return undefined;
  }
};

/** What a key does on a focused line of a diff. */
export type LineCommand =
  | { readonly kind: "move"; readonly step: Step; readonly extend: boolean }
  | { readonly kind: "comment" }
  | { readonly kind: "clear" };

/** The line key pressed, if any. Enter is the line's button's own. */
export const lineCommand = (press: KeyPress): LineCommand | undefined => {
  if (!plain(press)) return undefined;
  switch (press.key) {
    case "ArrowDown":
      return { kind: "move", step: 1, extend: press.shiftKey };
    case "ArrowUp":
      return { kind: "move", step: -1, extend: press.shiftKey };
    case "Escape":
      return { kind: "clear" };
    case "c":
    case "C":
      return press.shiftKey ? undefined : { kind: "comment" };
    default:
      return undefined;
  }
};

/**
 * The item a step moves to from the current one. From none, a step forward goes to the first and a step back goes
 * nowhere; past either end goes nowhere.
 */
export const stepFrom = <A>(
  items: ReadonlyArray<A>,
  current: A | undefined,
  step: Step,
): A | undefined => {
  const at = current === undefined ? -1 : items.indexOf(current);
  if (at === -1) return step === 1 ? items[0] : undefined;
  return items[at + step];
};

/** The files in the order the page shows them: by stop in the guided view, by path in the source view. */
export const fileOrder = (
  page: PageModel,
  view: View,
): ReadonlyArray<RepoPath> =>
  view === "source"
    ? pathOrder(page.files.keys())
    : page.stops.flatMap((stop) => stop.owns);

/**
 * The threads in the order the page shows them: inline threads by file, in the view's file order, and within a file
 * by the line they sit under; then threads on files that left the round; then those on the whole change.
 */
export const threadOrder = (
  page: PageModel,
  view: View,
): ReadonlyArray<CommentId> => {
  const sorted = page.snapshot.state.comments.toSorted(
    pageOrder(page.input, page.stops),
  );
  if (view === "guided") return sorted.map((comment) => comment.id);
  const files = new Map(fileOrder(page, view).map((path, at) => [path, at]));
  // The source view shows a stop's comments in the guide beside the diff, before the files.
  const rank = (comment: (typeof sorted)[number]) =>
    comment.kind === "general"
      ? files.size + 1
      : comment.kind === "stop"
        ? findStop(page.stops, comment.anchor.stop) === undefined
          ? files.size + 1
          : -1
        : (files.get(comment.anchor.path) ?? files.size);
  return sorted
    .toSorted((a, b) => rank(a) - rank(b))
    .map((comment) => comment.id);
};

/** One line of the key help: the keys, each a chord of key names, and what they do. */
export interface Shortcut {
  readonly keys: ReadonlyArray<ReadonlyArray<string>>;
  readonly does: string;
}

export interface ShortcutGroup {
  readonly title: string;
  /** When the group's keys work. */
  readonly when: string;
  readonly shortcuts: ReadonlyArray<Shortcut>;
}

/** Every key the review page takes, as the key help lists them. */
export const SHORTCUTS: ReadonlyArray<ShortcutGroup> = [
  {
    title: "Move around",
    when: "Anywhere but a text field, a dialog, or a menu. Single-letter keys can be turned off.",
    shortcuts: [
      { keys: [["J"], ["K"]], does: "Next or previous stop" },
      { keys: [["N"]], does: "The next thing to do" },
      { keys: [["F"], ["Shift", "F"]], does: "Next or previous file" },
      { keys: [["T"], ["Shift", "T"]], does: "Next or previous thread" },
      { keys: [["V"]], does: "Mark the current file viewed, or not viewed" },
      { keys: [["E"]], does: "Go to Finish review" },
      { keys: [["?"]], does: "Show these keys" },
    ],
  },
  {
    title: "Lines of a diff",
    when: "On a file's heading, its diff, or one of its lines.",
    shortcuts: [
      { keys: [["↓"], ["↑"]], does: "Move the line cursor" },
      {
        keys: [
          ["Shift", "↓"],
          ["Shift", "↑"],
        ],
        does: "Select lines from the cursor",
      },
      { keys: [["Enter"], ["C"]], does: "Comment on the selected lines" },
      {
        keys: [["Shift", "Enter"]],
        does: "Extend the open comment to the line",
      },
      { keys: [["Esc"]], does: "Clear the selection" },
    ],
  },
  {
    title: "Writing",
    when: "In a comment, reply, or summary.",
    shortcuts: [
      { keys: [["Ctrl", "Enter"]], does: "Send" },
      { keys: [["Esc"]], does: "Close the comment or reply box" },
    ],
  },
];
