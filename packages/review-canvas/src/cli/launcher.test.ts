// The command's failure line, and the skill launcher's setup lock, run as an agent runs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
echo "$3" >> "$2/pnpm.log"
case "$3" in
  install) mkdir -p "$2/node_modules" ;;
  build) mkdir -p "$2/dist/client/.vite" && echo '{}' > "$2/dist/client/.vite/manifest.json" ;;
esac
`,
  );
  chmodSync(pnpm, 0o755);
  const lock = join(pkg, ".setup.lock");
  const run = (env: Record<string, string> = {}) =>
    spawnSync("bash", [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
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
