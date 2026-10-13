import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { WorktreeRoot } from "../schema/primitives.ts";
import { gitEnvironment, trustedGit } from "../collector/git.ts";
import { checkoutStatus, discoverRepositories, identifyRepository, remoteAddress } from "./repositories.ts";
import { repositoryId } from "../schema/repositories.ts";

const folder = (t: TestContext) => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "review-canvas-repositories-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, {
  cwd, env: gitEnvironment({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }),
  stdio: ["ignore", "pipe", "pipe"],
});
const init = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  return Schema.decodeSync(WorktreeRoot)(path);
};

test("discovery skips hidden, dependency, and symlink directories, deduplicates roots, and includes worktrees", async (t) => {
  const base = folder(t);
  const root = init(join(base, "repo"));
  writeFileSync(join(root, "file"), "original\n");
  git(root, "add", "file");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  const worktree = join(base, "worktree");
  git(root, "worktree", "add", "-b", "experiment", worktree);
  init(join(base, "node_modules", "skipped"));
  init(join(base, ".hidden", "skipped"));
  const outside = init(join(folder(t), "outside"));
  symlinkSync(outside, join(base, "linked"), "dir");
  const discovery = await discoverRepositories([base, root]);
  assert.equal(discovery.repositories.length, 1);
  assert.deepEqual(discovery.repositories[0]?.checkouts, [root, worktree].sort());
  assert.deepEqual((await identifyRepository(Schema.decodeSync(WorktreeRoot)(worktree))).checkouts, [worktree]);
});

test("depth limits and missing scan roots are visible, and a narrow scan reaches a deeper repository", async (t) => {
  const base = folder(t);
  const deeper = init(join(base, "a", "b", "c", "d", "e"));
  const scan = await discoverRepositories([base, join(base, "missing")]);
  assert.deepEqual(scan.repositories, []);
  assert.match(scan.warnings.join(" "), /Depth limit/);
  assert.match(scan.warnings.join(" "), /Could not scan/);
  assert.deepEqual((await discoverRepositories([deeper])).repositories[0]?.checkouts, [deeper]);
});

test("invalid Git markers do not hide valid repositories below them", async (t) => {
  for (const marker of ["file", "directory"]) {
    const base = folder(t);
    if (marker === "file") writeFileSync(join(base, ".git"), "gitdir: missing\n");
    else mkdirSync(join(base, ".git"));
    const nested = init(join(base, "team", "repo"));
    const scan = await discoverRepositories([base]);
    assert.deepEqual(scan.repositories[0]?.checkouts, [nested]);
    assert.match(scan.warnings.join(" "), /Could not identify/);
  }
});

