// Ported from LimitTests, SecretTests, ConsistencyTests, HeadTests, and OutputTests in tests/test_collect_worktree.py.
// Each test keeps its Python name. Python's main() is the collector command, which step 6 builds; Fixture.main runs the
// same steps through the library: check the output, collect, write, and report.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test, type TestContext } from "node:test"
import { ATTEMPTS } from "./collect.ts"
import { SECRET_TEXT, secretName } from "./patch.ts"
import { Fixture, GITHUB_TOKEN, PRIVATE_KEY } from "./testing.ts"
import { decodeBytes, decodeValue, encodeDocument, WorktreeInputDocument } from "../schema/document.ts"
import type { WorktreeInput } from "../schema/input.ts"
import { accepted } from "../schema/testing.ts"

/** Reads written input back through the strict decoder, as the server will. */
const readReview = (path: string): WorktreeInput => accepted(decodeBytes(WorktreeInputDocument, readFileSync(path)))
const byPath = (review: WorktreeInput) => Object.fromEntries(review.files.map((file) => [file.path, file]))

const stateDirectoryNote = "Not applicable: review state moves from STATE/rounds/NNNN directories to the server's SQLite " +
  "store (Decisions: Storage), so the collector never writes into a state directory and has no round to guard."

describe("LimitTests", () => {
  const fixture = (t: TestContext) => {
    const f = new Fixture(t)
    f.commit({ "base.txt": "b\n" })
    return f
  }

  test("test_patch_over_the_line_limit_keeps_the_entry", (t) => {
    const f = fixture(t)
    f.write("big.txt", Array.from({ length: 5 }, (_, i) => `${i}\n`).join(""))
    f.write("small.txt", "1\n")
    const files = f.collect({ limits: { patchLines: 3 } })
    const big = files["big.txt"]
    assert.deepEqual([big?.patch_note, big?.patch_complete, big?.additions], ["too_large", false, 5])
    assert.ok(big && !("patch" in big))
    assert.equal(files["small.txt"]?.patch, "@@ -0,0 +1 @@\n+1\n")
  })

  test("test_total_patch_lines_are_counted_in_output_order", (t) => {
    const f = fixture(t)
    f.write("a.txt", "1\n2\n")
    f.write("b.txt", "1\n2\n")
    f.write("c.txt", "1\n")
    const files = f.collect({ limits: { totalPatchLines: 5 } })
    assert.equal(files["a.txt"]?.patch_complete, true)
    assert.deepEqual([files["b.txt"]?.patch_note, files["b.txt"]?.patch_complete], ["too_large", false])
    assert.equal(files["c.txt"]?.patch_complete, true)
  })

  test("test_patch_over_the_character_limit_and_a_huge_untracked_file", (t) => {
    const f = fixture(t)
    f.write("base.txt", `b\n${"x".repeat(40)}\n`)
    f.write("huge.txt", "123456789\n".repeat(100))
    const files = f.collect({ limits: { patchUnits: 16 } })
    for (const path of ["base.txt", "huge.txt"]) {
      assert.deepEqual([files[path]?.patch_note, files[path]?.patch_complete], ["too_large", false], path)
    }
    assert.equal(files["huge.txt"]?.additions, 100)
  })

  test("test_old_side_size_is_checked_before_reading_it", (t) => {
    const f = fixture(t)
    f.commit({ "long.txt": `${"x".repeat(200)}\n`, "shrink.txt": `${"y".repeat(200)}\n` })
    unlinkSync(join(f.root, "long.txt"))
    f.write("shrink.txt", "z\n")
    const outputs: Array<Buffer> = []
    const files = f.collect({
      limits: { patchUnits: 16 },
      trace: (event) => {
        if (event.kind === "git") outputs.push(event.stdout)
      }
    })
    for (const path of ["long.txt", "shrink.txt"]) {
      assert.deepEqual([files[path]?.patch_note, files[path]?.patch_complete], ["too_large", false], path)
    }
    // Neither 200-byte old side was read or diffed into memory; only its size was asked for.
    assert.deepEqual(outputs.filter((output) => output.includes("x".repeat(100)) || output.includes("y".repeat(100))), [])
  })

  test("test_too_many_files_is_an_error", (t) => {
    const f = fixture(t)
    for (const name of ["a", "b", "c"]) f.write(name, "x\n")
    assert.throws(() => f.collect({ limits: { files: 2 } }),
      { _tag: "CollectError", message: /3 changed files exceed the review limit of 2/ })
  })
})

