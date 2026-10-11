import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs"
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

/** Inherited variables that would point Git at another repository, index, or object store, or change pathspec and
 * diff parsing. */
const DROPPED_ENV: ReadonlySet<string> = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF",
  // Grafts and a shallow file rewrite ancestry, which GIT_NO_REPLACE_OBJECTS does not cover.
  "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
  "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
  // GIT_CONFIG redirects git config but no other command, so filter discovery would read a different file.
  "GIT_CONFIG",
  // On macOS, /usr/bin/git is a shim that runs the git of the active developer directory. These would choose that
  // directory, or a toolchain searched before it, so without them the shim runs the git an administrator selected.
  "DEVELOPER_DIR", "TOOLCHAINS"
])

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

/**
 * Every working tree that core.worktree names in repo's configuration, read without running Git. The checkout under
 * review may sit there, outside repo, so a git inside it must be refused before Git first runs. Included files count
 * too, whatever their condition: refusing a git under a tree Git would not use costs nothing. So does the common
 * configuration of a linked worktree, which Git also reads.
 */
export const configuredWorktrees = (repo: string): Array<string> => {
  const top = repositoryTop(repo)
  let gitDir = top !== null ? join(top, ".git") : resolveLoose(repo)
  if (statSync(fsEncode(gitDir), { throwIfNoEntry: false })?.isFile()) {
    // A linked worktree or submodule: .git names the Git directory.
    const text = readText(gitDir)?.trim() ?? ""
    if (text.startsWith("gitdir:")) gitDir = resolveFrom(dirname(gitDir), text.slice("gitdir:".length).trim())
  }
  const common = readText(join(gitDir, "commondir"))
  const directories = common === null ? [gitDir] : [gitDir, resolveFrom(gitDir, common.replace(/\n$/, ""))]
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
 * Refuses an executable inside repo: under the path as given or resolved, the working tree above it, or a working
 * tree its configuration names. A bare repository has no .git child, so the path itself counts. Both the executable
 * as found and its target count: a symbolic link inside the repository could point a PATH entry elsewhere.
 */
export const assertOutside = (executable: string, repo: string) => {
  const roots = [resolveLoose(repo), resolve(repo), repositoryTop(repo), ...configuredWorktrees(repo)]
  const candidates = [resolve(executable), realpathSync(executable)]
  if (roots.some((root) => root !== null && candidates.some((candidate) => isWithin(candidate, root)))) {
    throw new GitError({ message: `git resolves to ${executable}, inside the repository under review. Put the system git earlier in PATH.` })
  }
}

const environment = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Tracing variables would make every call append to a file, which could sit in the working tree.
    if (value !== undefined && !DROPPED_ENV.has(key) && !key.startsWith("GIT_TRACE")) inherited[key] = value
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
        env: environment(env),
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
