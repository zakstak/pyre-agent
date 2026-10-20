import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, startServer } from "./harness.ts";

test(
  "an unregistered PR opens a pinned local diff, refreshes, and leaves local reviews empty",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-direct-pr-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, "repo"),
      bin = join(directory, "bin");
    mkdirSync(root);
    mkdirSync(bin);
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-C", root, ...args], {
        env: gitEnvironment({}),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git("init", "-b", "main");
    const commit = (body: string) => {
      writeFileSync(join(root, "example.txt"), body);
      writeFileSync(join(root, "second.txt"), body);
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      return git("rev-parse", "HEAD");
    };
    const base = commit("before\n"),
      head = commit("after <script>literal</script>\n");
    git("remote", "add", "origin", "https://github.com/acme/project.git");
    const url = "https://github.com/acme/project/pull/7";
    writeFileSync(
      join(directory, "list.json"),
      JSON.stringify([
        [
          {
            html_url: url,
            title: "Review me",
            head: { ref: "feature", repo: { full_name: "acme/project" } },
            base: { ref: "main", repo: { full_name: "acme/project" } },
          },
        ],
      ]),
    );
    writeFileSync(
      join(directory, "view.json"),
      JSON.stringify({
        title: "Review me",
        url,
        baseRefOid: base,
        headRefOid: head,
        baseRefName: "main",
        changedFiles: 2,
      }),
    );
    writeFileSync(
      join(directory, "files.json"),
      [
        JSON.stringify({ filename: "example.txt" }),
        JSON.stringify({ filename: "second.txt" }),
      ].join("\n"),
    );
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1" = pr ]; then cat '${directory}/view.json'; elif echo "$*" | /usr/bin/grep -q '/files'; then cat '${directory}/files.json'; else cat '${directory}/list.json'; fi\n`,
      { mode: 0o755 },
    );
    const server = await startServer({
      repositoryRoots: [root],
      environment: { PATH: `${bin}:${process.env.PATH}` },
    });
    t.after(() => server.stop());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/settings/repositories`);
    await page
      .getByRole("button", {
        name: "Monitor github.com/acme/project",
        exact: true,
      })
      .click();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    await page.goto(server.origin);
    await page.getByRole("link", { name: "#7 Review me", exact: true }).click();
    await page
      .getByRole("region", { name: "Diff for example.txt", exact: true })
      .waitFor();
    assert.match(
      (await page
        .getByRole("region", { name: "Diff for example.txt", exact: true })
        .textContent()) ?? "",
      /after <script>literal<\/script>/,
    );
    assert.equal(await page.locator("table script").count(), 0);
    await page
      .getByRole("button", { name: "Refresh diff", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh diff", exact: true })
      .isEnabled();
    await page.getByLabel("Changed file").selectOption("second.txt");
    await page.reload();
    await page
      .getByRole("region", { name: "Diff for second.txt", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Changed file").inputValue(),
      "second.txt",
    );
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.goto(server.origin);
    await page.getByText("No reviews yet.", { exact: false }).waitFor();
  },
);
