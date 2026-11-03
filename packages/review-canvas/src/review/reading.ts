/**
 * The reviewer's reading of a review's tour, as pure functions: which stop of a round a mark belongs to, whether a
 * read stop still shows the file versions it was read at, and the change a page's read or unread makes. The stack
 * walkthrough's marks follow the same rule: a mark holds while the files it records keep their versions.
 */
import * as Result from "effect/Result";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type { RepoPath, RoundNumber, Timestamp } from "../schema/primitives.ts";
import type {
  Reading,
  ReadingAction,
  StopMark,
  StopProgress,
  StopRead,
} from "../schema/reading.ts";
import type { ReadFile } from "../schema/stack.ts";
import { patchDigest } from "./anchor.ts";
import { ActionError } from "./state.ts";
import { refKey, stopRefs } from "./stop-anchor.ts";
import { type StopView, stopFiles, tourView } from "./tour.ts";

/** The version of a file a mark records: its fingerprint, or else its patch, so an unchanged file keeps its mark. */
export const fileVersion = (file: ReviewFile): string =>
  file.fingerprint ??
  (file.patch === undefined
    ? `none:${file.status}:${file.patch_note ?? ""}`
    : patchDigest(file.patch));

/** What a mark of a stop records now: the version of each file it covers in the round's input. */
export const stopVersions = (
  stop: StopView,
  files: ReadonlyMap<RepoPath, ReviewFile>,
): ReadonlyArray<ReadFile> =>
  stopFiles(stop).flatMap((path) => {
    const file = files.get(path);
    return file === undefined ? [] : [{ path, version: fileVersion(file) }];
  });

/**
 * How the reviewer read a stop: unread without a mark; read while every file it covers now has the version the mark
 * recorded; changed when a round since changed one, or added one the mark does not hold.
 */
export const stopRead = (
  mark: StopMark | undefined,
  now: ReadonlyArray<ReadFile>,
): StopRead => {
  if (mark === undefined) return { state: "unread" };
  const then = new Map(mark.files.map((file) => [file.path, file.version]));
  const [first, ...rest] = now
    .filter((file) => then.get(file.path) !== file.version)
    .map((file) => file.path);
  return first === undefined
    ? { state: "read", round: mark.round, read_at: mark.read_at }
    : {
        state: "changed",
        round: mark.round,
        read_at: mark.read_at,
        files: [first, ...rest],
      };
};

const filesOf = (input: ReviewInput): ReadonlyMap<RepoPath, ReviewFile> =>
  new Map(input.files.map((file) => [file.path, file]));

/** Every stop of a round's tour, closing stop included, with how the reviewer read it. */
export const readingOf = (
  reading: Reading,
  input: ReviewInput,
): ReadonlyArray<StopProgress> => {
  const { stops } = tourView(input);
  const files = filesOf(input);
  const marks = new Map(reading.marks.map((mark) => [refKey(mark.stop), mark]));
  const refs = stopRefs(stops);
  return stops.map((stop, at) => {
    const ref = refs[at];
    return {
      stop: stop.index,
      read: stopRead(
        ref === undefined ? undefined : marks.get(refKey(ref)),
        stopVersions(stop, files),
      ),
    };
  });
};

/**
 * A page's read or unread of a stop of the current round. A read records the versions the round shows the stop's files
 * at, replacing an earlier mark of the stop, so reading a changed stop again makes it read. The page must show the
 * current round: a mark made on an older one would certify code the reviewer has not seen. Marks of stops the round
 * no longer has are dropped.
 */
export const markStop = (
  reading: Reading,
  current: { readonly round: RoundNumber; readonly input: ReviewInput },
  action: ReadingAction,
  now: Timestamp,
): Result.Result<Reading, ActionError> => {
  if (action.round !== current.round)
    return Result.fail(
      new ActionError(
        "changed",
        action.round < current.round
          ? `Round ${current.round} was published after the page showed round ${action.round}. Read the stop as it is now.`
          : `This review has no round ${action.round} yet. Reload the page.`,
      ),
    );
  const { stops } = tourView(current.input);
  const refs = stopRefs(stops);
  const at = stops.findIndex((stop) => stop.index === action.stop);
  const stop = stops[at];
  const ref = refs[at];
  if (stop === undefined || ref === undefined)
    return Result.fail(
      new ActionError(
        "not_found",
        `Round ${current.round} has no stop ${action.stop + 1}.`,
      ),
    );
  const kept = new Set(refs.map(refKey));
  const key = refKey(ref);
  const marks = reading.marks.filter(
    (mark) => kept.has(refKey(mark.stop)) && refKey(mark.stop) !== key,
  );
  return Result.succeed({
    marks:
      action.kind === "read"
        ? [
            ...marks,
            {
              stop: ref,
              round: current.round,
              files: stopVersions(stop, filesOf(current.input)),
              read_at: now,
            },
          ]
        : marks,
  });
};
