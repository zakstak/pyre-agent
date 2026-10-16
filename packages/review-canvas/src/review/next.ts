/**
 * The one thing the reviewer should do next on a review page, as a pure function of the review's state, the current
 * round's input, and its tour. The page's next strip renders it, and its target is the ID of the element the strip
 * points at, so the markup and the strip agree; the page script only scrolls and focuses.
 */
import type { Comment, Verdict } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { CommentId, RepoPath, RoundNumber, ThreadId } from "../schema/primitives.ts";
import { progress, standingOf } from "./progress.ts";
import { currentSubmission, type ReviewState, type Round } from "./queries.ts";
import type { StopView } from "./tour.ts";

/** A file's block on the review page. A path is a valid ID, and `#files/PATH` then works without the page script. */
export const fileElementId = (path: string): string => `files/${path}`;

/** A comment's thread on the review page. Each comment renders once. */
export const commentElementId = (id: string): string => `comment-${id}`;

/** The finish section at the end of the page. */
export const FINISH_ELEMENT_ID = "finish";

/** Where a comment points, as the strip names it. */
export type CommentPlace =
  | { readonly kind: "general" }
  | {
      readonly kind: "inline";
      readonly path: RepoPath;
      readonly start: number;
      readonly end: number;
    };

export type Next =
  | {
      /** An agent's answer waits for the reviewer to read it; on a comment from GitHub, it is "the reply". */
      readonly kind: "answer";
      readonly comment: CommentId;
      /** The thread whose answer it is. */
      readonly thread: ThreadId | undefined;
      readonly github: boolean;
      readonly place: CommentPlace;
      /** Answers to read after this one. */
      readonly more: number;
      readonly target: string;
    }
  | {
      /** The first file in walkthrough order the reviewer has not viewed. */
      readonly kind: "file";
      readonly path: RepoPath;
      /** The stop that owns the file, from 1. */
      readonly stop: number;
      /** Files not yet viewed, this one included. */
      readonly left: number;
      readonly target: string;
    }
  | {
      /** Everything is read and viewed: finish the round. */
      readonly kind: "finish";
      readonly round: RoundNumber;
      /** Comments that wait for an agent. */
      readonly waiting: number;
      readonly target: string;
    }
  | {
      /** The reviewer finished the current round; the agents have the turn. */
      readonly kind: "finished";
      readonly round: RoundNumber;
      readonly verdict: Verdict;
    }
  | { readonly kind: "closed" };

const placeOf = (comment: Comment): CommentPlace =>
  comment.kind === "general"
    ? { kind: "general" }
    : {
        kind: "inline",
        path: comment.anchor.path,
        start: comment.anchor.start_line,
        end: comment.anchor.end_line,
      };

/** Files in walkthrough order: the stops in order, each stop's owned files in its order, with the stop's number. */
export const walkthroughOrder = (
  stops: ReadonlyArray<StopView>,
): ReadonlyArray<{ readonly path: RepoPath; readonly stop: number }> =>
  stops.flatMap((stop) =>
    stop.owns.map((path) => ({ path, stop: stop.index + 1 })),
  );

/**
 * The comments in the order the page shows them: by file in walkthrough order, within a file by the row the thread
 * sits under, with comments whose lines left the round at the end of their file; then comments on files that left
 * the round; then the comments on the whole change. Ties go to the older comment.
 */
const pageOrder = (
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): ((a: Comment, b: Comment) => number) => {
  const files = new Map(walkthroughOrder(stops).map((item, at) => [item.path, at]));
  const departed = files.size;
  const place = (comment: Comment): readonly [number, number] => {
    if (comment.kind === "general") return [departed + 1, 0];
    const file = files.get(comment.anchor.path);
    if (file === undefined || !input.files.some((item) => item.path === comment.anchor.path))
      return [departed, 0];
    return [
      file,
      comment.attachment.state === "attached" ? comment.attachment.end : Number.POSITIVE_INFINITY,
    ];
  };
  return (a, b) => {
    const [fileA, rowA] = place(a);
    const [fileB, rowB] = place(b);
    if (fileA !== fileB) return fileA - fileB;
    if (rowA !== rowB) return rowA < rowB ? -1 : 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  };
};

/** The first answer that waits for the reviewer, in the order the page shows them. */
export const answerStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): Extract<Next, { kind: "answer" }> | undefined => {
  const standing = standingOf(state);
  const toRead = state.comments
    .filter((comment) => standing(comment) === "reviewer")
    .toSorted(pageOrder(input, stops));
  const first = toRead[0];
  if (first === undefined) return undefined;
  const last = first.replies.at(-1);
  return {
    kind: "answer",
    comment: first.id,
    thread: last?.actor === "agent" ? last.thread : undefined,
    github: first.source.kind === "github",
    place: placeOf(first),
    more: toRead.length - 1,
    target: commentElementId(first.id),
  };
};

/**
 * The first file in walkthrough order whose approval does not hold. Files without a fingerprint cannot be viewed, so
 * they are skipped.
 */
export const fileStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): Extract<Next, { kind: "file" }> | undefined => {
  const counts = progress(state, input);
  const viewable = new Set(
    input.files.filter((file) => file.fingerprint !== undefined).map((file) => file.path),
  );
  const unviewed = walkthroughOrder(stops).filter(
    (item) => viewable.has(item.path) && !counts.viewed.has(item.path),
  );
  const file = unviewed[0];
  if (file === undefined) return undefined;
  return {
    kind: "file",
    path: file.path,
    stop: file.stop,
    left: unviewed.length,
    target: fileElementId(file.path),
  };
};

/**
 * What the reviewer should do next, in priority order: read the answers that wait for them, in the order the page
 * shows them; view the first file in walkthrough order whose approval does not hold; otherwise finish the round. A
 * closed review, and a round the reviewer already finished, have nothing next. Drift is not a step: nothing on the
 * page acts on it, so the page says it in a line of its own.
 */
export const nextStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
  round: Round,
): Next => {
  if (state.closed_at !== undefined) return { kind: "closed" };
  const submission = currentSubmission(state);
  if (submission !== undefined)
    return { kind: "finished", round: round.round, verdict: submission.verdict };
  return (
    answerStep(state, input, stops) ??
    fileStep(state, input, stops) ?? {
      kind: "finish",
      round: round.round,
      waiting: progress(state, input).waiting,
      target: FINISH_ELEMENT_ID,
    }
  );
};