describe("SecretTests", () => {
  const fixture = (t: TestContext) => {
    const f = new Fixture(t)
    f.commit({ "config.txt": "name = demo\n" })
    f.write(".env.local", "API_TOKEN=hunter2-very-secret\n")
    f.write(".env.example", "API_TOKEN=\n")
    f.write("config.txt", `name = demo\n${PRIVATE_KEY}`)
    f.write("notes.md", `token ${GITHUB_TOKEN}\n`)
    f.write("deploy/id_ed25519", "key material\n")
    f.write("deploy/id_ed25519.pub", "ssh-ed25519 AAAA\n")
    return f
  }

  test("test_likely_secrets_are_flagged_and_absent_from_the_output_file", (t) => {
    const f = fixture(t)
    const output = join(f.base, "review.json")
    const { code, out } = f.main({ output })
    assert.equal(code, 0)
    const data = readFileSync(output)
    for (const secret of ["hunter2-very-secret", "key material", GITHUB_TOKEN, "MIIBsecretbody"]) {
      assert.ok(!data.includes(secret), secret)
    }
    const files = byPath(readReview(output))
    const flagged = [".env.local", "config.txt", "deploy/id_ed25519", "notes.md"]
    assert.deepEqual(Object.entries(files).filter(([, file]) => file.patch_note === "secret").map(([path]) => path).sort(), flagged)
    assert.equal(files[".env.local"]?.additions, 1)
    assert.equal(files["config.txt"]?.status, "modified")
    assert.ok("patch" in (files[".env.example"] ?? {}))
    assert.ok("patch" in (files["deploy/id_ed25519.pub"] ?? {}))
    assert.deepEqual(out.split("\n").slice(0, -1), [
      `Wrote ${output} (6 files; 0 binary; 0 too large; 4 likely secret)`,
      ...flagged.map((path) => `Likely secret, contents left out: ${path}`)
    ])
  })

  test("test_a_secret_under_a_directory_that_replaced_a_file_stays_out", (t) => {
    const f = fixture(t)
    f.commit({ settings: "plain\n" })
    f.git(f.root, "rm", "-q", "settings")
    f.write("settings/.env", "DB_PASSWORD=super-secret-value\n")
    f.git(f.root, "add", "settings/.env")
    const output = join(f.base, "review.json")
    const { code, out } = f.main({ output })
    assert.equal(code, 0)
    const files = byPath(readReview(output))
    assert.equal(files["settings"]?.patch, "@@ -1 +0,0 @@\n-plain\n")
    assert.equal(files["settings/.env"]?.patch_note, "secret")
    assert.ok(!readFileSync(output).includes("super-secret-value"))
    assert.ok(out.includes("Likely secret, contents left out: settings/.env"), out)
  })

  test("test_include_secret_file_restores_one_file", (t) => {
    const f = fixture(t)
    const files = f.collect({ includeSecret: [".env.local"] })
    assert.equal(files[".env.local"]?.patch, "@@ -0,0 +1 @@\n+API_TOKEN=hunter2-very-secret\n")
    assert.ok(!("patch_note" in (files[".env.local"] ?? {})))
    assert.deepEqual(f.flagged, ["config.txt", "deploy/id_ed25519", "notes.md"])
  })

  test("test_include_secret_file_must_name_a_changed_file", (t) => {
    const f = fixture(t)
    assert.throws(() => f.collect({ includeSecret: ["missing.env"] }), { _tag: "CollectError", message: /not a changed file: missing\.env/ })
    const { code, err } = f.main({ output: join(f.base, "review.json"), includeSecret: ["missing.env"] })
    assert.equal(code, 2)
    assert.match(err, /^Error: .*not a changed file: missing\.env\n$/)
  })

  test("test_secret_names_and_patterns", () => {
    for (const name of [".env", "app/.ENV.production", "server.pem", "tls.key", "id_rsa", "credentials.json", ".npmrc", "_netrc"]) {
      assert.ok(secretName(name), name)
    }
    for (const name of [".env.example", ".env.local.sample", "id_rsa.pub", "environment.py", "key.txt", "credentials.md"]) {
      assert.ok(!secretName(name), name)
    }
    for (const text of ["AKIA" + "ABCDEFGHIJKLMNOP", "xox" + "b-1234567890-abc", "x=sk-" + "ant-" + "a".repeat(24),
      "sk-" + "proj-" + "B".repeat(30), "github_" + "pat_" + "a".repeat(30), GITHUB_TOKEN, PRIVATE_KEY]) {
      assert.match(text, SECRET_TEXT)
    }
    for (const text of ["task-" + "a".repeat(30), "AKIA" + "short", "gh" + "p_short"]) assert.doesNotMatch(text, SECRET_TEXT)
    // Python's \b counts any Unicode letter or digit as part of a word, so a key glued to one is not a token.
    assert.doesNotMatch("é" + "AKIA" + "ABCDEFGHIJKLMNOP", SECRET_TEXT)
    const directory = new URL(".", import.meta.url)
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      assert.doesNotMatch(readFileSync(new URL(name, directory), "utf8"), SECRET_TEXT, name)
    }
  })
})

