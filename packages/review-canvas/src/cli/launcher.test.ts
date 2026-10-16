// The command's failure line, and the skill launcher's setup lock, run as an agent runs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(root, "../../skills/review-canvas/scripts/review-canvas");

const scratch = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a command that cannot start the server fails with one line and no stack trace", (t) => {
  const dir = scratch(t);
  const runtime = join(dir, "not-a-folder");
  writeFileSync(runtime, "");
  const result = spawnSync(
    process.execPath,
    [join(root, "src/cli/main.ts"), "status", "--session", join(dir, "s")],
    {
      encoding: "utf8",
      env: { ...process.env, REVIEW_CANVAS_RUNTIME: runtime },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^Error: [^\n]*not-a-folder is not a folder[^\n]* \(unsafe_runtime\)\n$/,
  );
});

test("a T3 CLI session publishes and reports an unwritable export as a file error", (t) => {
  const dir = scratch(t);
  const runtime = join(dir, "run");
  const session = join(dir, "s");
  mkdirSync(session);
  const env = {
    ...process.env,
    REVIEW_CANVAS_RUNTIME: runtime,
    REVIEW_CANVAS_DATA: join(dir, "reviews.sqlite"),
  };
  const cli = (...args: Array<string>) =>
    spawnSync(process.execPath, [join(root, "src/cli/main.ts"), ...args], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
  t.after(() =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { stopServer, withServerOperation } from "./src/cli/socket.ts"; await withServerOperation(stopServer);',
      ],
      { cwd: root, env },
    ),
  );
  const registered = cli(
    "register",
    "--session",
    session,
    "--input",
    join(root, "fixtures/input/worktree.json"),
    "--label",
    "Export fixture",
    "--host",
    "t3",
  );
  assert.equal(registered.status, 0, registered.stderr);
  const published = cli(
    "publish",
    "--session",
    session,
    "--input",
    join(root, "fixtures/input/worktree.json"),
    "--no-github",
  );
  assert.equal(published.status, 0, published.stderr);
  const result = cli(
    "export",
    "--session",
    session,
    "--output",
    join(dir, "no-such-folder", "feedback.json"),
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^Error: [^\n]*no-such-folder[^\n]* \(enoent\)\n$/,
  );
  assert.doesNotMatch(result.stderr, /no review server/);
});

/**
 * A package the launcher must set up, with a pnpm that records what it ran and an entry point that prints "ran".
 * Returns how to run the launcher against it.
 */
const stalePackage = (t: TestContext) => {
  const dir = scratch(t);
  const pkg = join(dir, "package");
  for (const folder of ["src/cli", "src/client", "src/server"])
    mkdirSync(join(pkg, folder), { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  writeFileSync(join(pkg, "pnpm-lock.yaml"), "");
  writeFileSync(join(pkg, "src/cli/main.ts"), 'console.log("ran");');
  // The real stamp command, so the fake build can record what it was made from as the real one does.
  cpSync(join(root, "src/cli/stamp.ts"), join(pkg, "src/cli/stamp.ts"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
echo "$3" >> "$2/pnpm.log"
case "$3" in
  install) mkdir -p "$2/node_modules" ;;
  build) mkdir -p "$2/dist/client/.vite" && echo '{}' > "$2/dist/client/.vite/manifest.json" && node "$2/src/cli/stamp.ts" --write ;;
esac
`,
  );
  chmodSync(pnpm, 0o755);
  const lock = join(pkg, ".setup.lock");
  const run = (env: Record<string, string> = {}, path = process.env["PATH"]) =>
    spawnSync("bash", [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${path ?? ""}`,
        REVIEW_CANVAS_PACKAGE: pkg,
        ...env,
      },
      timeout: 30_000,
    });
  return { pkg, lock, run };
};

test("setup breaks a lock whose owner is gone, then removes only its own", (t) => {
  const { pkg, lock, run } = stalePackage(t);
  const gone = spawnSync("true").pid;
  assert.ok(gone !== undefined);
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), `${gone}\n`);
  const result = run({ REVIEW_CANVAS_SETUP_TIMEOUT: "5" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ran\n");
  assert.equal(readFileSync(join(pkg, "pnpm.log"), "utf8"), "install\nbuild\n");
  assert.equal(existsSync(lock), false);
});

test("setup fails, naming the lock, while a live owner holds it, and leaves the lock in place", (t) => {
  const { pkg, lock, run } = stalePackage(t);
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  const result = run({ REVIEW_CANVAS_SETUP_TIMEOUT: "1" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(lock), result.stderr);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), `${process.pid}\n`);
  assert.equal(existsSync(join(pkg, "pnpm.log")), false);
});

test("without ps, setup cannot tell a lock is stale, and leaves it for its owner", (t) => {
  const { pkg, lock, run } = stalePackage(t);
  // Every tool the launcher uses but ps, as on a slim container image.
  const tools = join(pkg, "..", "tools");
  mkdirSync(tools);
  for (const name of [
    "bash",
    "cat",
    "dirname",
    "find",
    "mkdir",
    "node",
    "rm",
    "rmdir",
    "sleep",
    "touch",
  ]) {
    const found = spawnSync("bash", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).stdout.trim();
    assert.ok(found !== "", `${name} not found`);
    symlinkSync(found, join(tools, name));
  }
  const gone = spawnSync("true").pid;
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), `${gone}\n`);
  const result = run({ REVIEW_CANVAS_SETUP_TIMEOUT: "1" }, tools);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(lock), result.stderr);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), `${gone}\n`);
  assert.equal(existsSync(join(pkg, "pnpm.log")), false);
});
