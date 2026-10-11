// Ported from IsolationTests in tests/test_collect_worktree.py. Each test keeps its Python name. The tests after the
// describe block are not in the Python suite: they cover protections the TypeScript port adds.
import assert from "node:assert/strict"
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { configEntries } from "./config.ts"
import { gitEnvironment, trustedGit } from "./git.ts"
import { Fixture, script, withEnv } from "./testing.ts"

const stateDirectoryNote = "Not applicable: review state moves from STATE/rounds/NNNN directories to the server's SQLite " +
  "store (Decisions: Storage), so there is no state directory to archive and no round lock."

/** Every file under directory with its bytes. */
const snapshot = (directory: string) =>
  new Map(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [path, readFileSync(path)] as const
    }))

const fakeGit = (path: string, marker: string) => script(path, `touch '${marker}'\nexit 1\n`)

describe("IsolationTests", () => {
  test("test_configuration_and_environment_cannot_redirect_output_or_run_programs", (t) => {
    const f = new Fixture(t)
    const marker = join(f.base, "ran")
    const tool = script(join(f.base, "tool.sh"), `touch '${marker}'\n`)
    const other = f.init(join(f.base, "other"))
    f.commit({ "other.txt": "o\n" }, { root: other })
    f.commit({ "code.txt": "a\n\nb\n", "naïve.txt": "n\n", "touched.txt": "t\n", ".gitattributes": "*.txt diff=tool\n" })
    f.write("code.txt", "a\n\nB\n")
    f.write("naïve.txt", "N\n")
    utimesSync(join(f.root, "touched.txt"), 1, 1) // stat-only change: tempts Git to refresh and rewrite the index
    for (const [key, value] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["diff.suppressBlankEmpty", "true"],
      ["color.ui", "always"], ["core.quotePath", "true"], ["diff.external", tool], ["diff.tool.textconv", tool],
      ["diff.tool.command", tool], ["core.fsmonitor", tool]]) {
      f.git(f.root, "config", key ?? "", value ?? "")
    }
    if (existsSync(marker)) unlinkSync(marker)
    const gitDir = join(f.root, ".git")
    const before = snapshot(gitDir)
    const hostile = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(f.base, "index") }
    const files = withEnv(hostile, () => f.collect())
    assert.deepEqual(Object.keys(files).sort(), ["code.txt", "naïve.txt"])
    assert.equal(files["code.txt"]?.patch, "@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n")
    assert.ok(!existsSync(marker))
    assert.deepEqual(snapshot(gitDir), before)
  })

  test("test_global_attributes_cannot_hide_a_text_patch", (t) => {
    const f = new Fixture(t)
    const attributes = join(f.base, "attributes")
    writeFileSync(attributes, "* -diff\n")
    const config = join(f.base, "global-config")
    writeFileSync(config, `[core]\n\tattributesFile = ${attributes}\n`)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    const files = withEnv({ GIT_CONFIG_GLOBAL: config }, () => f.collect())
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
  })

  test("test_configured_filter_drivers_never_run", (t) => {
    const f = new Fixture(t)
    const marker = join(f.base, "filter-ran")
    const tool = script(join(f.base, "filter.sh"), `touch '${marker}'\ncat\n`)
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("")
    f.commit({ ".gitattributes": "*.txt filter=mark\n", "a.txt": "a\n", "old.txt": lines })
    f.write("a.txt", "b\n")
    f.write("new.txt", `${lines}more\n`)
    f.git(f.root, "rm", "-q", "--cached", "old.txt")
    unlinkSync(join(f.root, "old.txt"))
    f.git(f.root, "add", "-N", "new.txt")
    // Configure the driver last: from here on, any git diff that compares these files would run it.
    for (const key of ["clean", "smudge", "process"]) f.git(f.root, "config", `filter.mark.${key}`, tool)
    f.git(f.root, "config", "filter.mark.required", "true")
    const files = f.collect()
    assert.ok(!existsSync(marker), "a configured filter driver ran")
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
    assert.equal(files["new.txt"]?.old_path, "old.txt")
  })

  test("test_a_git_file_in_the_repository_never_runs_through_a_relative_path_entry", (t) => {
    const f = new Fixture(t)
    const marker = join(f.base, "fake-git-ran")
    fakeGit(join(f.root, "git"), marker)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    // From inside the repository, as an agent runs it, a relative entry would find the repository's git.
    const cwd = process.cwd()
    process.chdir(f.root)
    t.after(() => process.chdir(cwd))
    const files = withEnv({ PATH: `.::${process.env.PATH}` }, () => f.collect())
    assert.ok(!existsSync(marker), "the repository's git file ran")
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
  })

  test("test_a_state_replaced_while_collecting_is_not_written", { skip: stateDirectoryNote }, () => {})

  test("test_the_lock_the_final_check_and_the_write_use_one_resolved_path", (t) => {
    // The round lock is gone with the state directory. What remains: the check resolves a symlinked folder once, and
    // the write goes to that resolved path, because writeOutput accepts only what checkOutput returned.
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    const real = join(f.base, "state", "rounds", "0001")
    mkdirSync(real, { recursive: true })
    const alias = join(f.base, "alias")
    symlinkSync(real, alias)
    const { code, err } = f.main({ output: join(alias, "input.json") })
    assert.equal(code, 0, err)
    assert.ok(lstatSync(join(real, "input.json")).isFile())
    assert.ok(lstatSync(alias).isSymbolicLink())
  })

  test("test_a_git_executable_inside_the_repository_never_runs", (t) => {
    const f = new Fixture(t)
    const marker = join(f.base, "repo-git-ran")
    fakeGit(join(f.root, "bin", "git"), marker)
    f.commit({ "a.txt": "a\n" })
    withEnv({ PATH: `${join(f.root, "bin")}:${process.env.PATH}` }, () =>
      assert.throws(() => f.collect(), { _tag: "GitError", message: /inside the repository under review/ }))
    assert.ok(!existsSync(marker))
  })

  test("test_a_git_executable_inside_an_external_worktree_never_runs", (t) => {
    const f = new Fixture(t)
    const outside = join(f.base, "checkout")
    const marker = join(f.base, "worktree-git-ran")
    fakeGit(join(outside, "bin", "git"), marker)
    f.commit({ "a.txt": "a\n" })
    f.git(f.root, "config", "core.worktree", outside)
    withEnv({ PATH: `${join(outside, "bin")}:${process.env.PATH}` }, () =>
      assert.throws(() => f.collect(), { _tag: "GitError", message: /inside the repository under review/ }))
    assert.ok(!existsSync(marker))
  })

  test("test_config_values_decode_as_git_reads_them", (t) => {
    const f = new Fixture(t)
    const text = '[core]\n\tworktree = "../external\\"tree"  # comment\n\tbare\n[includeIf "gitdir:~/x/"]\n\tpath = a\\\n b ; c\n' +
      '[Core]\nWorkTree="q;#"x\n[core]\r\n\tworktree = ../crlf\r\n' // Git reads CRLF as one line ending
    const path = join(f.base, "check.config")
    writeFileSync(path, text)
    const gitValues = (key: string) => f.git(f.base, "config", "-f", path, "--get-all", key).split("\n").slice(0, -1)
    const entries = configEntries(text)
    assert.deepEqual(entries.filter((entry) => entry.section === "core" && entry.key === "worktree").map((entry) => entry.value),
      gitValues("core.worktree"))
    assert.deepEqual(entries.filter((entry) => entry.key === "path").map((entry) => entry.value), gitValues("includeif.gitdir:~/x/.path"))
  })

  test("test_a_git_executable_inside_an_included_worktree_never_runs", (t) => {
    const f = new Fixture(t)
    const outside = join(f.base, "checkout")
    const marker = join(f.base, "included-git-ran")
    fakeGit(join(outside, "bin", "git"), marker)
    f.commit({ "a.txt": "a\n" })
    writeFileSync(join(f.base, "extra.config"), `[core]\n\tworktree = "${outside}"\n`)
    const config = join(f.root, ".git", "config")
    for (const section of ["include", 'includeIf "gitdir:/"']) {
      writeFileSync(config, `${readFileSync(config, "utf8").split("[include")[0]}[${section}]\n\tpath = ../../extra.config\n`)
      withEnv({ PATH: `${join(outside, "bin")}:${process.env.PATH}` }, () =>
        assert.throws(() => f.collect(), { _tag: "GitError", message: /inside the repository under review/ }, section))
      assert.ok(!existsSync(marker), section)
    }
  })

  test("test_a_git_reached_through_a_symlink_in_the_repository_never_runs", (t) => {
    const f = new Fixture(t)
    const outside = join(f.base, "tools")
    const marker = join(f.base, "linked-git-ran")
    fakeGit(join(outside, "git"), marker)
    f.commit({ "a.txt": "a\n" })
    symlinkSync(outside, join(f.root, "bin"))
    withEnv({ PATH: `${join(f.root, "bin")}:${process.env.PATH}` }, () =>
      assert.throws(() => f.collect(), { _tag: "GitError", message: /inside the repository under review/ }))
    assert.ok(!existsSync(marker))
  })

  test("test_git_tracing_cannot_write_into_the_working_tree", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    const files = withEnv({ GIT_TRACE: join(f.root, "trace.log"), GIT_TRACE2_EVENT: join(f.root, "trace2.log") }, () => f.collect())
    assert.deepEqual(Object.keys(files), ["a.txt"])
    assert.ok(!existsSync(join(f.root, "trace.log")))
    assert.ok(!existsSync(join(f.root, "trace2.log")))
  })

  test("test_git_config_cannot_hide_a_filter_from_discovery", (t) => {
    const f = new Fixture(t)
    const marker = join(f.base, "filter-ran")
    const tool = script(join(f.base, "filter.sh"), `touch '${marker}'\ncat\n`)
    f.commit({ ".gitattributes": "*.txt filter=mark\n", "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    f.git(f.root, "config", "filter.mark.clean", tool)
    const empty = join(f.base, "empty-config")
    writeFileSync(empty, "")
    withEnv({ GIT_CONFIG: empty }, () => f.collect())
    assert.ok(!existsSync(marker), "a repository filter ran because GIT_CONFIG hid it from discovery")
  })

  test("test_filter_driver_names_that_are_not_utf8_stop_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    // argv cannot carry the byte, so the setting is appended to the config file as git config would write it.
    appendFileSync(join(f.root, ".git", "config"), Buffer.concat([Buffer.from('[filter "'), Buffer.from([0xff]), Buffer.from('"]\n\tclean = cat\n')]))
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /filter\.\\xff\.clean; its name is not valid UTF-8/ })
  })
})

