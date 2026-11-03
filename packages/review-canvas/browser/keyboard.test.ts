// The whole review from the keyboard, in Chromium against a real server: files, threads, the line cursor and its
// selection, the composer, Viewed, the finish, and the key help. Run after `pnpm build`: pnpm test:browser.
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

const STORE = "src/notes/store.py";
const FORMAT = "src/notes/format.py";

/** What has focus: the file it is in, and the line, heading, or thread it is. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return {};
    return {
      file: element.closest("article[data-path]")?.getAttribute("data-path"),
      line: element
        .closest("[data-unit]")
        ?.getAttribute("data-new")
        ?.toString(),
      heading: element.matches("article[data-path] h3"),
      comment: element.closest("article[data-comment]")?.id,
      tag: element.tagName,
    };
  });

/** Waits until focus is on a line of a file's diff. */
const onLine = (page: Page, path: string, line: number) =>
  page.waitForFunction(
    ({ path, line }) => {
      const element = document.activeElement;
      return (
        element?.closest("article[data-path]")?.getAttribute("data-path") ===
          path &&
        element?.closest("[data-unit]")?.getAttribute("data-new") ===
          String(line)
      );
    },
    { path, line },
  );

/** Waits until focus is on a file's heading. */
const onHeading = (page: Page, path: string) =>
  page.waitForFunction(
    (path) =>
      document.activeElement?.matches(`article[data-path='${path}'] h3`) ===
      true,
    path,
  );

const announced = (page: Page, words: string) =>
  page
    .locator("[data-announce]")
    .filter({ hasText: words })
    .waitFor({ state: "attached" });

/** Waits for a composer to close after sending, so the next key is not raced by its focus moving back. */
const sent = async (page: Page) => {
  await page.locator("tr[data-composer]").waitFor({ state: "detached" });
  await settle(page);
};

