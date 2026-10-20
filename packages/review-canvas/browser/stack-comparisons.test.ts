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
  "merged stack navigation switches between layer and cumulative diffs and survives reload",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-stack-diff-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, "repo"),
      bin = join(directory, "bin");
    mkdirSync(root);
    mkdirSync(bin);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        env: gitEnvironment({}),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git("init", "-b", "main");
    const commit = (name: string) => {
      writeFileSync(join(root, name), `${name}\n`);
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
        name,
      );
      return git("rev-parse", "HEAD");
    };
    const base = commit("base.txt"),
      parent = commit("foundation.txt"),
      child = commit("feature.txt"),
      tip = commit("ui.txt");
    git("remote", "add", "origin", "https://github.com/acme/project.git");
    const row = (
      n: number,
      head: string,
      branch: string,
      parentBranch: string,
    ) => ({
      url: `https://github.com/acme/project/pull/${n}`,
      title: `Layer ${n}`,
      state: "MERGED",
      baseRefName: "main",
      headRefName: branch,
      headRefOid: head,
      baseRefOid: base,
      isCrossRepository: false,
      timelineItems: {
        pageInfo: { hasNextPage: false },
        nodes:
          parentBranch === "main"
            ? []
            : [{ previousRefName: parentBranch, currentRefName: "main" }],
      },
    });
    const rows = [
      row(1, parent, "foundation", "main"),
      row(2, child, "feature", "foundation"),
      row(3, tip, "ui", "feature"),
    ];
    writeFileSync(
      join(directory, "history.json"),
      JSON.stringify([
        {
          data: {
            repository: {
              defaultBranchRef: { name: "main" },
              pullRequests: { nodes: rows },
            },
          },
        },
      ]),
    );
    for (const row of rows)
      writeFileSync(
        join(directory, `${row.url.split("/").at(-1)}.json`),
        JSON.stringify({ ...row, changedFiles: 1 }),
      );
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1" = pr ]; then n="${"$"}{3##*/}"; cat '${directory}/'"$n".json; else cat '${directory}/history.json'; fi\n`,
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
    await page.getByLabel("PR inbox").selectOption("history");
    await page
      .getByText("Stack · 3 PRs · Base first", { exact: true })
      .waitFor();
    await page.getByRole("link", { name: "#3 Layer 3", exact: true }).click();
    await page
      .getByRole("region", { name: "Diff for ui.txt", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Changed file").locator("option").count(),
      1,
    );
    await page.getByLabel("Comparison scope").selectOption("cumulative");
    await page
      .getByLabel("Changed file")
      .locator("option")
      .filter({ hasText: "foundation.txt" })
      .waitFor({ state: "attached" });
    assert.equal(
      await page.getByLabel("Changed file").locator("option").count(),
      3,
    );
    await page.getByLabel("Changed file").selectOption("feature.txt");
    await page.reload();
    await page
      .getByRole("region", { name: "Diff for feature.txt", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Comparison scope").inputValue(),
      "cumulative",
    );
    await page
      .getByRole("navigation", { name: "PR stack", exact: true })
      .getByText("Stack · 3 PRs · Base first", { exact: true })
      .waitFor();
    await page.screenshot({
      path: "/tmp/review-stack-comparison-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "/tmp/review-stack-comparison-mobile.png",
      fullPage: true,
    });
  },
);