test("a git inside a worktree named in a linked worktree's common config never runs", (t) => {
  // A linked worktree's own Git directory has no config; Git reads core.worktree from the common one.
  const f = new Fixture(t)
  const outside = join(f.base, "checkout")
  const marker = join(f.base, "common-git-ran")
  fakeGit(join(outside, "bin", "git"), marker)
  f.commit({ "a.txt": "a\n" })
  const linked = join(f.base, "linked")
  f.git(f.root, "worktree", "add", "-q", linked)
  f.git(f.root, "config", "core.worktree", outside)
  withEnv({ PATH: `${join(outside, "bin")}:${process.env.PATH}` }, () =>
    assert.throws(() => trustedGit({ repo: linked }), { _tag: "GitError", message: /inside the repository under review/ }))
  assert.ok(!existsSync(marker))
})

test("a git inside the Git directory that a .git file names, or in its common directory, never runs", (t) => {
  // A linked worktree's .git file names its Git directory inside the main checkout's .git, whose commondir names that
  // .git as the common directory. A submodule's .git file names its Git directory relative to the submodule.
  const f = new Fixture(t)
  f.commit({ "a.txt": "a\n" })
  const linked = join(f.base, "linked")
  f.git(f.root, "worktree", "add", "-q", linked)
  const separate = f.init(join(f.base, "separate"))
  f.commit({ "s.txt": "s\n" }, { root: separate })
  renameSync(join(separate, ".git"), join(f.base, "modules"))
  writeFileSync(join(separate, ".git"), "gitdir: ../modules\n")
  for (const [repo, directory] of [[linked, join(f.root, ".git", "worktrees", "linked")], [linked, join(f.root, ".git")],
    [separate, join(f.base, "modules")]] as const) {
    const marker = join(f.base, "metadata-git-ran")
    fakeGit(join(directory, "bin", "git"), marker)
    withEnv({ PATH: `${join(directory, "bin")}:${process.env.PATH}` }, () =>
      assert.throws(() => f.collect({ repo }), { _tag: "GitError", message: /inside the repository under review/ }, directory))
    assert.ok(!existsSync(marker), directory)
    rmSync(join(directory, "bin"), { recursive: true })
  }
})

