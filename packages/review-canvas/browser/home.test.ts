import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { built, fixtureInput, startServer } from "./harness.ts";

test("the home page lists open reviews by default, a chip shows the closed ones, and a search narrows the list", { skip: !built }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  // A worktree review closed by a fresh start, the open one that replaced it, and an open pull request review.
  const input = fixtureInput();
  await (await server.register(input)).publish(input);
  await server.register(input, "Codex: fresh start", { fresh: true });
  const pr = fixtureInput();
  pr.target = {
    kind: "github_pr", title: "Demo PR", url: "https://github.com/acme/ledger/pull/55",
    head_sha: pr.target.head_sha, changed_files: pr.files.length,
  };
  await (await server.register(pr)).publish(pr);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const rows = page.locator("li[data-standing]");
  await page.goto(server.origin);
  await page.getByRole("heading", { name: "Reviews" }).waitFor();
  assert.equal(await page.getByLabel("Filter reviews").inputValue(), "is:open");
  assert.equal(await rows.count(), 2);
  assert.equal(await page.locator("[data-standing-filter='open']").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("[data-standing-filter='closed']").textContent(), "Closed 1");
  // The repositories live on their own page now.
  assert.equal(await page.locator("[data-repositories]").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Repositories" }).getAttribute("href"), "/repositories");

  await page.goto(`${server.origin}/?q=is:closed`);
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.getAttribute("data-standing"), "closed");
  assert.equal(await page.locator("[data-standing-filter='closed']").getAttribute("aria-pressed"), "true");
  await page.getByText("1 of 3 reviews shown").waitFor();

  // A chip replaces the query's is: term and keeps the rest.
  await page.getByLabel("Filter reviews").fill("is:closed demo");
  await page.getByText("No reviews match.", { exact: true }).waitFor();
  await page.locator("[data-standing-filter='open']").click();
  assert.equal(await page.getByLabel("Filter reviews").inputValue(), "is:open demo");
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.getByRole("link").textContent(), "Demo PR");
  await page.waitForURL(/[?&]q=is%3Aopen\+demo(&|$)/);
  await page.reload();
  assert.equal(await page.getByLabel("Filter reviews").inputValue(), "is:open demo");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1);

  // Clearing the field shows every review, and the empty query stays across a reload.
  await page.getByLabel("Filter reviews").fill("");
  await page.getByText("3 of 3 reviews shown").waitFor();
  assert.equal(await page.locator("[data-standing-filter][aria-pressed='true']").count(), 0);
  await page.reload();
  await page.getByText("3 of 3 reviews shown").waitFor();
  assert.equal(await page.getByLabel("Filter reviews").inputValue(), "");
  await page.getByLabel("Filter reviews").fill("-author:codex");
  await page.getByText("2 of 3 reviews shown").waitFor();
});
