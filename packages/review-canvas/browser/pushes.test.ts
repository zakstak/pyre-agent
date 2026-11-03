// Commits pushed to a pull request after its round, in Chromium against a real server and a gh that answers as
// GitHub does: the review page notices the new head in the open pull request list on its own, without an agent's
// check, and names the files that changed on the line under the title and on each stop that covers them.
// Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, fixtureInput, startServer } from "./harness.ts";

const PUSHED = "3".repeat(40);

test(
  "a review page notices commits pushed since its round, and its stops name the files they changed",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-canvas-pushes-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const root = join(directory, "repo");
    const bin = join(directory, "bin");
    mkdirSync(root);
    mkdirSync(bin);
    execFileSync("git", ["init", "-b", "main", root], {
      env: gitEnvironment({}),
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/project.git",
      ],
      { env: gitEnvironment({}) },
    );
    const input = fixtureInput();
    const roundHead: string = input.target.head_sha;
    input.target = {
      kind: "github_pr",
      title: "Write notes atomically",
      url: "https://github.com/acme/project/pull/7",
      head_sha: roundHead,
      changed_files: input.files.length,
    };
    const list = join(directory, "pulls.json");
    writeFileSync(
      list,
      JSON.stringify([
        [
          {
            html_url: "https://github.com/acme/project/pull/7",
            title: "Write notes atomically",
            base: { ref: "main", repo: { full_name: "acme/project" } },
            head: {
              ref: "atomic",
              sha: PUSHED,
              repo: { full_name: "acme/project" },
            },
          },
        ],
      ]),
    );
    const compare = join(directory, "compare.json");
    writeFileSync(
      compare,
      JSON.stringify({
        ahead_by: 2,
        behind_by: 0,
        files: [
          { filename: "src/notes/store.py", previous_filename: null },
          { filename: "package.json", previous_filename: null },
        ],
      }),
    );
    const calls = join(directory, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
echo "$*" >> '${calls}'
case "$*" in
  *"compare/${roundHead}...${PUSHED}"*) cat '${compare}' ;;
  *"pulls?state=open"*) cat '${list}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const server = await startServer({
      repositoryRoots: [root],
      environment: { PATH: `${bin}:${process.env.PATH}` },
    });
    t.after(() => server.stop());
    const agent = await server.register(input);
    await agent.publish(input);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(`${server.origin}/settings/repositories`);
    await page
      .getByRole("button", {
        name: "Monitor github.com/acme/project",
        exact: true,
      })
      .click();
    await page.getByText("1 monitored", { exact: true }).waitFor();

    // No agent ran check: the page's own list of open pull requests shows the new head.
    await page.goto(agent.url);
    const line = page.locator(`#drift[data-pushed='${PUSHED}']`);
    await line.waitFor();
    assert.match(
      ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim(),
      /^New commits pushed since round 1: 2 commits · head 3333333 · changed package\.json, src\/notes\/store\.py · checked .+ · the agents publish a new round with them\.$/,
    );
    assert.equal(
      await line
        .locator("a[data-drift-file='src/notes/store.py']")
        .getAttribute("href"),
      "#files/src/notes/store.py",
    );
    // The stop that excerpts store.py names it; the other stop's files did not change.
    const first = page.locator("section[data-stop='0'] [data-stop-drift='0']");
    assert.equal(
      ((await first.textContent()) ?? "").replace(/\s+/g, " ").trim(),
      "Changed since round 1: store.py",
    );
    assert.equal(await page.locator("[data-stop-drift='1']").count(), 0);
    assert.equal(
      ((await page.locator("[data-drift-files='0']").textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      "since round 1: store.py",
    );

    // The agents see what the server found, and it compared the head once however often the list is read.
    const status = await agent.status();
    assert.equal(status.drift.head_sha, PUSHED);
    assert.deepEqual(status.drift.paths, [
      "package.json",
      "src/notes/store.py",
    ]);
    assert.deepEqual(status.drift.compared, { kind: "listed", commits: 2 });
    await page.reload();
    await line.waitFor();
    await page.waitForTimeout(500);
    const compared = readFileSync(calls, "utf8")
      .split("\n")
      .filter((call) => call.includes("/compare/"));
    assert.equal(compared.length, 1, compared.join("\n"));

    // A new round with the pushed head replaces the line.
    await agent.publish({
      ...input,
      target: { ...input.target, head_sha: PUSHED },
    });
    await page
      .locator("[data-round-current]")
      .filter({ hasText: /^Round 2 · / })
      .waitFor();
    assert.equal(await page.locator("#drift").count(), 0);
    assert.equal(await page.locator("[data-stop-drift]").count(), 0);
  },
);
