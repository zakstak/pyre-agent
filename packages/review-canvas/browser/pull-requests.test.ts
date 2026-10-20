import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, fixtureInput, startServer } from "./harness.ts";

test(
  "unregistered repository PRs show base-first stacks and navigation survives opening a local layer",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-open-prs-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const root = join(directory, "repo"),
      bin = join(directory, "bin");
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
    const row = (id: number, head: string, base: string) => ({
      html_url: `https://github.com/acme/project/pull/${id}`,
      title: `Layer ${id}`,
      head: { ref: head, repo: { full_name: "acme/project" } },
      base: { ref: base, repo: { full_name: "acme/project" } },
    });
    const response = join(directory, "response.json");
    writeFileSync(
      response,
      JSON.stringify([
        [row(3, "ui", "feature"), row(2, "feature", "foundation")],
        [row(1, "foundation", "main"), row(4, "other", "main")],
      ]),
    );
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat '${response}'\n`, {
      mode: 0o755,
    });
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
    const list = page.getByRole("region", { name: "Open pull requests" });
    await list
      .getByText("Stack · 3 PRs · Base first", { exact: true })
      .waitFor();
    assert.deepEqual(await list.locator("li > a").allTextContents(), [
      "#1 Layer 1",
      "#2 Layer 2",
      "#3 Layer 3",
      "#4 Layer 4",
    ]);
    assert.equal(
      await list
        .getByRole("link", { name: "#3 Layer 3", exact: true })
        .getAttribute("href"),
      "https://github.com/acme/project/pull/3",
    );
    await page.getByText("No reviews yet.", { exact: false }).waitFor();
    assert.equal(
      await list.getByText("Depends on #1", { exact: false }).count(),
      1,
    );
    await page.screenshot({
      path: "/tmp/review-open-prs-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/review-open-prs-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const input = fixtureInput();
    input.target = {
      kind: "github_pr",
      title: "Layer 2",
      url: "https://github.com/acme/project/pull/2",
      head_sha: input.target.head_sha,
      changed_files: input.files.length,
    };
    const agent = await server.register(input);
    const published = await agent.publish(input);
    assert.equal(published.ok, true, JSON.stringify(published));
    await page.reload();
    await list.getByRole("link", { name: "#2 Layer 2", exact: true }).click();
    const stack = page.getByRole("navigation", {
      name: "PR stack",
      exact: true,
    });
    await stack
      .getByText("Stack · 3 PRs · Base first", { exact: true })
      .waitFor();
    assert.equal(
      await stack
        .locator("li[aria-current=page]")
        .textContent()
        .then((text) => text?.includes("#2 Layer 2")),
      true,
    );
    assert.equal(await stack.locator("li").count(), 3);
    await stack
      .getByRole("link", { name: "#1 Layer 1", exact: true })
      .waitFor();
    await page.screenshot({
      path: "/tmp/review-stack-mobile.png",
      fullPage: true,
    });
    writeFileSync(response, "[]");
    await stack.getByRole("button", { name: "Refresh PRs" }).click();
    await stack
      .getByText("This PR is no longer in the open PR list.")
      .waitFor();
  },
);