describe("ConsistencyTests", () => {
  const fixture = (t: TestContext) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "first\n")
    return f
  }

  test("test_change_between_reads_triggers_a_successful_retry", (t) => {
    const f = fixture(t)
    let calls = 0
    const files = f.collect({
      trace: (event) => {
        if (event.kind !== "between-reads") return
        calls += 1
        if (calls === 1) f.write("a.txt", "second\n")
      }
    })
    assert.equal(calls, 2)
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+second\n")
  })

  test("test_an_edit_restored_before_the_second_read_cannot_mix_versions", (t) => {
    // The first inventory hashes "first". The patch's own read then sees an intruder, which is gone again before the
    // confirming inventory, so only the patch's check against the fingerprint can catch it. The intruder has the same
    // size as "first", so the blob comparison catches it, not the size.
    const f = fixture(t)
    let reads = 0
    const files = f.collect({
      trace: (event) => {
        if (event.kind !== "read" || event.path !== "a.txt") return
        reads += 1
        if (reads === 2) f.write("a.txt", "intru\n")
        if (reads === 3) f.write("a.txt", "first\n")
      }
    })
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1 @@\n-a\n+first\n")
    assert.doesNotMatch(JSON.stringify(f.review), /intru/)
  })

  test("test_change_on_every_attempt_fails", (t) => {
    const f = fixture(t)
    let calls = 0
    assert.throws(() =>
      f.collect({
        trace: (event) => {
          if (event.kind !== "between-reads") return
          calls += 1
          f.write("a.txt", `${"x".repeat(calls)}\n`)
        }
      }), { _tag: "CollectError", message: /kept changing.*Collect again when writes finish/ })
    assert.equal(calls, ATTEMPTS)
  })
})

describe("HeadTests", () => {
  // Not in the Python suite, which decoded the branch with replacement characters.
  test("a branch name that is not valid UTF-8 stops collection with the escaped name", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    if (f.git(f.root, "rev-parse", "--show-ref-format").trim() !== "files") return t.skip("needs the files ref backend")
    // Written as file contents, since a loose ref would need a file name that APFS refuses.
    const branch = Buffer.concat([Buffer.from("refs/heads/topic-"), Buffer.from([0xff])])
    writeFileSync(join(f.root, ".git", "packed-refs"), Buffer.concat([Buffer.from(`${f.head()} `), branch, Buffer.from("\n")]))
    writeFileSync(join(f.root, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: "), branch, Buffer.from("\n")]))
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /^the branch topic-\\xff is not valid UTF-8/ })
  })

  test("test_unborn_head_needs_a_first_commit", (t) => {
    const f = new Fixture(t)
    f.write("a.txt", "a\n")
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /no commit yet\. Make a first commit/ })
  })

  test("test_detached_head_omits_branch", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.git(f.root, "checkout", "-q", "--detach")
    f.write("a.txt", "b\n")
    f.collect()
    assert.ok(f.review && !("branch" in f.review.target))
    assert.equal(f.review?.target.title, `Uncommitted changes at ${f.head().slice(0, 7)}`)
  })
})

