// collect --pr against real Git repositories and a fake gh: what GitHub says is scripted, the clone is real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as Result from "effect/Result";
import { openWorktree } from "../collector/collect.ts";
import { CollectError } from "../collector/errors.ts";
import { prFingerprints } from "../collector/fingerprint.ts";
import { Fixture, PRIVATE_KEY, script } from "../collector/testing.ts";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import { GhFailed, type Gh } from "./github.ts";
import type { ForgeClients } from "./hosted.ts";
import { collectPullRequest, reconcile } from "./pull-request.ts";

const PR = "https://github.com/example/notes/pull/7" as PullRequestUrl;
const root = fileURLToPath(new URL("../../", import.meta.url));

/** A clone with main and a feature branch whose commits the pull request names. */
const pullRequest = (t: TestContext) => {
  const f = new Fixture(t);
  f.commit({
    "a.txt": "a\n",
    "old.txt": "o\n".repeat(5),
    "gone.txt": "g\n",
  });
  f.git(f.root, "checkout", "-q", "-b", "feature");
  f.write("a.txt", "a\nb\n");
  f.git(f.root, "mv", "old.txt", "new.txt");
  f.git(f.root, "rm", "-q", "gone.txt");
  f.write("added.txt", "new\n");
  f.commit({}, { message: "feature" });
  const head = f.head();
  f.git(f.root, "checkout", "-q", "main");
  // The base moved on after the branch: GitHub compares from the merge base, so this file is not in the change.
  f.commit({ "main.txt": "m\n" }, { message: "main" });
  const base = f.head();
  return { f, base, head };
};

/** GitHub's side: the pull request's facts and file list, and the heads that successive views report. */
const fakeGh = (options: {
  readonly base: string;
  readonly heads: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly previous_filename?: string;
  }>;
  readonly changedFiles?: number;
}): ForgeClients & { readonly calls: Array<ReadonlyArray<string>> } => {
  const calls: Array<ReadonlyArray<string>> = [];
  let views = 0;
  const gh = (args: ReadonlyArray<string>, cwd?: string) => {
    calls.push(args);
    assert.equal(cwd, undefined, "gh must run where runGh puts it");
    if (args[0] === "pr" && args[1] === "view") {
      const head =
        options.heads[Math.min(views++, options.heads.length - 1)] ?? "";
      return JSON.stringify({
        title: "Feature",
        url: PR,
        baseRefOid: options.base,
        headRefOid: head,
        baseRefName: "main",
        changedFiles: options.changedFiles ?? options.files.length,
      });
    }
    if (args[0] === "api")
      return options.files.map((file) => JSON.stringify(file)).join("\n");
    throw new GhFailed(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, api: () => { throw new Error("REST is not used for GitHub"); }, calls };
};

const FILES = [
  { filename: "a.txt" },
  { filename: "added.txt" },
  { filename: "gone.txt" },
  { filename: "new.txt", previous_filename: "old.txt" },
];

const collectError = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof CollectError, String(error));
    return error.message;
  }
  return assert.fail("collection succeeded");
};

