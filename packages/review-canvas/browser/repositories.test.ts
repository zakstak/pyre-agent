import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { gitEnvironment } from "../src/collector/git.ts";
import { built, fixtureInput, startServer } from "./harness.ts";

/** The page renders after its socket connects and the server answers: wait for the repositories section. */
const loaded = (page: Page) => page.locator("[data-repositories]").waitFor();

test(
  "the repositories page discovers without enrollment, monitors explicitly, keeps the filter in the URL, and removes missing repos",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "review-canvas-repository-browser-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const alpha = join(directory, "alpha");
    for (const name of ["alpha", "beta<script>"]) {
      const root = join(directory, name);
      mkdirSync(root);
      execFileSync("git", ["init", "-b", "main"], {
        cwd: root,
        env: gitEnvironment({}),
        stdio: "ignore",
      });
    }
    const alphaCopy = join(directory, "renamed-copy");
    mkdirSync(alphaCopy);
    execFileSync("git", ["init", "-b", "main"], {
      cwd: alphaCopy,
      env: gitEnvironment({}),
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Owner/Alpha.git"],
      { cwd: alpha, env: gitEnvironment({}), stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/owner/alpha.git"],
      { cwd: alphaCopy, env: gitEnvironment({}), stdio: "ignore" },
    );
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
    assert.equal(await page.locator("[data-checkout]:visible").count(), 0);
    const alphaRow = page.locator("[data-repository]").filter({
      has: page.getByRole("button", {
        name: "Checkouts for github.com/owner/alpha",
        exact: true,
      }),
    });
    await alphaRow
      .getByRole("button", {
        name: "Checkouts for github.com/owner/alpha",
        exact: true,
      })
      .click();
    assert.equal(await alphaRow.locator("[data-checkout]:visible").count(), 2);
    // Found repositories are grouped apart, with a Monitor button and no monitoring until it is pressed.
    assert.equal(
      await page
        .getByRole("button", { name: "Add repository", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await page
        .locator("[data-repository][data-monitoring='discovered']")
        .count(),
      2,
    );
    assert.equal(await page.locator("[data-repository] script").count(), 0);
    await page.getByLabel("Filter repositories").fill("alpha");
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    await page
      .getByRole("button", {
        name: "Monitor github.com/owner/alpha",
        exact: true,
      })
      .click();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Filter repositories").inputValue(),
      "alpha",
    );
    // The filter text lives in the URL, written a moment after the typing stops, so it stays after a reload.
    await page.waitForURL(/[?&]q=alpha(&|$)/);
    await page.reload();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Filter repositories").inputValue(),
      "alpha",
    );
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    // An older link's filter still applies, with no control for it.
    await page.goto(`${server.origin}/repositories?filter=monitored`);
    await page.getByText("1 monitored", { exact: true }).waitFor();
    assert.equal(await page.locator("select").count(), 0);
    await page.getByLabel("Filter repositories").fill("not present");
    await page
      .getByText("No repositories match this filter.", { exact: true })
      .waitFor();
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
    execFileSync("git", ["init", "-b", "feature"], {
      cwd: laterCopy,
      env: gitEnvironment({}),
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:owner/alpha.git"],
      { cwd: laterCopy, env: gitEnvironment({}), stdio: "ignore" },
    );
    await page.reload();
    await loaded(page);
    assert.equal(await page.locator("[data-checkout]:visible").count(), 0);
    await alphaRow
      .getByRole("button", {
        name: "Checkouts for github.com/owner/alpha",
        exact: true,
      })
      .click();
    assert.equal(await alphaRow.locator("[data-checkout]:visible").count(), 3);
    await page.getByLabel("Filter repositories").fill("feature");
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    assert.equal(await page.locator("[data-checkout]:visible").count(), 1);
    await page
      .locator("[data-checkout]:visible")
      .getByText("feature", { exact: true })
      .waitFor();
    await page.getByLabel("Filter repositories").fill("");
    assert.equal(await page.locator("[data-checkout]:visible").count(), 0);
    writeFileSync(join(alpha, "new"), "new\n");
    await page.reload();
    await loaded(page);
    await alphaRow.getByText(/1 with changes/).waitFor();
    await page.goto(`${server.origin}/repositories?filter=changed`);
    await loaded(page);
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    rmSync(alpha, { recursive: true, force: true });
    await page.goto(`${server.origin}/repositories?filter=unavailable`);
    await loaded(page);
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    await page
      .locator("[data-repository]:visible")
      .getByText("missing", { exact: true })
      .waitFor();
    await page
      .getByRole("button", {
        name: "Remove github.com/owner/alpha",
        exact: true,
      })
      .click();
    await page.getByText("0 monitored", { exact: true }).waitFor();
    await page.goto(`${server.origin}/repositories?filter=discovered`);
    await loaded(page);
    assert.equal(await page.locator("[data-repository]:visible").count(), 2);
    assert.ok(
      requests.every((url) => url.startsWith(server.origin + "/")),
      requests.join("\n"),
    );
    // The page's one socket goes to the same server.
    assert.ok(
      sockets.length > 0 &&
        sockets.every(
          (url) => url === `${server.origin.replace(/^http/, "ws")}/rpc`,
        ),
      sockets.join("\n"),
    );
  },
);

test(
  "repository action attributes keep carriage returns, and Monitor and Remove work with them",
  { skip: !built },
  async (t) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "review-canvas-cr-repository-")),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, "line\rbreak");
    mkdirSync(root);
    execFileSync("git", ["init", "-b", "main"], {
      cwd: root,
      env: gitEnvironment({}),
      stdio: "ignore",
    });
    const server = await startServer({ repositoryRoots: [directory] });
    t.after(() => server.stop());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/repositories`);
    await loaded(page);
    const accept = page.locator("[data-repository-action='accept']");
    assert.equal(await accept.getAttribute("data-root"), root);
    assert.equal(
      await accept.getAttribute("data-id"),
      `local:${join(root, ".git")}`,
    );
    await accept.click();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Checkouts for / }).click();
    await page.locator("[data-repository-action='remove']").click();
    await page.getByText("0 monitored", { exact: true }).waitFor();
  },
);

test(
  "PR reviews belong to one repository across copies, separate from forks and hosts, and survive restart",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "review-canvas-pr-repository-browser-"),
    );
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
      execFileSync("git", ["init", "-b", "main"], {
        cwd: root,
        env: gitEnvironment({}),
        stdio: "ignore",
      });
      execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: root,
        env: gitEnvironment({}),
        stdio: "ignore",
      });
    }
    const server = await startServer({ repositoryRoots: [directory] });
    t.after(() => server.stop());
    const input = fixtureInput();
    input.target = {
      kind: "github_pr",
      title: "Demo PR",
      url: "https://github.com/OWNER/ALPHA/pull/55",
      head_sha: input.target.head_sha,
      changed_files: input.files.length,
    };
    const agent = await server.register(input);
    const published = await agent.publish(input);
    assert.equal(published.ok, true, JSON.stringify(published));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/repositories`);
    await loaded(page);
    const repository = page.locator("[data-repository]").filter({
      has: page.getByRole("button", {
        name: "Checkouts for github.com/owner/alpha",
        exact: true,
      }),
    });
    assert.equal(await page.locator("[data-repository]").count(), 4);
    assert.equal(
      await repository.locator("[data-checkout]:visible").count(),
      0,
    );
    await repository
      .getByRole("button", {
        name: "Checkouts for github.com/owner/alpha",
        exact: true,
      })
      .click();
    assert.equal(
      await repository.locator("[data-checkout]:visible").count(),
      2,
    );
    // The repository counts its pull-request reviews, titled by them; the Reviews section opens them.
    assert.equal(
      await page.locator("[data-repository] [title='Demo PR']").count(),
      1,
    );
    assert.equal(
      await repository
        .getByRole("img", { name: "Demo PR", exact: true })
        .textContent(),
      "1",
    );
    await repository
      .getByRole("button", {
        name: "Monitor github.com/owner/alpha",
        exact: true,
      })
      .click();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    await server.stop();
    await server.start();
    await page.reload();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    assert.equal(
      await page.locator("[data-repository] [title='Demo PR']").count(),
      1,
    );
    await page.goto(server.origin);
    assert.equal(
      await page
        .getByRole("link", { name: "Demo PR", exact: true })
        .getAttribute("href"),
      `/reviews/${agent.review}`,
    );
    await page.getByRole("link", { name: "Demo PR", exact: true }).click();
    await page
      .locator("[data-round-current]")
      .getByText("Round 1 · open", { exact: true })
      .waitFor();
  },
);