test("the scan budget includes slow identification and stops scheduling more Git work", async (t) => {
  const base = folder(t);
  for (let i = 0; i < 8; i++) init(join(base, `repo-${i}`));
  const executable = trustedGit({ repo: base }).executable;
  const bin = join(folder(t), "bin");
  mkdirSync(bin);
  const started = join(bin, "started");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--git-common-dir")) {
  appendFileSync(${JSON.stringify(started)}, process.pid + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}
try { process.stdout.write(execFileSync(${JSON.stringify(executable)}, args)); }
catch (error) { process.stderr.write(error.stderr ?? ""); process.exit(error.status ?? 1); }
`);
  chmodSync(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const before = Date.now();
  const scan = await discoverRepositories([base]);
  assert.ok(Date.now() - before < 4_000, "identification outlasted the overall scan budget");
  assert.match(scan.warnings.join(" "), /time limit/);
  const processes = readFileSync(started, "utf8").trim().split("\n");
  assert.ok(processes.length <= 4, "queued candidates started after the scan expired");
  // Abort can report its error before Node reaps the killed process.
  for (const pid of processes) {
    let running = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(Number(pid), 0); }
      catch { running = false; break; }
      await delay(10);
    }
    assert.equal(running, false, "cancelled Git process did not exit");
  }
});

test("status handles unborn and detached branches, renames, untracked items, and does not rewrite the index", async (t) => {
  const root = init(join(folder(t), "repo"));
  assert.deepEqual(await checkoutStatus(root), { kind: "ready", branch: "main", changed: 0 });
  writeFileSync(join(root, "file"), "original\n");
  git(root, "add", "file");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  git(root, "mv", "file", "renamed");
  writeFileSync(join(root, "new\nfile"), "new\n");
  const before = readFileSync(join(root, ".git", "index"));
  assert.deepEqual(await checkoutStatus(root), { kind: "ready", branch: "main", changed: 2 });
  assert.deepEqual(readFileSync(join(root, ".git", "index")), before);
  git(root, "checkout", "--detach");
  assert.deepEqual(await checkoutStatus(root), { kind: "ready", branch: null, changed: 2 });
});

test("acceptance rejects subdirectories and forged Git markers; missing monitored repos remain unavailable", async (t) => {
  const base = folder(t);
  const root = init(join(base, "repo"));
  mkdirSync(join(root, "subdir"));
  await assert.rejects(identifyRepository(Schema.decodeSync(WorktreeRoot)(join(root, "subdir"))), /repository root/);
  const fake = join(base, "fake");
  mkdirSync(join(fake, ".git"), { recursive: true });
  await assert.rejects(identifyRepository(Schema.decodeSync(WorktreeRoot)(fake)));
  rmSync(root, { recursive: true });
  assert.equal((await checkoutStatus(root)).kind, "unavailable");
});

test("remote identity matches SSH and HTTPS without exposing credentials, but keeps hosts, forks, and custom ports separate", () => {
  const expected = "github.com/owner/project";
  assert.equal(remoteAddress("git@github.com:Owner/Project.git"), expected);
  assert.equal(remoteAddress("git@github.com:OWNER/PROJECT.GIT"), expected);
  assert.equal(remoteAddress("https://example-user:example-password@github.com/owner/project.git/"), expected);
  assert.equal(remoteAddress("ssh://git@github.com:22/owner/project.git"), expected);
  assert.notEqual(remoteAddress("https://github.com/another-owner/project.git"), expected);
  assert.notEqual(remoteAddress("ssh://git@github.com:2222/owner/project.git"), expected);
  assert.notEqual(remoteAddress("https://git.example/owner/project.git"), expected);
  assert.equal(remoteAddress("https://host/project?access_token=example"), null);
  assert.equal(remoteAddress("ext::example-helper"), null);
});

test("independent clones and worktrees form one repository; unrelated same-name local repos stay separate", async (t) => {
  const base = folder(t);
  const root = init(join(base, "original"));
  writeFileSync(join(root, "file"), "original\n");
  git(root, "add", "file");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  const clone = join(base, "different-directory-name");
  git(base, "clone", root, clone);
  const localClone = join(base, "local-copy");
  git(base, "clone", root, localClone);
  git(root, "remote", "add", "origin", "git@github.com:Owner/Project.git");
  git(clone, "remote", "set-url", "origin", "https://github.com/owner/project.git");
  const worktree = join(base, "experiment");
  git(root, "worktree", "add", "-b", "experiment", worktree);
  const left = init(join(base, "left", "same-name"));
  const right = init(join(base, "right", "same-name"));
  const scan = await discoverRepositories([base]);
  assert.equal(scan.repositories.length, 3);
  const grouped = scan.repositories.find((repository) => repository.identity.kind === "remote");
  assert.deepEqual(grouped?.checkouts, [root, clone, localClone, worktree].sort());
  assert.notEqual(repositoryId((await identifyRepository(left)).identity), repositoryId((await identifyRepository(right)).identity));
  const originalIdentity = (await identifyRepository(Schema.decodeSync(WorktreeRoot)(clone))).identity;
  git(clone, "remote", "set-url", "origin", "https://github.com/fork-owner/project.git");
  assert.deepEqual(await checkoutStatus(Schema.decodeSync(WorktreeRoot)(clone), originalIdentity), {
    kind: "unavailable", message: "This checkout now belongs to a different repository.",
  });
});

test("local clone sources with colons retain their repository identity", async (t) => {
  const base = folder(t);
  const root = init(join(base, "team:project"));
  writeFileSync(join(root, "file"), "original\n");
  git(root, "add", "file");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  git(root, "remote", "add", "origin", "git@github.com:owner/project.git");
  const expected = (await identifyRepository(root)).identity;
  for (const source of [root, "./team:project"]) {
    const clone = join(base, source === root ? "absolute-copy" : "relative-copy");
    git(base, "clone", source, clone);
    if (source !== root) git(clone, "remote", "set-url", "origin", "../team:project");
    assert.deepEqual((await identifyRepository(Schema.decodeSync(WorktreeRoot)(clone))).identity, expected);
  }
});
