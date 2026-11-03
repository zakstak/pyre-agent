// The review page's guide progress and "since my last review" in Chromium against a real server: stops read on the
// server and marked changed by a later round, and a review of only what changed since the reviewer last finished,
// with an earlier round's whole diff from the rounds line. Run after `pnpm build`: pnpm test:browser. reading.test.ts
// covers when the page reads a stop.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import {
  built,
  changedStore,
  fixtureInput,
  type Server,
  startServer,
} from "./harness.ts";

let server: Server;
let browser: Browser;

/** Two frames, so the page's first scroll-spy pass and focus moves have run. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** A new page in a browser context of its own, once the review shows its stops. */
const open = async (url: string) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(url);
  await page
    .locator("section[data-stop]")
    .first()
    .waitFor({ state: "attached" });
  await settle(page);
  return page;
};

const onRound = (page: Page, round: number) =>
  page
    .locator("[data-round-current]")
    .filter({ hasText: new RegExp(`^Round ${round} · `) })
    .waitFor();

const text = async (page: Page, selector: string) =>
  ((await page.locator(selector).first().textContent()) ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Each stop's reading as the contents mark it, by stop. */
const readings = (page: Page) =>
  page
    .locator("[data-stop-link]")
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLElement).dataset.read),
    );

/** Longer than the page waits before a stop kept on screen is read. */
const DWELL = 2600;

/** Marks a stop read through its own Mark read, and waits until the contents show it read. */
const markRead = async (page: Page, stop: number) => {
  await page
    .locator(`section[data-stop='${stop}'] [data-mark-read='${stop}']`)
    .click();
  await page.locator(`[data-stop-link='${stop}'][data-read='read']`).waitFor();
};

/** The paths of the file blocks the page shows, in order. */
const shownFiles = (page: Page) =>
  page
    .locator("main article[data-path]")
    .evaluateAll((articles) =>
      articles.map((article) => (article as HTMLElement).dataset.path),
    );

/** A patch's new side, as the whole text of a file whose first hunk starts at line 1. */
const newSide = (patch: string) =>
  `${patch
    .split("\n")
    .filter((row) => row.startsWith(" ") || row.startsWith("+"))
    .map((row) => row.slice(1))
    .join("\n")}\n`;

