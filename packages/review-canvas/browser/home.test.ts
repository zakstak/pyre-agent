import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { built, fixtureInput, startServer } from "./harness.ts";

for (const [provider, route, number, fragment] of [
  ["github", "pull", "#42", "issuecomment-1"],
  ["gitlab", "-/merge_requests", "!42", "note_1"],
  ["gitea", "pulls", "#42", "issuecomment-1"],
] as const) {
  test(
    `${provider}: private reviews show their host, filter by repository, and open the correct review URL`,
    { skip: !built },
    async (t) => {
      const server = await startServer();
      t.after(() => server.stop());
      const input = fixtureInput();
      const url = `https://git.something.company.com/team/project/${route}/42`;
      input.target = {
        kind: "pull_request",
        provider,
        title: "Corporate review",
        url,
        head_sha: input.target.head_sha,
        changed_files: input.files.length,
      };
      const agent = await server.register(input);
      assert.equal((await agent.publish(input)).ok, true);
      const imported = await agent.call("POST", "/github", {
        pull_request: url,
        items: [
          {
            kind: "conversation",
            id: "corporate_1",
            author: "employee.name",
            url: `${url}#${fragment}`,
            body: "Corporate comment",
            created_at: "2026-10-15T12:00:00.000Z",
          },
        ],
      });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      await page.goto(server.origin);
      await page
        .getByRole("link", { name: "Corporate review", exact: true })
        .waitFor();
      await page
        .getByLabel("Filter reviews")
        .fill("repo:git.something.company.com/team/project");
      await page
        .getByRole("link", { name: "Corporate review", exact: true })
        .click();
      await page
        .getByRole("link", {
          name: "Open on git.something.company.com",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("link", {
            name: "Open on git.something.company.com",
            exact: true,
          })
          .getAttribute("href"),
        url,
      );
      await page.getByText(number, { exact: true }).waitFor();
      await page
        .getByText("on git.something.company.com", { exact: true })
        .waitFor();
      await page.getByText("Corporate comment", { exact: true }).waitFor();
    },
  );
}

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
  await page.locator("[data-standing-filter='open']").waitFor();
  assert.equal(await page.getByLabel("Filter reviews").inputValue(), "is:open");
  assert.equal(await rows.count(), 2);
  assert.equal(await page.locator("[data-standing-filter='open']").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("[data-standing-filter='closed']").textContent(), "Closed 1");
  // The repositories live on the settings page.
  assert.equal(await page.locator("[data-repositories]").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Settings" }).getAttribute("href"), "/settings");

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

test("the filter menus write repo: and author: terms into the query and read them back", { skip: !built }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  // As above: a closed worktree review by Claude Code, its open fresh start by Codex, and an open pull request review.
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
  const field = page.getByLabel("Filter reviews");
  const repo = page.locator("[data-filter-menu='repo']");
  await page.goto(server.origin);
  await rows.first().waitFor();
  assert.equal(await repo.getAttribute("data-active"), null);

  // Picking a value includes it; the menu stays open.
  await repo.click();
  // Opening focuses the first row: the worktree's folder, which two reviews carry, one of them open.
  const focused = () => page.evaluate(() => document.activeElement?.textContent);
  const first = `${input.target.root.split("/").at(-1)}1`;
  assert.equal(await page.locator("button[data-row]").first().textContent(), first);
  // The popup moves focus a frame after it opens.
  await page.locator("button[data-row]:focus").waitFor();
  assert.equal(await focused(), first);
  const ledger = page.locator("button[data-row]", { hasText: "acme/ledger" });
  await ledger.click();
  assert.equal(await field.inputValue(), "is:open repo:acme/ledger");
  await page.getByText("1 of 3 reviews shown").waitFor();
  assert.equal(await rows.getByRole("link").textContent(), "Demo PR");
  assert.equal(await repo.getAttribute("data-active"), "");
  assert.equal(await ledger.getAttribute("aria-pressed"), "true");

  // Excluding it replaces the include, and the other open review shows.
  await page.getByRole("button", { name: "Exclude acme/ledger" }).click();
  assert.equal(await field.inputValue(), "is:open -repo:acme/ledger");
  await page.getByText("1 of 3 reviews shown").waitFor();
  assert.notEqual(await rows.getByRole("link").textContent(), "Demo PR");
  assert.equal(await page.getByRole("button", { name: "Exclude acme/ledger" }).getAttribute("aria-pressed"), "true");

  // Clear removes every repo: term and leaves focus on the first row; the arrows wrap and Alt+Enter excludes.
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  assert.equal(await field.inputValue(), "is:open");
  assert.equal(await repo.getAttribute("data-active"), null);
  assert.equal(await focused(), first);
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "acme/ledger1");
  await page.keyboard.press("Home");
  assert.equal(await focused(), first);
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "acme/ledger1");
  await page.keyboard.press("Alt+Enter");
  assert.equal(await field.inputValue(), "is:open -repo:acme/ledger");
  await page.keyboard.press("Alt+Enter");
  assert.equal(await field.inputValue(), "is:open");
  await page.keyboard.press("Escape");
  await page.locator("button[data-row]").first().waitFor({ state: "detached" });

  // Each author counts the open reviews they took part in.
  await page.locator("[data-filter-menu='author']").click();
  const codex = page.locator("li", { has: page.locator("button[data-row]", { hasText: "Codex" }) });
  assert.equal(await codex.locator("button[data-row] .tabular-nums").textContent(), "1");
  const claude = page.locator("button[data-row]", { hasText: "Claude Code" });
  assert.equal(await claude.locator(".tabular-nums").textContent(), "1");

  // An excluded author in the URL shows struck through.
  await page.goto(`${server.origin}/?q=is:open+-author:codex`);
  await page.getByText("1 of 3 reviews shown").waitFor();
  await page.locator("[data-filter-menu='author']").click();
  const struck = page.locator("button[data-row]", { hasText: "Codex" }).locator(".line-through");
  assert.equal(await struck.count(), 1);
  assert.equal(await page.getByRole("button", { name: "Exclude Codex" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("[data-filter-menu='author']").getAttribute("data-active"), "");
});