describe("OutputTests", () => {
  const fixture = (t: TestContext) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    return f
  }

  test("test_refuses_output_inside_the_working_tree", (t) => {
    const f = fixture(t)
    const { code, err } = f.main({ output: join(f.root, "review.json") })
    assert.equal(code, 2)
    assert.match(err, /^Error: .* is inside the working tree/)
    assert.equal(lstatSync(join(f.root, "review.json"), { throwIfNoEntry: false }), undefined)
  })

  test("test_only_a_round_input_is_written_in_a_state_directory", { skip: stateDirectoryNote }, () => {})

  test("test_output_works_where_ownership_cannot_be_read", {
    skip: "Not applicable: the Python case removes os.getuid as on Windows, and the state directory check that read " +
      "ownership is gone; the server supports only Linux and macOS (Decisions: Platforms)."
  }, () => {})

  test("test_a_shared_ancestor_with_rounds_is_not_a_state_directory", { skip: stateDirectoryNote }, () => {})

  test("test_refuses_git_files_as_output", (t) => {
    const f = fixture(t)
    const head = readFileSync(join(f.root, ".git", "HEAD"))
    for (const name of ["HEAD", "config", "review.json"]) {
      const { code, err } = f.main({ output: join(f.root, ".git", name) })
      assert.equal(code, 2, name)
      assert.ok(err.includes("is inside the Git directory, where it could replace Git's own files"), err)
    }
    assert.deepEqual(readFileSync(join(f.root, ".git", "HEAD")), head)
    assert.equal(lstatSync(join(f.root, ".git", "review.json"), { throwIfNoEntry: false }), undefined)
  })

  test("test_a_worktree_setting_that_leads_to_another_repository_is_refused", (t) => {
    const f = fixture(t)
    const other = f.init(join(f.base, "other"))
    f.commit({ "theirs.txt": "t\n" }, { root: other })
    f.write("theirs.txt", "changed\n", other)
    f.git(f.root, "config", "core.worktree", other)
    assert.throws(() => f.collect(), { _tag: "CollectError", message: /sets core\.worktree to .*another repository/ })
  })

  test("test_errors_escape_control_characters_in_paths", (t) => {
    const f = fixture(t)
    const nested = join(f.root, "evil\nWrote trusted.json")
    mkdirSync(nested)
    execFileSync("git", ["init", "-q", nested]) // a nested repository with no commit
    const { code, err } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 2)
    assert.ok(err.includes("evil\\nWrote trusted.json"), err)
    assert.equal(err.split("\n").length - 1, 1, "the error stays one line")
  })

  test("test_the_written_path_prints_escaped", (t) => {
    const f = fixture(t)
    const { code, out } = f.main({ output: join(f.base, "review\nforged.json") })
    assert.equal(code, 0)
    assert.ok(out.startsWith(`Wrote "${f.base}/review\\nforged.json" (`), out)
  })

  test("test_a_change_during_the_staged_scan_is_collected_again", (t) => {
    const f = fixture(t)
    const output = join(f.base, "review.json")
    let calls = 0
    const { code, err } = f.main({
      output,
      trace: (event) => {
        if (event.kind !== "staged-scan") return
        calls += 1
        if (calls === 1) f.write("a.txt", "second\n") // the file changes while the staged versions are read
      }
    })
    assert.equal(code, 0, err)
    assert.equal(calls, 2, "the inventory after the scan caught the change and collected again")
    assert.ok(readReview(output).files[0]?.patch?.includes("+second"))
  })

  test("test_a_staging_change_during_collection_is_collected_again", (t) => {
    const f = fixture(t)
    f.write("a.txt", "b\n")
    f.git(f.root, "add", "a.txt") // the index matches the reviewed file
    const staged = f.gitInput(f.root, "c\n", "hash-object", "-w", "--stdin").trim()
    let calls = 0
    const { code, out, err } = f.main({
      output: join(f.base, "review.json"),
      trace: (event) => {
        if (event.kind !== "staged-scan") return
        calls += 1
        // Another process stages different content without touching the file.
        if (calls === 1) f.git(f.root, "update-index", "--cacheinfo", `100644,${staged},a.txt`)
      }
    })
    assert.equal(code, 0, err)
    assert.equal(calls, 2, "the index change was caught and collection ran again")
    assert.ok(out.includes("Staged version differs from the reviewed file, so a commit would record unreviewed content: a.txt"), out)
  })

  test("test_notices_escape_control_characters_in_paths", (t) => {
    const f = fixture(t)
    f.write("a\nLikely secret, contents left out: forged/.env", "A=1\n")
    const { code, out } = f.main({ output: join(f.base, "review.json") })
    assert.equal(code, 0)
    assert.ok(out.includes('Likely secret, contents left out: "a\\nLikely secret, contents left out: forged/.env"\n'), out)
    assert.ok(!out.includes("\nLikely secret, contents left out: forged/.env\n"), out)
  })

  test("test_refuses_a_symlinked_output", (t) => {
    const f = fixture(t)
    const outside = join(f.base, "outside.json")
    symlinkSync(outside, join(f.root, "review.json"))
    const { code, err } = f.main({ output: join(f.root, "review.json") })
    assert.equal(code, 2)
    assert.ok(err.includes("is a symbolic link"), err)
    assert.ok(lstatSync(join(f.root, "review.json")).isSymbolicLink())
    assert.equal(lstatSync(outside, { throwIfNoEntry: false }), undefined)
  })

  test("test_writes_private_valid_output_inside_the_git_directory", (t) => {
    // The Python case writes into the state directory inside the Git directory. State now lives in the server's store,
    // so the whole Git directory is refused (see test_refuses_git_files_as_output), and this case checks the same
    // private, complete, valid output written outside the repository. Rendering it is the page's job (step 5).
    const f = fixture(t)
    const output = join(f.base, "out", "review.json")
    mkdirSync(join(f.base, "out"))
    const { code, out } = f.main({ output })
    assert.equal(code, 0)
    assert.equal(out, `Wrote ${output} (1 file; 0 binary; 0 too large; 0 likely secret)\n`)
    assert.equal(statSync(output).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(f.base, "out")), ["review.json"])
    assert.deepEqual(Object.keys(f.collect()), ["a.txt"]) // the snapshot is not a change itself
    assert.deepEqual(readReview(output), f.review)
  })

  test("test_cli_end_to_end", (t) => {
    // The command-line tool is step 6. This case runs the same steps with a title, and a directory outside Git.
    const f = fixture(t)
    const output = join(f.base, "review.json")
    const result = f.main({ output, title: "Check" })
    assert.deepEqual([result.code, result.err], [0, ""])
    assert.equal(result.out, `Wrote ${output} (1 file; 0 binary; 0 too large; 0 likely secret)\n`)
    const review = readReview(output)
    assert.deepEqual([review.target.title, review.files[0]?.patch], ["Check", "@@ -1 +1 @@\n-a\n+b\n"])
    const plain = join(f.base, "plain")
    mkdirSync(plain)
    const failed = f.main({ output, repo: plain })
    assert.equal(failed.code, 2)
    assert.ok(failed.err.startsWith("Error: not a git repository"), failed.err)
  })
})

