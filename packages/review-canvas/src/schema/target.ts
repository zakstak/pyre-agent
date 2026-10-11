import * as Schema from "effect/Schema"
import * as Limits from "./limits.ts"
import { CommitSha, Count, nonEmptyText, PullRequestUrl, WorktreeRoot } from "./primitives.ts"

const Title = nonEmptyText(Limits.MAX_TEXT_UNITS)

/** A GitHub pull request, pinned to its head commit so comments anchor to one version of its diff. */
export const PullRequestTarget = Schema.Struct({
  kind: Schema.Literal("github_pr"),
  title: Title,
  url: PullRequestUrl,
  head_sha: CommitSha,
  base_sha: Schema.optionalKey(CommitSha),
  /** The changed-file count GitHub reports. */
  changed_files: Schema.optionalKey(Count)
})
export type PullRequestTarget = typeof PullRequestTarget.Type

/** The uncommitted changes in a local working tree, compared with its HEAD commit. */
export const WorktreeTarget = Schema.Struct({
  kind: Schema.Literal("worktree"),
  title: Title,
  root: WorktreeRoot,
  head_sha: CommitSha,
  /** The checked-out branch, absent for a detached HEAD. */
  branch: Schema.optionalKey(nonEmptyText(Limits.MAX_BRANCH_UNITS)),
  changed_files: Schema.optionalKey(Count)
})
export type WorktreeTarget = typeof WorktreeTarget.Type

/** What a review covers. */
export const Target = Schema.Union([PullRequestTarget, WorktreeTarget]).annotate({
  expected: "a target whose kind is github_pr or worktree"
})
export type Target = typeof Target.Type

/** Two targets belong to the same review when they name the same pull request, or the same working tree root. */
export const sameTarget = (a: Target, b: Target): boolean => {
  switch (a.kind) {
    case "github_pr":
      return b.kind === "github_pr" && a.url === b.url
    case "worktree":
      return b.kind === "worktree" && a.root === b.root
  }
}