test("Git metadata the collector cannot read as Git does stops collection before git runs", (t) => {
  const f = new Fixture(t)
  f.commit({ "a.txt": "a\n" })
  const linked = join(f.base, "linked")
  f.git(f.root, "worktree", "add", "-q", linked)
  const marker = join(f.base, "metadata-git-ran")
  const tools = join(f.base, "tools")
  fakeGit(join(tools, "git"), marker)
  const dotGit = join(linked, ".git")
  const commondir = join(f.root, ".git", "worktrees", "linked", "commondir")
  const original = readFileSync(dotGit)
  const refused = (problem: RegExp, label: string) => {
    withEnv({ PATH: `${tools}:${process.env.PATH}` }, () =>
      assert.throws(() => f.collect({ repo: linked }), { _tag: "GitError", message: problem }, label))
    assert.ok(!existsSync(marker), label)
  }
  // Git reads "gitdir:" without its space as no .git file at all.
  writeFileSync(dotGit, `gitdir:${original.toString().slice("gitdir: ".length)}`)
  refused(/\.git does not hold "gitdir: " and a path, so the collector cannot tell where/, "no space")
  writeFileSync(join(f.base, "dotgit"), original)
  unlinkSync(dotGit)
  symlinkSync(join(f.base, "dotgit"), dotGit)
  refused(/\.git is a symbolic link, so/, "symbolic link")
  unlinkSync(dotGit)
  writeFileSync(dotGit, original)
  writeFileSync(commondir, "")
  refused(/commondir holds no path, so/, "empty commondir")
  // Git drops every trailing CR and LF, so this commondir still names the main .git, and a git there is still refused.
  writeFileSync(commondir, "../..\r\n")
  fakeGit(join(f.root, ".git", "bin", "git"), marker)
  withEnv({ PATH: `${join(f.root, ".git", "bin")}:${process.env.PATH}` }, () =>
    assert.throws(() => f.collect({ repo: linked }), { _tag: "GitError", message: /inside the repository under review/ }))
  assert.ok(!existsSync(marker))
})

