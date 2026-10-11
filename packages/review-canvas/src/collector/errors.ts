import * as Data from "effect/Data";

/** A Git command failed or could not start, or the git on PATH is not one the collector may run. */
export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
}> {}

/** The working tree, or the output path, cannot be collected as review input. */
export class CollectError extends Data.TaggedError("CollectError")<{
  readonly message: string;
}> {}