describe("collect --pr", () => {
  test("a clone with both commits gives complete github_pr input, fingerprinted as the other collectors do", (t) => {
    const { f, base, head } = pullRequest(t);
    const gh = fakeGh({ base, heads: [head], files: FILES });
    const collected = collectPullRequest(
      openWorktree({ repo: f.root }),
      PR,
      gh,
      { withContent: true },
    );
    // The input round-trips through the published format.
    const decoded = decodeBytes(
      InputDocument,
      Buffer.from(JSON.stringify(collected.review)),
    );
    if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
    const review = decoded.success;
    assert.equal(review.target.kind, "github_pr");
    assert.equal(review.files_complete, true);
    assert.deepEqual(
      review.target.kind === "github_pr"
        ? [review.target.head_sha, review.target.base_sha]
        : [],
      [head, base],
    );
    assert.equal(collected.baseRef, "main");
    assert.equal(collected.headMoved, false);
    assert.equal(collected.mismatch, undefined);
    const files = Object.fromEntries(
      review.files.map((file) => [file.path, file]),
    );
    assert.deepEqual(Object.keys(files).sort(), [
      "a.txt",
      "added.txt",
      "gone.txt",
      "new.txt",
    ]);
    assert.equal(files["a.txt"]?.patch, "@@ -1 +1,2 @@\n a\n+b\n");
    assert.equal(files["a.txt"]?.new_content, "a\nb\n");
    assert.equal(files["new.txt"]?.old_path, "old.txt");
    assert.equal(files["gone.txt"]?.status, "deleted");

    // The same fingerprints as the fingerprints command, and as the working tree collector before the commit.
    assert.deepEqual(
      new Map(review.files.map((file) => [file.path, file.fingerprint])),
      prFingerprints({ repo: f.root, base, head }),
    );
    f.git(f.root, "checkout", "-q", "feature");
    f.git(f.root, "reset", "-q", "--soft", "HEAD~1");
    const uncommitted = f.collect();
    for (const file of review.files)
      assert.equal(uncommitted[file.path]?.fingerprint, file.fingerprint);
  });

  test("a secret is flagged without content, and a file past the line budget is too large", (t) => {
    const { f, base } = pullRequest(t);
    f.git(f.root, "checkout", "-q", "feature");
    f.commit({
      "notes.txt": `keep this out\n${PRIVATE_KEY}`,
      "long.txt": "x\n".repeat(30),
    });
    const head = f.head();
    const gh = fakeGh({
      base,
      heads: [head],
      files: [...FILES, { filename: "long.txt" }, { filename: "notes.txt" }],
    });
    const collected = collectPullRequest(
      openWorktree({ repo: f.root }),
      PR,
      gh,
      { withContent: true, limits: { patchLines: 20 } },
    );
    const files = Object.fromEntries(
      collected.review.files.map((file) => [file.path, file]),
    );
    assert.deepEqual(collected.flagged, ["notes.txt"]);
    assert.equal(files["notes.txt"]?.patch_note, "secret");
    assert.equal(files["notes.txt"]?.patch, undefined);
    assert.equal(files["notes.txt"]?.new_content, undefined);
    assert.equal(files["long.txt"]?.patch_note, "too_large");
    assert.equal(files["long.txt"]?.patch_complete, false);
    assert.equal(collected.review.files_complete, true);
  });

  test("a path only GitHub lists, or a count that differs, leaves the file list incomplete and named", (t) => {
    const { f, base, head } = pullRequest(t);
    const extra = collectPullRequest(
      openWorktree({ repo: f.root }),
      PR,
      fakeGh({
        base,
        heads: [head],
        files: [...FILES, { filename: "ghost.txt" }],
      }),
    );
    assert.equal(extra.review.files_complete, false);
    assert.deepEqual(extra.mismatch?.only_on_github, ["ghost.txt"]);
    assert.deepEqual(extra.mismatch?.only_in_clone, []);
    // GitHub's own count beyond its list, as past its 3,000-file cap.
    const counted = collectPullRequest(
      openWorktree({ repo: f.root }),
      PR,
      fakeGh({ base, heads: [head], files: FILES, changedFiles: 5 }),
    );
    assert.equal(counted.review.files_complete, false);
    assert.deepEqual(counted.mismatch?.counts, { github: 5, clone: 4 });
  });

  test("renames that only one side detects still reconcile by path", () => {
    assert.equal(
      reconcile(
        [{ path: "new.txt", old_path: "old.txt" }],
        [{ filename: "new.txt", previous_filename: "old.txt" }],
        1,
      ),
      undefined,
    );
    // A delete and an add here, a rename on GitHub: the paths agree, the counts do not.
    assert.deepEqual(
      reconcile(
        [{ path: "new.txt" }, { path: "old.txt" }],
        [{ filename: "new.txt", previous_filename: "old.txt" }],
        1,
      ),
      {
        only_on_github: [],
        only_in_clone: [],
        counts: { github: 1, clone: 2 },
      },
    );
  });

  test("a head that moves during collection is reported, and the list is not called complete", (t) => {
    const { f, base, head } = pullRequest(t);
    const collected = collectPullRequest(
      openWorktree({ repo: f.root }),
      PR,
      fakeGh({ base, heads: [head, "f".repeat(40)], files: FILES }),
    );
    assert.equal(collected.headMoved, true);
    assert.equal(collected.review.files_complete, false);
    assert.equal(
      collected.review.target.kind === "github_pr" &&
        collected.review.target.head_sha,
      head,
    );
  });

  test("a commit the clone lacks fails with the command that fetches it", (t) => {
    const { f, base } = pullRequest(t);
    const missing = "e".repeat(40);
    const message = collectError(() =>
      collectPullRequest(
        openWorktree({ repo: f.root }),
        PR,
        fakeGh({ base, heads: [missing], files: FILES }),
      ),
    );
    assert.match(message, new RegExp(`does not hold ${missing}\\.`));
    assert.ok(
      message.endsWith(
        `git -C ${f.root} fetch https://github.com/example/notes.git pull/7/head main`,
      ),
      message,
    );
  });

  test("the command writes nothing without the commits, never runs gh in the clone, and runs no repository config", (t) => {
    const { f, base, head } = pullRequest(t);
    const bin = realpathSync(f.base);
    const record = join(bin, "gh-ran-in");
    const marker = join(bin, "filter-ran");
    const tool = script(join(bin, "filter.sh"), `touch '${marker}'\ncat\n`);
    const files = FILES.map((file) => JSON.stringify(file)).join("\\n");
    script(
      join(bin, "fake", "gh"),
      `pwd >> '${record}'
case "$1" in
  pr) printf '%s\\n' '{"title":"Feature","url":"${PR}","baseRefOid":"${base}","headRefOid":"'"$HEAD_SHA"'","baseRefName":"main","changedFiles":4}' ;;
  api) printf '${files}\\n' ;;
  *) exit 1 ;;
esac
`,
    );
    // A filter driver for every file, configured in the clone: Git must not run it while it reads the commits.
    f.commit({ ".gitattributes": "*.txt filter=mark\n" }, { message: "attrs" });
    for (const key of ["clean", "smudge", "process"])
      f.git(f.root, "config", `filter.mark.${key}`, tool);
    f.git(f.root, "config", "filter.mark.required", "true");
    if (existsSync(marker)) unlinkSync(marker);
    const run = (headSha: string, output: string) =>
      spawnSync(
        process.execPath,
        [
          join(root, "src/cli/main.ts"),
          "collect",
          "--pr",
          PR,
          "--repo",
          f.root,
          "--output",
          output,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(bin, "fake")}:${process.env["PATH"] ?? ""}`,
            HEAD_SHA: headSha,
          },
        },
      );

    const absent = join(bin, "absent", "round-1.json");
    const failed = run("e".repeat(40), absent);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /fetch https:\/\/github\.com\/example\/notes/);
    assert.equal(existsSync(absent), false);

    const output = join(bin, "session", "round-1.json");
    const ok = run(head, output);
    assert.equal(ok.status, 0, ok.stderr);
    const printed = JSON.parse(ok.stdout);
    assert.equal(printed.files_complete, true);
    assert.equal(printed.base_ref, "main");
    assert.equal(printed.head_moved, false);
    assert.equal(printed.inventory_mismatch, null);
    const written = decodeBytes(InputDocument, readFileSync(output));
    if (Result.isFailure(written)) assert.fail(written.failure.message);
    assert.equal(written.success.files.length, 4);

    assert.ok(!existsSync(marker), "a configured filter driver ran");
    for (const cwd of readFileSync(record, "utf8").trim().split("\n"))
      assert.ok(
        !realpathSync(cwd).startsWith(realpathSync(f.root)),
        `gh ran in ${cwd}`,
      );
  });
});
