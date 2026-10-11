// Ported from InventoryTests in tests/test_collect_worktree.py. Each test keeps its Python name, so
// parity.test.ts can check that every Python case has a counterpart here or in another collector test file.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { type CollectEvent, hiddenStats, openWorktree, stagedDifferently } from "./collect.ts"
import { GitError } from "./errors.ts"
import { fileFingerprint, objectId } from "./fingerprint.ts"
import { blob, Fixture, foldsCase, keepsUndecodableNames, withEnv } from "./testing.ts"

const statuses = (files: Readonly<Record<string, { readonly status: string }>>) =>
  Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.status]))

const caseFoldingNote = "the file system folds case, so both spellings cannot exist side by side"

describe("InventoryTests", () => {
  test("test_staged_unstaged_and_untracked_changes_appear_but_ignored_files_do_not", (t) => {
    const f = new Fixture(t)
    f.commit({ "staged.txt": "one\n", "unstaged.txt": "one\n", ".gitignore": "*.log\nbuild/\n" })
    f.write("staged.txt", "one\nstaged\n")
    f.git(f.root, "add", "staged.txt")
    f.write("unstaged.txt", "one\nunstaged\n")
    f.write("dir/new.txt", "a\nb\n")
    f.write("debug.log", "ignored\n")
    f.write("build/out.txt", "ignored\n")
    const files = f.collect()
    assert.deepEqual(Object.keys(files).sort(), ["dir/new.txt", "staged.txt", "unstaged.txt"])
    assert.equal(files["staged.txt"]?.patch, "@@ -1 +1,2 @@\n one\n+staged\n")
    assert.equal(files["unstaged.txt"]?.patch, "@@ -1 +1,2 @@\n one\n+unstaged\n")
    const added = files["dir/new.txt"]
    assert.deepEqual(added, {
      path: "dir/new.txt", status: "added", group: "core", additions: 2, deletions: 0, fingerprint: added?.fingerprint,
      new_mode: "100644", patch: "@@ -0,0 +1,2 @@\n+a\n+b\n", patch_complete: true
    })
    assert.deepEqual(f.review?.target, {
      kind: "worktree", title: "Uncommitted changes on main", root: f.root, head_sha: f.head(), branch: "main",
      changed_files: 3
    })
    assert.equal(f.review?.files_complete, true)
    assert.deepEqual(f.flagged, [])
  })

  test("test_binary_files_keep_entry_and_stats_without_a_patch", (t) => {
    const f = new Fixture(t)
    f.commit({ "image.bin": Buffer.from([0, 1, 2, 10]) })
    f.write("image.bin", Buffer.from([0, 3, 10]))
    f.write("blob.dat", Buffer.from("text\0more\n"))
    const files = f.collect()
    assert.equal(files["image.bin"]?.status, "modified")
    assert.equal(files["blob.dat"]?.status, "added")
    for (const file of Object.values(files)) {
      assert.deepEqual([file.patch_note, file.additions, file.deletions], ["binary", 0, 0])
      assert.ok(!("patch" in file))
      assert.ok(!("patch_complete" in file))
    }
  })

  test("test_rename_detection_ignores_the_configured_limit", (t) => {
    const f = new Fixture(t)
    const body = (i: number) => Array.from({ length: 50 }, (_, n) => `f${i} line ${n}\n`).join("")
    f.commit(Object.fromEntries([0, 1, 2].map((i) => [`f${i}.txt`, body(i)])))
    for (const i of [0, 1, 2]) {
      f.git(f.root, "mv", `f${i}.txt`, `g${i}.txt`)
      f.write(`g${i}.txt`, `${body(i)}extra\n`)
    }
    f.git(f.root, "config", "diff.renameLimit", "1")
    assert.deepEqual(Object.values(f.collect()).map((file) => file.status), ["renamed", "renamed", "renamed"])
  })

  test("test_staged_rename_with_an_edit_and_a_pure_rename", (t) => {
    const f = new Fixture(t)
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("")
    f.commit({ "old.txt": lines, "same.txt": "same\n" })
    f.git(f.root, "mv", "old.txt", "new.txt")
    f.write("new.txt", `${lines}added\n`)
    f.git(f.root, "mv", "same.txt", "moved.txt")
    const files = f.collect()
    assert.deepEqual(Object.keys(files).sort(), ["moved.txt", "new.txt"])
    const edited = files["new.txt"]
    assert.deepEqual([edited?.status, edited?.old_path, edited?.additions, edited?.deletions], ["renamed", "old.txt", 1, 0])
    assert.equal(edited?.patch, "@@ -8,3 +8,4 @@ line 6\n line 7\n line 8\n line 9\n+added\n")
    const pure = files["moved.txt"]
    assert.deepEqual([pure?.status, pure?.old_path, pure?.patch_note], ["renamed", "same.txt", "no_content_change"])
    assert.ok(pure && !("patch" in pure))
  })

  test("test_deletion_and_mode_only_change", (t) => {
    const f = new Fixture(t)
    f.commit({ "gone.txt": "bye\n", "run.sh": "echo hi\n" })
    unlinkSync(join(f.root, "gone.txt"))
    chmodSync(join(f.root, "run.sh"), 0o755)
    const files = f.collect()
    const gone = files["gone.txt"]
    assert.deepEqual([gone?.status, gone?.deletions, gone?.old_mode, gone?.patch], ["deleted", 1, "100644", "@@ -1 +0,0 @@\n-bye\n"])
    assert.ok(gone && !("new_mode" in gone))
    const run = files["run.sh"]
    assert.deepEqual([run?.status, run?.patch_note, run?.old_mode, run?.new_mode], ["changed", "no_content_change", "100644", "100755"])
    assert.ok(run && !("patch" in run))
  })

  test("test_symlinks_submodules_and_nested_repositories_have_no_patch", (t) => {
    const f = new Fixture(t)
    const source = f.init(join(f.base, "source"))
    f.commit({ "s.txt": "s\n" }, { root: source })
    symlinkSync("target-a", join(f.root, "link"))
    f.commit({ "file.txt": "f\n" })
    f.git(f.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub")
    f.commit({}, { message: "add submodule" })
    const sub = join(f.root, "sub")
    const oldCommit = f.head(sub)
    f.configure(sub)
    f.commit({ "t.txt": "t\n" }, { root: sub })
    unlinkSync(join(f.root, "link"))
    symlinkSync("target-b", join(f.root, "link"))
    symlinkSync("file.txt", join(f.root, "new-link"))
    const nested = f.init(join(f.root, "nested"))
    f.commit({ "n.txt": "n\n" }, { root: nested })
    const files = f.collect()
    assert.deepEqual(Object.keys(files).sort(), ["link", "nested", "new-link", "sub"])
    for (const [path, note] of [["link", "symlink"], ["new-link", "symlink"], ["sub", "submodule"], ["nested", "submodule"]] as const) {
      assert.equal(files[path]?.patch_note, note, path)
      assert.ok(!("patch" in (files[path] ?? {})), path)
    }
    assert.equal(files["link"]?.fingerprint, fileFingerprint({
      path: "link", oldPath: null, oldBlob: blob("target-a"), newBlob: blob("target-b"), oldMode: "120000", newMode: "120000"
    }))
    assert.equal(files["new-link"]?.new_mode, "120000")
    // Git counts a one-line link target or a submodule commit as one line, staged or not.
    assert.deepEqual(Object.fromEntries(Object.entries(files).map(([path, file]) => [path, [file.additions, file.deletions]])),
      { link: [1, 1], "new-link": [1, 0], sub: [1, 1], nested: [1, 0] })
    const changed = files["sub"]
    assert.deepEqual([changed?.status, changed?.old_mode, changed?.new_mode], ["modified", "160000", "160000"])
    assert.equal(changed?.fingerprint, fileFingerprint({
      path: "sub", oldPath: null, oldBlob: objectId(oldCommit), newBlob: objectId(f.head(sub)), oldMode: "160000",
      newMode: "160000"
    }))
    assert.deepEqual([files["nested"]?.status, files["nested"]?.new_mode], ["added", "160000"])
    assert.equal(files["nested"]?.fingerprint, fileFingerprint({
      path: "nested", oldPath: null, oldBlob: null, newBlob: objectId(f.head(nested)), oldMode: null, newMode: "160000"
    }))
  })

  test("test_an_untracked_link_target_with_line_breaks_counts_each_line", (t) => {
    const f = new Fixture(t)
    f.commit({ "keep.txt": "k\n" })
    symlinkSync("a\nb", join(f.root, "link"))
    const link = f.collect()["link"]
    assert.deepEqual([link?.additions, link?.deletions], [2, 0])
    f.git(f.root, "add", "link")
    assert.deepEqual(f.git(f.root, "diff", "--cached", "--numstat", "HEAD").split("\t").slice(0, 2), ["2", "0"], "as Git counts it")
  })

  test("test_a_link_replaced_by_a_file_keeps_the_link_deletion", (t) => {
    const f = new Fixture(t)
    symlinkSync("old", join(f.root, "link"))
    f.commit({ "keep.txt": "k\n" })
    unlinkSync(join(f.root, "link"))
    f.write("link", "new\n")
    const link = f.collect()["link"]
    assert.deepEqual([link?.additions, link?.deletions, link?.patch], [1, 1, "@@ -0,0 +1 @@\n+new\n"])
    assert.deepEqual(f.git(f.root, "diff", "--numstat", "HEAD", "--", "link").split("\t").slice(0, 2), ["1", "1"], "as Git counts it")
  })

  test("test_type_changes_follow_the_current_file", (t) => {
    const f = new Fixture(t)
    symlinkSync("target", join(f.root, "link"))
    f.commit({ "plain.txt": "was a file\n" })
    unlinkSync(join(f.root, "link"))
    f.write("link", "now a regular file\n")
    unlinkSync(join(f.root, "plain.txt"))
    symlinkSync("elsewhere", join(f.root, "plain.txt"))
    const files = f.collect()
    const link = files["link"]
    assert.deepEqual([link?.status, link?.old_mode, link?.new_mode, link?.patch],
      ["changed", "120000", "100644", "@@ -0,0 +1 @@\n+now a regular file\n"])
    assert.ok(link && !("patch_note" in link))
    assert.deepEqual([files["plain.txt"]?.patch_note, files["plain.txt"]?.new_mode], ["symlink", "120000"])
  })

  test("test_symlink_placeholder_without_symlink_support", (t) => {
    const f = new Fixture(t)
    f.commit({ "keep.txt": "k\n" })
    f.git(f.root, "config", "core.symlinks", "false")
    const target = f.gitInput(f.root, "old-target", "hash-object", "-w", "--stdin").trim()
    f.git(f.root, "update-index", "--add", "--cacheinfo", `120000,${target},link`)
    f.git(f.root, "commit", "-q", "-m", "link")
    f.git(f.root, "checkout", "--", "link")
    assert.ok(!lstatSync(join(f.root, "link")).isSymbolicLink())
    f.write("link", "new-target")
    const files = f.collect()
    assert.deepEqual([files["link"]?.patch_note, files["link"]?.new_mode], ["symlink", "120000"])
    assert.equal(files["link"]?.fingerprint, fileFingerprint({
      path: "link", oldPath: null, oldBlob: objectId(target), newBlob: blob("new-target"), oldMode: "120000", newMode: "120000"
    }))
    // A placeholder past 1 MiB is hashed in full, so a change near its end still changes the fingerprint.
    const big = Buffer.alloc(2 << 20, "t")
    f.write("link", big)
    const first = f.collect()["link"]?.fingerprint
    f.write("link", Buffer.concat([big.subarray(0, -1), Buffer.from("u")]))
    assert.notEqual(f.collect()["link"]?.fingerprint, first)
  })

  test("test_a_text_file_marked_minus_diff_still_shows_its_patch", (t) => {
    const f = new Fixture(t)
    f.commit({ ".gitattributes": "*.lock -diff\n", "deps.lock": "a 1\n" })
    f.write("deps.lock", "a 2\n")
    const files = f.collect()
    assert.equal(files["deps.lock"]?.patch, "@@ -1 +1 @@\n-a 1\n+a 2\n")
    assert.deepEqual([files["deps.lock"]?.additions, files["deps.lock"]?.deletions], [1, 1])
    assert.ok(!("patch_note" in (files["deps.lock"] ?? {})))
  })

  test("test_intent_to_add_file_matches_the_untracked_entry", (t) => {
    const f = new Fixture(t)
    f.commit({ "base.txt": "b\n" })
    f.write("ita.txt", "first\nlast")
    f.write("empty.txt", "")
    const untracked = f.collect()
    f.git(f.root, "add", "-N", "ita.txt", "empty.txt")
    const marked = f.collect()
    assert.deepEqual(marked, untracked)
    assert.equal(marked["ita.txt"]?.patch, "@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file\n")
    assert.deepEqual([marked["empty.txt"]?.status, marked["empty.txt"]?.patch_note], ["added", "empty"])
    assert.ok(!("patch" in (marked["empty.txt"] ?? {})))
  })

  test("test_invalid_utf8_and_control_characters_are_replaced_and_crlf_is_kept", (t) => {
    const f = new Fixture(t)
    f.commit({ "feed.txt": "a\n", "crlf.txt": "one\r\ntwo\r\n" })
    f.write("latin1.txt", Buffer.from("café\n", "latin1"))
    f.write("feed.txt", "a\n\x0cb\x7f\n")
    f.write("crlf.txt", "one\r\nTWO\r\n")
    f.write("win.txt", "x\r\ny\r\n")
    const files = f.collect()
    assert.deepEqual([files["latin1.txt"]?.patch_note, files["latin1.txt"]?.patch], ["replaced_characters", "@@ -0,0 +1 @@\n+caf\ufffd\n"])
    assert.deepEqual([files["feed.txt"]?.patch_note, files["feed.txt"]?.patch], ["replaced_characters", "@@ -1 +1,2 @@\n a\n+\u240cb\u2421\n"])
    assert.equal(files["crlf.txt"]?.patch, "@@ -1,2 +1,2 @@\n one\r\n-two\r\n+TWO\r\n")
    assert.equal(files["win.txt"]?.patch, "@@ -0,0 +1,2 @@\n+x\r\n+y\r\n")
    assert.ok(!("patch_note" in (files["crlf.txt"] ?? {})))
    assert.ok(!("patch_note" in (files["win.txt"] ?? {})))
  })

  test("test_non_utf8_path_fails_with_the_escaped_name", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    // The index holds any name, so a tracked file deleted from disk checks the refusal on every file system.
    const indexed = f.init(join(f.base, "indexed"))
    f.commit({ "a.txt": "a\n" }, { root: indexed })
    f.stageRaw(Buffer.from([0x67, 0x6f, 0x6e, 0x65, 0xff, 0x2e, 0x74, 0x78, 0x74]), "x\n", indexed)
    f.git(indexed, "commit", "-q", "-m", "undecodable")
    assert.throws(() => f.collect({ repo: indexed }), { _tag: "CollectError", message: /not valid UTF-8.*gone\\xff\.txt/ })
    // APFS refuses a name that is not valid UTF-8, so the untracked file of the Python case needs another file system.
    if (!keepsUndecodableNames) return t.diagnostic("the file system refuses names that are not valid UTF-8; the untracked half did not run")
    writeFileSync(Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0x62, 0x61, 0x64, 0xff]), Buffer.from(".txt")]), "x\n")
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /not valid UTF-8.*bad\\xff\.txt/ })
  })

  test("test_path_removed_from_index_but_kept_on_disk_stops_collection", (t) => {
    // A deletion and an untracked file at one path cannot both be reviewed, and neither alone is the truth.
    const f = new Fixture(t)
    f.commit({ "kept.txt": "k\n" })
    f.git(f.root, "rm", "-q", "--cached", "kept.txt")
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /kept\.txt is removed from Git's index but still on disk/ })
  })

  test("test_assume_unchanged_files_are_compared_by_their_bytes", (t) => {
    const f = new Fixture(t)
    f.commit({ "hidden.txt": "a\n", "gone.txt": "g\n", "same.txt": "s\n" })
    f.git(f.root, "update-index", "--assume-unchanged", "hidden.txt", "gone.txt", "same.txt")
    f.write("hidden.txt", "b\n")
    unlinkSync(join(f.root, "gone.txt"))
    const files = f.collect()
    assert.deepEqual(Object.keys(files).sort(), ["gone.txt", "hidden.txt"])
    assert.equal(files["hidden.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
    assert.equal(files["gone.txt"]?.status, "deleted")
  })

  test("test_a_submodule_marked_assume_unchanged_stays_a_submodule", (t) => {
    const f = new Fixture(t)
    const library = f.init(join(f.base, "library"))
    f.commit({ "lib.txt": "l\n" }, { root: library })
    f.git(f.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "sub")
    f.commit({ "a.txt": "a\n" })
    const subCommit = objectId(f.head(join(f.root, "sub")))
    f.git(f.root, "update-index", "--assume-unchanged", "sub")
    assert.deepEqual(f.collect(), {})
    // Replaced by a file, the hidden submodule is a type change. Its commit is never read as a blob, and the patch
    // shows the file that replaced it.
    rmSync(join(f.root, "sub"), { recursive: true })
    f.write("sub", "now\na file\n")
    const sub = f.collect()["sub"]
    assert.deepEqual([sub?.old_mode, sub?.new_mode, sub?.patch], ["160000", "100644", "@@ -0,0 +1,2 @@\n+now\n+a file\n"])
    const entry = { kind: "file", path: "sub", oldMode: "160000", oldBlob: subCommit, newMode: "100644", newBlob: null, fromIndex: false } as const
    const stats = hiddenStats(openWorktree({ repo: f.root }), entry)
    assert.deepEqual([stats.additions, stats.deletions], [2, 1], "Git counts the submodule side as one line")
  })

  test("test_present_skip_worktree_files_are_compared_by_their_bytes", (t) => {
    const f = new Fixture(t)
    f.commit({ "pinned.txt": "a\n" })
    f.git(f.root, "update-index", "--skip-worktree", "pinned.txt")
    f.write("pinned.txt", "b\n")
    assert.equal(f.collect()["pinned.txt"]?.patch, "@@ -1 +1 @@\n-a\n+b\n")
  })

  test("test_unresolved_merge_conflicts_stop_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ "f.txt": "base\n" })
    f.git(f.root, "checkout", "-q", "-b", "other")
    f.commit({ "f.txt": "other\n" })
    f.git(f.root, "checkout", "-q", "main")
    f.commit({ "f.txt": "mine\n" })
    spawnSync("git", ["merge", "other"], { cwd: f.root })
    f.write("f.txt", "mine\n") // resolved to HEAD's bytes, but not staged
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /unresolved merge conflicts/ })
  })

  test("test_an_assume_unchanged_addition_missing_from_disk_is_no_change", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("new.txt", "n\n")
    f.git(f.root, "add", "new.txt")
    f.git(f.root, "update-index", "--assume-unchanged", "new.txt")
    unlinkSync(join(f.root, "new.txt"))
    assert.deepEqual(f.collect(), {})
  })

  test("test_a_temporary_directory_inside_the_tree_is_refused", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    mkdirSync(join(f.root, "tmp"))
    withEnv({ TMPDIR: join(f.root, "tmp") }, () =>
      assert.throws(() => f.collect(), { _tag: "CollectError", message: /is inside the working tree\. Set TMPDIR elsewhere/ }))
  })

  test("test_a_staged_mode_change_reverted_on_disk_is_named", (t) => {
    const f = new Fixture(t)
    f.commit({ "run.sh": "echo\n" })
    chmodSync(join(f.root, "run.sh"), 0o755)
    f.git(f.root, "add", "run.sh")
    chmodSync(join(f.root, "run.sh"), 0o644)
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.match(out, /would record unreviewed content: run\.sh/)
  })

  test("test_staged_symlinks_that_differ_from_the_working_tree_are_named", (t) => {
    const f = new Fixture(t)
    symlinkSync("a", join(f.root, "link"))
    f.commit({ "keep.txt": "k\n" })
    unlinkSync(join(f.root, "link"))
    symlinkSync("b", join(f.root, "link"))
    f.git(f.root, "add", "link")
    unlinkSync(join(f.root, "link"))
    symlinkSync("c", join(f.root, "link"))
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.match(out, /would record unreviewed content: link/)
  })

  test("test_a_sparse_entry_shown_from_the_index_is_not_named", (t) => {
    const f = new Fixture(t)
    f.commit({ "sparse.txt": "a\n" })
    f.write("sparse.txt", "b\n")
    f.git(f.root, "add", "sparse.txt")
    f.git(f.root, "update-index", "--skip-worktree", "sparse.txt")
    unlinkSync(join(f.root, "sparse.txt"))
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.doesNotMatch(out, /unreviewed content/)
  })

  test("test_a_hidden_symlink_placeholder_stays_a_symlink", (t) => {
    const f = new Fixture(t)
    f.commit({ "keep.txt": "k\n" })
    f.git(f.root, "config", "core.symlinks", "false")
    const target = f.gitInput(f.root, "old", "hash-object", "-w", "--stdin").trim()
    f.git(f.root, "update-index", "--add", "--cacheinfo", `120000,${target},link`)
    f.git(f.root, "commit", "-q", "-m", "link")
    f.git(f.root, "checkout", "--", "link")
    f.git(f.root, "update-index", "--assume-unchanged", "link")
    f.write("link", "new")
    // The placeholder is diffed in place, never read whole into memory: the diff names the file in the tree.
    const diffs: Array<ReadonlyArray<string>> = []
    const link = f.collect({
      trace: (event) => {
        if (event.kind === "git" && event.args.includes("--no-index")) diffs.push(event.args)
      }
    })["link"]
    assert.deepEqual([link?.new_mode, link?.patch_note, link?.additions, link?.deletions], ["120000", "symlink", 1, 1])
    assert.ok(diffs.some((args) => args.at(-1) === join(f.root, "link")), JSON.stringify(diffs))
  })

  test("test_absent_sparse_entries_count_lines_from_the_index_blob", (t) => {
    // A secret file has no patch to recount from, so the stats must come from the staged blob itself.
    const f = new Fixture(t)
    f.commit({ ".gitattributes": "* -diff\n", ".env": "A=1\n" })
    f.write(".env", "A=2\nB=3\n")
    f.git(f.root, "add", ".env")
    f.git(f.root, "update-index", "--skip-worktree", ".env")
    unlinkSync(join(f.root, ".env"))
    const secret = f.collect()[".env"]
    assert.deepEqual([secret?.additions, secret?.deletions, secret?.patch_note], [2, 1, "secret"])
  })

  test("test_inherited_inter_hunk_context_does_not_fuse_hunks", (t) => {
    const f = new Fixture(t)
    const lines = Array.from({ length: 200 }, (_, n) => `line ${n}\n`)
    f.commit({ "long.txt": lines.join("") })
    lines[0] = "first\n"
    lines[199] = "last\n"
    f.write("long.txt", lines.join(""))
    // GIT_CONFIG_COUNT no longer reaches Git at all; a global config file still does, so the option has to win over it.
    const global = join(f.base, "global-config")
    writeFileSync(global, "[diff]\n\tinterHunkContext = 20000\n")
    const patch = withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.interHunkContext", GIT_CONFIG_VALUE_0: "20000",
      GIT_CONFIG_GLOBAL: global }, () => f.collect()["long.txt"]?.patch)
    assert.equal(patch?.split("@@ -").length, 3)
  })

  test("test_hidden_symlink_changes_keep_their_line_counts", (t) => {
    const f = new Fixture(t)
    symlinkSync("old", join(f.root, "link"))
    f.commit({ "keep.txt": "k\n" })
    f.git(f.root, "update-index", "--assume-unchanged", "link")
    unlinkSync(join(f.root, "link"))
    symlinkSync("new", join(f.root, "link"))
    const link = f.collect()["link"]
    assert.deepEqual([link?.additions, link?.deletions, link?.patch_note], [1, 1, "symlink"])
  })

  test("test_absent_sparse_symlinks_are_read_from_the_index", (t) => {
    const f = new Fixture(t)
    symlinkSync("a", join(f.root, "link"))
    f.commit({ "keep.txt": "k\n" })
    unlinkSync(join(f.root, "link"))
    symlinkSync("b", join(f.root, "link"))
    f.git(f.root, "add", "link")
    f.git(f.root, "update-index", "--skip-worktree", "link")
    unlinkSync(join(f.root, "link"))
    const link = f.collect()["link"]
    const staged = objectId(f.git(f.root, "rev-parse", ":link").trim())
    assert.deepEqual([link?.status, link?.new_mode, link?.patch_note, link?.additions, link?.deletions],
      ["modified", "120000", "symlink", 1, 1])
    assert.equal(link?.fingerprint, fileFingerprint({
      path: "link", oldPath: null, oldBlob: blob("a"), newBlob: staged, oldMode: "120000", newMode: "120000"
    }))
  })

  test("test_hidden_files_keep_the_index_mode_when_file_modes_are_off", (t) => {
    const f = new Fixture(t)
    f.commit({ "plain.txt": "a\n" })
    f.git(f.root, "config", "core.filemode", "false")
    f.git(f.root, "update-index", "--assume-unchanged", "plain.txt")
    f.write("plain.txt", "b\n")
    chmodSync(join(f.root, "plain.txt"), 0o755)
    const plain = f.collect()["plain.txt"]
    assert.deepEqual([plain?.old_mode, plain?.new_mode], ["100644", "100644"])
  })

  test("test_hidden_files_without_a_patch_keep_their_stats", (t) => {
    const f = new Fixture(t)
    f.commit({ ".env": "A=1\n" })
    f.git(f.root, "update-index", "--assume-unchanged", ".env")
    f.write(".env", "A=2\nB=3\n")
    const secret = f.collect()[".env"]
    assert.deepEqual([secret?.patch_note, secret?.additions, secret?.deletions], ["secret", 2, 1])
  })

  test("test_a_staged_deletion_with_the_file_kept_on_disk_is_named", (t) => {
    const f = new Fixture(t)
    f.commit({ "old.txt": Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("") })
    f.git(f.root, "mv", "old.txt", "new.txt")
    copyFileSync(join(f.root, "new.txt"), join(f.root, "old.txt"))
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.match(out, /would record unreviewed content: old\.txt/)
  })

  test("test_a_staged_link_replaced_by_a_file_with_the_same_bytes_is_named", (t) => {
    const f = new Fixture(t)
    symlinkSync("foo", join(f.root, "link"))
    f.commit({ "keep.txt": "k\n" })
    unlinkSync(join(f.root, "link"))
    symlinkSync("bar", join(f.root, "link"))
    f.git(f.root, "add", "link")
    unlinkSync(join(f.root, "link"))
    f.write("link", "bar")
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.match(out, /would record unreviewed content: link/)
  })

  test("test_attribute_binary_text_keeps_real_stats_without_a_patch", (t) => {
    const f = new Fixture(t)
    f.commit({ ".gitattributes": "* -diff\n", ".env.local": "A=1\n" })
    f.write(".env.local", "A=2\nB=3\n")
    const secret = f.collect()[".env.local"]
    assert.deepEqual([secret?.patch_note, secret?.additions, secret?.deletions], ["secret", 2, 1])
  })

  test("test_untracked_files_honor_core_filemode", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.git(f.root, "config", "core.filemode", "false")
    f.write("run.sh", "echo\n")
    chmodSync(join(f.root, "run.sh"), 0o755)
    assert.equal(f.collect()["run.sh"]?.new_mode, "100644")
  })

  test("test_a_hidden_file_replaced_by_a_directory_is_a_deletion", (t) => {
    const f = new Fixture(t)
    f.commit({ thing: "t\n" })
    f.git(f.root, "update-index", "--assume-unchanged", "thing")
    unlinkSync(join(f.root, "thing"))
    f.write("thing/inside.txt", "i\n")
    const files = f.collect()
    assert.deepEqual([files["thing"]?.status, files["thing/inside.txt"]?.status], ["deleted", "added"])
  })

  test("test_hidden_file_stats_stream_the_old_blob", (t) => {
    const f = new Fixture(t)
    f.commit({ "big.txt": "x\n".repeat(1000) })
    f.git(f.root, "update-index", "--assume-unchanged", "big.txt")
    f.write("big.txt", "y\n")
    const captured: Array<number> = []
    const big = f.collect({
      limits: { patchUnits: 16 },
      trace: (event) => {
        if (event.kind === "git" && event.args.includes("blob")) captured.push(event.stdout.length)
      }
    })["big.txt"]
    assert.deepEqual([big?.patch_note, big?.additions, big?.deletions], ["too_large", 1, 1000])
    assert.ok(captured.length > 0 && captured.every((length) => length === 0), "the old blob was read into memory")
  })

  test("test_an_assumed_rename_target_that_vanishes_leaves_the_source_deleted", (t) => {
    const f = new Fixture(t)
    f.commit({ "old.txt": "o\n" })
    f.git(f.root, "mv", "old.txt", "new.txt")
    f.git(f.root, "update-index", "--assume-unchanged", "new.txt")
    unlinkSync(join(f.root, "new.txt"))
    const files = f.collect()
    assert.deepEqual(Object.keys(files), ["old.txt"])
    assert.equal(files["old.txt"]?.status, "deleted")
  })

  test("test_a_case_only_rename_without_case_folding_is_a_deletion_and_an_addition",
    { skip: foldsCase && "core.ignoreCase=false on a file system that folds case misleads Git; this case needs one that does not" },
    (t) => {
      const f = new Fixture(t)
      f.commit({ "foo.txt": "f\n" })
      f.git(f.root, "config", "core.ignoreCase", "false")
      renameSync(join(f.root, "foo.txt"), join(f.root, "FOO.txt"))
      assert.deepEqual(statuses(f.collect()), { "FOO.txt": "added", "foo.txt": "deleted" })
    })

  test("test_hidden_entries_behind_a_file_are_deletions", (t) => {
    const f = new Fixture(t)
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      if (lstatSync(join(f.root, "dir"), { throwIfNoEntry: false })?.isFile()) {
        unlinkSync(join(f.root, "dir"))
        f.git(f.root, "checkout", "--", "dir")
      }
      f.commit({ "dir/child": "c\n", "keep.txt": "k\n" })
      f.git(f.root, "update-index", flag, "dir/child")
      rmSync(join(f.root, "dir"), { recursive: true })
      f.write("dir", "now a file\n")
      const files = f.collect()
      assert.deepEqual([files["dir/child"]?.status, files["dir"]?.status], ["deleted", "added"], flag)
      f.git(f.root, "update-index", "--no-assume-unchanged", "--no-skip-worktree", "dir/child")
    }
  })

  test("test_hidden_entries_behind_a_symlinked_directory_are_deletions", (t) => {
    const f = new Fixture(t)
    const outside = join(f.base, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "file"), "outside the tree\n")
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      if (lstatSync(join(f.root, "dir"), { throwIfNoEntry: false })?.isSymbolicLink()) {
        unlinkSync(join(f.root, "dir"))
        f.git(f.root, "checkout", "--", "dir")
      }
      f.commit({ "dir/file": "a\n", "keep.txt": "k\n" })
      f.git(f.root, "update-index", flag, "dir/file")
      rmSync(join(f.root, "dir"), { recursive: true })
      symlinkSync(outside, join(f.root, "dir"))
      const files = f.collect()
      assert.deepEqual([files["dir/file"]?.status, files["dir"]?.new_mode], ["deleted", "120000"], flag)
      assert.doesNotMatch(JSON.stringify(f.review), /outside the tree/)
      f.git(f.root, "update-index", "--no-assume-unchanged", "--no-skip-worktree", "dir/file")
    }
  })

  test("test_the_divergence_check_reads_only_staged_index_entries", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n", "b.txt": "b\n" })
    const calls: Array<ReadonlyArray<string>> = []
    const worktree = openWorktree({
      repo: f.root,
      trace: (event: CollectEvent) => {
        if (event.kind === "git") calls.push(event.args)
      }
    })
    calls.length = 0
    assert.deepEqual(stagedDifferently(worktree), [])
    assert.deepEqual(calls.filter((args) => args.includes("ls-files")), [], "nothing is staged, so the index is not read")
    f.write("a.txt", "staged\n")
    f.git(f.root, "add", "a.txt")
    f.write("a.txt", "on disk\n")
    calls.length = 0
    assert.deepEqual(stagedDifferently(worktree), ["a.txt"])
    const listings = calls.filter((args) => args.includes("ls-files"))
    assert.ok(listings.length > 0 && listings.every((args) => args.slice(-2).join(" ") === "-- a.txt"), JSON.stringify(listings))
  })

  test("test_a_case_only_rename_hidden_by_ignore_case_stops_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ foo: "f\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    renameSync(join(f.root, "foo"), join(f.root, "FOO"))
    // A file system that folds case finds foo under its new spelling, so Git hides nothing and a commit records no change.
    if (foldsCase) return assert.deepEqual(f.collect(), {})
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /renamed by case only/ })
  })

  test("test_a_case_only_directory_rename_hidden_by_ignore_case_stops_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ "dir/file": "f\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    renameSync(join(f.root, "dir"), join(f.root, "DIR"))
    if (foldsCase) return assert.deepEqual(f.collect(), {})
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /dir\/file was renamed by case only/ })
  })

  test("test_a_case_renamed_directory_is_found_beside_its_old_spelling", { skip: foldsCase && caseFoldingNote }, (t) => {
    const f = new Fixture(t)
    f.commit({ "dir/file": "f\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    renameSync(join(f.root, "dir"), join(f.root, "DIR"))
    mkdirSync(join(f.root, "dir")) // the old spelling remains, empty
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /dir\/file was renamed by case only/ })
  })

  test("test_names_that_differ_beyond_ascii_case_are_not_case_renames", (t) => {
    const f = new Fixture(t)
    f.commit({ "straße": "s\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    renameSync(join(f.root, "straße"), join(f.root, "STRASSE"))
    // A file system that folds ß to ss still finds straße, but Git folds only ASCII, so STRASSE is a new file to it.
    const oneName = lstatSync(join(f.root, "straße"), { throwIfNoEntry: false }) !== undefined
    assert.deepEqual(statuses(f.collect()), oneName ? { STRASSE: "added" } : { STRASSE: "added", "straße": "deleted" })
  })

  test("test_a_vanished_staged_file_that_replaced_a_directory_is_no_change", (t) => {
    const f = new Fixture(t)
    f.commit({ "dir/child": "c\n", "keep.txt": "k\n" })
    f.git(f.root, "rm", "-q", "-r", "dir")
    f.write("dir", "now a file\n")
    f.git(f.root, "add", "dir")
    f.git(f.root, "update-index", "--assume-unchanged", "dir")
    unlinkSync(join(f.root, "dir"))
    assert.deepEqual(statuses(f.collect()), { "dir/child": "deleted" })
  })

  test("test_a_hidden_staged_addition_renamed_by_case_stops_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ "keep.txt": "k\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    f.write("foo", "f\n")
    f.git(f.root, "add", "foo")
    f.git(f.root, "update-index", "--assume-unchanged", "foo")
    renameSync(join(f.root, "foo"), join(f.root, "FOO"))
    // A file system that folds case still finds foo, and its bytes are what a commit records.
    if (foldsCase) return assert.deepEqual(statuses(f.collect()), { foo: "added" })
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /foo was renamed by case only/ })
  })

  test("test_too_many_tracked_changes_stop_before_reading_the_rest", (t) => {
    const f = new Fixture(t)
    f.commit(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, "a\n"])))
    for (let i = 0; i < 6; i++) f.write(`f${i}.txt`, "b\n")
    let reads = 0
    assert.throws(() =>
      f.collect({
        limits: { files: 2 },
        trace: (event) => {
          if (event.kind === "read") reads += 1
        }
      }), { _tag: "CollectError", message: /^3 changed files exceed the review limit of 2/ })
    assert.equal(reads, 3)
  })

  test("test_an_absent_sparse_entry_with_an_undecodable_name_is_ignored", (t) => {
    // The entry is built in the index alone, which every file system allows, and it is absent from disk anyway.
    const f = new Fixture(t)
    f.commit({ "keep.txt": "k\n" })
    const name = Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74])
    f.stageRaw(name, "x\n")
    f.git(f.root, "commit", "-q", "-m", "undecodable")
    f.gitInput(f.root, Buffer.concat([name, Buffer.from([0])]), "update-index", "-z", "--skip-worktree", "--stdin")
    f.write("keep.txt", "changed\n")
    assert.deepEqual(Object.keys(f.collect()), ["keep.txt"])
  })

  test("test_invisible_and_reordering_characters_are_shown_replaced", (t) => {
    const f = new Fixture(t)
    f.commit({ "text.txt": "plain\n" })
    f.write("text.txt", "next\u0085line \u202eevil\u202c and \u2028 here\n")
    const text = f.collect()["text.txt"]
    assert.equal(text?.patch_note, "replaced_characters")
    assert.ok(text?.patch?.includes("next\ufffdline \ufffdevil\ufffd and \ufffd here"))
  })

  test("test_a_new_file_beside_a_tracked_one_differing_in_case_stops_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ foo: "f\n" })
    f.git(f.root, "config", "core.ignoreCase", "true")
    f.write("FOO", "a different file\n")
    // On a file system that folds case, writing FOO rewrites foo.
    if (foldsCase) return assert.deepEqual(statuses(f.collect()), { foo: "modified" })
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /FOO differs from tracked foo only in case/ })
  })

  // Not in the Python suite, whose same-file check followed links: twins are separate names even when they share a file.
  test("case twins that link to one file still stop collection", { skip: foldsCase && caseFoldingNote }, (t) => {
    const f = new Fixture(t)
    f.commit({ target: "t\n" })
    symlinkSync("target", join(f.root, "foo"))
    f.commit()
    f.git(f.root, "config", "core.ignoreCase", "true")
    symlinkSync("target", join(f.root, "FOO"))
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /^FOO differs from tracked foo only in case/ })
    const linked = f.init(join(f.base, "linked"))
    f.commit({ bar: "b\n" }, { root: linked })
    f.git(linked, "config", "core.ignoreCase", "true")
    linkSync(join(linked, "bar"), join(linked, "BAR"))
    assert.throws(() => f.collect({ repo: linked }), { _tag: "CollectError", message: /^BAR differs from tracked bar only in case/ })
  })

  test("test_many_long_hidden_paths_fit", (t) => {
    const f = new Fixture(t)
    const names = Array.from({ length: 300 }, (_, i) => `${"d".repeat(200)}/${String(i).padStart(4, "0")}-${"n".repeat(150)}.txt`)
    f.commit(Object.fromEntries(names.map((name) => [name, "x\n"])))
    for (let start = 0; start < names.length; start += 50) {
      f.git(f.root, "update-index", "--assume-unchanged", ...names.slice(start, start + 50))
    }
    f.write(names[0] ?? "", "y\n")
    let longest = 0
    const files = f.collect({
      trace: (event) => {
        if (event.kind === "git") longest = Math.max(longest, event.args.length)
      }
    })
    assert.deepEqual(Object.keys(files), [names[0]])
    assert.ok(longest <= 260, `one command carried ${longest} arguments`)
  })

  test("test_a_failure_after_collecting_writes_nothing", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    const output = join(f.base, "review.json")
    const { code } = f.main({
      output,
      trace: (event) => {
        if (event.kind === "staged-scan") throw new GitError({ message: "late failure" })
      }
    })
    assert.equal(code, 2)
    assert.equal(lstatSync(output, { throwIfNoEntry: false }), undefined)
  })

  test("test_a_staged_version_that_differs_from_the_working_tree_is_named", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    f.git(f.root, "add", "a.txt")
    f.write("a.txt", "a\n")
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.ok(out.includes("Staged version differs from the reviewed file, so a commit would record unreviewed content: a.txt"), out)
  })

  test("test_staged_skip_worktree_entry_reads_the_index", (t) => {
    const f = new Fixture(t)
    f.commit({ "sparse.txt": "a\n" })
    f.write("sparse.txt", "b\n")
    f.git(f.root, "add", "sparse.txt")
    f.git(f.root, "update-index", "--skip-worktree", "sparse.txt")
    unlinkSync(join(f.root, "sparse.txt"))
    const files = f.collect()
    assert.deepEqual([files["sparse.txt"]?.status, files["sparse.txt"]?.patch], ["modified", "@@ -1 +1 @@\n-a\n+b\n"])
  })

  test("test_nested_repository_without_a_commit_stops_collection", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.init(join(f.root, "nested"))
    f.write("nested/file.txt", "x\n")
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /nested is a nested repository or submodule with no commit/ })
  })
})