describe(
  "guide progress and since my last review",
  {
    skip: !built && "run pnpm build first",
  },
  () => {
    before(async () => {
      server = await startServer();
      browser = await chromium.launch();
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("read stops stay read on the server, and a round that changes a read stop's file marks it changed until it is read again", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      assert.equal(
        await text(page, "[data-contents] [data-read-count]"),
        "0 of 3 stops read",
      );
      // The reviewer marks the first two stops read, and goes back to the top, where the third is out of view.
      await markRead(page, 0);
      await markRead(page, 1);
      await page.evaluate(() => scrollTo(0, 0));
      assert.deepEqual(await readings(page), ["read", "read", "unread"]);
      assert.equal(
        await text(page, "[data-contents] [data-read-count]"),
        "2 of 3 stops read",
      );
      // A reload, and a second browser context that never saw the page, show the same reading.
      await page.reload();
      await page.locator("[data-stop-link='1'][data-read='read']").waitFor();
      assert.deepEqual(await readings(page), ["read", "read", "unread"]);
      const second = await open(agent.url);
      await second.locator("[data-stop-link='0'][data-read='read']").waitFor();
      assert.deepEqual(await readings(second), ["read", "read", "unread"]);

      // Round 2 changes store.py, which the first stop owns: that stop is changed and names it; the second stays read.
      await agent.publish(changedStore(input));
      await onRound(second, 2);
      await second
        .locator("[data-stop-link='0'][data-read='changed']")
        .waitFor();
      assert.deepEqual(await readings(second), ["changed", "read", "unread"]);
      assert.equal(
        await text(second, "[data-stop-link='0'] [data-changed-files]"),
        "changed: store.py",
      );
      assert.equal(
        await text(second, "[data-contents] [data-read-count]"),
        "1 of 3 stops read",
      );
      assert.equal(
        await text(second, "section[data-stop='0'] [data-stop-changed] p"),
        "Changed since you read it in round 1: store.py",
      );
      assert.equal(
        await second
          .locator("section[data-stop='0'] [data-changed-file]")
          .getAttribute("data-changed-file"),
        "src/notes/store.py",
      );
      assert.equal(
        await second
          .locator("section[data-stop='1'] [data-stop-changed]")
          .count(),
        0,
      );
      // Moving past the changed stop and back to it, and keeping it on screen, does not read it again: the page keeps
      // saying what changed until Mark read.
      await second.keyboard.press("j");
      await second.keyboard.press("k");
      await settle(second);
      await second.waitForTimeout(DWELL);
      assert.deepEqual(await readings(second), ["changed", "read", "unread"]);
      // The source view's guide shows the same. From the top of the page, where its diff has not reached a file yet,
      // so the view's own scroll-spy reads no other stop.
      await second.evaluate(() => scrollTo(0, 0));
      await settle(second);
      await second
        .locator("[role='group'][aria-label='View'] button[data-view='source']")
        .click();
      await second.locator("#guide-stop-1[data-read='changed']").waitFor();
      assert.equal(
        await text(second, "#guide-stop-1 [data-stop-changed] p"),
        "Changed since you read it in round 1: store.py",
      );
      assert.equal(
        await text(second, "[data-guide] [data-read-count]"),
        "1 of 3 stops read",
      );
      await second.locator("#guide-stop-1 [data-mark-read='0']").click();
      await second.locator("#guide-stop-1[data-read='read']").waitFor();
      assert.equal(
        await second.locator("#guide-stop-1 [data-stop-changed]").count(),
        0,
      );
      await second.locator("button[data-view='guided']").click();
      await second.locator("section[data-stop]").first().waitFor();
      // Reading it again reached every page: the first page shows it read too.
      await onRound(page, 2);
      await page.locator("[data-stop-link='0'][data-read='read']").waitFor();
      assert.deepEqual((await readings(page)).slice(0, 2), ["read", "read"]);
      await page.close();
      await second.close();
    });

    test("Mark read on a changed stop in the guided view reads it again", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      await markRead(page, 0);
      await agent.publish(changedStore(input));
      await onRound(page, 2);
      const mark = page.locator("section[data-stop='0'] [data-mark-read='0']");
      await mark.waitFor();
      await mark.click();
      await page.locator("[data-stop-link='0'][data-read='read']").waitFor();
      assert.equal(
        await page
          .locator("section[data-stop='0'] [data-stop-changed]")
          .count(),
        0,
      );
      await page.close();
    });

    /**
     * Round 1 with store.py's whole text, and round 2 in which store.py gains a line, legacy.py changes without a stored
     * text, and cli.py is deleted; every other file is as it was.
     */
    const rounds = () => {
      const first = fixtureInput();
      for (const file of first.files)
        if (file.path === "src/notes/store.py")
          file.new_content = newSide(file.patch);
      const changed = changedStore(first);
      const second = {
        ...changed,
        files: changed.files.map((file: any) =>
          file.path === "src/notes/store.py"
            ? { ...file, new_content: newSide(file.patch) }
            : file.path === "src/notes/legacy.py"
              ? {
                  ...file,
                  fingerprint: "2".repeat(64),
                  patch: file.patch.replace("au lait", "noir"),
                }
              : file.path === "src/notes/cli.py"
                ? { ...file, status: "deleted", fingerprint: "3".repeat(64) }
                : file,
        ),
      };
      return { first, second };
    };

    test("after a finished round 1, the control shows only round 2's changes, folds the rest, and stays on across a reload", async () => {
      const { first, second } = rounds();
      const agent = await server.register(first);
      await agent.publish(first);
      const page = await open(agent.url);
      // No earlier round yet: no control.
      assert.equal(await page.locator("[data-since]").count(), 0);
      // A comment on store.py, sent by finishing round 1.
      await page
        .locator(
          "table[data-path='src/notes/store.py'][data-patch] tr[data-row='13'] button[data-add-comment]",
        )
        .click();
      await page.keyboard.type("Lock before the rename.");
      await page.keyboard.press("Control+Enter");
      await page.locator("article[data-comment]").first().waitFor();
      await page.locator("#finish button[type=submit]").click();
      await page.locator("#finish [data-submission]").waitFor();
      const published = await agent.publish(second);
      assert.equal(published.ok, true, JSON.stringify(published));
      await onRound(page, 2);
      const all = await shownFiles(page);
      assert.equal(all.length, first.files.length);

      const control = page.locator("input[data-since-last-review]");
      assert.equal(
        await text(page, "[data-since] label"),
        "Only changes since your last review, in round 1",
      );
      assert.equal(await control.isChecked(), false);
      await control.check();
      await page.locator("[data-since-summary]").waitFor();
      assert.equal(
        await text(page, "[data-since-summary]"),
        "3 files changed · 7 unchanged",
      );
      // Only the files that changed since round 1 show; the others fold into each stop's disclosure.
      assert.deepEqual(await shownFiles(page), [
        "src/notes/store.py",
        "src/notes/cli.py",
        "src/notes/legacy.py",
      ]);
      // store.py shows its change since round 1, and nothing older.
      const store = page.locator("article[data-path='src/notes/store.py']");
      assert.equal(
        await text(
          page,
          "article[data-path='src/notes/store.py'] [data-since-note]",
        ),
        "Changes since round 1",
      );
      const since = store.locator("table[data-table$='-since']");
      assert.deepEqual(
        await since
          .locator("tr[data-kind='add'] td:last-child")
          .allTextContents(),
        ["import fcntl"],
      );
      assert.equal(await since.locator("tr[data-kind='del']").count(), 0);
      assert.equal(await store.locator("table[data-patch]").count(), 0);
      // Its thread and Viewed control show as usual.
      assert.equal(
        await store
          .locator("[data-since-threads] article[data-comment]")
          .count(),
        1,
      );
      assert.equal(await store.locator("button[data-viewed]").count(), 1);
      // A file that cannot be compared says why, over its whole change.
      assert.equal(
        await text(
          page,
          "article[data-path='src/notes/legacy.py'] [data-since-note]",
        ),
        "Can’t compare with round 1: a round did not keep this file's whole text. This is its whole change.",
      );
      assert.equal(
        await text(
          page,
          "article[data-path='src/notes/cli.py'] [data-since-note]",
        ),
        "Can’t compare with round 1: the file is deleted now, so there is no text to compare. This is its whole change.",
      );
      // The second stop's unchanged file is behind its disclosure until it opens.
      const unchanged = page.locator("section[data-stop='1'] [data-unchanged]");
      assert.equal(
        await text(page, "section[data-stop='1'] [data-unchanged] button"),
        "1 unchanged file since round 1",
      );
      assert.equal(
        await page.locator("article[data-path='src/notes/format.py']").count(),
        0,
      );
      await unchanged.locator("button").click();
      await page.locator("article[data-path='src/notes/format.py']").waitFor();
      assert.equal(
        await text(page, "section[data-stop='2'] [data-unchanged] button"),
        "6 unchanged files since round 1",
      );

      // The setting holds across a reload.
      await page.reload();
      await page.locator("[data-since-summary]").waitFor();
      assert.equal(await control.isChecked(), true);
      assert.deepEqual(await shownFiles(page), [
        "src/notes/store.py",
        "src/notes/cli.py",
        "src/notes/legacy.py",
      ]);
      // Going to an unchanged file from the contents opens its disclosure.
      await page.locator("[data-toc-file='src/notes/format.py']").click();
      await page.locator("article[data-path='src/notes/format.py']").waitFor();

      // Off again, every file shows its whole change.
      await control.uncheck();
      await page.locator("[data-since-summary]").waitFor({ state: "detached" });
      assert.equal((await shownFiles(page)).length, first.files.length);
      assert.equal(await page.locator("[data-since-note]").count(), 0);
      await page.close();
    });

    test("an earlier round's whole diff opens read-only from the rounds line", async () => {
      const { first, second } = rounds();
      const agent = await server.register(first);
      await agent.publish(first);
      await agent.publish(second);
      const page = await open(agent.url);
      await onRound(page, 2);
      // Without a finished review, the control compares with the round before, and says so.
      assert.equal(
        await text(page, "[data-since] label"),
        "Only changes since round 1",
      );
      const round = page.locator("button[aria-controls='round-1-detail']");
      await round.click();
      const toggle = page.locator("[data-round-diff-toggle='1']");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      const diff = page.locator("[data-round-diff='1']");
      await diff.waitFor();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(
        await diff.locator("[data-round-file]").count(),
        first.files.length,
      );
      // Round 1's store.py, without the line round 2 added, and with nothing to comment on.
      const store = diff.locator("[data-round-file='src/notes/store.py']");
      const rows = await store
        .locator("tr[data-kind]")
        .evaluateAll((items) => items.map((item) => item.textContent ?? ""));
      assert.ok(rows.some((row) => row.includes("import tempfile")));
      assert.ok(!rows.some((row) => row.includes("import fcntl")));
      assert.equal(await diff.locator("button, textarea").count(), 0);
      assert.match(
        await text(page, "[data-round-file='docs/logo.png']"),
        /binary file; there is no text to show/,
      );
      await toggle.click();
      await diff.waitFor({ state: "detached" });
      await page.close();
    });
  },
);
