/**
 * A stop of the tour across rounds, and the comments on one, as pure functions: a stop's identity, the anchor a
 * comment on a stop takes, and where it lands in a round. A stop is found again by its title and how many stops of
 * that title come before it, or as the closing stop; its reading marks use the same identity.
 */
import type {
  RoundSnapshot,
  StopAnchor,
  StopAttachment,
  StopExcerpt,
} from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import type { StopRef } from "../schema/reading.ts";
import { parseRows } from "./patch.ts";
import { type StopView, tourView } from "./tour.ts";

/**
 * Each stop of a round as a stop across rounds: the closing stop, or the first, second, ... stop of its title. A
 * stop keeps its reading, and the comments on it, while the agent keeps its title.
 */
export const stopRefs = (
  stops: ReadonlyArray<StopView>,
): ReadonlyArray<StopRef> => {
  const seen = new Map<string, number>();
  return stops.map((stop): StopRef => {
    if (stop.closing) return { kind: "closing" };
    const occurrence = seen.get(stop.title) ?? 0;
    seen.set(stop.title, occurrence + 1);
    return { kind: "stop", title: stop.title, occurrence };
  });
};

/** One string per stop reference, to find a stop's mark, comments, or draft by. */
export const refKey = (ref: StopRef): string =>
  ref.kind === "closing"
    ? "closing"
    : JSON.stringify([ref.title, ref.occurrence]);

/** The stop of a round's tour that a reference names, with its reference, if the tour has it. */
export const findStop = (
  stops: ReadonlyArray<StopView>,
  ref: StopRef,
): StopView | undefined => {
  const key = refKey(ref);
  const at = stopRefs(stops).findIndex(
    (candidate) => refKey(candidate) === key,
  );
  return stops[at];
};

/** The reference of a stop of a round's tour, as {@link stopRefs} gives it. */
export const refOf = (
  stops: ReadonlyArray<StopView>,
  stop: StopView,
): StopRef =>
  stop.closing
    ? { kind: "closing" }
    : {
        kind: "stop",
        title: stop.title,
        occurrence: stops.filter(
          (other) =>
            other.index < stop.index &&
            !other.closing &&
            other.title === stop.title,
        ).length,
      };

/** A stop's name as the page and the agents read it: its title, or for the closing stop, what it holds. */
export const stopTitle = (ref: StopRef): string =>
  ref.kind === "stop" ? ref.title : "Other files";

/** The lines a stop excerpts in a round, by file and side, as its rows of the patch show them. */
export const stopExcerpts = (
  stop: StopView,
  input: ReviewInput,
): ReadonlyArray<StopExcerpt> =>
  stop.excerpts.flatMap((excerpt) => {
    const patch = input.files.find((file) => file.path === excerpt.path)?.patch;
    const lines = parseRows(patch ?? "")
      .slice(excerpt.start_row, excerpt.end_row + 1)
      .flatMap((row) => {
        const line = row[excerpt.side];
        return line === undefined ? [] : [line];
      });
    const first = lines[0];
    const last = lines.at(-1);
    return first === undefined || last === undefined
      ? []
      : [
          {
            path: excerpt.path,
            side: excerpt.side,
            start_line: first,
            end_line: last,
          },
        ];
  });

/** The anchor of a question about a stop of a round. */
export const stopAnchorFor = (
  snapshot: RoundSnapshot,
  ref: StopRef,
  stop: StopView,
  input: ReviewInput,
): StopAnchor => ({
  kind: "stop",
  snapshot,
  stop: ref,
  excerpts: stopExcerpts(stop, input),
});

/**
 * Where a question about a stop lands in a round: on the stop of the same identity, or an orphan when the round's
 * tour dropped it.
 */
export const attachStop = (
  anchor: StopAnchor,
  stops: ReadonlyArray<StopView>,
  round: number,
): StopAttachment => {
  const stop = findStop(stops, anchor.stop);
  return stop === undefined
    ? {
        state: "orphan",
        reason: `Round ${round}'s tour has no stop “${stopTitle(anchor.stop)}”.`,
      }
    : { state: "attached", stop: stop.index };
};

/** The same as {@link attachStop}, for a round's input. */
export const attachStopIn = (
  anchor: StopAnchor,
  input: ReviewInput,
  round: number,
): StopAttachment => attachStop(anchor, tourView(input).stops, round);
