// tests/test_collect_worktree.py is the collector's specification until the Python review canvas is removed (step 7),
// which deletes this test with it. Every Python case needs a TypeScript test of the same name, run or skipped with
// the reason it does not apply.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

const here = new URL(".", import.meta.url)
const python = readFileSync(new URL("../../../../tests/test_collect_worktree.py", here), "utf8")

test("every Python collector case has a TypeScript counterpart of the same name", () => {
  const cases = [...python.matchAll(/^ {4}def (test_\w+)\(self\):/gm)].map((match) => match[1])
  const ported = new Set(readdirSync(here)
    .filter((name) => name.endsWith(".test.ts"))
    .flatMap((name) => [...readFileSync(new URL(name, here), "utf8").matchAll(/\btest\(\s*"(test_\w+)"/g)].map((match) => match[1])))
  assert.ok(cases.length > 100, `found only ${cases.length} Python cases`)
  assert.deepEqual(cases.filter((name) => !ported.has(name)), [])
})
