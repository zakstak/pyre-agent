// The review input the collector produces, mirrored from what collect_worktree.py emits. Step 1 defines the review
// input with Effect Schema; when it lands, the collector produces the schema's working-tree input and this file goes.
import type { FileMode } from "./fingerprint.ts"

export type Status = "added" | "modified" | "deleted" | "renamed" | "copied" | "changed"

export type PatchNote =
  | "binary"
  | "too_large"
  | "symlink"
  | "submodule"
  | "secret"
  | "no_content_change"
  | "empty"
  | "replaced_characters"

export interface CollectedFile {
  readonly path: string
  readonly status: Status
  readonly group: "core"
  readonly additions: number
  readonly deletions: number
  readonly fingerprint: string
  readonly old_path?: string
  readonly old_mode?: FileMode
  readonly new_mode?: FileMode
  readonly patch?: string
  readonly patch_complete?: boolean
  readonly patch_note?: PatchNote
}

export interface WorktreeTarget {
  readonly kind: "worktree"
  readonly title: string
  readonly root: string
  readonly head_sha: string
  readonly branch?: string
  readonly changed_files: number
}

export interface WorktreeReview {
  readonly schema_version: 2
  readonly target: WorktreeTarget
  readonly files_complete: true
  readonly files: ReadonlyArray<CollectedFile>
}
