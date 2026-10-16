// Ported from FingerprintTests in tests/test_collect_worktree.py. Each test keeps its Python name. The Python
// fingerprint command printed prFingerprints as JSON; the command-line tool is step 6, so these cases call the
// function and format its errors as the command does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { GitError } from "./errors.ts";
import { fileFingerprint, objectId, prFingerprints } from "./fingerprint.ts";
import { errorLine } from "./output.ts";
import { blob, Fixture, script, withEnv } from "./testing.ts";

const branched = (t: TestContext) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "a\n" });
  f.git(f.root, "checkout", "-q", "-b", "feature");
  f.commit({ "feature.txt": "f\n" });
  f.git(f.root, "checkout", "-q", "main");
  f.commit({ "main.txt": "m\n" });
  return f;
};

const prError = (options: Parameters<typeof prFingerprints>[0]) => {
  try {
    prFingerprints(options);
  } catch (error) {
    if (error instanceof GitError) return errorLine(error);
    throw error;
  }
  assert.fail("prFingerprints succeeded");
};

describe("FingerprintTests", () => {
  test("test_fingerprint_is_sha256_of_canonical_json", () => {
    const [a, b] = ["a".repeat(40), "b".repeat(40)];
    const canonical = `{"new_blob":"${b}","new_mode":"100644","old_blob":"${a}","old_mode":"100644","old_path":null,"path":"café.txt"}`;
    assert.equal(
      fileFingerprint({
        path: "café.txt",
        oldPath: null,
        oldBlob: objectId(a),
        newBlob: objectId(b),
        oldMode: "100644",
        newMode: "100644",
      }),
      createHash("sha256").update(canonical).digest("hex"),
    );
    // Python refused the all-zero ID in file_fingerprint. Here Git's all-zero ID parses to null, a missing side, so
    // fileFingerprint cannot receive it.
    assert.equal(objectId("0".repeat(40)), null);
    assert.equal(objectId("0".repeat(64)), null);
    assert.throws(() => objectId("A".repeat(40)), { _tag: "GitError" });
  });

  test("test_fingerprints_follow_content_and_mode", (t) => {
    const f = new Fixture(t);
    f.commit({ "same.txt": "s\n", "edit.txt": "e\n", "mode.txt": "m\n" });
    for (const name of ["same.txt", "edit.txt", "mode.txt"])
      f.write(name, "changed\n");
    const prints = (files: ReturnType<Fixture["collect"]>) =>
      Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, file.fingerprint]),
      );
    const first = f.collect();
    assert.deepEqual(prints(first), prints(f.collect()));
    f.write("edit.txt", "changed again\n");
    chmodSync(join(f.root, "mode.txt"), 0o755);
    const third = f.collect();
    assert.equal(
      third["same.txt"]?.fingerprint,
      first["same.txt"]?.fingerprint,
    );
    assert.notEqual(
      third["edit.txt"]?.fingerprint,
      first["edit.txt"]?.fingerprint,
    );
    assert.notEqual(
      third["mode.txt"]?.fingerprint,
      first["mode.txt"]?.fingerprint,
    );
  });

  test("test_cli_matches_the_collector_after_the_change_is_committed", (t) => {
    const f = new Fixture(t);
    f.commit({
      "a.txt": "a\n",
      "old.txt": "o\n".repeat(5),
      "gone.txt": "g\n",
      "run.sh": "r\n",
    });
    f.write("a.txt", "a\nb\n");
    f.git(f.root, "mv", "old.txt", "new.txt");
    unlinkSync(join(f.root, "gone.txt"));
    chmodSync(join(f.root, "run.sh"), 0o755);
    f.write("added.txt", "new\n");
    symlinkSync("a.txt", join(f.root, "link"));
    const files = f.collect();
    assert.equal(Object.keys(files).length, 6);
    f.commit({}, { message: "change" });
    const prints = prFingerprints({
      repo: f.root,
      base: "HEAD~1",
      head: "HEAD",
    });
    assert.deepEqual(
      Object.fromEntries(prints),
      Object.fromEntries(
        Object.entries(files).map(([path, file]) => [path, file.fingerprint]),
      ),
    );
  });

  test("test_cli_compares_the_merge_base_with_the_head", (t) => {
    const f = branched(t);
    assert.deepEqual(
      prFingerprints({ repo: f.root, base: "main", head: "feature" }),
      new Map([
        [
          "feature.txt",
          fileFingerprint({
            path: "feature.txt",
            oldPath: null,
            oldBlob: null,
            newBlob: blob("f\n"),
            oldMode: null,
            newMode: "100644",
          }),
        ],
      ]),
    );
  });

  test("test_a_git_executable_inside_a_bare_repository_never_runs", (t) => {
    const f = new Fixture(t);
    f.commit({ "a.txt": "a\n" });
    const bare = join(f.base, "bare.git");
    f.git(f.base, "clone", "-q", "--bare", f.root, bare);
    const marker = join(f.base, "bare-git-ran");
    script(join(bare, "bin", "git"), `touch '${marker}'\nexit 1\n`);
    const message = withEnv(
      { PATH: `${join(bare, "bin")}:${process.env.PATH}` },
      () => prError({ repo: bare, base: "HEAD", head: "HEAD" }),
    );
    assert.match(message, /inside the repository under review/);
    assert.ok(!existsSync(marker));
  });

  test("test_grafts_from_the_environment_do_not_change_the_merge_base", (t) => {
    const f = branched(t);
    const expected = prFingerprints({
      repo: f.root,
      base: "main",
      head: "feature",
    });
    const graft = join(f.base, "grafts");
    writeFileSync(
      graft,
      `${f.git(f.root, "rev-parse", "feature").trim()} ${f.git(f.root, "rev-parse", "main").trim()}\n`,
    );
    withEnv({ GIT_GRAFT_FILE: graft }, () =>
      assert.deepEqual(
        prFingerprints({ repo: f.root, base: "main", head: "feature" }),
        expected,
      ),
    );
  });

  test("test_repository_grafts_do_not_change_the_merge_base", (t) => {
    const f = branched(t);
    const expected = prFingerprints({
      repo: f.root,
      base: "main",
      head: "feature",
    });
    mkdirSync(join(f.root, ".git", "info"), { recursive: true });
    writeFileSync(
      join(f.root, ".git", "info", "grafts"),
      `${f.git(f.root, "rev-parse", "feature").trim()} ${f.git(f.root, "rev-parse", "main").trim()}\n`,
    );
    assert.deepEqual(
      prFingerprints({ repo: f.root, base: "main", head: "feature" }),
      expected,
    );
  });

  test("test_a_repository_shallow_file_does_not_change_the_merge_base", (t) => {
    const f = new Fixture(t);
    f.commit({ "a.txt": "a\n" });
    f.git(f.root, "checkout", "-q", "-b", "feature");
    f.commit({ "feature.txt": "f\n" });
    const expected = prFingerprints({
      repo: f.root,
      base: "main",
      head: "feature",
    });
    writeFileSync(
      join(f.root, ".git", "shallow"),
      `${f.git(f.root, "rev-parse", "feature").trim()}\n`,
    );
    assert.deepEqual(
      prFingerprints({ repo: f.root, base: "main", head: "feature" }),
      expected,
    );
  });

  test("test_cli_errors", (t) => {
    const f = new Fixture(t);
    f.commit({ "a.txt": "a\n" });
    const plain = join(f.base, "plain");
    mkdirSync(plain);
    for (const [repo, ref, message] of [
      [f.root, "nosuch", "Error: nosuch does not name a commit"],
      [plain, "HEAD", "Error: not a git repository"],
    ] as const) {
      const line = prError({ repo, base: ref, head: "HEAD" });
      assert.ok(line.startsWith(message), line);
    }
  });
});
