import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, fixtureInput, startServer } from "./harness.ts";

/** The page renders after its socket connects and the server answers: wait for the repositories section. */
const loaded = (page: Page) => page.locator("[data-repositories]").waitFor();

test("the repositories page discovers without enrollment, monitors explicitly, keeps the filter in the URL, and removes missing repos", { skip: !built }, async (t) => {
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
  const sockets: Array<string> = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(`${server.origin}/repositories`);
  await page.getByText("0 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-repository]").count(), 2);
  assert.equal(await page.locator("[data-checkout]").count(), 3);
  const alphaRow = page.locator("[data-repository]").filter({ has: page.getByRole("heading", { name: "owner/alpha github.com", exact: true }) });
  assert.equal(await alphaRow.locator("[data-checkout]").count(), 2);
  // Found repositories are grouped apart, with a Monitor button and no monitoring until it is pressed.
  await page.getByRole("heading", { name: "Found, not monitored" }).waitFor();
  assert.equal(await page.locator("[data-repository][data-monitoring='discovered']").count(), 2);
  assert.equal(await page.locator("[data-repository] script").count(), 0);
  await page.getByLabel("Filter repositories").fill("alpha");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await page.getByRole("button", { name: "Monitor github.com/owner/alpha", exact: true }).click();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Filter repositories").inputValue(), "alpha");
  // The filter text lives in the URL, written a moment after the typing stops, so it stays after a reload.
  await page.waitForURL(/[?&]q=alpha(&|$)/);
  await page.reload();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Filter repositories").inputValue(), "alpha");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  // An older link's filter still applies, with no control for it.
  await page.goto(`${server.origin}/repositories?filter=monitored`);
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("select").count(), 0);
  await page.getByLabel("Filter repositories").fill("not present");
  await page.getByText("No repositories match this filter.", { exact: true }).waitFor();
  await page.waitForURL(/[?&]q=not\+present(&|$)/);
  assert.match(page.url(), /[?&]filter=monitored(&|$)/);
  await page.getByLabel("Filter repositories").fill("");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await server.stop();
  await server.start();
  await page.reload();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  const laterCopy = join(directory, "later-copy");
  mkdirSync(laterCopy);
  execFileSync("git", ["init", "-b", "feature"], { cwd: laterCopy, env: gitEnvironment({}), stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:owner/alpha.git"], { cwd: laterCopy, env: gitEnvironment({}), stdio: "ignore" });
  await page.reload();
  await loaded(page);
  assert.equal(await page.locator("[data-repository]:visible [data-checkout]").count(), 3);
  await page.getByLabel("Filter repositories").fill("feature");
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await page.getByLabel("Filter repositories").fill("");
  writeFileSync(join(alpha, "new"), "new\n");
  await page.reload();
  await page.getByRole("img", { name: "1 file changed", exact: true }).waitFor();
  await page.goto(`${server.origin}/repositories?filter=changed`);
  await loaded(page);
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  rmSync(alpha, { recursive: true, force: true });
  await page.goto(`${server.origin}/repositories?filter=unavailable`);
  await loaded(page);
  assert.equal(await page.locator("[data-repository]:visible").count(), 1);
  await page.locator("[data-repository]:visible").getByText("missing", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Remove github.com/owner/alpha", exact: true }).click();
  await page.getByText("0 monitored", { exact: true }).waitFor();
  await page.goto(`${server.origin}/repositories?filter=discovered`);
  await loaded(page);
  assert.equal(await page.locator("[data-repository]:visible").count(), 2);
  assert.ok(requests.every((url) => url.startsWith(server.origin + "/")), requests.join("\n"));
  // The page's one socket goes to the same server.
  assert.ok(sockets.length > 0 && sockets.every((url) => url === `${server.origin.replace(/^http/, "ws")}/rpc`), sockets.join("\n"));
});

test("repository action attributes keep carriage returns, and Monitor and Remove work with them", { skip: !built }, async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "review-canvas-cr-repository-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "line\rbreak");
  mkdirSync(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitEnvironment({}), stdio: "ignore" });
  const server = await startServer({ repositoryRoots: [directory] });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/repositories`);
  await loaded(page);
  const accept = page.locator("[data-repository-action='accept']");
  assert.equal(await accept.getAttribute("data-root"), root);
  assert.equal(await accept.getAttribute("data-id"), `local:${join(root, ".git")}`);
  await accept.click();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  await page.locator("[data-repository-action='remove']").click();
  await page.getByText("0 monitored", { exact: true }).waitFor();
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
  await page.goto(`${server.origin}/repositories`);
  await loaded(page);
  const repository = page.locator("[data-repository]").filter({ has: page.getByRole("heading", { name: "owner/alpha github.com", exact: true }) });
  assert.equal(await page.locator("[data-repository]").count(), 4);
  assert.equal(await repository.locator("[data-checkout]").count(), 2);
  // The repository counts its pull-request reviews, titled by them; the Reviews section opens them.
  assert.equal(await page.locator("[data-repository] [title='Demo PR']").count(), 1);
  assert.equal(await repository.getByRole("img", { name: "Demo PR", exact: true }).textContent(), "1");
  await repository.getByRole("button", { name: "Monitor github.com/owner/alpha", exact: true }).click();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  await server.stop();
  await server.start();
  await page.reload();
  await page.getByText("1 monitored", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-repository] [title='Demo PR']").count(), 1);
  await page.goto(server.origin);
  assert.equal(await page.getByRole("link", { name: "Demo PR", exact: true }).getAttribute("href"), `/reviews/${agent.review}`);
  await page.getByRole("link", { name: "Demo PR", exact: true }).click();
  await page.locator("[data-round-current]").getByText("Round 1 · open", { exact: true }).waitFor();
});
