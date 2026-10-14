/**
 * The one thing the reviewer should do next on a review page, as a pure function of the review's state, the current
 * round's input, and its tour. The page's next strip renders it, and its target is the ID of the element the strip
 * points at, so the markup and the strip agree; the page script only scrolls and focuses.
 */
import type { Comment, Verdict } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type {
  CommentId,
  RepoPath,
  RoundNumber,
  ThreadId,
} from "../schema/primitives.ts";
import {
  approvalHolds,
  currentRound,
  currentSubmission,
  type ReviewState,
  turnOf,
} from "./state.ts";
import type { StopView } from "./tour.ts";

/** A file's block on the review page. A path is a valid ID, and `#files/PATH` then works without the page script. */
export const fileElementId = (path: string): string => `files/${path}`;

/** A comment's thread on the review page. Each comment renders once. */
export const commentElementId = (id: string): string => `comment-${id}`;

/** The line that says what changed since the round. */
export const DRIFT_ELEMENT_ID = "drift";

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
      /** An agent found the code changed since this round. */
      readonly kind: "drift";
      readonly files: number;
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
      /** Comments that wait for the agents, which finishing hands over. */
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

const oldestFirst = (a: Comment, b: Comment) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/** Files in walkthrough order: the stops in order, each stop's owned files in its order, with the stop's number. */
export const walkthroughOrder = (
  stops: ReadonlyArray<StopView>,
): ReadonlyArray<{ readonly path: RepoPath; readonly stop: number }> =>
  stops.flatMap((stop) =>
    stop.owns.map((path) => ({ path, stop: stop.index + 1 })),
  );

/**
 * What the reviewer should do next, in priority order: read the oldest answer that waits for them; look at a drift
 * an agent found in this round; view the first file in walkthrough order whose approval does not hold (files without
 * a fingerprint cannot be viewed, so they are skipped); otherwise finish the round. A closed review, and a round the
 * reviewer already finished, have nothing next.
 */
export const nextStep = (
  state: ReviewState,
  input: ReviewInput,
  stops: ReadonlyArray<StopView>,
): Next => {
  if (state.closed_at !== undefined) return { kind: "closed" };
  const round = currentRound(state);
  const submission = currentSubmission(state);
  if (round !== undefined && submission !== undefined)
    return {
      kind: "finished",
      round: round.round,
      verdict: submission.verdict,
    };

  const toRead = state.comments
    .filter((comment) => turnOf(comment) === "reviewer")
    .toSorted(oldestFirst);
  const first = toRead[0];
  if (first !== undefined) {
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
  }

  const drift = state.drift;
  if (
    drift !== undefined &&
    round !== undefined &&
    drift.round === round.round
  )
    return {
      kind: "drift",
      files: drift.paths.length,
      target: DRIFT_ELEMENT_ID,
    };

  const files = new Map(input.files.map((file) => [file.path, file]));
  const unviewed = walkthroughOrder(stops).filter((item) => {
    const file = files.get(item.path);
    return (
      file?.fingerprint !== undefined &&
      !state.approvals.some(
        (approval) =>
          approval.path === item.path && approvalHolds(approval, [file]),
      )
    );
  });
  const file = unviewed[0];
  if (file !== undefined)
    return {
      kind: "file",
      path: file.path,
      stop: file.stop,
      left: unviewed.length,
      target: fileElementId(file.path),
    };

  return {
    kind: "finish",
    round: round?.round ?? (1 as RoundNumber),
    waiting: state.comments.filter((comment) => turnOf(comment) === "agent")
      .length,
    target: FINISH_ELEMENT_ID,
  };
};
