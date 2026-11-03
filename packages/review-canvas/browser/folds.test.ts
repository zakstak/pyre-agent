// Folded code on the review page, in Chromium against a real server: changed rows outside the tour's excerpts fold
// behind a control of their own, never with unchanged lines; each file opens all its folds; the contents open or fold
// every file; and Viewed asks first while some of a file's changes were never shown. Run after `pnpm build`:
// pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { built, fixtureInput, type Server, startServer } from "./harness.ts";

let server: Server;
let browser: Browser;

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

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

const text = async (page: Page, selector: string) =>
  ((await page.locator(selector).first().textContent()) ?? "")
    .replace(/\s+/g, " ")
    .trim();

const BUILD = "build.ts";

/**
 * The fixture with build.ts (+8 −1) in a stop of its own: six imports added at its top, and the excerpt on its last
 * change, as the pull request the testers read had it.
 */
const withBuild = () => {
  const input = fixtureInput();
  input.files_complete = false;
  input.files.push({
    path: BUILD,
    status: "modified",
    group: "core",
    additions: 8,
    deletions: 1,
    fingerprint: "7".repeat(64),
    patch: [
      "@@ -1,8 +1,15 @@",
      " import a",
      "+import b",
      "+import c",
      "+import d",
      "+import e",
      "+import f",
      "+import g",
      " u1",
      " u2",
      " u3",
      " u4",
      " u5",
      "-old",
      "+new",
      "+newer",
      " u6",
      "",
    ].join("\n"),
  });
  input.stops.push({
    title: "The build",
    summary: "",
    attention: null,
    excerpts: [
      { path: BUILD, side: "new", start: 13, end: 14, caption: "The new step" },
    ],
    files: [],
    notes: [],
    questions: [],
  });
  return input;
};

