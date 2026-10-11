import { closeSync, constants, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"
import type { Collected, Worktree } from "./collect.ts"
import { CollectError, type GitError } from "./errors.ts"
import { absolute, isSystemError, isWithin, resolveLoose } from "./paths.ts"
import * as Schema from "effect/Schema"
import { WorktreeInput } from "../schema/input.ts"

/** An output path that passed checkOutput, with its folders resolved once so the check and the write agree. */
export type Output = string & { readonly __brand: "Output" }

/**
 * Checks where collected input may be written: not a symbolic link, which writing would replace, not inside the Git
 * directory, where it could replace Git's own files, and not inside the working tree, where it would become an
 * untracked change of its own.
 */
export const checkOutput = (worktree: Worktree, output: string): Output => {
  const destination = join(resolveLoose(dirname(absolute(output))), basename(output))
  if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new CollectError({ message: `the output ${output} is a symbolic link; name the real file instead` })
  }
  if (isWithin(destination, worktree.gitDir) || isWithin(destination, worktree.commonDir)) {
    throw new CollectError({ message: `the output ${output} is inside the Git directory, where it could replace Git's own files. Write it outside the repository.` })
  }
  if (isWithin(destination, resolveLoose(worktree.top))) {
    throw new CollectError({ message: `the output ${output} is inside the working tree, where the snapshot would become an untracked change of its own. Write it outside ${worktree.top}.` })
  }
  return destination as Output
}

/** Replaces output in one step with a private 0600 file, so no reader sees a partial snapshot. */
export const writeOutput = (output: Output, review: WorktreeInput) => {
  const temp = join(dirname(output), `.${basename(output)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(Schema.encodeSync(WorktreeInput)(review), null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, output)
  } catch (error) {
    rmSync(temp, { force: true })
    if (isSystemError(error)) throw new CollectError({ message: `cannot write ${output}: ${error.message}` })
    throw error
  }
}

// C0 and C1 controls and the line and paragraph separators, which could end or forge a terminal line.
const ESCAPED = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/
const SHORT_ESCAPES: ReadonlyMap<string, string> = new Map([["\t", "\\t"], ["\n", "\\n"], ["\r", "\\r"]])
const unicodeEscape = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`

/** Text for one terminal line, such as an error naming a path: control characters and line separators become escapes. */
export const escaped = (text: string) => text.replace(ESCAPED, (character) => SHORT_ESCAPES.get(character) ?? unicodeEscape(character))

/**
 * A path for terminal output. Git allows control characters in names, so a name with one is quoted and escaped as JSON,
 * and cannot forge or overwrite a line.
 */
export const shown = (path: string) => {
  if (!UNSAFE.test(path)) return path
  return JSON.stringify(path).replace(/[\x7f-\x9f\u2028\u2029]/g, unicodeEscape)
}

/** The line a command prints for a collector failure. */
export const errorLine = (error: CollectError | GitError) => `Error: ${escaped(error.message)}`

/** The lines a command prints after writing collected input to output, a path as the user gave it. */
export const report = ({ output, collected }: { readonly output: string; readonly collected: Collected }): ReadonlyArray<string> => {
  const notes = collected.review.files.map((file) => file.patch_note)
  const count = (note: string) => notes.filter((found) => found === note).length
  return [
    `Wrote ${shown(output)} (${notes.length} file${notes.length === 1 ? "" : "s"}; ${count("binary")} binary; ${count("too_large")} too large; ${collected.flagged.length} likely secret)`,
    ...collected.flagged.map((path) => `Likely secret, contents left out: ${shown(path)}`),
    ...collected.staged.map((path) => `Staged version differs from the reviewed file, so a commit would record unreviewed content: ${shown(path)}`)
  ]
}
