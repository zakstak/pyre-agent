import * as Schema from "effect/Schema"
import { documentBytes } from "./encoding.ts"
import * as Limits from "./limits.ts"
import { Count, Fingerprint, GitMode, nonEmptyText, RepoPath, text } from "./primitives.ts"
import { Target, WorktreeTarget } from "./target.ts"

/** The format key of review input: what an agent publishes as a round. */
export const INPUT_FORMAT = "review-canvas.input/1"

export const FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged"
] as const
export const FileStatus = Schema.Literals(FILE_STATUSES)
export type FileStatus = typeof FileStatus.Type

/** Core logic leads; wiring and mechanical changes start collapsed. */
export const FILE_GROUPS = ["core", "wiring", "mechanical"] as const
export const FileGroup = Schema.Literals(FILE_GROUPS)
export type FileGroup = typeof FileGroup.Type

/** Why a file has no patch, or why its patch differs from the bytes on disk. The page owns the wording. */
export const PATCH_NOTES = [
  "binary",
  "too_large",
  "symlink",
  "submodule",
  "secret",
  "no_content_change",
  "empty",
  "replaced_characters"
] as const
export const PatchNote = Schema.Literals(PATCH_NOTES)
export type PatchNote = typeof PatchNote.Type
/** The notes that describe a patch that is present. Every other note explains a missing patch. */
export const TEXT_PATCH_NOTES: ReadonlySet<PatchNote> = new Set(["replaced_characters"])

/** LF-delimited lines, counting a last line without LF. */
export const patchLines = (patch: string): number => {
  let lines = patch.endsWith("\n") || patch === "" ? 0 : 1
  for (let at = patch.indexOf("\n"); at !== -1; at = patch.indexOf("\n", at + 1)) lines++
  return lines
}

const HUNK_HEADER = /^@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@/

/** What a complete patch holds: its added and deleted lines, or why it is not a whole unified diff. */
export type PatchTotals =
  | { readonly kind: "totals"; readonly additions: number; readonly deletions: number }
  | { readonly kind: "malformed"; readonly problem: string }

/** An open hunk: where it starts, the counts its header declares, and the old and new lines seen so far. */
interface Hunk {
  readonly line: number
  readonly declared: readonly [number, number]
  old: number
  new: number
}

/**
 * Reads a patch as whole hunks: it starts with a hunk header, every other line is context, an addition, a deletion,
 * or a no-newline marker, and each hunk holds the old and new line counts its header declares (1 when omitted).
 */
export const patchTotals = (patch: string): PatchTotals => {
  const lines = patch.split("\n")
  if (patch.endsWith("\n")) lines.pop()
  let additions = 0
  let deletions = 0
  let hunk: Hunk | undefined
  const unbalanced = (): PatchTotals | undefined => {
    if (hunk === undefined || (hunk.old === hunk.declared[0] && hunk.new === hunk.declared[1])) return undefined
    const [old, added] = hunk.declared
    return {
      kind: "malformed",
      problem: `the hunk at line ${hunk.line} declares ${old} old and ${added} new lines, but holds ${hunk.old} and ` +
        `${hunk.new}`
    }
  }
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("@@")) {
      const header = HUNK_HEADER.exec(line)
      if (header === null) return { kind: "malformed", problem: `line ${index + 1} is not a hunk header` }
      const problem = unbalanced()
      if (problem !== undefined) return problem
      hunk = { line: index + 1, declared: [Number(header[1] ?? 1), Number(header[2] ?? 1)], old: 0, new: 0 }
    } else if (hunk === undefined) {
      return { kind: "malformed", problem: "it does not start with a hunk header" }
    } else if (line.startsWith(" ")) {
      hunk.old++
      hunk.new++
    } else if (line.startsWith("-")) {
      hunk.old++
      deletions++
    } else if (line.startsWith("+")) {
      hunk.new++
      additions++
    } else if (!line.startsWith("\\")) {
      return { kind: "malformed", problem: `line ${index + 1} is not context, an addition, or a deletion` }
    }
  }
  return unbalanced() ?? { kind: "totals", additions, deletions }
}

