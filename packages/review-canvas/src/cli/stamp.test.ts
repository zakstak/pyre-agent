/** The build stamp answers from contents, never from file times. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fresh, inputsHash, writeStamp } from "./stamp.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** A small package with the stamp command copied in, so the command's own root is the package. */
const fixture = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-stamp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src/cli"), { recursive: true });
  mkdirSync(join(dir, "src/client"));
  cpSync(join(root, "src/cli/stamp.ts"), join(dir, "src/cli/stamp.ts"));
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}');
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(dir, "src/client/page.ts"), "export const page = 1;\n");
  writeFileSync(join(dir, "src/client/page.test.ts"), "test();\n");
  const stamp = (mode: string) => spawnSync(process.execPath, [join(dir, "src/cli/stamp.ts"), mode], { encoding: "utf8" });
  return { dir, stamp };
};

test("the hash follows the inputs' contents and paths, not their times or their tests", (t) => {
  const { dir } = fixture(t);
  const first = inputsHash(dir);
  assert.equal(inputsHash(dir), first);
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(dir, "src/client/page.ts"), old, old);
  utimesSync(join(dir, "pnpm-lock.yaml"), new Date(), new Date());
  assert.equal(inputsHash(dir), first, "times do not count");
  writeFileSync(join(dir, "src/client/page.test.ts"), "test(2);\n");
  assert.equal(inputsHash(dir), first, "a test is not an input");
  writeFileSync(join(dir, "src/client/page.ts"), "export const page = 2;\n");
  const changed = inputsHash(dir);
  assert.notEqual(changed, first, "a source is");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\nimporters: {}\n");
  assert.notEqual(inputsHash(dir), changed, "so is the lockfile");
});

test("the command says whether dist was built from these sources", (t) => {
  const { dir, stamp } = fixture(t);
  assert.equal(stamp("--check").status, 1, "no build yet");
  assert.equal(stamp("--write").status, 0);
  assert.equal(stamp("--check").status, 0, "built from these sources");
  assert.equal(fresh(dir), true);
  writeFileSync(join(dir, "src/client/page.ts"), "export const page = 3;\n");
  assert.equal(stamp("--check").status, 1, "a source changed since the build");
  writeStamp(dir);
  assert.equal(fresh(dir), true);
  assert.equal(stamp("--nope").status, 2);
});