describe("the keyboard", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("a review from opening to finished, with two line comments, using only keys", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const keys = page.keyboard;
    // F goes to the first file, and Down onto its first line: line 11, then the deleted line, then line 12.
    await keys.press("f");
    await onHeading(page, STORE);
    await keys.press("ArrowDown");
    await onLine(page, STORE, 11);
    await keys.press("ArrowDown");
    await keys.press("ArrowDown");
    await onLine(page, STORE, 12);
    await keys.press("Shift+ArrowDown");
    await announced(page, "Selected lines 12–13.");
    await keys.press("Enter");
    await keys.type("Lock before the rename.");
    await keys.press("Control+Enter");
    await sent(page);
    // V marks the file viewed, which folds it; focus goes to its heading.
    await keys.press("v");
    await page
      .locator(`article[data-path='${STORE}'][data-viewed='true']`)
      .waitFor();
    await onHeading(page, STORE);
    // F goes on to the next file; C comments on the line under the cursor.
    await keys.press("f");
    await onHeading(page, FORMAT);
    for (const _ of [1, 2, 3]) await keys.press("ArrowDown");
    await onLine(page, FORMAT, 5);
    await keys.press("c");
    await keys.type("Name the format.");
    await keys.press("Control+Enter");
    await sent(page);
    // E goes to the finish; arrows pick the verdict, Tab the summary, Ctrl+Enter sends.
    await keys.press("e");
    await page.waitForFunction(
      () => document.activeElement?.matches("input[name='verdict']") === true,
    );
    await keys.press("ArrowRight");
    await keys.press("Tab");
    await keys.type("Two things to fix.");
    await keys.press("Control+Enter");
    await page.locator("#finish [data-submission]").waitFor();
    const status = await agent.status();
    assert.deepEqual(
      status.feedback.comments.map((comment: any) => [
        comment.anchor.path,
        comment.anchor.start_line,
        comment.anchor.end_line,
        comment.body,
      ]),
      [
        [STORE, 12, 13, "Lock before the rename."],
        [FORMAT, 5, 5, "Name the format."],
      ],
    );
    assert.equal(status.feedback.submissions.at(-1).verdict, "request_changes");
    assert.deepEqual(status.approved, [STORE]);
    await page.close();
  });

  test("the line cursor is a visible, described focus, and its selection is lit and said", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const table = page.locator(`table[data-path='${STORE}'][data-patch]`);
    // Only one line is in the tab order once a line had focus; before that, the diff itself.
    assert.equal(
      await table.locator("button[data-add-comment][tabindex='0']").count(),
      0,
    );
    await page.keyboard.press("f");
    await page.keyboard.press("ArrowDown");
    await onLine(page, STORE, 11);
    assert.equal(
      await table.locator("button[data-add-comment][tabindex='0']").count(),
      1,
    );
    // The line's button names the line, and its description is the line's code.
    const cursor = await page.evaluate(() => {
      const button = document.activeElement;
      const described = document.getElementById(
        button?.getAttribute("aria-describedby") ?? "",
      );
      const unit = button?.closest("[data-unit]");
      return {
        label: button?.getAttribute("aria-label"),
        description: described?.textContent,
        code: unit?.querySelector("code")?.textContent,
        outline:
          unit === null || unit === undefined
            ? ""
            : getComputedStyle(unit).outlineStyle,
        opacity:
          button instanceof HTMLElement ? getComputedStyle(button).opacity : "",
      };
    });
    assert.equal(cursor.label, "Comment on line 11");
    assert.equal(cursor.description, cursor.code);
    assert.equal(cursor.outline, "solid");
    assert.equal(cursor.opacity, "1");
    // Line 11, the deleted line under it, and the added line 12 in its place.
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await announced(page, "Selected lines 11–12.");
    assert.deepEqual(
      await table
        .locator("[data-unit][data-selected]")
        .evaluateAll((units) =>
          units.map((unit) => unit.getAttribute("data-kind")),
        ),
      ["context", "del", "add"],
    );
    // Esc lets the selection go; a plain arrow does too.
    await page.keyboard.press("Escape");
    await announced(page, "Selection cleared.");
    assert.equal(await table.locator("[data-unit][data-selected]").count(), 0);
    await page.keyboard.press("Shift+ArrowUp");
    assert.equal(await table.locator("[data-unit][data-selected]").count(), 2);
    await page.keyboard.press("ArrowDown");
    assert.equal(await table.locator("[data-unit][data-selected]").count(), 0);
    // Up from the first line goes back to the heading.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await onLine(page, STORE, 11);
    await page.keyboard.press("ArrowUp");
    await onHeading(page, STORE);
    // Only the cursor's line is in the tab order: Shift+Tab leaves the lines, and Tab comes straight back to it.
    for (const _ of [1, 2, 3]) await page.keyboard.press("ArrowDown");
    await onLine(page, STORE, 12);
    await page.keyboard.press("Shift+Tab");
    assert.equal((await focused(page)).line, undefined);
    await page.keyboard.press("Tab");
    assert.equal((await focused(page)).line, "12");
    await page.close();
  });

  test("F and Shift+F move between files, T and Shift+T between threads, opening what hides them", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    // Two comments: one on store.py, which then folds as viewed, and one on format.py.
    await page.keyboard.press("f");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("c");
    await page.keyboard.type("First.");
    await page.keyboard.press("Control+Enter");
    await sent(page);
    await page.keyboard.press("v");
    await page
      .locator(`article[data-path='${STORE}'][data-folded='true']`)
      .waitFor();
    await page.keyboard.press("f");
    await onHeading(page, FORMAT);
    await page.keyboard.press("Shift+F");
    await onHeading(page, STORE);
    await page.keyboard.press("f");
    await onHeading(page, FORMAT);
    for (const _ of [1, 2, 3]) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("c");
    await page.keyboard.type("Second.");
    await page.keyboard.press("Control+Enter");
    await sent(page);
    // From no thread, T goes to the first, in the folded file, which opens.
    await page.keyboard.press("t");
    await page.waitForFunction(
      () => document.activeElement?.matches("article[data-comment]") === true,
    );
    assert.equal((await focused(page)).file, STORE);
    await page
      .locator(`article[data-path='${STORE}'][data-folded='false']`)
      .waitFor();
    await announced(page, "Thread 1 of 2.");
    await page.keyboard.press("t");
    await page.waitForFunction(
      (path) =>
        document.activeElement?.matches(
          `article[data-path='${path}'] article[data-comment]`,
        ) === true,
      FORMAT,
    );
    await announced(page, "Thread 2 of 2.");
    // Past the last thread, nothing moves and a toast says so.
    await page.keyboard.press("t");
    await page.getByText("This is the last thread.").waitFor();
    assert.equal((await focused(page)).file, FORMAT);
    await page.keyboard.press("Shift+T");
    await page.waitForFunction(
      (path) =>
        document.activeElement?.matches(
          `article[data-path='${path}'] article[data-comment]`,
        ) === true,
      STORE,
    );
    await page.close();
  });

  test("V marks the current file viewed and not viewed, and E goes to the finish", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.keyboard.press("f");
    await page.keyboard.press("ArrowDown");
    await onLine(page, STORE, 11);
    await page.keyboard.press("v");
    const viewed = page.locator(
      `article[data-path='${STORE}'] button[data-viewed]`,
    );
    await page
      .locator(
        `article[data-path='${STORE}'] button[data-viewed][aria-pressed='true']`,
      )
      .waitFor();
    await announced(page, `${STORE} viewed.`);
    await onHeading(page, STORE);
    assert.deepEqual((await agent.status()).approved, [STORE]);
    await page.keyboard.press("v");
    await page
      .locator(
        `article[data-path='${STORE}'] button[data-viewed][aria-pressed='false']`,
      )
      .waitFor();
    assert.equal(await viewed.getAttribute("aria-pressed"), "false");
    assert.deepEqual((await agent.status()).approved, []);
    await page.keyboard.press("e");
    await page.waitForFunction(
      () =>
        document.activeElement?.matches("#finish input[name='verdict']") ===
        true,
    );
    await page.close();
  });

  test("? lists the keys, Esc gives focus back, and single-letter keys can be turned off", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.keyboard.press("f");
    await page.keyboard.press("ArrowDown");
    await onLine(page, STORE, 11);
    await page.keyboard.press("?");
    const help = page.locator("[data-key-help]");
    await help.waitFor();
    assert.equal(await help.getAttribute("role"), "dialog");
    const text = (await help.textContent()) ?? "";
    for (const words of [
      "Next or previous stop",
      "Next or previous file",
      "Next or previous thread",
      "Move the line cursor",
      "Select lines from the cursor",
      "Comment on the selected lines",
      "Mark the current file viewed",
      "Go to Finish review",
    ])
      assert.ok(text.includes(words), words);
    // Keys inside the help do nothing to the page behind it.
    await page.waitForFunction(
      () => document.activeElement?.closest("[data-key-help]") !== null,
    );
    const hash = () => page.evaluate(() => location.hash);
    const before = await hash();
    await page.keyboard.press("j");
    assert.equal(await hash(), before);
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    await onLine(page, STORE, 11);
    // Turned off, J, F, and ? do nothing; the line keys still work. The setting holds across a reload.
    await page.locator("[data-key-help-open]").click();
    await help.locator("input[data-shortcuts]").click();
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    await page.reload();
    await page.locator("section[data-stop]").first().waitFor();
    await settle(page);
    const reloaded = await hash();
    for (const key of ["j", "f", "?"]) await page.keyboard.press(key);
    await settle(page);
    assert.equal(await hash(), reloaded);
    assert.equal(await help.count(), 0);
    assert.equal(await page.locator("[data-next] kbd").count(), 0);
    await page
      .locator(
        `table[data-path='${STORE}'][data-patch] tr[data-new='11'] button`,
      )
      .focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await onLine(page, STORE, 12);
    await page.locator("[data-key-help-open]").click();
    await help.locator("input[data-shortcuts]").click();
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    await page.keyboard.press("j");
    await page.waitForFunction(() => location.hash.startsWith("#tour/"));
    await page.close();
  });

  test("in a menu or a confirmation, letters stay theirs and fire no page key", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page
      .locator(
        `table[data-path='${STORE}'][data-patch] tr[data-new='11'] button`,
      )
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Pending until the finish.");
    await page.keyboard.press("Control+Enter");
    await sent(page);
    const article = page.locator("article[data-comment]", {
      hasText: "Pending until the finish.",
    });
    const viewed = page.locator(
      `article[data-path='${STORE}'] button[data-viewed]`,
    );
    /** Focus is still in the open popup, and the page did not move, mark, or open anything. */
    const stays = async (popup: string) => {
      for (const key of ["j", "f", "t", "v", "e", "n", "?"]) {
        await page.keyboard.press(key);
        await settle(page);
        assert.equal(
          await page.evaluate(
            (popup) => document.activeElement?.closest(popup) !== null,
            popup,
          ),
          true,
          `${key} left ${popup}`,
        );
      }
      assert.equal(await viewed.getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("[data-key-help]").count(), 0);
    };
    // The pending list and the comment's own menu are menus.
    await page.locator("[data-pending-count]").click();
    await page.locator("[data-pending-comment]").waitFor();
    await page.keyboard.press("ArrowDown");
    await stays("[role='menu']");
    await page.keyboard.press("Escape");
    await article.locator("[data-comment-menu]").click();
    await page.locator("[data-delete-comment]").waitFor();
    await page.keyboard.press("ArrowDown");
    await stays("[role='menu']");
    // Delete asks first, in an alert dialog.
    await page.locator("[data-delete-comment]").click();
    await page.locator("[role='alertdialog']").waitFor();
    await stays("[role='alertdialog']");
    await page.keyboard.press("Escape");
    await page.locator("[role='alertdialog']").waitFor({ state: "detached" });
    assert.equal(await article.count(), 1);
    await page.close();
  });

  test("typing in a text field never fires a key", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const box = page.locator("textarea#general-body");
    await box.focus();
    const typed = "jkfnFtTve?c";
    await page.keyboard.type(typed);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowDown");
    assert.equal(await box.inputValue(), typed);
    assert.equal(await page.evaluate(() => location.hash), "");
    assert.equal(await page.locator("[data-key-help]").count(), 0);
    assert.equal(await page.locator("tr[data-composer]").count(), 0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "TEXTAREA",
    );
    // So does the composer: arrows move its caret, not the line cursor.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page
      .locator(
        `table[data-path='${STORE}'][data-patch] tr[data-new='11'] button`,
      )
      .focus();
    await page.keyboard.press("Enter");
    await page.locator("tr[data-composer] textarea").waitFor();
    await page.keyboard.type("j\nk");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("c");
    assert.equal(
      await page.locator("tr[data-composer] textarea").inputValue(),
      "jc\nk",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "TEXTAREA",
    );
    await page.close();
  });
});
