// `check` on a pull request after a push with no new round, run as an agent runs it, against a gh that answers as
// GitHub does: the head the host shows, and its comparison with the round's head.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const input = JSON.parse(
  readFileSync(join(root, "fixtures/input/pull-request.json"), "utf8"),
);
const ROUND_HEAD = input.target.head_sha;
const PUSHED = "3".repeat(40);

/** A session of a pull request review with one round, and a gh on PATH that prints `answers` for its calls. */
const reviewed = (
  t: TestContext,
  answers: { readonly head: string; readonly compare: unknown },
) => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "gh.log");
  writeFileSync(join(dir, "view.json"), JSON.stringify(view(answers.head)));
  writeFileSync(join(dir, "compare.json"), JSON.stringify(answers.compare));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> '${calls}'
case "$1 $2" in
  "pr view") cat '${join(dir, "view.json")}' ;;
  "api --hostname") cat '${join(dir, "compare.json")}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REVIEW_CANVAS_RUNTIME: join(dir, "run"),
    REVIEW_CANVAS_DATA: join(dir, "reviews.sqlite"),
  };
  const cli = (...args: Array<string>) => {
    const result = spawnSync(
      process.execPath,
      [join(root, "src/cli/main.ts"), ...args],
      { encoding: "utf8", env, timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
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
  const session = join(dir, "session");
  const round = join(dir, "round-1.json");
  writeFileSync(round, JSON.stringify(input));
  cli(
    "register",
    "--session",
    session,
    "--input",
    round,
    "--label",
    "Claude Code: check",
  );
  cli("publish", "--session", session, "--input", round, "--no-comments");
  return {
    check: () => cli("check", "--session", session),
    status: () => cli("status", "--session", session).status,
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
  };
};

const view = (head: string) => ({
  title: input.target.title,
  url: input.target.url,
  baseRefOid: input.target.base_sha,
  headRefOid: head,
  baseRefName: "main",
  changedFiles: 3,
});

test("after a push, check lists the files the host's comparison of the heads names", (t) => {
  const review = reviewed(t, {
    head: PUSHED,
    compare: {
      ahead_by: 2,
      behind_by: 0,
      files: [
        { filename: "package.json", previous_filename: null },
        { filename: "src/retry.py", previous_filename: "src/retries.py" },
      ],
    },
  });
  const checked = review.check();
  assert.deepEqual(checked.changed, [
    "package.json",
    "src/retries.py",
    "src/retry.py",
  ]);
  assert.equal(checked.head_moved, true);
  assert.deepEqual(checked.compared, { kind: "listed", commits: 2 });
  assert.ok(
    review
      .calls()
      .includes(
        `api --hostname github.com repos/example/retry-demo/compare/${ROUND_HEAD}...${PUSHED} --jq {ahead_by, behind_by, files: [.files[]? | {filename, previous_filename}]}`,
      ),
    review.calls().join("\n"),
  );
  // The agents and the page see the same drift.
  const { drift } = review.status();
  assert.deepEqual(drift.paths, checked.changed);
  assert.equal(drift.head_sha, PUSHED);
  assert.deepEqual(drift.compared, { kind: "listed", commits: 2 });
});

test("a force-pushed head is a moved head whose files the host cannot list, and the same head changed nothing", (t) => {
  const pushed = reviewed(t, {
    head: PUSHED,
    compare: { ahead_by: 3, behind_by: 1, files: [{ filename: "a.ts" }] },
  });
  const checked = pushed.check();
  assert.deepEqual(checked.changed, []);
  assert.equal(checked.head_moved, true);
  assert.equal(checked.compared.kind, "unlisted");
  assert.equal(checked.compared.commits, 3);
  assert.match(checked.compared.reason, /rewritten/);

  const same = reviewed(t, { head: ROUND_HEAD, compare: {} });
  const unchanged = same.check();
  assert.deepEqual(
    [unchanged.changed, unchanged.head_moved, unchanged.compared],
    [[], false, undefined],
  );
  assert.equal(same.status().drift, undefined);
  // An unmoved head needs no comparison.
  assert.ok(same.calls().every((call) => !call.includes("compare")));
});