test(
  "repository summaries stay compact, reveal matching and missing checkouts, and expose discovery by keyboard or settings link",
  { skip: !built },
  async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "review-canvas-compact-repositories-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const missingRoot = join(directory, "copy-9");
    const copies = Array.from({ length: 12 }, (_, at) =>
      join(directory, `copy-${at}`),
    );
    for (const [at, root] of copies.entries()) {
      mkdirSync(root);
      execFileSync(
        "git",
        ["init", "-b", at === 0 ? "unique-feature" : "main"],
        { cwd: root, env: gitEnvironment({}), stdio: "ignore" },
      );
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/example/project.git"],
        { cwd: root, env: gitEnvironment({}), stdio: "ignore" },
      );
    }
    writeFileSync(join(directory, "copy-0", "change.txt"), "Example change\n");
    const other = join(directory, "other");
    mkdirSync(other);
    execFileSync("git", ["init", "-b", "main"], {
      cwd: other,
      env: gitEnvironment({}),
      stdio: "ignore",
    });
    const server = await startServer({ repositoryRoots: [directory] });
    t.after(() => server.stop());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/settings/repositories`);
    await page
      .getByRole("button", {
        name: "Monitor github.com/example/project",
        exact: true,
      })
      .click();
    await page.getByText("1 monitored", { exact: true }).waitFor();
    rmSync(missingRoot, { recursive: true, force: true });
    await page.reload();
    await loaded(page);
    const summary = page.getByRole("button", {
      name: "Checkouts for github.com/example/project",
      exact: true,
    });
    const add = page.getByRole("button", {
      name: "Add repository",
      exact: true,
    });
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    assert.equal(await add.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("[data-repository]:visible").count(), 1);
    assert.equal(await page.locator("[data-checkout]:visible").count(), 0);
    await summary.getByText(/12 checkouts.*1 missing/).waitFor();
    await t.test(
      "collapsed summaries expose checkout, changed, and missing counts to assistive technology",
      async () => {
        const session = await page.context().newCDPSession(page);
        try {
          const { root } = await session.send("DOM.getDocument");
          const { nodeId } = await session.send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: "[data-repository] h3 button",
          });
          const { nodes } = await session.send(
            "Accessibility.getPartialAXTree",
            { nodeId, fetchRelatives: false },
          );
          assert.equal(
            nodes[0]?.name?.value,
            "Checkouts for github.com/example/project",
          );
          assert.match(
            nodes[0]?.description?.value ?? "",
            /12 checkouts.*1 with changes.*1 missing/,
          );
        } finally {
          await session.detach();
        }
      },
    );
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("[data-checkout]:visible").count(), 11);
    const missing = page.getByRole("button", {
      name: "Missing checkouts (1)",
      exact: true,
    });
    assert.equal(await missing.getAttribute("aria-expanded"), "false");
    await missing.click();
    await page
      .locator("[data-checkout]:visible")
      .getByText("missing", { exact: true })
      .waitFor();
    assert.equal(await page.locator("[data-checkout]:visible").count(), 12);
    await page.getByLabel("Filter repositories").fill("unique-feature");
    assert.equal(await page.locator("[data-checkout]:visible").count(), 1);
    await page
      .locator("[data-checkout]:visible")
      .getByText("unique-feature", { exact: true })
      .waitFor();
    await page.getByLabel("Filter repositories").fill(missingRoot);
    assert.equal(await page.locator("[data-checkout]:visible").count(), 1);
    await page
      .locator("[data-checkout]:visible")
      .getByText("missing", { exact: true })
      .waitFor();
    await page.getByLabel("Filter repositories").fill("");
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    assert.equal(await add.getAttribute("aria-expanded"), "false");
    // Clearing the search restores the compact view; missing paths remain recorded across restart.
    await server.stop();
    await server.start();
    await page.reload();
    await summary.getByText(/12 checkouts.*1 missing/).waitFor();

    for (const theme of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.theme = mode;
      }, theme);
      for (const scale of [100, 200]) {
        await page.evaluate((percent) => {
          document.documentElement.style.fontSize = `${percent}%`;
        }, scale);
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            `${theme} ${scale}% ${width}px collapsed`,
          );
          await summary.click();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            `${theme} ${scale}% ${width}px expanded`,
          );
          await summary.click();
          await add.click();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            `${theme} ${scale}% ${width}px discovery`,
          );
          await add.click();
        }
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await add.focus();
    await page.keyboard.press("Space");
    await page
      .getByRole("list", { name: "Available repositories", exact: true })
      .waitFor();
    await page
      .getByRole("list", { name: "Available repositories", exact: true })
      .getByRole("button", { name: /^Monitor / })
      .focus();
    await page.keyboard.press("Enter");
    await page.getByText("2 monitored", { exact: true }).waitFor();
    await page.reload();
    await loaded(page);
    assert.equal(await add.getAttribute("aria-expanded"), "false");
    await page.locator("[data-settings-search]").fill("add repository");
    await page
      .locator("[data-settings-results]")
      .getByRole("link", { name: "Add repository Repositories", exact: true })
      .click();
    await page.waitForURL(/#found$/);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#found button")
          ?.getAttribute("aria-expanded") === "true",
    );
    assert.equal(await add.getAttribute("aria-expanded"), "true");
    await t.test(
      "the same Add repository result reopens its closed disclosure",
      async () => {
        await add.click();
        await page
          .locator("[data-settings-results]")
          .getByRole("link", {
            name: "Add repository Repositories",
            exact: true,
          })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("#found button")
              ?.getAttribute("aria-expanded") === "true",
          undefined,
          { timeout: 2000 },
        );
      },
    );
    await page.locator("[data-settings-search]").fill("scan");
    await page
      .locator("[data-settings-results]")
      .getByRole("link", { name: "Scan directories Repositories", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#scan button")
          ?.getAttribute("aria-expanded") === "true",
    );
    await t.test(
      "the same Scan directories result reopens its closed disclosure",
      async () => {
        await page
          .getByRole("button", { name: "Scan directories", exact: true })
          .click();
        await page
          .locator("[data-settings-results]")
          .getByRole("link", {
            name: "Scan directories Repositories",
            exact: true,
          })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("#scan button")
              ?.getAttribute("aria-expanded") === "true",
          undefined,
          { timeout: 2000 },
        );
      },
    );
    await t.test(
      "removing the last monitored repository opens discovery",
      async () => {
        await page.goto(`${server.origin}/settings/repositories`);
        await loaded(page);
        assert.equal(await add.getAttribute("aria-expanded"), "false");
        for (const remaining of [1, 0]) {
          const row = page
            .locator("[data-repository][data-monitoring='monitored']")
            .first();
          await row.getByRole("button", { name: /^Checkouts for / }).click();
          await row.getByRole("button", { name: /^Remove / }).click();
          await page
            .getByText(`${remaining} monitored`, { exact: true })
            .waitFor();
        }
        await page.waitForFunction(
          () =>
            document
              .querySelector("#found button")
              ?.getAttribute("aria-expanded") === "true",
          undefined,
          { timeout: 2000 },
        );
        assert.equal(
          await page
            .getByRole("list", { name: "Available repositories", exact: true })
            .isVisible(),
          true,
        );
      },
    );
  },
);