// A link or submodule replaced by a file has no text on its old side, so the patch shows only the new file, and the
// deletions keep Git's count of the old side.
const NO_TEXT_MODES: ReadonlySet<string> = new Set(["120000", "160000"])

/**
 * A unified diff as plain text, from its first hunk header. CR is kept, so a CRLF line ends in CR. A file without a
 * patch omits the field, so a patch is never empty; it may be only whitespace, such as a file of blank lines.
 */
export const Patch = text(Limits.MAX_PATCH_UNITS).check(
  Schema.makeFilter((patch: string) => patch !== "" || "must not be empty; omit the patch instead"),
  Schema.makeFilter((patch: string) =>
    patchLines(patch) <= Limits.MAX_PATCH_LINES || `exceeds ${Limits.MAX_PATCH_LINES} lines; nothing was truncated`
  )
)

const Text = text(Limits.MAX_TEXT_UNITS)
const RequiredText = nonEmptyText(Limits.MAX_TEXT_UNITS)

/** A remark the agent pins to a file, such as a risk or a follow-up. */
export const Callout = Schema.Struct({ tag: nonEmptyText(Limits.MAX_CALLOUT_TAG_UNITS), text: RequiredText })
export type Callout = typeof Callout.Type

/** An example input, and the behavior before and after the change. */
export const Trace = Schema.Struct({ input: Text, before: Text, after: Text })
export type Trace = typeof Trace.Type

const fileFields = {
  path: RepoPath,
  status: FileStatus,
  group: FileGroup,
  additions: Count,
  deletions: Count,
  /** The original path of a renamed or copied file, which such a file must have. */
  old_path: Schema.optionalKey(RepoPath),
  old_mode: Schema.optionalKey(GitMode),
  new_mode: Schema.optionalKey(GitMode),
  patch: Schema.optionalKey(Patch),
  /**
   * True only after the whole patch was verified, false for an excerpt. Absent means unverified. A complete patch is
   * whole hunks, and its lines add up to additions and deletions; any other patch is shown as it is.
   */
  patch_complete: Schema.optionalKey(Schema.Boolean),
  patch_note: Schema.optionalKey(PatchNote),
  summary: Schema.optionalKey(Text),
  pseudocode: Schema.optionalKey(Text),
  trace: Schema.optionalKey(Trace),
  callouts: Schema.optionalKey(Schema.Array(Callout).check(Schema.isMaxLength(Limits.MAX_CALLOUTS)))
}

const ReviewFileFields = Schema.Struct({ ...fileFields, fingerprint: Schema.optionalKey(Fingerprint) })

const fileRules = Schema.makeFilter((file: typeof ReviewFileFields.Type) => {
  const moved = file.status === "renamed" || file.status === "copied"
  if (moved && file.old_path === undefined) {
    return { path: ["old_path"], issue: `required for a ${file.status} file: the path it came from` }
  }
  if (file.old_path !== undefined && (!moved || file.old_path === file.path)) {
    return { path: ["old_path"], issue: "allowed only for a renamed or copied file, and must differ from path" }
  }
  if (file.patch_note !== undefined && TEXT_PATCH_NOTES.has(file.patch_note) !== (file.patch !== undefined)) {
    return {
      path: ["patch_note"],
      issue: TEXT_PATCH_NOTES.has(file.patch_note)
        ? `${file.patch_note} needs a patch`
        : `${file.patch_note} is only for a file without a patch`
    }
  }
  if (file.patch_complete === true) {
    if (file.patch === undefined) return { path: ["patch_complete"], issue: "true needs a patch" }
    const totals = patchTotals(file.patch)
    if (totals.kind === "malformed") return { path: ["patch"], issue: `is marked complete, but ${totals.problem}` }
    if (totals.additions !== file.additions) {
      return { path: ["additions"], issue: `is ${file.additions}, but the complete patch adds ${totals.additions}` }
    }
    if (totals.deletions !== file.deletions && !NO_TEXT_MODES.has(file.old_mode ?? "")) {
      return { path: ["deletions"], issue: `is ${file.deletions}, but the complete patch deletes ${totals.deletions}` }
    }
  }
  return undefined
})

