import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, fixtureInput, startServer } from "./harness.ts";

test("home discovers without enrollment, accepts explicitly, preserves filters and monitoring, and removes missing repos", { skip: !built }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "review-canvas-repository-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const alpha = join(directory, "alpha");
  for (const name of ["alpha", "beta<script>"]) {
    const root = join(directory, name);
    mkdirSync(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnvironment({}), stdio: "ignore" });
  }
  const alphaCopy = join(directory, "renamed-copy");
  mkdirSync(alphaCopy);
  execFileSync("git", ["init", "-b", "main"], { cwd: alphaCopy, env: gitEnvironment({}), stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:Owner/Alpha.git"], { cwd: alpha, env: gitEnvironment({}), stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/alpha.git"], { cwd: alphaCopy, env: gitEnvironment({}), stdio: "ignore" });
  const server = await startServer({ repositoryRoots: [directory] });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests: Array<string> = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(server.origin);
  await page.getByText("0 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-repository]").count(), 2);
  assert.equal(await page.locator("[data-checkout]").count(), 3);
  await page.getByText("2 checkouts", { exact: true }).waitFor();
  assert.equal(await page.locator(".repository-card script").count(), 0);
  await page.getByLabel("Filter repositories").fill("alpha");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await page.getByRole("button", { name: "Add to monitoring github.com/owner/alpha", exact: true }).click();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Filter repositories").inputValue(), "alpha");
  await page.getByLabel("Show repositories", { exact: true }).selectOption("monitored");
  await page.getByLabel("Filter repositories").fill("not present");
  await page.getByText("No repositories match these filters.", { exact: true }).waitFor();
  await page.getByLabel("Filter repositories").fill("");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await server.stop();
  await server.start();
  await page.reload();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Show repositories", { exact: true }).inputValue(), "monitored");
  const laterCopy = join(directory, "later-copy");
  mkdirSync(laterCopy);
  execFileSync("git", ["init", "-b", "feature"], { cwd: laterCopy, env: gitEnvironment({}), stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:owner/alpha.git"], { cwd: laterCopy, env: gitEnvironment({}), stdio: "ignore" });
  await page.reload();
  await page.locator(".repository-card:visible").getByText("3 checkouts", { exact: true }).waitFor();
  await page.getByLabel("Filter repositories").fill("feature");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await page.getByLabel("Filter repositories").fill("");
  writeFileSync(join(alpha, "new"), "new\n");
  await page.reload();
  await page.locator(".repository-card:visible summary").click();
  await page.getByText("1 changed item", { exact: true }).waitFor();
  await page.getByLabel("Show repositories", { exact: true }).selectOption("changed");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  rmSync(alpha, { recursive: true, force: true });
  await page.reload();
  await page.getByLabel("Show repositories", { exact: true }).selectOption("unavailable");
  await page.locator(".repository-card:visible summary").click();
  await page.locator(".repository-card").getByText("Unavailable", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Remove from monitoring github.com/owner/alpha", exact: true }).click();
  await page.getByText("0 monitored", { exact: true }).waitFor();
  await page.getByLabel("Show repositories", { exact: true }).selectOption("discovered");
  assert.equal(await page.locator("[data-repository]:visible").count(), 2);
  assert.ok(requests.every((url) => url.startsWith(server.origin + "/")));
});

test("PR reviews belong to one repository across copies, separate from forks and hosts, and survive restart", { skip: !built }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "review-canvas-pr-repository-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, remote] of [
    ["first", "git@github.com:Owner/Alpha.git"],
    ["copy", "https://github.com/owner/alpha.git"],
    ["fork", "https://github.com/another/alpha.git"],
    ["host", "https://other.example/owner/alpha.git"],
    ["port", "ssh://git@github.com:2222/owner/alpha.git"],
  ] as const) {
    const root = join(directory, name);
    mkdirSync(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnvironment({}), stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, env: gitEnvironment({}), stdio: "ignore" });
  }
  const server = await startServer({ repositoryRoots: [directory] });
  t.after(() => server.stop());
  const input = fixtureInput();
  input.target = {
    kind: "github_pr", title: "Demo PR", url: "https://github.com/OWNER/ALPHA/pull/55",
    head_sha: input.target.head_sha, changed_files: input.files.length,
  };
  const agent = await server.register(input);
  const published = await agent.publish(input);
  assert.equal(published.ok, true, JSON.stringify(published));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.origin);
  const repository = page.locator("[data-repository]").filter({ has: page.getByRole("heading", { name: "github.com/owner/alpha", exact: true }) });
  assert.equal(await page.locator("[data-repository]").count(), 4);
  assert.equal(await repository.locator("[data-checkout]").count(), 2);
  assert.equal(await page.locator("[data-repository-review]").count(), 1);
  assert.equal(await repository.getByRole("link", { name: "Demo PR", exact: true }).getAttribute("href"), `/reviews/${agent.review}`);
  await repository.getByRole("button", { name: "Add to monitoring github.com/owner/alpha", exact: true }).click();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  await server.stop();
  await server.start();
  await page.reload();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-repository-review]").count(), 1);
  await repository.getByRole("link", { name: "Demo PR", exact: true }).click();
  await page.locator("header.topbar").getByText("Round 1", { exact: true }).waitFor();
});
