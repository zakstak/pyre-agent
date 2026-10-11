import { spawnSync } from "node:child_process"
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs"
import { devNull, homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { configEntries } from "./config.ts"
import { GitError } from "./errors.ts"
import { fsDecode, fsEncode, isSystemError, isWithin, lexists, resolveFrom, resolveLoose, systemMessage } from "./paths.ts"

/*
 * Git runs without a shell, with options and an environment that keep user configuration from changing its output,
 * starting helper programs, or selecting a different repository, and only from a git outside the repository under
 * review: a git there would be code from the change.
 */

/**
 * The only inherited GIT_* variables Git sees. They choose which user and system config files Git reads, as HOME and
 * XDG_CONFIG_HOME do, and every setting from those files that could change the output or start a program is
 * overridden below. Every other GIT_* variable is dropped: they select another repository, index, object store, or
 * namespace, change discovery, pathspecs, or diffs, trace into files, or add config of their own.
 */
const KEPT_GIT_ENV: ReadonlySet<string> = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"])

/**
 * On macOS, /usr/bin/git is a shim that runs the git of the active developer directory. These would choose that
 * directory, or a toolchain searched before it, so without them the shim runs the git an administrator selected.
 */
const DROPPED_ENV: ReadonlySet<string> = new Set(["DEVELOPER_DIR", "TOOLCHAINS"])

/** -c options for every Git call. diff.autoRefreshIndex=false stops git diff from rewriting .git/index; callers drop
 * stat-only entries by blob ID. */
export const GIT_CONFIG: ReadonlyArray<string> = [
  "core.fsmonitor=false", "core.quotePath=false", "diff.suppressBlankEmpty=false", "diff.noprefix=false",
  "diff.mnemonicPrefix=false", "diff.relative=false", "diff.autoRefreshIndex=false",
  "diff.renameLimit=0", // 0 is unlimited, so renames never depend on user configuration
  // A stale untracked cache could hide new files; listing them directly costs little.
  "core.untrackedCache=false"
].flatMap((setting) => ["-c", setting])

/** Submodules compare by commit only, so Git never runs inside them to check for local edits. */
export const DIFF_FLAGS: ReadonlyArray<string> = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "-M"]

export interface GitEvent {
  readonly kind: "git"
  readonly cwd: string
  /** The arguments after the fixed -c options. */
  readonly args: ReadonlyArray<string>
  /** Empty when the output went to a file. */
  readonly stdout: Buffer
}

export interface RunOptions {
  /** Exit codes that count as success. */
  readonly ok?: ReadonlyArray<number>
  readonly env?: Readonly<Record<string, string>>
  /** A file descriptor that receives the output instead of memory. */
  readonly into?: number
}

/** A git checked against one repository. Run it only in that repository, its submodules, or a scratch directory. */
export interface Git {
  readonly executable: string
  /** Runs Git in cwd and returns its output. An exit code outside ok throws GitError. */
  readonly run: (cwd: string, args: ReadonlyArray<string>, options?: RunOptions) => Buffer
}

/** PATH without relative entries. With cwd set, a relative entry such as . would find a git file in the repository. */
export const trustedPath = () =>
  (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "" && isAbsolute(entry)).join(delimiter)

const isDirectory = (path: string) => {
  try {
    return statSync(fsEncode(path)).isDirectory()
  } catch (error) {
    if (isSystemError(error)) return false
    throw error
  }
}

