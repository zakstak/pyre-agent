/**
 * The reviewer's reading of a review's tour: which stops they read, at which file versions. The server keeps it per
 * review, so every tab and browser resumes with the same marks, and a stop whose files a later round changed shows as
 * changed. A stack walkthrough's step marks are the same idea across the layers of a stack.
 */
import * as Schema from "effect/Schema";
import * as Limits from "./limits.ts";
import {
  integer,
  nonEmptyText,
  RepoPath,
  RoundNumber,
  Timestamp,
} from "./primitives.ts";
import { ReadFile } from "./stack.ts";

const StopIndex = integer(0, Limits.MAX_STOPS);

/**
 * A stop across rounds. The agent writes the tour again each round, so a stop is the one with the same title, the
 * first, second, ... of that title in its round; the closing "Other files" stop is one stop in every round.
 */
export const StopRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stop"),
    title: nonEmptyText(Limits.MAX_LABEL_UNITS),
    /** How many stops of the same title come before it in its round. */
    occurrence: StopIndex,
  }),
  Schema.Struct({ kind: Schema.Literal("closing") }),
]);
export type StopRef = typeof StopRef.Type;

/** The reviewer read a stop in a round, at the versions its files had then: the files it owns and those it excerpts. */
export const StopMark = Schema.Struct({
  stop: StopRef,
  round: RoundNumber,
  files: Schema.Array(ReadFile),
  read_at: Timestamp,
});
export type StopMark = typeof StopMark.Type;

/**
 * The stops of a review the reviewer read, one mark per stop. A change keeps only marks of stops the current round
 * has, so there are at most as many as a tour has stops, its closing stop included.
 */
export const Reading = Schema.Struct({
  marks: Schema.Array(StopMark).check(Schema.isMaxLength(Limits.MAX_STOPS + 1)),
});
export type Reading = typeof Reading.Type;

/**
 * A stop of the current round as the reviewer read it: not yet; read at the versions it shows now; or read in an
 * earlier round, after which a round changed some of its files, which `files` names.
 */
export const StopRead = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unread") }),
  Schema.Struct({
    state: Schema.Literal("read"),
    round: RoundNumber,
    read_at: Timestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("changed"),
    /** The round the reviewer read the stop in. */
    round: RoundNumber,
    read_at: Timestamp,
    files: Schema.NonEmptyArray(RepoPath),
  }),
]);
export type StopRead = typeof StopRead.Type;

/** A stop of the current round's tour, by its index there, with how the reviewer read it. */
export const StopProgress = Schema.Struct({
  stop: StopIndex,
  read: StopRead,
});
export type StopProgress = typeof StopProgress.Type;

/**
 * A page's change to the reading: mark a stop of the round it shows read at the versions that round has, or take the
 * mark off. The round must be the current one, so a page cannot mark code it has not shown read.
 */
export const ReadingAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("read"),
    round: RoundNumber,
    stop: StopIndex,
  }),
  Schema.Struct({
    kind: Schema.Literal("unread"),
    round: RoundNumber,
    stop: StopIndex,
  }),
]);
export type ReadingAction = typeof ReadingAction.Type;
