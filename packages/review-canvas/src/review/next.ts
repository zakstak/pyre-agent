/**
 * The one thing the reviewer should do next on a review page, as a pure function of the review's state, the current
 * round's input, and its tour. The page's next strip renders it, and its target is the ID of the element the strip
 * points at, so the markup and the strip agree; the page script only scrolls and focuses. The strip's steps and the
 * one step it names come from one call, {@link roundSteps}, so what it says and where N goes cannot part.
 */
import type { Comment, Verdict } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type {
  CommentId,
  RepoPath,
  RoundNumber,
  ThreadId,
} from "../schema/primitives.ts";
import { attachedRows, parseRows, type Row } from "./patch.ts";
import { progress, standingOf } from "./progress.ts";
import { currentSubmission, type ReviewState, type Round } from "./queries.ts";
import { findStop, stopTitle } from "./stop-anchor.ts";
import type { StopView } from "./tour.ts";

/** A file's block on the review page. A path is a valid ID, and `#files/PATH` then works without the page script. */
export const fileElementId = (path: string): string => `files/${path}`;

/** A comment's thread on the review page. Each comment renders once. */
export const commentElementId = (id: string): string => `comment-${id}`;

/** The finish section at the end of the page. */
export const FINISH_ELEMENT_ID = "finish";

/** Where a comment points, as the strip names it. A comment on a stop the round dropped is on the whole change. */
export type CommentPlace =
  | { readonly kind: "general" }
  | {
      readonly kind: "inline";
      readonly path: RepoPath;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "stop";
      /** The stop's number in the tour, from 1. */
      readonly stop: number;
      readonly title: string;
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

const placeOf = (
  comment: Comment,
  stops: ReadonlyArray<StopView>,
): CommentPlace => {
  switch (comment.kind) {
    case "general":
      return { kind: "general" };
    case "inline":
      return {
        kind: "inline",
        path: comment.anchor.path,
        start: comment.anchor.start_line,
        end: comment.anchor.end_line,
      };
    case "stop": {
      const stop = findStop(stops, comment.anchor.stop);
      return stop === undefined
        ? { kind: "general" }
        : {
            kind: "stop",
            stop: stop.index + 1,
            title: stopTitle(comment.anchor.stop),
          };
    }
  }
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
 * sits under, with comments whose lines left the round at the end of their file, and a stop's comments after its
 * files; then comments on files that left the round; then the comments on the whole change, with those on stops the
 * round dropped. Ties go to the older comment.
 */
export const pageOrder = (
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): ((a: Comment, b: Comment) => number) => {
  const files = new Map(
    walkthroughOrder(stops).map((item, at) => [item.path, at]),
  );
  const departed = files.size;
  // A stop's comments come after the files it owns, before the next stop's.
  const afterStop = new Map<number, number>();
  let owned = 0;
  for (const stop of stops) {
    owned += stop.owns.length;
    afterStop.set(stop.index, owned - 0.5);
  }
  const rowsOf = new Map<string, ReadonlyArray<Row>>();
  const rows = (path: RepoPath) => {
    let parsed = rowsOf.get(path);
    if (parsed === undefined) {
      parsed = parseRows(
        input.files.find((item) => item.path === path)?.patch ?? "",
      );
      rowsOf.set(path, parsed);
    }
    return parsed;
  };
  /**
   * Where a thread sits in its file, as a row of the patch: the last row it spans, or for lines outside the patch,
   * just before the first row after them.
   */
  const rowOf = (comment: Extract<Comment, { kind: "inline" }>): number => {
    const { attachment } = comment;
    if (attachment.state !== "attached") return Number.POSITIVE_INFINITY;
    const patch = rows(comment.anchor.path);
    const span = attachedRows(patch, attachment);
    if (span !== undefined) return span.end;
    if (!("start_line" in attachment)) return Number.POSITIVE_INFINITY;
    const after = patch.find(
      (row) => row.new !== undefined && row.new > attachment.end_line,
    );
    return (after?.index ?? patch.length) - 0.5;
  };
  const place = (comment: Comment): readonly [number, number] => {
    if (comment.kind === "general") return [departed + 1, 0];
    if (comment.kind === "stop") {
      const stop = findStop(stops, comment.anchor.stop);
      return [
        stop === undefined
          ? departed + 1
          : (afterStop.get(stop.index) ?? departed + 1),
        0,
      ];
    }
    const file = files.get(comment.anchor.path);
    if (
      file === undefined ||
      !input.files.some((item) => item.path === comment.anchor.path)
    )
      return [departed, 0];
    return [file, rowOf(comment)];
  };
  return (a, b) => {
    const [fileA, rowA] = place(a);
    const [fileB, rowB] = place(b);
    if (fileA !== fileB) return fileA - fileB;
    if (rowA !== rowB) return rowA < rowB ? -1 : 1;
    return a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : 0;
  };
};

export type AnswerStep = Extract<Next, { kind: "answer" }>;
export type FileStep = Extract<Next, { kind: "file" }>;

/** The first answer that waits for the reviewer, in the order the page shows them. */
const answerStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): AnswerStep | undefined => {
  const standing = standingOf;
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
    place: placeOf(first, stops),
    more: toRead.length - 1,
    target: commentElementId(first.id),
  };
};

/**
 * The first file in walkthrough order whose approval does not hold. Files without a fingerprint cannot be viewed, so
 * they are skipped.
 */
const fileStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): FileStep | undefined => {
  const counts = progress(state, input);
  const viewable = new Set(
    input.files
      .filter((file) => file.fingerprint !== undefined)
      .map((file) => file.path),
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
 * The round's steps as the strip shows them, and the one it names. `answer` and `file` are where the strip's steps go:
 * the first answer to read and the first file not viewed, when there is one. `next` is what the strip names and N
 * takes, in priority order: read the answers that wait for the reviewer, in the order the page shows them, also after
 * the finish, while the agents' answers arrive; once the reviewer finished the round, nothing else, since the agents
 * have the turn; view the first file in walkthrough order whose approval does not hold; otherwise finish the round. A
 * closed review has nothing next. Drift is not a step: nothing on the page acts on it, so the page says it in a line
 * of its own.
 */
export interface Steps {
  readonly answer: AnswerStep | undefined;
  readonly file: FileStep | undefined;
  readonly next: Next;
}

export const roundSteps = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
  round: Round,
): Steps => {
  const answer = answerStep(state, input, stops);
  const file = fileStep(state, input, stops);
  const next = (): Next => {
    if (state.closed_at !== undefined) return { kind: "closed" };
    if (answer !== undefined) return answer;
    const submission = currentSubmission(state);
    if (submission !== undefined)
      return {
        kind: "finished",
        round: round.round,
        verdict: submission.verdict,
      };
    return (
      file ?? {
        kind: "finish",
        round: round.round,
        waiting: progress(state, input).waiting,
        target: FINISH_ELEMENT_ID,
      }
    );
  };
  return { answer, file, next: next() };
};
