/**
 * "Since my last review": each file's changes since the round the reviewer last finished, as pure functions of the
 * review's state and two rounds' inputs. Browser-safe: the page compares the rounds it fetched.
 */
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type { RepoPath, RoundNumber } from "../schema/primitives.ts";
import { unifiedDiff } from "./linediff.ts";
import { currentRound, type ReviewState } from "./queries.ts";

/**
 * The round the reviewer's last review saw: the round of the last submission, or without one the round before the
 * current one. Undefined when there is nothing earlier to compare with.
 */
export const sinceRound = (state: ReviewState): RoundNumber | undefined => {
  const last = state.submissions.at(-1);
  if (last !== undefined) return last.round;
  const round = currentRound(state)?.round;
  return round === undefined || round <= 1
    ? undefined
    : ((round - 1) as RoundNumber);
};

/** Why a file's change since then cannot be shown as a diff. */
export type CannotCompare =
  /** The file is deleted now, so it has no text to compare. */
  | "deleted"
  /** A round did not store the file's whole text, so its versions cannot be compared. */
  | "no_text"
  /** The versions differ in too many lines to diff. */
  | "too_different";

/** A file of the current round against the same file in the earlier round. */
export type SinceFile =
  | { readonly kind: "unchanged" }
  /** `patch` is a unified diff from the earlier round's text to the current one. */
  | { readonly kind: "changed"; readonly patch: string }
  /** The earlier round did not hold the file: its whole patch is new since then. */
  | { readonly kind: "added" }
  | { readonly kind: "cannot_compare"; readonly reason: CannotCompare };

export interface SinceComparison {
  /** The round compared with. */
  readonly round: RoundNumber;
  /** Every file of the current round. */
  readonly files: ReadonlyMap<RepoPath, SinceFile>;
  /** How many files of the current round did not change since then. */
  readonly unchanged: number;
  /** Files the earlier round held that the current round does not: their change is gone from the review. */
  readonly left: ReadonlyArray<RepoPath>;
}

/** One file now against the same path then. */
export const compareFile = (
  then: ReviewFile | undefined,
  now: ReviewFile,
): SinceFile => {
  if (then === undefined) return { kind: "added" };
  if (then.fingerprint !== undefined && then.fingerprint === now.fingerprint)
    return { kind: "unchanged" };
  if (now.status === "deleted" || now.status === "removed")
    return { kind: "cannot_compare", reason: "deleted" };
  if (then.new_content !== undefined && now.new_content !== undefined) {
    if (then.new_content === now.new_content) return { kind: "unchanged" };
    const patch = unifiedDiff(then.new_content, now.new_content);
    return patch === undefined
      ? { kind: "cannot_compare", reason: "too_different" }
      : { kind: "changed", patch };
  }
  // Without both texts, only an identical change is known to be unchanged.
  if (
    then.patch !== undefined &&
    then.patch === now.patch &&
    then.status === now.status
  )
    return { kind: "unchanged" };
  return { kind: "cannot_compare", reason: "no_text" };
};

/** Every file of the current round against the earlier round's input. */
export const compareSince = (
  round: RoundNumber,
  then: ReviewInput,
  now: ReviewInput,
): SinceComparison => {
  const earlier = new Map(then.files.map((file) => [file.path, file]));
  const files = new Map(
    now.files.map((file): [RepoPath, SinceFile] => [
      file.path,
      compareFile(earlier.get(file.path), file),
    ]),
  );
  const present = new Set<string>(now.files.map((file) => file.path));
  return {
    round,
    files,
    unchanged: [...files.values()].filter((file) => file.kind === "unchanged")
      .length,
    left: then.files
      .filter((file) => !present.has(file.path))
      .map((file) => file.path),
  };
};
