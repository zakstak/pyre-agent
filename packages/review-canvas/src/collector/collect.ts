import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, rmSync,
  statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { devNull, tmpdir } from "node:os"
import { dirname, isAbsolute } from "node:path"
import { isDeepStrictEqual } from "node:util"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { CollectError, GitError } from "./errors.ts"
import { blobId, fileFingerprint, type FileMode, fileMode, isRegular, type ObjectFormat, objectFormat, type ObjectId,
  objectId, type RawChange, rawChanges } from "./fingerprint.ts"
import { assertOutside, DIFF_FLAGS, type Git, type GitEvent, trustedGit } from "./git.ts"
import { asciiLower, backslashReplace, byCodePoint, decodePath, fsDecode, fsEncode, isDecodable, isSystemError, isWithin,
  lexists, line, onDisk, records, resolveFrom, resolveLoose, systemMessage } from "./paths.ts"
import { cleanText, SECRET_TEXT, secretName } from "./patch.ts"
import { decodeValue, WorktreeInputDocument } from "../schema/document.ts"
import { type FileStatus, INPUT_FORMAT, type PatchNote, type WorktreeFile, type WorktreeInput } from "../schema/input.ts"
import { MAX_FILES, MAX_INPUT_BYTES, MAX_PATCH_LINES, MAX_PATCH_UNITS, MAX_TOTAL_PATCH_LINES } from "../schema/limits.ts"
import { type Fingerprint, RepoPath } from "../schema/primitives.ts"

/*
 * Collects the uncommitted changes in a local Git working tree as review input: staged, unstaged, and untracked (not
 * ignored) files compared with HEAD. Every file starts in the core group with no analysis; the agent adds both. Likely
 * secret files keep their entry and stats, but their contents are left out unless named in includeSecret.
 *
 * Git never writes to the repository, and nothing from the repository or its configuration runs: every configured
 * filter driver is switched off for every Git call.
 */

export const ATTEMPTS = 3

/** The review input limits the collector keeps to, from the schema. Tests lower them. */
export interface Limits {
  readonly files: number
  /** UTF-16 code units in one patch, the unit the page's JavaScript counts. */
  readonly patchUnits: number
  readonly patchLines: number
  readonly totalPatchLines: number
  readonly inputBytes: number
}

export const LIMITS: Limits = {
  files: MAX_FILES,
  patchUnits: MAX_PATCH_UNITS,
  patchLines: MAX_PATCH_LINES,
  totalPatchLines: MAX_TOTAL_PATCH_LINES,
  inputBytes: MAX_INPUT_BYTES
}

/** Steps a caller can observe. The callback runs synchronously; tests use it to change files at exact moments. */
export type CollectEvent =
  | GitEvent
  | {
    /** Before a working tree file is read. path is relative to the working tree. */
    readonly kind: "read"
    readonly path: string
  }
  | {
    /** Before the staged versions are compared with the working tree. */
    readonly kind: "staged-scan"
  }
  | {
    /** After the snapshot is built, before the inventory is read again to confirm it. */
    readonly kind: "between-reads"
  }

/** A working tree whose git, root, and settings are checked: the boundary every collector step works inside. */
export interface Worktree {
  readonly git: Git
  /** The working tree root, as Git prints it. */
  readonly top: string
  readonly gitDir: string
  readonly commonDir: string
  readonly format: ObjectFormat
  /** -c options that switch off every configured filter driver. */
  readonly config: ReadonlyArray<string>
  /** The resolved temporary directory, outside the working tree. */
  readonly temp: string
  readonly trace: (event: CollectEvent) => void
}

export interface CollectOptions {
  /** The review title. Defaults to "Uncommitted changes on BRANCH". */
  readonly title?: string
  /** Likely secret files, by exact repository-relative path, whose contents the review may show. */
  readonly includeSecret?: ReadonlyArray<string>
  readonly limits?: Partial<Limits>
}

export interface Collected {
  readonly review: WorktreeInput
  /** Likely secret files whose contents were left out. */
  readonly flagged: ReadonlyArray<string>
  /** Paths whose staged version differs from both HEAD and the working tree, so a commit records unreviewed content. */
  readonly staged: ReadonlyArray<string>
}

/** The statuses a working tree change can have. */
type Status = Extract<FileStatus, "added" | "modified" | "deleted" | "renamed" | "copied" | "changed">

type Kind = "file" | "symlink" | "submodule"

interface EntryBase {
  readonly path: string
  readonly oldPath: string | null
  readonly status: Status
  readonly kind: Kind
  readonly oldBlob: ObjectId | null
  readonly oldMode: FileMode | null
  readonly newBlob: ObjectId | null
  readonly newMode: FileMode | null
  readonly size: number
  /** NUL bytes in the file's first 8000 bytes. */
  readonly binary: boolean
  readonly fingerprint: Fingerprint
}

export interface TrackedEntry extends EntryBase {
  readonly untracked: false
  /** Git's own diff skips it, as for an assume-unchanged file. */
  readonly hidden: boolean
  /** An absent skip-worktree entry, whose content is its staged blob. */
  readonly fromIndex: boolean
}

interface UntrackedEntry extends EntryBase {
  readonly untracked: true
  /** Lines as Git counts them: a link's target lines, and one for a submodule commit. */
  readonly lines: number
}

type Entry = TrackedEntry | UntrackedEntry

/** A tracked change from git diff, or one Git hid that the collector found on disk. */
interface Change extends RawChange {
  readonly hidden: boolean
}

interface IndexEntry {
  /** The git ls-files -v letter: lowercase marks assume-unchanged, S or s marks skip-worktree. */
  readonly tag: string
  readonly mode: FileMode
  readonly blob: ObjectId
  readonly path: string
}

interface Snapshot {
  readonly head: string
  readonly branch: string | null
  /** The index file's identity: staging can change the index without changing any file the review shows. */
  readonly index: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint } | null
  readonly entries: ReadonlyArray<Entry>
}

type Content =
  | { readonly kind: "patch"; readonly data: Buffer }
  | { readonly kind: "note"; readonly note: Exclude<PatchNote, "replaced_characters"> }