describe("folds", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("changed rows the tour leaves out fold apart from unchanged lines, and say what they add and delete", async () => {
    const input = withBuild();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/${BUILD}`);
    const file = page.locator(`article[data-path='${BUILD}']`);
    const table = file.locator("table[data-patch]");
    await table.waitFor();
    // The six imports fold behind their own control, which counts them; the five unchanged lines behind the other.
    const changes = file.locator("button[data-expand-changes]");
    assert.equal(await changes.count(), 1);
    assert.equal(
      ((await changes.textContent()) ?? "").replace(/\s+/g, " ").trim(),
      "6 more changed lines (+6 −0)",
    );
    assert.equal(await changes.getAttribute("aria-expanded"), "false");
    const gap = file.locator("button[data-expand]");
    assert.equal(await gap.count(), 1);
    assert.equal(await gap.getAttribute("aria-label"), "Show 5 more lines");
    // The deletion and the additions around the excerpt show; no unchanged-lines control hides a change.
    assert.deepEqual(
      await table
        .locator("tr[data-kind='add'] td:last-child")
        .allTextContents(),
      ["new", "newer"],
    );
    assert.equal(await table.locator("tr[data-kind='del']").count(), 1);
    // The two controls read differently: the changes' in the warning tone, beside a warning rule.
    const look = (selector: string) =>
      file.locator(selector).evaluate((element) => {
        const cell = element.closest("td");
        return {
          color: getComputedStyle(element).color,
          rule: cell === null ? "" : getComputedStyle(cell).borderLeftStyle,
        };
      });
    const changesLook = await look("button[data-expand-changes]");
    const gapLook = await look("button[data-expand]");
    assert.notEqual(changesLook.color, gapLook.color);
    assert.equal(changesLook.rule, "solid");
    // Opened, the imports show under it, and it offers to hide them.
    await changes.click();
    assert.equal(await changes.getAttribute("aria-expanded"), "true");
    assert.equal(
      await text(
        page,
        `article[data-path='${BUILD}'] button[data-expand-changes]`,
      ),
      "Hide 6 changed lines",
    );
    assert.equal(await table.locator("tr[data-kind='add']").count(), 8);
    await changes.click();
    assert.equal(await table.locator("tr[data-kind='add']").count(), 2);
    await page.close();
  });

  test("Viewed asks first while changes were never shown, and shows them on request", async () => {
    const input = withBuild();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/${BUILD}`);
    const file = page.locator(`article[data-path='${BUILD}']`);
    await file.locator("table[data-patch]").waitFor();
    const viewed = file.locator("button[data-viewed]");
    const dialog = page.locator("[data-unseen-dialog]");
    await viewed.click();
    await dialog.waitFor();
    assert.equal(
      await text(page, "[data-unseen-dialog] h2"),
      "6 changed lines not shown yet",
    );
    assert.match(
      await text(page, "[data-unseen-dialog] p"),
      /^The page has not shown these lines of build\.ts \(\+6 −0\)\. Show them before you mark the file viewed\?$/,
    );
    // Show them opens the fold, and the file is not viewed.
    await dialog.locator("[data-show-unseen]").click();
    await dialog.waitFor({ state: "detached" });
    await file
      .locator("button[data-expand-changes][aria-expanded='true']")
      .waitFor();
    assert.equal(await file.locator("tr[data-kind='add']").count(), 8);
    assert.equal(await viewed.getAttribute("aria-pressed"), "false");
    assert.deepEqual((await agent.status()).approved, []);
    // Every change shown now, Viewed marks the file at once, even folded back.
    await file.locator("button[data-expand-changes]").click();
    await viewed.click();
    await file.locator("button[data-viewed][aria-pressed='true']").waitFor();
    assert.equal(await dialog.count(), 0);
    assert.deepEqual((await agent.status()).approved, [BUILD]);

    // A file the page folds showed none of its changes: marking it viewed asks, and Mark viewed anyway goes ahead.
    const windows = page.locator("article[data-path='tests/data/windows.txt']");
    assert.equal(await windows.getAttribute("data-folded"), "true");
    await windows.locator("button[data-viewed]").click();
    await dialog.waitFor();
    assert.equal(
      await text(page, "[data-unseen-dialog] h2"),
      "2 changed lines not shown yet",
    );
    await dialog.locator("[data-view-anyway]").click();
    await windows.locator("button[data-viewed][aria-pressed='true']").waitFor();
    assert.deepEqual((await agent.status()).approved.toSorted(), [
      BUILD,
      "tests/data/windows.txt",
    ]);
    await page.close();
  });

  test("a file's Expand all opens every fold of its diff, and Collapse all folds them back", async () => {
    const input = withBuild();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/${BUILD}`);
    const file = page.locator(`article[data-path='${BUILD}']`);
    const all = file.locator("button[data-expand-all]");
    assert.equal(
      await text(page, `article[data-path='${BUILD}'] button[data-expand-all]`),
      "Expand all",
    );
    await all.click();
    await file.locator("button[data-expand-all='open']").waitFor();
    assert.equal(
      await text(page, `article[data-path='${BUILD}'] button[data-expand-all]`),
      "Collapse all",
    );
    assert.equal(
      await file
        .locator("button[data-expand-changes][aria-expanded='false']")
        .count(),
      0,
    );
    assert.equal(
      await file.locator("button[data-expand][aria-expanded='false']").count(),
      0,
    );
    // Every row of the patch shows: the header, sixteen lines, and the deletion.
    assert.equal(await file.locator("tr[data-kind='add']").count(), 8);
    assert.equal(await file.locator("tr[data-kind='context']").count(), 7);
    await all.click();
    await file.locator("button[data-expand-all='folded']").waitFor();
    assert.equal(await file.locator("tr[data-kind='add']").count(), 2);
    // A folded file's Expand all opens the file too.
    await file.locator("button[data-fold]").click();
    assert.equal(await file.getAttribute("data-folded"), "true");
    await all.click();
    assert.equal(await file.getAttribute("data-folded"), "false");
    assert.equal(await file.locator("tr[data-kind='add']").count(), 8);
    // A file with nothing folded in its diff has no such control.
    assert.equal(
      await page
        .locator(
          "article[data-path='src/notes/cli.py'] button[data-expand-all]",
        )
        .count(),
      0,
    );
    await page.close();
  });

  test("Expand all files opens every file of the review, and Collapse all files folds them", async () => {
    const input = withBuild();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const folded = () =>
      page
        .locator("main article[data-path]:has(button[data-fold])")
        .evaluateAll((articles) =>
          articles.map((article) => (article as HTMLElement).dataset.folded),
        );
    // Files without an excerpt start folded.
    assert.ok((await folded()).includes("true"));
    const choices = page.locator("[data-contents]");
    await choices.locator("button[data-all-files='open']").click();
    await page.waitForFunction(
      () => document.querySelector("main article[data-folded='true']") === null,
    );
    assert.ok((await folded()).every((fold) => fold === "false"));
    await choices.locator("button[data-all-files='closed']").click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          "main article[data-folded='false']:has(button[data-fold])",
        ) === null,
    );
    assert.ok((await folded()).every((fold) => fold === "true"));
    // The choice holds across a reload, as the reviewer's own folds do.
    await page.reload();
    await page.locator("section[data-stop]").first().waitFor();
    await settle(page);
    assert.ok((await folded()).every((fold) => fold === "true"));
    await page.close();
  });
});