const isExecutableFile = (path: string) => {
  try {
    if (statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The working tree root above path, found without running Git: the nearest directory holding .git. */
export const repositoryTop = (path: string): string | null => {
  for (let directory = resolveLoose(path); ; directory = dirname(directory)) {
    if (lexists(fsEncode(join(directory, ".git")))) return directory
    if (dirname(directory) === directory) return null
  }
}

const readText = (path: string): string | null => {
  try {
    return fsDecode(readFileSync(fsEncode(path)))
  } catch {
    return null
  }
}

const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? homedir() + path.slice(1) : path)

/** Git refuses a .git file larger than this, and the collector reads no larger metadata file. */
const METADATA_BYTES = 1 << 20

const badMetadata = (path: string, problem: string) =>
  new GitError({ message: `${path} ${problem}, so the collector cannot tell where the repository's Git directory is and runs no git` })

/**
 * A file of Git metadata, such as .git or commondir, or null when nothing is there. It is read as working tree files
 * are, without following a symbolic link or blocking on a FIFO. Git would follow a link, so a link, or anything else
 * that is not a small regular file, stops collection rather than leave a Git directory unknown.
 */
const readMetadata = (path: string): Buffer | null => {
  let fd: number
  try {
    fd = openSync(fsEncode(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (!isSystemError(error)) throw error
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
    throw badMetadata(path, error.code === "ELOOP" ? "is a symbolic link" : `cannot be read (${systemMessage(error)})`)
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw badMetadata(path, "is not a regular file")
    if (info.size > METADATA_BYTES) throw badMetadata(path, `holds more than ${METADATA_BYTES} bytes`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The path in a metadata file, after prefix and without its trailing line breaks, as Git reads it. A file that Git
 * would refuse, or would cut short at a NUL byte, stops collection.
 */
const metadataPath = (path: string, data: Buffer | null, prefix: string): string => {
  const bytes = data ?? Buffer.alloc(0)
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1
  const head = Buffer.from(prefix)
  if (end <= head.length || !bytes.subarray(0, head.length).equals(head) || bytes.subarray(0, end).includes(0)) {
    throw badMetadata(path, prefix === "" ? "holds no path" : `does not hold "${prefix}" and a path`)
  }
  return fsDecode(bytes.subarray(head.length, end))
}

/** The Git directory that top's .git names: .git itself, or the directory a .git file names relative to top. */
const dotGitTarget = (top: string) => {
  const dotGit = join(top, ".git")
  // Git follows a link to a directory, which needs no reading. Anything else must be a .git file.
  if (isDirectory(dotGit)) return resolveLoose(dotGit)
  return resolveFrom(top, metadataPath(dotGit, readMetadata(dotGit), "gitdir: "))
}

/**
 * The repository's Git directory, and the common directory its commondir file names, read without running Git. Both
 * are the same directory unless repo is a linked worktree. A linked worktree or a submodule has a .git file that names
 * a Git directory outside the working tree, often inside another checkout's .git, so a git there must be refused
 * before Git first runs. A bare repository has no .git child, so the path itself counts.
 */
export const gitDirectories = (repo: string): { readonly gitDir: string; readonly commonDir: string } => {
  const top = repositoryTop(repo)
  const gitDir = top === null ? resolveLoose(repo) : dotGitTarget(top)
  const common = join(gitDir, "commondir")
  const data = readMetadata(common)
  return { gitDir, commonDir: data === null ? gitDir : resolveFrom(gitDir, metadataPath(common, data, "")) }
}

/**
 * Every working tree that core.worktree names in repo's configuration, read without running Git. The checkout under
 * review may sit there, outside repo, so a git inside it must be refused before Git first runs. Included files count
 * too, whatever their condition: refusing a git under a tree Git would not use costs nothing. So does the common
 * configuration of a linked worktree, which Git also reads.
 */
export const configuredWorktrees = (repo: string): Array<string> => {
  const { gitDir, commonDir } = gitDirectories(repo)
  const directories = [gitDir, commonDir]
  const found: Array<string> = []
  const seen = new Set<string>()
  const read = (path: string, depth: number) => {
    if (depth > 10 || seen.has(path)) return
    seen.add(path)
    const text = readText(path)
    if (text === null) return
    for (const { section, key, value } of configEntries(text)) {
      if (value === null) continue
      if (section === "core" && key === "worktree") {
        found.push(resolveFrom(gitDir, value)) // relative to the Git directory, as Git reads it
      } else if ((section === "include" || section.startsWith("includeif.")) && key === "path") {
        read(resolveFrom(dirname(path), expandHome(value)), depth + 1)
      }
    }
  }
  for (const directory of directories) for (const name of ["config", "config.worktree"]) read(join(directory, name), 0)
  return found
}

/**
 * Refuses an executable inside repo: under the path as given or resolved, the working tree above it, its Git and
 * common directories, or a working tree its configuration names. A bare repository has no .git child, so the path
 * itself counts. Both the executable as found and its target count: a symbolic link inside the repository could point
 * a PATH entry elsewhere.
 */
export const assertOutside = (executable: string, repo: string) => {
  const { gitDir, commonDir } = gitDirectories(repo)
  const roots = [resolveLoose(repo), resolve(repo), repositoryTop(repo), gitDir, commonDir, ...configuredWorktrees(repo)]
  const candidates = [resolve(executable), realpathSync(executable)]
  if (roots.some((root) => root !== null && candidates.some((candidate) => isWithin(candidate, root)))) {
    throw new GitError({ message: `git resolves to ${executable}, inside the repository under review. Put the system git earlier in PATH.` })
  }
}

/** The environment for a Git call: the inherited one without GIT_* variables, then the settings below and extra. */
export const gitEnvironment = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || DROPPED_ENV.has(key) || (key.startsWith("GIT_") && !KEPT_GIT_ENV.has(key))) continue
    inherited[key] = value
  }
  return {
    ...inherited,
    PATH: trustedPath(),
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    // Keeps a partial clone from fetching missing objects over the network.
    GIT_NO_LAZY_FETCH: "1",
    // Empty graft and shallow files replace .git/info/grafts and .git/shallow, whose fake ancestry or roots would
    // otherwise move the merge base.
    GIT_GRAFT_FILE: devNull,
    GIT_SHALLOW_FILE: devNull,
    ...extra
  }
}

/**
 * The first git in an absolute PATH directory, refused when it lies inside repo. The executable is resolved once, so
 * every call runs the program that was checked.
 */
export const trustedGit = ({ repo, trace }: { readonly repo: string; readonly trace?: (event: GitEvent) => void }): Git => {
  const executable = trustedPath().split(delimiter).map((directory) => join(directory, "git")).find(isExecutableFile)
  if (executable === undefined) throw new GitError({ message: "git was not found in any absolute PATH directory" })
  assertOutside(executable, repo)
  return {
    executable,
    run: (cwd, args, options: RunOptions = {}) => {
      const { ok = [0], env = {}, into } = options
      const result = spawnSync(executable, [...GIT_CONFIG, ...args], {
        cwd,
        env: gitEnvironment(env),
        stdio: ["ignore", into ?? "pipe", "pipe"],
        maxBuffer: Number.POSITIVE_INFINITY
      })
      if (result.error !== undefined) {
        const reason = isSystemError(result.error) ? systemMessage(result.error) : result.error.message
        throw new GitError({ message: `cannot run git in ${cwd}: ${reason}` })
      }
      const stdout = into === undefined ? result.stdout : Buffer.alloc(0)
      trace?.({ kind: "git", cwd, args, stdout })
      if (result.status === null || !ok.includes(result.status)) {
        const message = result.stderr.toString("utf8").trim().replace(/^fatal: /, "")
        throw new GitError({ message: message || `git exited with ${result.status === null ? `signal ${result.signal}` : `status ${result.status}`}` })
      }
      return stdout
    }
  }
}