// Not in the Python suite, which validated with render_review.py: the step 1 schema is the contract now.
describe("Schema", () => {
  test("the collector's output round-trips through WorktreeInputDocument", (t) => {
    const f = new Fixture(t)
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("")
    symlinkSync("target", join(f.root, "link"))
    f.commit({ "edit.txt": "a\n", "old.txt": lines, "gone.txt": "g\n", "run.sh": "r\n", "big.txt": "b\n" })
    f.write("edit.txt", "a\n\x0cb\n")
    f.git(f.root, "mv", "old.txt", "new.txt")
    f.write("new.txt", `${lines}more\n`)
    unlinkSync(join(f.root, "gone.txt"))
    chmodSync(join(f.root, "run.sh"), 0o755)
    unlinkSync(join(f.root, "link"))
    symlinkSync("elsewhere", join(f.root, "link"))
    f.write("image.bin", Buffer.from([0, 1, 2]))
    f.write(".env", "A=1\n")
    f.write("big.txt", "x\n".repeat(40))
    f.write("empty.txt", "")
    const nested = f.init(join(f.root, "nested"))
    f.commit({ "n.txt": "n\n" }, { root: nested })
    const files = f.collect({ limits: { patchLines: 10 } })
    const review = f.review
    assert.ok(review)
    assert.deepEqual(new Set(Object.values(files).map((file) => file.patch_note ?? "none")), new Set(["replaced_characters",
      "none", "no_content_change", "symlink", "binary", "secret", "too_large", "empty", "submodule"]))
    assert.deepEqual(accepted(decodeValue(WorktreeInputDocument, review)), review)
    assert.deepEqual(accepted(decodeBytes(WorktreeInputDocument, accepted(encodeDocument(WorktreeInputDocument, review)))), review)
  })

  test("input the schema refuses stops collection with its reason", (t) => {
    const f = new Fixture(t)
    f.commit({ "a.txt": "a\n" })
    f.write("a.txt", "b\n")
    assert.throws(() => f.collect({ title: " " }), { _tag: "CollectError", message: /target\.title: must not be empty/ })
  })
})