const STATUSES: ReadonlyMap<string, Status> = new Map([["A", "added"], ["M", "modified"], ["D", "deleted"], ["R", "renamed"],
  ["C", "copied"], ["T", "changed"], ["U", "modified"]])

const BINARY_PREFIX = 8000

/** The working tree changed while it was being read. */
class Changed extends Error {}

/** Runs read, turning a file that vanishes or changes type into a concurrent write. Only a permission problem is final. */
const reading = <A>(path: string, read: () => A): A => {
  try {
    return read()
  } catch (error) {
    if (!isSystemError(error)) throw error
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new CollectError({ message: `cannot read ${path}: ${systemMessage(error)}` })
    }
    throw new Changed(`${path}: ${systemMessage(error)}`)
  }
}

const kindOf = (mode: FileMode | null): Kind => (mode === "160000" ? "submodule" : mode === "120000" ? "symlink" : "file")

const gitBool = ({ git, top }: Worktree, key: string, fallback = true) =>
  line(git.run(top, ["config", "--type=bool", "--default", fallback ? "true" : "false", key])).toString() === "true"

const parseCount = (data: Buffer | string) => {
  const text = data.toString().trim()
  if (!/^[0-9]+$/.test(text)) throw new GitError({ message: `expected a count from Git, got ${JSON.stringify(text)}` })
  return Number(text)
}

const decodeRepoPath = Schema.decodeUnknownResult(RepoPath)
const describeIssue = SchemaIssue.makeFormatterDefault()

/**
 * A valid UTF-8 path as review input carries it. Git allows names RepoPath refuses, such as one holding a control
 * character or one longer than the limit; those stop collection here, named, rather than failing the whole input with
 * a schema error.
 */
const representable = (path: string): RepoPath => {
  const decoded = decodeRepoPath(path)
  if (Result.isSuccess(decoded)) return decoded.success
  const named = JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}...` : path)
  throw new CollectError({ message: `review input cannot represent the path ${named}: ${describeIssue(decoded.failure.issue)}` })
}

const tooMany = (count: number, limits: Limits) =>
  new CollectError({ message: `${count} changed files exceed the review limit of ${limits.files}. Commit, stash, or ignore part of the work, then collect again.` })

const unfingerprintable = (path: string) =>
  new CollectError({ message: `${path} is a nested repository or submodule with no commit checked out, so no fingerprint can cover its contents. Commit in it, or ignore it, then collect again.` })

const caseRenamedError = (path: string) =>
  new CollectError({ message: `${path} was renamed by case only, which Git hides with core.ignoreCase on. Stage the rename with git mv, then collect again.` })

/**
 * Switches off every configured filter driver. A clean or process filter is a command from Git configuration, and git
 * diff runs it to compare working tree files, including during rename detection. With the drivers off, Git compares
 * the bytes on disk, which are also what fingerprints hash.
 */
const filterOverrides = (git: Git, top: string): Array<string> => {
  // Every entry, filtered here rather than with --get-regexp: Git matches that regular expression with the C library,
  // which on macOS refuses a key that is not valid UTF-8 in a UTF-8 locale, so such a driver would go unlisted and run.
  const names = new Set<string>()
  for (const entry of records(git.run(top, ["config", "-z", "--list"]))) {
    const newline = entry.indexOf(0x0a)
    const key = newline < 0 ? entry : entry.subarray(0, newline)
    if (!key.subarray(0, "filter.".length).equals(Buffer.from("filter."))) continue
    if (!isDecodable(key)) {
      // A replacement character would switch off a different driver and leave this one running.
      throw new CollectError({ message: `cannot switch off the filter driver in ${backslashReplace(key)}; its name is not valid UTF-8` })
    }
    const rest = key.toString("utf8").slice("filter.".length)
    // Git reads a driver only from filter.NAME.KEY. A key with no name, such as filter.foo, configures no driver.
    const dot = rest.lastIndexOf(".")
    if (dot >= 0) names.add(rest.slice(0, dot))
  }
  return [...names].sort(byCodePoint).flatMap((name) => {
    if (name.includes("=") || name === "") {
      throw new CollectError({ message: `cannot switch off the filter driver ${JSON.stringify(name)}; its name contains '=' or is empty` })
    }
    return ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${name}.${setting}`])
  })
}

/**
 * Checks the git to run, finds the working tree containing repo, and reads its settings. Throws GitError when the git
 * on PATH lies inside the repository, and CollectError when the working tree cannot be collected.
 */
export const openWorktree = ({ repo, trace = () => {} }: { readonly repo: string; readonly trace?: (event: CollectEvent) => void }): Worktree => {
  const git = trustedGit({ repo, trace }) // before any Git call: a git inside the repository would be code from the change
  const top = decodePath(line(git.run(repo, ["rev-parse", "--show-toplevel"])))
  assertOutside(git.executable, top) // the working tree Git found, which core.worktree may put outside repo
  const gitDir = resolveLoose(decodePath(line(git.run(repo, ["rev-parse", "--absolute-git-dir"]))))
  // Every later command runs from top and finds its repository again. If core.worktree points at a checkout with a .git
  // of its own, that is another repository.
  let same: boolean
  try {
    same = resolveLoose(decodePath(line(git.run(top, ["rev-parse", "--absolute-git-dir"])))) === gitDir
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    same = false
  }
  if (!same) {
    throw new CollectError({ message: `${repo} sets core.worktree to ${top}, which Git there resolves to another repository or none. Collect from the repository that ${top} belongs to.` })
  }
  const commonDir = resolveFrom(resolveLoose(repo), decodePath(line(git.run(repo, ["rev-parse", "--git-common-dir"]))))
  const format = objectFormat(line(git.run(top, ["rev-parse", "--show-object-format"])).toString())
  const config = filterOverrides(git, top)
  const temp = resolveLoose(tmpdir())
  if (isWithin(temp, resolveLoose(top))) {
    // Scratch diffs hold copies of the reviewed files; they must never land inside the tree they come from.
    throw new CollectError({ message: `the temporary directory ${tmpdir()} is inside the working tree. Set TMPDIR elsewhere.` })
  }
  return { git, top, gitDir, commonDir, format, config, temp, trace }
}