test("a git symlink outside the repository that points into it never runs", (t) => {
  const f = new Fixture(t)
  const marker = join(f.base, "pointed-git-ran")
  fakeGit(join(f.root, "bin", "git"), marker)
  f.commit({ "a.txt": "a\n" })
  const tools = join(f.base, "tools")
  mkdirSync(tools)
  symlinkSync(join(f.root, "bin", "git"), join(tools, "git"))
  withEnv({ PATH: `${tools}:${process.env.PATH}` }, () =>
    assert.throws(() => f.collect(), { _tag: "GitError", message: /inside the repository under review/ }))
  assert.ok(!existsSync(marker))
})

test("the Xcode shim runs the system git, never one that DEVELOPER_DIR selects", {
  skip: process.platform !== "darwin" && "only macOS has the Xcode shim at /usr/bin/git"
}, (t) => {
  // /usr/bin/git runs the git of the active developer directory, which DEVELOPER_DIR moves. The collector drops it,
  // so the shim runs the git an administrator selected with xcode-select.
  const f = new Fixture(t)
  const marker = join(f.base, "developer-git-ran")
  const developer = join(f.root, "Developer")
  for (const tool of ["git", "xcrun"]) fakeGit(join(developer, "usr", "bin", tool), marker)
  f.commit({ "a.txt": "a\n" })
  f.write("a.txt", "b\n")
  const files = withEnv({ PATH: `/usr/bin:${process.env.PATH}`, DEVELOPER_DIR: developer }, () => f.collect())
  assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
  assert.ok(!existsSync(marker))
})

test("only the variables that choose config files reach Git from the environment", () => {
  const inherited = {
    GIT_CEILING_DIRECTORIES: "/", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", GIT_EXEC_PATH: "/nowhere", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.external", GIT_CONFIG_VALUE_0: "/tool", GIT_CONFIG_PARAMETERS: "'core.pager'='x'",
    GIT_LITERAL_PATHSPECS: "0", GIT_CONFIG_GLOBAL: "/global", GIT_CONFIG_SYSTEM: "/system", GIT_CONFIG_NOSYSTEM: "1",
    DEVELOPER_DIR: "/developer", TOOLCHAINS: "swift", REVIEW_CANVAS_UNRELATED: "kept"
  }
  const env = withEnv(inherited, () => gitEnvironment({ GIT_CEILING_DIRECTORIES: "/scratch" }))
  const git = Object.keys(env).filter((key) => key.startsWith("GIT_")).sort()
  assert.deepEqual(git, ["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM",
    "GIT_GRAFT_FILE", "GIT_LITERAL_PATHSPECS", "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS",
    "GIT_SHALLOW_FILE"])
  assert.deepEqual([env["GIT_CEILING_DIRECTORIES"], env["GIT_LITERAL_PATHSPECS"], env["GIT_CONFIG_GLOBAL"]], ["/scratch", "1", "/global"])
  assert.deepEqual([env["DEVELOPER_DIR"], env["TOOLCHAINS"], env["REVIEW_CANVAS_UNRELATED"]], [undefined, undefined, "kept"])
})

test("an inherited ceiling cannot stop collection from a subdirectory", (t) => {
  const f = new Fixture(t)
  f.commit({ "sub/a.txt": "a\n" })
  f.write("sub/a.txt", "b\n")
  const files = withEnv({ GIT_CEILING_DIRECTORIES: f.root }, () => f.collect({ repo: join(f.root, "sub") }))
  assert.deepEqual(Object.keys(files), ["sub/a.txt"])
})