/** A changed file. A file without a fingerprint cannot be approved. */
export const ReviewFile = ReviewFileFields.check(fileRules)
export type ReviewFile = typeof ReviewFile.Type

/** A changed file in a working tree, which always has a fingerprint: the collector computes it. */
export const WorktreeFile = Schema.Struct({ ...fileFields, fingerprint: Fingerprint }).check(fileRules)
export type WorktreeFile = typeof WorktreeFile.Type

const inputFields = {
  format: Schema.Literal(INPUT_FORMAT),
  /** The review's main point. */
  summary: Schema.optionalKey(Text),
  /** True once the file list was reconciled with the target: then target.changed_files must equal the file count. */
  files_complete: Schema.Boolean
}

const ReviewInputFields = Schema.Struct({
  ...inputFields,
  target: Target,
  files: Schema.Array(ReviewFile).check(Schema.isMaxLength(Limits.MAX_FILES))
})

const utf8 = new TextEncoder()

const inputRules = Schema.makeFilter((input: typeof ReviewInputFields.Type) => {
  if (input.files_complete && input.target.changed_files !== input.files.length) {
    return {
      path: ["files_complete"],
      issue: "true requires target.changed_files matching the supplied file count"
    }
  }
  // An early refusal, not a guarantee: the feedback schema checks the size of the whole export.
  let pathBytes = 0
  for (const file of input.files) pathBytes += utf8.encode(JSON.stringify(file.path)).length
  if (2 * pathBytes + Limits.FEEDBACK_BYTES_PER_FILE * input.files.length > Limits.MAX_FEEDBACK_PATH_BYTES) {
    return {
      path: ["files"],
      issue: `the paths are too long for feedback on this review to fit its ${
        Limits.MAX_FEEDBACK_BYTES / 1024 / 1024
      } MiB limit; split the review`
    }
  }
  const seen = new Set<string>()
  let totalLines = 0
  for (const [index, file] of input.files.entries()) {
    if (seen.has(file.path)) return { path: ["files", index, "path"], issue: "duplicate file path" }
    seen.add(file.path)
    if (input.target.kind === "worktree" && file.fingerprint === undefined) {
      return { path: ["files", index, "fingerprint"], issue: "required for a worktree target" }
    }
    totalLines += file.patch === undefined ? 0 : patchLines(file.patch)
    if (totalLines > Limits.MAX_TOTAL_PATCH_LINES) {
      return {
        path: ["files", index, "patch"],
        issue: `patches exceed ${Limits.MAX_TOTAL_PATCH_LINES} total lines; nothing was truncated`
      }
    }
  }
  // Written in its one spelling, the input fits its byte limit, so every accepted input can be stored and written
  // again. Indentation can grow a minified input past the limit its bytes passed.
  const bytes = documentBytes(input).byteLength
  if (bytes > Limits.MAX_INPUT_BYTES) {
    return `takes ${bytes} bytes as written JSON, more than ${Limits.MAX_INPUT_BYTES / 1024 / 1024} MiB`
  }
  return undefined
})

/**
 * One round of a review, as the agent publishes it: the target, every changed file with its patch, and the agent's
 * analysis. Agent answers are separate actions, not part of the input.
 */
export const ReviewInput = ReviewInputFields.check(inputRules)
export type ReviewInput = typeof ReviewInput.Type

/**
 * The input for a working tree, as the collector writes it: every file has a fingerprint, and old and new modes and
 * patch notes say what the patch leaves out. Every file starts in the core group, with no analysis; the agent adds
 * analysis before it publishes the round. It is a {@link ReviewInput}.
 */
export const WorktreeInput = Schema.Struct({
  ...inputFields,
  target: WorktreeTarget,
  files: Schema.Array(WorktreeFile).check(Schema.isMaxLength(Limits.MAX_FILES))
}).check(inputRules)
export type WorktreeInput = typeof WorktreeInput.Type