/** A private scratch directory for one diff, removed when work returns. */
const scratch = <A>(worktree: Worktree, work: (directory: string) => A): A => {
  const directory = mkdtempSync(`${worktree.temp}/review-canvas-`)
  try {
    return work(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Streams a blob into a new file, so a large blob never sits in memory. */
const writeBlob = ({ git, top, config }: Worktree, id: ObjectId, path: string) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    git.run(top, [...config, "cat-file", "blob", id], { into: fd })
  } finally {
    closeSync(fd)
  }
}

const blobSize = ({ git, top, config }: Worktree, id: ObjectId) => parseCount(git.run(top, [...config, "cat-file", "-s", id]))

interface Blob {
  readonly blob: ObjectId
  readonly size: number
  readonly lines: number
  readonly binary: boolean
  readonly mode: "100644" | "100755"
  /** The bytes, kept only when the file has at most keep bytes. */
  readonly data: Buffer | null
}

/** Streams a regular file into a Git blob ID with no filters. */
const readBlob = (worktree: Worktree, path: string, keep = 0): Blob => {
  worktree.trace({ kind: "read", path })
  const full = `${worktree.top}/${path}`
  // O_NOFOLLOW refuses a symbolic link, and O_NONBLOCK keeps a FIFO from blocking until the type check refuses it.
  const fd = openSync(fsEncode(full), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Changed(`${full} is no longer a regular file`)
    const hash = createHash(worktree.format).update(`blob ${info.size}\0`)
    const head: Array<Buffer> = []
    const kept: Array<Buffer> = []
    const chunk = Buffer.allocUnsafe(1 << 20)
    let size = 0
    let lines = 0
    let last = 0x0a
    for (let count = readSync(fd, chunk); count > 0; count = readSync(fd, chunk)) {
      const data = chunk.subarray(0, count)
      hash.update(data)
      for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) lines += 1
      last = data[count - 1] ?? last
      if (size < BINARY_PREFIX) head.push(Buffer.from(data.subarray(0, BINARY_PREFIX - size)))
      size += count
      if (size <= keep) kept.push(Buffer.from(data))
    }
    if (size !== info.size) throw new Changed(`${full} changed size while it was read`)
    return {
      blob: hash.digest("hex") as ObjectId, // a digest, which is never all zeros
      size,
      lines: lines + (last === 0x0a ? 0 : 1),
      binary: Buffer.concat(head).includes(0),
      mode: info.mode & 0o100 ? "100755" : "100644",
      data: size <= keep ? Buffer.concat(kept) : null
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * A symbolic link's blob ID, which covers its target. With core.symlinks=false, Git checks a link out as a regular
 * file holding the target, so that whole file is hashed instead.
 */
const linkBlob = (worktree: Worktree, path: string): ObjectId => {
  const full = onDisk(worktree.top, path)
  try {
    return blobId(worktree.format, readlinkSync(full, { encoding: "buffer" }))
  } catch (error) {
    if (!isSystemError(error) || !lstatSync(full).isFile()) throw error
  }
  return readBlob(worktree, path).blob
}

/** The commit checked out in a submodule or nested repository, or null when it has none. */
const repositoryHead = ({ git, top }: Worktree, path: string): ObjectId | null => {
  if (!lexists(onDisk(top, `${path}/.git`))) return null // without .git, Git would find the enclosing repository instead
  // Git runs inside it, and Node passes a working directory only as UTF-8, so its name must decode. A name that does
  // not could never reach review input anyway.
  const cwd = `${top}/${decodePath(fsEncode(path))}`
  try {
    return objectId(line(git.run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toString())
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
}

/** The Git mode of a working tree path, or null when it is absent. A directory counts as a checked-out submodule. */
const diskMode = (path: Buffer): FileMode | null => {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info === undefined) return null
  if (info.isDirectory()) return "160000"
  return info.isSymbolicLink() ? "120000" : info.mode & 0o100 ? "100755" : "100644"
}

/**
 * Whether a directory on the way to path is now a symbolic link or a file. Git then counts path as deleted. Reading it
 * would follow the link outside the working tree, or fail on the file.
 */
const ancestorReplaced = (top: string, path: string) => {
  const parts = path.split("/").slice(0, -1)
  for (let depth = 1; depth <= parts.length; depth++) {
    const info = lstatSync(onDisk(top, parts.slice(0, depth).join("/")), { throwIfNoEntry: false })
    if (info === undefined) return false // an absent directory leaves path absent, which callers already handle
    if (!info.isDirectory()) return true
  }
  return false
}

/**
 * Whether a deleted path still exists under a spelling, of its name or a directory's on the way, that differs only in
 * case. Git folds only ASCII letters, so this does too; the old spelling of a directory may remain beside the new.
 */
const caseRenamed = (top: string, path: string) => {
  const found = (parent: Buffer, parts: ReadonlyArray<Buffer>, exact: boolean): boolean => {
    const [part, ...rest] = parts
    if (part === undefined) return !exact
    let names: Array<Buffer>
    try {
      names = readdirSync(parent, { encoding: "buffer" })
    } catch (error) {
      if (isSystemError(error)) return false
      throw error
    }
    const folded = asciiLower(part)
    return names.some((name) =>
      asciiLower(name).equals(folded) && found(Buffer.concat([parent, Buffer.from("/"), name]), rest, exact && name.equals(part)))
  }
  return found(fsEncode(top), path.split("/").map(fsEncode), true)
}

/** Parses git ls-files -s -v -z records: "TAG MODE BLOB STAGE\tPATH". */
const indexEntry = (record: Buffer): IndexEntry => {
  const tab = record.indexOf(0x09)
  const [tag = "", mode = "", blob = ""] = record.subarray(0, tab).toString("latin1").split(" ")
  const [parsedMode, parsedBlob] = [fileMode(mode), objectId(blob)]
  if (tab < 0 || parsedMode === null || parsedBlob === null) {
    throw new GitError({ message: `unexpected git ls-files entry ${JSON.stringify(record.toString("latin1"))}` })
  }
  return { tag, mode: parsedMode, blob: parsedBlob, path: fsDecode(record.subarray(tab + 1)) }
}

/** The index entries for paths, read in chunks so many long paths never overflow one command line. */
const indexEntries = ({ git, top }: Worktree, paths: ReadonlySet<string>): Map<string, IndexEntry> => {
  const names = [...paths].sort(byCodePoint)
  const entries = new Map<string, IndexEntry>()
  for (let start = 0; start < names.length; start += 200) {
    for (const record of records(git.run(top, ["ls-files", "-s", "-v", "-z", "--", ...names.slice(start, start + 200)]))) {
      const entry = indexEntry(record)
      if (paths.has(entry.path)) entries.set(entry.path, entry) // a pathspec naming a directory also lists its contents
    }
  }
  return entries
}

/**
 * Compares files that Git trusts without reading by their bytes on disk: assume-unchanged files, and skip-worktree files
 * that are present anyway. Git hides edits to both. The index listing stands in for HEAD: an entry Git's diff passed
 * over matches HEAD exactly.
 */
const assumedUnchanged = (worktree: Worktree, tracked: ReadonlyArray<RawChange>, listing: ReadonlyArray<Buffer>): Array<Change> => {
  const { top } = worktree
  // A lowercase tag marks assume-unchanged; S or s marks skip-worktree, read from the index only when absent. Either
  // behind a symlinked directory is a deletion, as staging would record it. Names keep undecodable bytes, so an
  // unchanged or absent entry with such a name never stops collection; trackedEntry refuses one only if it is a change.
  const assumed: Array<IndexEntry> = []
  for (const record of listing) {
    const tag = String.fromCharCode(record[0] ?? 0)
    const skip = tag === "S" || tag === "s"
    if (!skip && !(tag >= "a" && tag <= "z")) continue
    const entry = indexEntry(record)
    if (!skip || lexists(onDisk(top, entry.path)) || ancestorReplaced(top, entry.path)) assumed.push(entry)
  }
  const changes = new Map<string, Change>(tracked.map((change) => [change.path, { ...change, hidden: false }]))
  if (assumed.length === 0) return [...changes.values()]
  const linksAreFiles = !gitBool(worktree, "core.symlinks")
  const modesCount = gitBool(worktree, "core.filemode")
  const foldsCase = gitBool(worktree, "core.ignoreCase", false)
  for (const indexed of assumed.sort((a, b) => byCodePoint(a.path, b.path))) {
    const { path } = indexed
    let newMode = ancestorReplaced(top, path) ? null : diskMode(onDisk(top, path))
    if (linksAreFiles && indexed.mode === "120000" && isRegular(newMode)) {
      newMode = "120000" // with core.symlinks off, Git checks a link out as a placeholder file and keeps the link mode
    } else if (!modesCount && isRegular(indexed.mode) && isRegular(newMode)) {
      newMode = indexed.mode // with core.filemode off, Git records the index mode, not the executable bit on disk
    } else if (newMode === "160000" && indexed.mode !== "160000" && repositoryHead(worktree, path) === null) {
      newMode = null // an ordinary directory replaced the file: a deletion, with its children collected as untracked
    }
    const change = changes.get(path)
    // An added path or a rename target has no old side at this path: the file was only ever staged.
    if (change !== undefined && newMode === null && (change.oldMode === null || change.oldPath !== null)) {
      // Git hides the new spelling from the untracked list, and no HEAD deletion is left for the later guard.
      if (foldsCase && caseRenamed(top, path)) throw caseRenamedError(path)
      changes.delete(path) // added to the index, then removed from disk: nothing new in the tree
      if (change.oldPath !== null) {
        // A rename's source is still gone from the tree, so it is a deletion.
        changes.set(change.oldPath, { status: "D", path: change.oldPath, oldPath: null, oldMode: change.oldMode, newMode: null,
          oldBlob: change.oldBlob, newBlob: null, hidden: false })
      }
    } else if (change !== undefined) {
      changes.set(path, { ...change, newBlob: null, newMode, status: newMode === null ? "D" : change.status, hidden: true })
    } else {
      changes.set(path, { status: newMode === null ? "D" : "M", path, oldPath: null, oldMode: indexed.mode, newMode,
        oldBlob: indexed.blob, newBlob: null, hidden: true })
    }
  }
  return [...changes.values()]
}

const trackedEntry = (worktree: Worktree, change: Change): TrackedEntry | null => {
  const listed = STATUSES.get(change.status)
  if (listed === undefined) throw new CollectError({ message: `unexpected Git status ${change.status} for ${change.path}` })
  const { oldMode, newMode, oldBlob } = change
  const name = change.path // may hold undecodable bytes until the change proves real
  let newBlob: ObjectId | null = null
  let size = 0
  let binary = false
  let fromIndex = false
  if (newMode === "160000") {
    newBlob = change.newBlob ?? repositoryHead(worktree, name)
    if (newBlob === null) throw unfingerprintable(name)
  } else if (newMode !== null && change.newBlob !== null && !lexists(onDisk(worktree.top, name))) {
    // A skip-worktree entry in a sparse checkout, file or link, is staged but absent from disk; its content is the index blob.
    newBlob = change.newBlob
    size = blobSize(worktree, newBlob)
    fromIndex = true
  } else if (newMode === "120000") {
    newBlob = linkBlob(worktree, name)
  } else if (newMode !== null) {
    const read = readBlob(worktree, name)
    newBlob = read.blob
    size = read.size
    binary = read.binary
  }
  let status = listed
  if (status === "modified" && newBlob === oldBlob) {
    if (oldMode === newMode) return null // only the stat data changed; Git lists it because the index is never refreshed
    status = "changed"
  }
  // Only a change reaches review input, so an unchanged entry with a name it cannot carry never stops collection.
  const path = representable(decodePath(fsEncode(name)))
  const oldPath = change.oldPath === null ? null : representable(change.oldPath)
  return {
    untracked: false, path, oldPath, status, kind: kindOf(newMode ?? oldMode), hidden: change.hidden, fromIndex, oldBlob,
    oldMode, newBlob, newMode, size, binary,
    fingerprint: fileFingerprint({ path, oldPath, oldBlob, newBlob, oldMode, newMode })
  }
}

const untrackedEntry = (worktree: Worktree, path: string, nested: boolean, modesCount: boolean): UntrackedEntry => {
  const full = onDisk(worktree.top, path)
  const info = lstatSync(full)
  const added = (fields: Pick<UntrackedEntry, "kind" | "newMode" | "newBlob" | "size" | "lines" | "binary">): UntrackedEntry => ({
    untracked: true, path, oldPath: null, status: "added", oldBlob: null, oldMode: null, ...fields,
    fingerprint: fileFingerprint({ path, oldPath: null, oldBlob: null, newBlob: fields.newBlob, oldMode: null, newMode: fields.newMode })
  })
  if (nested) {
    if (!info.isDirectory()) throw new Changed(`${path} is no longer a directory`)
    const head = repositoryHead(worktree, path)
    if (head === null) throw unfingerprintable(path)
    return added({ kind: "submodule", newMode: "160000", newBlob: head, size: 0, lines: 1, binary: false })
  }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(full, { encoding: "buffer" })
    // Git counts a link's target as its content, so a target with line breaks is several lines.
    let lines = target.at(-1) === 0x0a ? 0 : 1
    for (let at = target.indexOf(0x0a); at >= 0; at = target.indexOf(0x0a, at + 1)) lines += 1
    return added({ kind: "symlink", newMode: "120000", newBlob: blobId(worktree.format, target), size: 0, lines, binary: false })
  }
  const read = readBlob(worktree, path)
  // With core.filemode off, Git adds a file as 100644 whatever its executable bit.
  return added({ kind: "file", newMode: modesCount ? read.mode : "100644", newBlob: read.blob, size: read.size, lines: read.lines,
    binary: read.binary })
}

/** Whether the index tracks path itself or anything under it, as git ls-files -- path would list. */
const isTracked = (listing: ReadonlyArray<Buffer>, path: string) => {
  const exact = fsEncode(path)
  const prefix = Buffer.concat([exact, Buffer.from("/")])
  return listing.some((record) => {
    const name = record.subarray(record.indexOf(0x09) + 1)
    return name.equals(exact) || (name.length > prefix.length && name.subarray(0, prefix.length).equals(prefix))
  })
}

/** The tracked path, a file or a folder holding one, that differs from path only in ASCII case, or null when none does. */
const trackedSpelling = (listing: ReadonlyArray<Buffer>, path: string): string | null => {
  const own = fsEncode(path)
  const folded = asciiLower(own)
  for (const record of listing) {
    const name = record.subarray(record.indexOf(0x09) + 1)
    const spelled = name.subarray(0, own.length)
    if ((name.length === own.length || name[own.length] === 0x2f) && !spelled.equals(own) && asciiLower(spelled).equals(folded)) {
      return fsDecode(spelled)
    }
  }
  return null
}

/**
 * Whether path exists only through an entry spelled in another case, as on a file system that folds case: it exists,
 * but some part of it is missing, spelled exactly, from its folder's listing.
 */
const reachedByFolding = (top: string, path: string) => {
  if (!lexists(onDisk(top, path))) return false
  const parts = path.split("/")
  return parts.some((part, depth) => {
    let names: Array<Buffer>
    try {
      names = readdirSync(onDisk(top, parts.slice(0, depth).join("/")), { encoding: "buffer" })
    } catch (error) {
      if (isSystemError(error)) return false
      throw error
    }
    const own = fsEncode(part)
    return !names.some((name) => name.equals(own))
  })
}

/** Reads HEAD and every changed path with its fingerprint. Equal reads before and after bracket a consistent snapshot. */
const inventory = (worktree: Worktree, limits: Limits): Snapshot => {
  const { git, top, config } = worktree
  let head: string
  try {
    head = line(git.run(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toString()
  } catch (error) {
    if (error instanceof GitError) throw new CollectError({ message: "HEAD has no commit yet. Make a first commit, then collect again." })
    throw error
  }
  let ref: Buffer | null
  try {
    ref = line(git.run(top, ["symbolic-ref", "--quiet", "HEAD"]))
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    ref = null // detached HEAD
  }
  if (ref !== null && !isDecodable(ref)) {
    // A replacement character would name a different branch in the review's title and target.
    const name = backslashReplace(ref).replace(/^refs\/heads\//, "")
    throw new CollectError({ message: `the branch ${name} is not valid UTF-8, so review input cannot name it. Rename it with git branch -m, then collect again.` })
  }
  const branch = ref === null ? null : ref.toString("utf8").replace(/^refs\/heads\//, "")
  const indexPath = decodePath(line(git.run(top, ["rev-parse", "--git-path", "index"])))
  const indexInfo = statSync(fsEncode(isAbsolute(indexPath) ? indexPath : `${top}/${indexPath}`), { bigint: true, throwIfNoEntry: false })
  const index = indexInfo === undefined ? null : { dev: indexInfo.dev, ino: indexInfo.ino, size: indexInfo.size, mtimeNs: indexInfo.mtimeNs }
  if (git.run(top, ["ls-files", "-z", "--unmerged"]).length > 0) {
    // git diff HEAD hides a conflict whose working tree bytes match HEAD, so the snapshot would look clean.
    throw new CollectError({ message: "the index has unresolved merge conflicts. Resolve and stage them, then collect again." })
  }
  const tracked = rawChanges(git.run(top, [...config, "diff", "--raw", "-z", "--no-abbrev", ...DIFF_FLAGS, "HEAD", "--"]))
  const listing = records(git.run(top, ["ls-files", "-s", "-v", "-z"]))
  const changes = assumedUnchanged(worktree, tracked, listing)
  const others = records(git.run(top, ["ls-files", "-z", "--others", "--exclude-standard"]))
  if (others.length > limits.files) throw tooMany(others.length, limits)
  const modesCount = gitBool(worktree, "core.filemode")
  const entries = new Map<string, Entry>()
  for (const change of changes) {
    const entry = reading(change.path, () => trackedEntry(worktree, change))
    if (entry === null) continue
    entries.set(entry.path, entry)
    if (entries.size > limits.files) throw tooMany(entries.size, limits) // before reading the rest
  }
  for (const raw of others) {
    // Git lists a nested repository as one directory entry ending in a slash.
    const nested = raw.at(-1) === 0x2f
    const path = representable(decodePath(nested ? raw.subarray(0, -1) : raw))
    if (entries.has(path)) {
      // git rm --cached deletes the path from Git but leaves the file: one path, two contradictory changes.
      throw new CollectError({ message: `${path} is removed from Git's index but still on disk, as after git rm --cached. Restore it with git restore --staged, or move or ignore the file, then collect again.` })
    }
    entries.set(path, reading(path, () => untrackedEntry(worktree, path, nested, modesCount)))
  }
  if (entries.size > limits.files) throw tooMany(entries.size, limits)
  if (gitBool(worktree, "core.ignoreCase", false)) {
    // With core.ignoreCase on, Git hides a file whose name, or a directory's on the way, differs from a deleted one only
    // in case.
    for (const entry of entries.values()) {
      if (entry.status === "deleted" && caseRenamed(top, entry.path)) throw caseRenamedError(entry.path)
    }
    // Git also hides a new file beside a tracked one whose name differs only in case. Listing with exact case finds it.
    // Twins are two directory entries, so both names must appear in their folder's listing: on a file system that folds
    // case, the folder holds one entry and the name Git listed is the tracked file itself. Links, symbolic or hard, to
    // one file are still two entries, so neither a followed link nor a shared inode makes them one.
    const listed = new Set(others.map((raw) => raw.toString("latin1")))
    for (const raw of records(git.run(top, ["-c", "core.ignoreCase=false", "ls-files", "-z", "--others", "--exclude-standard"]))) {
      if (listed.has(raw.toString("latin1"))) continue
      const path = fsDecode(raw.at(-1) === 0x2f ? raw.subarray(0, -1) : raw)
      const slash = path.lastIndexOf("/")
      const [parent, name] = [slash < 0 ? "" : path.slice(0, slash), path.slice(slash + 1)]
      const own = fsEncode(name)
      const folder = readdirSync(onDisk(top, parent), { encoding: "buffer" })
      if (!folder.some((entry) => entry.equals(own))) continue
      const folded = asciiLower(own)
      for (const other of folder) {
        const twin = parent === "" ? fsDecode(other) : `${parent}/${fsDecode(other)}`
        if (!other.equals(own) && asciiLower(other).equals(folded) && isTracked(listing, twin)) {
          throw new CollectError({ message: `${path} differs from tracked ${twin} only in case, which Git hides with core.ignoreCase on. Rename one of them, then collect again.` })
        }
      }
      // On a file system that folds case, renaming tracked foo to FOO leaves the one entry FOO, and Git still finds foo
      // through it, so no deletion appears above and a commit would keep the old name. The index tracks the name Git
      // listed in another case, and that spelling exists only through the new entry.
      const renamed = trackedSpelling(listing, path)
      if (renamed !== null && reachedByFolding(top, renamed)) throw caseRenamedError(renamed)
    }
  }
  return { head, branch, index, entries: [...entries.values()].sort((a, b) => byCodePoint(a.path, b.path)) }
}

/** Line counts for an entry Git's own diff skips, such as one marked assume-unchanged: diff its exact bytes. */
export const hiddenStats = (worktree: Worktree,
  entry: Pick<TrackedEntry, "path" | "kind" | "oldMode" | "oldBlob" | "newMode" | "newBlob" | "fromIndex">) => {
  const { git, top, config } = worktree
  const output = scratch(worktree, (temp) => {
    let old = devNull
    if (entry.oldMode === "160000") {
      // A submodule side is its commit, which Git diffs as one "Subproject commit" line.
      old = `${temp}/old`
      writeFileSync(old, `Subproject commit ${entry.oldBlob}\n`, { mode: 0o600 })
    } else if (entry.oldBlob !== null) {
      old = `${temp}/old`
      writeBlob(worktree, entry.oldBlob, old)
    }
    let next = entry.newMode === null ? devNull : `${top}/${entry.path}`
    if (entry.newMode === "160000") {
      next = `${temp}/new`
      writeFileSync(next, `Subproject commit ${entry.newBlob}\n`, { mode: 0o600 })
    } else if (entry.fromIndex && entry.newBlob !== null) {
      // An absent sparse entry's content is its staged blob; nothing is on disk.
      next = `${temp}/new`
      writeBlob(worktree, entry.newBlob, next)
    } else if (entry.kind === "symlink" && entry.newMode !== null && lstatSync(onDisk(top, entry.path), { throwIfNoEntry: false })?.isSymbolicLink()) {
      // Git counts a link's target as its content. With core.symlinks off, the placeholder file already holds it.
      next = `${temp}/new`
      writeFileSync(next, readlinkSync(onDisk(top, entry.path), { encoding: "buffer" }), { mode: 0o600 })
    }
    return git.run(temp, [...config, "-c", `core.attributesFile=${devNull}`, "diff", "--no-index", "--numstat", "--no-ext-diff",
      "--no-textconv", "--", old, next], { ok: [0, 1], env: { GIT_CEILING_DIRECTORIES: temp, GIT_ATTR_NOSYSTEM: "1" } })
  })
  const [additions, deletions] = output.toString("latin1").split("\t")
  if (additions === undefined || deletions === undefined) return { additions: 0, deletions: 0, binary: false } // no difference
  if (additions === "-") return { additions: 0, deletions: 0, binary: true }
  return { additions: parseCount(additions), deletions: parseCount(deletions), binary: false }
}

/** Each tracked path's additions and deletions as git diff counts them. Binary means a diff attribute or NUL bytes. */
const numstat = ({ git, top, config }: Worktree) => {
  const fields = records(git.run(top, [...config, "diff", "--numstat", "-z", ...DIFF_FLAGS, "HEAD", "--"]))
  const stats = new Map<string, { readonly additions: number; readonly deletions: number; readonly binary: boolean }>()
  for (let index = 0; index < fields.length && (fields[index]?.length ?? 0) > 0;) {
    const field = fields[index] ?? Buffer.alloc(0)
    const first = field.indexOf(0x09)
    const second = field.indexOf(0x09, first + 1)
    const [additions, deletions] = [field.subarray(0, first).toString("latin1"), field.subarray(first + 1, second).toString("latin1")]
    let path = field.subarray(second + 1)
    if (path.length > 0) {
      index += 1
    } else {
      // A rename: the old and new paths follow as separate fields.
      const renamed = fields[index + 2]
      if (first < 0 || second < 0 || renamed === undefined) throw new GitError({ message: "git diff --numstat output ended inside an entry" })
      path = renamed
      index += 3
    }
    const binary = additions === "-"
    stats.set(decodePath(path), { additions: binary ? 0 : parseCount(additions), deletions: binary ? 0 : parseCount(deletions), binary })
  }
  return stats
}

/** Diffs two byte strings with Git's own algorithm, outside any repository. */
const textPatch = (worktree: Worktree, old: Buffer | null, next: Buffer | null): Content => {
  const output = scratch(worktree, (temp) => {
    const names = ([["old", old], ["new", next]] as const).map(([name, data]) => {
      if (data === null) return devNull
      writeFileSync(`${temp}/${name}`, data, { mode: 0o600 })
      return name
    })
    // The ceiling keeps Git from finding a repository, and its attributes, above the temporary directory. No attributes
    // apply: a global core.attributesFile with * -diff would otherwise call text binary.
    return worktree.git.run(temp, [...worktree.config, "-c", `core.attributesFile=${devNull}`, "diff", "--no-index", "--no-ext-diff",
      "--no-textconv", "--no-color", "--unified=3", "--inter-hunk-context=0", "--", ...names],
    { ok: [0, 1], env: { GIT_CEILING_DIRECTORIES: dirname(temp), GIT_ATTR_NOSYSTEM: "1" } })
  })
  const at = output.indexOf("\n@@")
  const header = at < 0 ? output : output.subarray(0, at)
  if (header.toString("latin1").split("\n").some((text) => text.startsWith("Binary files ") && text.endsWith(" differ"))) {
    return { kind: "note", note: "binary" }
  }
  if (at < 0) return { kind: "note", note: "no_content_change" }
  return { kind: "patch", data: output.subarray(at + 1) }
}

/**
 * The patch bytes for a text diff, otherwise a note saying why there is none. The patch is built from the exact bytes
 * the fingerprint covers: the old blob read from the object store, and the file read again and checked against its
 * fingerprint. Diffing one pair of files never picks up a neighbor.
 */
const content = (worktree: Worktree, entry: Entry, options: { readonly allowSecret: boolean; readonly oversized: boolean; readonly limits: Limits }): Content => {
  const { git, top, config } = worktree
  const { path } = entry
  if (entry.kind !== "file") return { kind: "note", note: entry.kind }
  if (entry.oldBlob === entry.newBlob) return { kind: "note", note: "no_content_change" }
  if (!options.allowSecret && [path, entry.oldPath].some((name) => name !== null && secretName(name))) return { kind: "note", note: "secret" }
  // Binary means NUL bytes in the content, never a diff attribute: a text file marked -diff still shows its patch.
  if (entry.binary) return { kind: "note", note: "binary" }
  // A symbolic link or submodule replaced by a file has no text on its old side, so the file reads as new.
  const oldBlob = kindOf(entry.oldMode) === "file" ? entry.oldBlob : null
  const oldSize = oldBlob === null ? 0 : blobSize(worktree, oldBlob)
  if (oldSize === 0 && entry.size === 0) return { kind: "note", note: "empty" }
  if (options.oversized || Math.max(oldSize, entry.size) > 4 * options.limits.patchUnits) return { kind: "note", note: "too_large" }
  const old = oldBlob === null ? null : git.run(top, [...config, "cat-file", "blob", oldBlob])
  let next: Buffer | null = null
  if (!entry.untracked && entry.fromIndex && entry.newBlob !== null) {
    next = git.run(top, [...config, "cat-file", "blob", entry.newBlob])
  } else if (entry.newBlob !== null) {
    const read = reading(path, () => readBlob(worktree, path, entry.size))
    if (read.blob !== entry.newBlob || read.data === null) throw new Changed(`${path} changed while it was read`)
    next = read.data
  }
  if ([old, next].some((data) => data !== null && data.subarray(0, BINARY_PREFIX).includes(0))) return { kind: "note", note: "binary" }
  return textPatch(worktree, old, next)
}

type Draft = { -readonly [K in keyof typeof WorktreeFile.Encoded]: (typeof WorktreeFile.Encoded)[K] }

/** Turns an inventory into review files, and the likely secret files left out. */
const build = (worktree: Worktree, snapshot: Snapshot, include: ReadonlySet<string>, limits: Limits) => {
  const stats = numstat(worktree)
  const files: Array<typeof WorktreeFile.Encoded> = []
  const flagged: Array<string> = []
  let totalLines = 0
  let totalBytes = 0
  for (const entry of snapshot.entries) {
    const { path, binary } = entry
    let counts = { additions: 0, deletions: 0 }
    const stat = stats.get(path)
    if (entry.untracked) {
      counts = { additions: binary ? 0 : entry.lines, deletions: 0 }
    } else if (stat !== undefined && (binary || !stat.binary)) {
      counts = stat
    } else if (entry.hidden || stat !== undefined) {
      // numstat skipped the file, or called its text binary because of a diff attribute: count the exact bytes.
      counts = hiddenStats(worktree, entry)
    }
    const file: Draft = { path, status: entry.status, group: "core", additions: counts.additions, deletions: counts.deletions,
      fingerprint: entry.fingerprint }
    if (entry.oldPath !== null) file.old_path = entry.oldPath
    if (entry.oldMode !== null) file.old_mode = entry.oldMode
    if (entry.newMode !== null) file.new_mode = entry.newMode
    const budget = Math.min(limits.patchLines, limits.totalPatchLines - totalLines)
    const found = content(worktree, entry, { allowSecret: include.has(path), oversized: counts.additions + counts.deletions > budget, limits })
    let note: PatchNote | null = found.kind === "note" ? found.note : null
    if (found.kind === "patch") {
      const { text: patch, replaced } = cleanText(found.data)
      const lines = patch.split("\n")
      // The patch counts what the reviewer sees. A link or submodule replaced by a file shows only the file, so its old
      // side keeps Git's count.
      file.additions = lines.filter((text) => text.startsWith("+")).length
      if (kindOf(entry.oldMode) === "file") file.deletions = lines.filter((text) => text.startsWith("-")).length
      const lineCount = lines.length - (patch.endsWith("\n") ? 1 : 0)
      const size = Buffer.byteLength(JSON.stringify(patch))
      if (!include.has(path) && SECRET_TEXT.test(patch)) {
        note = "secret"
      } else if (patch.length > limits.patchUnits || lineCount > budget || totalBytes + size > Math.floor(limits.inputBytes / 2)) {
        // Patches may fill half of the input limit, leaving room for paths and the agent's analysis.
        note = "too_large"
      } else {
        totalLines += lineCount
        totalBytes += size
        file.patch = patch
        file.patch_complete = true
        note = replaced ? "replaced_characters" : null
      }
    }
    if (note === "too_large") file.patch_complete = false
    if (note === "secret") flagged.push(path)
    if (note !== null) file.patch_note = note
    files.push(file)
  }
  return { files, flagged }
}

/**
 * Paths whose staged version differs from both HEAD and the working tree. The review shows the working tree, but a
 * commit records the staged version.
 */
export const stagedDifferently = (worktree: Worktree): Array<string> => {
  const { git, top, config } = worktree
  const staged = new Set(records(git.run(top, [...config, "diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"]))
    .filter((raw) => raw.length > 0)
    .map(decodePath))
  if (staged.size === 0) return []
  // With core.filemode off, Git ignores the executable bit on disk, so only content can differ.
  const modesCount = gitBool(worktree, "core.filemode")
  const linksAreLinks = gitBool(worktree, "core.symlinks")
  const index = indexEntries(worktree, staged)
  // A staged deletion has no index entry; a file kept on disk at that path means the commit removes what was reviewed.
  const found = [...staged].filter((path) => !index.has(path) && lexists(onDisk(top, path)) && !ancestorReplaced(top, path))
  for (const { path, mode, blob, tag } of index.values()) {
    const full = onDisk(top, path)
    if (ancestorReplaced(top, path)) {
      found.push(path) // the review shows a deletion, but the commit records the staged file
      continue
    }
    if ((tag === "S" || tag === "s") && !lexists(full)) continue // a sparse entry whose staged blob is what the review showed
    let differs: boolean
    try {
      if (mode === "160000") differs = repositoryHead(worktree, path) !== blob
      // A regular file holding the target's bytes has the same blob; only the mode shows the type change.
      else if (mode === "120000") differs = linkBlob(worktree, path) !== blob || (linksAreLinks && diskMode(full) !== "120000")
      else differs = readBlob(worktree, path).blob !== blob || (modesCount && diskMode(full) !== mode)
    } catch (error) {
      if (!(error instanceof Changed) && !isSystemError(error)) throw error
      differs = true
    }
    if (differs) found.push(path)
  }
  return found.sort(byCodePoint)
}

/** A file system error the collector did not expect, as a CollectError that names it. */
const unexpected = (error: unknown) => (isSystemError(error) ? new CollectError({ message: error.message }) : error)

/**
 * Collects the working tree as review input. Reads the inventory, builds the review and the staged comparison, then
 * reads the inventory again; a difference means something wrote meanwhile, and collection starts over, up to
 * ATTEMPTS times. Throws CollectError or GitError.
 */
export const collect = (worktree: Worktree, options: CollectOptions = {}): Collected => {
  const limits = { ...LIMITS, ...options.limits }
  const include = new Set(options.includeSecret ?? [])
  let reason = "HEAD or a changed file differed between two reads"
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const snapshot = inventory(worktree, limits)
      const unknown = [...include].filter((path) => !snapshot.entries.some((entry) => entry.path === path)).sort(byCodePoint)
      if (unknown.length > 0) {
        throw new CollectError({ message: `a likely secret file to include is not a changed file: ${unknown.join(", ")}` })
      }
      const { files, flagged } = build(worktree, snapshot, include, limits)
      // Read inside the same before-and-after check, so a file that changes during this scan is caught too.
      worktree.trace({ kind: "staged-scan" })
      const staged = stagedDifferently(worktree)
      worktree.trace({ kind: "between-reads" })
      if (isDeepStrictEqual(inventory(worktree, limits), snapshot)) {
        const { head, branch } = snapshot
        const review = decodeValue(WorktreeInputDocument, {
          format: INPUT_FORMAT,
          target: {
            kind: "worktree",
            title: options.title ?? (branch === null ? `Uncommitted changes at ${head.slice(0, 7)}` : `Uncommitted changes on ${branch}`),
            root: worktree.top,
            head_sha: head,
            ...(branch === null ? {} : { branch }),
            changed_files: files.length
          },
          files_complete: true,
          files
        } satisfies typeof WorktreeInput.Encoded)
        // The schema's limits on paths, titles, and branch names apply here; the collector already kept the rest.
        if (Result.isFailure(review)) throw new CollectError({ message: review.failure.message })
        return { review: review.success, flagged, staged }
      }
      reason = "HEAD or a changed file differed between two reads"
    } catch (error) {
      if (!(error instanceof Changed)) throw unexpected(error)
      reason = error.message
    }
  }
  throw new CollectError({ message: `the working tree kept changing during ${ATTEMPTS} attempts (${reason}). Collect again when writes finish.` })
}