// Not in the Python suite: an untouched file whose timestamps changed is not a change, and the index is never rewritten.
test("a stat-only change is no change and leaves the index alone", (t) => {
  const f = new Fixture(t)
  f.commit({ "a.txt": "a\n" })
  utimesSync(join(f.root, "a.txt"), 1, 1)
  const index = lstatSync(join(f.root, ".git", "index")).mtimeMs
  assert.deepEqual(f.collect(), {})
  assert.equal(lstatSync(join(f.root, ".git", "index")).mtimeMs, index)
})

// Not in the Python suite: names Git allows that review input cannot carry stop collection with the name, before the
// schema sees them. The tracked ones live in the index alone, so no file system has to hold them.
test("a path review input cannot represent stops collection and names the path", (t) => {
  const f = new Fixture(t)
  f.commit({ "keep.txt": "k\n" })
  f.write(" ", "only a space in the name\n")
  assert.throws(() => f.collect(), { _tag: "CollectError", message: /^review input cannot represent the path " ": must not be empty$/ })
  for (const [name, reason] of [["a\x01b", /"a\\u0001bx": contains a control character/], ["d/".repeat(2100), /exceeds 4096 UTF-16 code units/]] as const) {
    const repo = f.init(join(f.base, `tracked-${reason.source.length}`))
    f.commit({ "keep.txt": "k\n" }, { root: repo })
    f.stageRaw(Buffer.from(`${name}x`), "x\n", repo)
    f.git(repo, "commit", "-q", "-m", "unrepresentable") // deleted on disk, so the diff names it
    assert.throws(() => f.collect({ repo }), { _tag: "CollectError", message: reason })
  }
})
