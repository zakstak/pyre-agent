// Test support for the collector tests, ported from the Fixture class in tests/test_collect_worktree.py. Each test
// builds throwaway Git repositories in its own temporary directory. User and system Git configuration is shut out.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { TestContext } from "node:test"
import { collect, type CollectEvent, type CollectOptions, openWorktree } from "./collect.ts"
import { CollectError, GitError } from "./errors.ts"
import { type ObjectId, objectId } from "./fingerprint.ts"
import { checkOutput, errorLine, report, writeOutput } from "./output.ts"
import type { WorktreeInput } from "../schema/input.ts"

// Assembled from pieces so no source file matches the collector's secret patterns.
export const PRIVATE_KEY = "-".repeat(5) + "BEGIN RSA " + "PRIVATE KEY" + "-".repeat(5) + "\nMIIBsecretbody\n"
export const GITHUB_TOKEN = "gh" + "p_" + "A1b2".repeat(9)

const probe = <A>(check: (directory: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), "review-canvas-probe-"))
  try {
    return check(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether the temporary directory's file system folds case, as APFS does by default on macOS. */
export const foldsCase = probe((directory) => {
  writeFileSync(join(directory, "case"), "")
  return existsSync(join(directory, "CASE"))
})

/** Whether the temporary directory's file system accepts a name that is not valid UTF-8. APFS refuses one. */
export const keepsUndecodableNames = probe((directory) => {
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${directory}/`), Buffer.from([0xff])]), "")
    return true
  } catch {
    return false
  }
})

/** Sets environment variables for the length of run; undefined removes one. */
export const withEnv = <A>(variables: Readonly<Record<string, string | undefined>>, run: () => A): A => {
  const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
  assign(variables)
  try {
    return run()
  } finally {
    assign(saved)
  }
}

const assign = (variables: Readonly<Record<string, string | undefined>>) => {
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** The SHA-1 Git blob ID of data. */
export const blob = (data: string | Buffer): ObjectId => {
  const bytes = typeof data === "string" ? Buffer.from(data) : data
  const id = objectId(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"))
  if (id === null) throw new Error("a SHA-1 digest is never all zeros")
  return id
}

/** An executable shell script that touches marker, as the Python tests' fake git and filter programs do. */
export const script = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
  return path
}

export interface MainOptions extends CollectOptions {
  readonly output: string
  readonly repo?: string
  readonly trace?: (event: CollectEvent) => void
}

export interface MainResult {
  readonly code: number
  readonly out: string
  readonly err: string
}

export class Fixture {
  readonly base: string
  readonly root: string
  review: WorktreeInput | undefined
  flagged: ReadonlyArray<string> = []
  staged: ReadonlyArray<string> = []

  constructor(t: TestContext) {
    const saved = { ...process.env }
    // An inherited GIT_DIR or GIT_INDEX_FILE, as inside a Git hook, would send the fixture's own Git calls elsewhere.
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
    this.base = realpathSync(mkdtempSync(join(tmpdir(), "review-canvas-test-")))
    assign({
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      // Git also reads attributes and ignore rules under XDG_CONFIG_HOME or HOME without any configuration.
      HOME: this.base,
      XDG_CONFIG_HOME: join(this.base, ".config")
    })
    t.after(() => {
      rmSync(this.base, { recursive: true, force: true })
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      assign(saved)
    })
    this.root = this.init(join(this.base, "repo"))
  }

  init(path: string) {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path])
    this.configure(path)
    return path
  }

  configure(path: string) {
    for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"],
      ["init.defaultBranch", "main"]] as const) {
      this.git(path, "config", key, value)
    }
  }

  git(cwd: string, ...args: ReadonlyArray<string>) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  }

  /** Runs Git with input on standard input, for names and contents argv cannot carry. */
  gitInput(cwd: string, input: string | Buffer, ...args: ReadonlyArray<string>) {
    return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
  }

  write(name: string, data: string | Buffer, root = this.root) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    return path
  }

  commit(files: Readonly<Record<string, string | Buffer>> = {}, options: { readonly root?: string; readonly message?: string } = {}) {
    const root = options.root ?? this.root
    for (const [name, data] of Object.entries(files)) this.write(name, data, root)
    this.git(root, "add", "-A")
    this.git(root, "commit", "-q", "--allow-empty", "-m", options.message ?? "commit")
  }

  /** Stages a file under a raw byte name without creating it, since some file systems refuse such a name. */
  stageRaw(name: Buffer, data: string, root = this.root) {
    const id = this.gitInput(root, data, "hash-object", "-w", "--stdin").trim()
    this.gitInput(root, Buffer.concat([Buffer.from(`100644 ${id}\t`), name, Buffer.from([0])]), "update-index", "-z",
      "--add", "--index-info")
  }

  head(root = this.root) {
    return this.git(root, "rev-parse", "HEAD").trim()
  }

  collect(options: CollectOptions & { readonly repo?: string; readonly trace?: (event: CollectEvent) => void } = {}) {
    const worktree = openWorktree({ repo: options.repo ?? this.root, ...(options.trace ? { trace: options.trace } : {}) })
    const collected = collect(worktree, options)
    this.review = collected.review
    this.flagged = collected.flagged
    this.staged = collected.staged
    return Object.fromEntries(collected.review.files.map((file) => [file.path, file]))
  }

  /** The collector command's steps as Python's main ran them: check the output, collect, write, and report. */
  main(options: MainOptions): MainResult {
    try {
      const worktree = openWorktree({ repo: options.repo ?? this.root, ...(options.trace ? { trace: options.trace } : {}) })
      const output = checkOutput(worktree, options.output)
      const collected = collect(worktree, options)
      writeOutput(output, collected.review)
      return { code: 0, out: report({ output: options.output, collected }).map((line) => `${line}\n`).join(""), err: "" }
    } catch (error) {
      if (error instanceof CollectError || error instanceof GitError) return { code: 2, out: "", err: `${errorLine(error)}\n` }
      throw error
    }
  }
}
