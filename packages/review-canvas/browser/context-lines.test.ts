// Comments on unchanged lines revealed around a hunk, in Chromium against a real server: the + button, a drag,
// Shift-click, and the keyboard select them as they select patch rows; the comment anchors to new-side lines and
// their text, stays on its line across a reload, and follows it when a later round moves it. Its unsent text and its
// suggested change work as they do on patch rows. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import {
  built,
  fixtureInput,
  record,
  type Server,
  startServer,
  thenAnswered,
} from "./harness.ts";

let server: Server;
let browser: Browser;

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const open = async (url: string, layout?: "split") => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  record(page);
  if (layout !== undefined)
    await page.addInitScript(() =>
      localStorage.setItem("review-canvas-layout", JSON.stringify("split")),
    );
  await page.goto(url);
  await page
    .locator("section[data-stop]")
    .first()
    .waitFor({ state: "attached" });
  await settle(page);
  return page;
};

const LONG = "long.txt";
const lines = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`);

/** The fixture with long.txt: twelve lines, line 10 changed, and a hunk of lines 9-11. Lines 1-8 and 12 are outside. */
const longInput = () => {
  const input = fixtureInput();
  input.files_complete = false;
  input.files.push({
    path: LONG,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    fingerprint: "2".repeat(64),
    patch: "@@ -9,3 +9,3 @@\n line 9\n-line 10\n+ten\n line 11\n",
    new_content: `${lines.map((line, at) => (at === 9 ? "ten" : line)).join("\n")}\n`,
  });
  return input;
};

/** The same file a round later, with a line added at the top: every line moves one down. */
const shiftedInput = (input: any) => ({
  ...input,
  files: input.files.map((file: any) =>
    file.path === LONG
      ? {
          ...file,
          fingerprint: "4".repeat(64),
          additions: 2,
          patch:
            "@@ -0,0 +1 @@\n+header\n@@ -9,3 +10,3 @@\n line 9\n-line 10\n+ten\n line 11\n",
          new_content: `header\n${file.new_content}`,
        }
      : file,
  ),
});

const fileOf = (page: Page) => page.locator(`article[data-path='${LONG}']`);
const unit = (page: Page, line: number) =>
  fileOf(page).locator(`table[data-patch] [data-unit][data-new='${line}']`);
const plus = (page: Page, line: number) =>
  unit(page, line).locator("button[data-add-comment]");
/** The thread under the unit of a new-side line, in the unified layout. */
const threadUnder = (page: Page, line: number) =>
  fileOf(page).locator(
    `table[data-patch] tr[data-new='${line}'] + tr article[data-comment]`,
  );
const range = (page: Page) =>
  page.locator("tr[data-composer] [data-range]").textContent();

/** Opens the unchanged lines above the hunk. */
const expandAbove = async (page: Page) => {
  const expand = fileOf(page).locator("button[data-expand='0']");
  await expand.click();
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute("aria-expanded") ===
      "true",
    `article[data-path='${LONG}'] button[data-expand='0']`,
  );
};

const finishRound = async (page: Page) => {
  await page.locator("#finish button[type=submit]").click();
  await page.locator("#finish [data-submission]").waitFor();
};

describe(
  "comments on unchanged lines",
  { skip: !built && "run pnpm build first" },
  () => {
    before(async () => {
      server = await startServer();
      browser = await chromium.launch();
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("a comment on an expanded line sits on that line after a reload, and the agent reads a text anchor", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`);
      // Hidden until expanded: nothing to select.
      assert.equal(await unit(page, 4).count(), 0);
      await expandAbove(page);
      await plus(page, 4).click();
      assert.equal(await range(page), "line 4");
      await page.keyboard.type("Why is line 4 here?");
      await page.keyboard.press("Control+Enter");
      await threadUnder(page, 4).waitFor();
      assert.match(
        (await unit(page, 4).getAttribute("class")) ?? "",
        /shadow-mark/,
      );
      // The gap's lines are in the page's memory only: a reload shows the gap open because it holds the thread.
      await page.reload();
      await threadUnder(page, 4).waitFor();
      assert.equal(
        await fileOf(page)
          .locator("button[data-expand='0']")
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.match(
        (await threadUnder(page, 4).textContent()) ?? "",
        /Why is line 4 here\?/,
      );
      await finishRound(page);
      const [comment] = (await agent.status()).feedback.comments;
      assert.equal(comment.anchor.kind, "text");
      assert.equal(comment.anchor.side, "new");
      assert.deepEqual(
        [comment.anchor.start_line, comment.anchor.end_line],
        [4, 4],
      );
      assert.equal(comment.anchor.quote, "line 4");
      // Closing the gap hides the thread; the reviewer's choice holds over the thread's.
      await fileOf(page).locator("button[data-expand='0']").click();
      assert.equal(await threadUnder(page, 4).count(), 0);
      // T goes to the thread anyway, opening the gap again.
      await page.locator("main").focus();
      await page.keyboard.press("t");
      await page.waitForFunction(
        () =>
          document.activeElement?.matches(
            "tr[data-new='4'] + tr article[data-comment]",
          ) === true,
      );
      await page.close();
    });

    test("a round that moves the line down moves the comment with it", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`);
      await expandAbove(page);
      await plus(page, 6).click();
      await page.keyboard.type("Follow me.");
      await page.keyboard.press("Control+Enter");
      await threadUnder(page, 6).waitFor();
      await finishRound(page);
      await agent.publish(shiftedInput(input));
      await page
        .locator("[data-round-current]")
        .filter({ hasText: /^Round 2 · / })
        .waitFor();
      await threadUnder(page, 7).waitFor();
      assert.equal(await threadUnder(page, 6).count(), 0);
      assert.equal(await unit(page, 7).locator("code").textContent(), "line 6");
      const [comment] = (await agent.status()).feedback.comments;
      assert.equal(comment.attachment.state, "attached");
      assert.deepEqual(
        [comment.attachment.start_line, comment.attachment.end_line],
        [7, 7],
      );
      await page.close();
    });

    test("a drag and Shift-click select expanded lines, and a selection running into the hunk is lines of the text", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`);
      await expandAbove(page);
      // A drag over the line numbers of lines 2 to 3.
      const from = await unit(page, 2).locator("td").first().boundingBox();
      const to = await unit(page, 3).locator("td").first().boundingBox();
      if (from === null || to === null) return assert.fail("lines 2 and 3");
      await page.mouse.move(from.x + from.width - 4, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2);
      assert.equal(
        await fileOf(page).locator("[data-unit][data-selected]").count(),
        2,
      );
      await page.mouse.up();
      assert.equal(await range(page), "lines 2–3");
      // Shift-click on line 5 extends the open composer, then on the hunk's line 9 runs into the patch.
      await plus(page, 5).click({ modifiers: ["Shift"] });
      assert.equal(await range(page), "lines 2–5");
      await plus(page, 9).click({ modifiers: ["Shift"] });
      assert.equal(await range(page), "lines 2–9");
      await page.keyboard.type("Lines 2 to 9.");
      await page.keyboard.press("Control+Enter");
      // The thread sits under its last line, which the patch shows.
      await threadUnder(page, 9).waitFor();
      await finishRound(page);
      const [comment] = (await agent.status()).feedback.comments;
      assert.equal(comment.anchor.kind, "text");
      assert.deepEqual(
        [comment.anchor.start_line, comment.anchor.end_line],
        [2, 9],
      );
      await page.close();
    });

    test("the keyboard's line cursor goes from the hunk into the expanded lines and selects them", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`);
      await expandAbove(page);
      await plus(page, 9).focus();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Shift+ArrowUp");
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest("[data-unit]")
              ?.getAttribute("data-new") ?? "",
        ),
        "7",
      );
      await page
        .locator("[data-announce]")
        .filter({ hasText: "Selected lines 7–8." })
        .waitFor({ state: "attached" });
      await page.keyboard.press("c");
      assert.equal(await range(page), "lines 7–8");
      await page.keyboard.type("Two expanded lines.");
      await page.keyboard.press("Control+Enter");
      await threadUnder(page, 8).waitFor();
      await finishRound(page);
      const [comment] = (await agent.status()).feedback.comments;
      assert.deepEqual(
        [
          comment.anchor.kind,
          comment.anchor.start_line,
          comment.anchor.end_line,
        ],
        ["text", 7, 8],
      );
      await page.close();
    });

    test("unsent text on expanded lines is back on them after a reload, and their suggested change reaches the agents", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`);
      await expandAbove(page);
      await plus(page, 4).click();
      await plus(page, 6).click({ modifiers: ["Shift"] });
      assert.equal(await range(page), "lines 4–6");
      const box = page.locator("tr[data-composer] textarea");
      await page.locator("tr[data-composer] [data-suggest]").click();
      assert.equal(
        await box.inputValue(),
        "```suggestion\nline 4\nline 5\nline 6\n```",
      );
      const body =
        "Spell it out:\n```suggestion\nline 4\nline five\nline 6\n```";
      await thenAnswered(page, "review.saveDraft", () => box.fill(body));
      const ops = (view: Page) =>
        view
          .locator("tr[data-composer] [data-suggestion] tr[data-op]")
          .evaluateAll((rows) =>
            rows.map((row) => [
              row.getAttribute("data-op"),
              // The line's text follows its marker.
              row.querySelector("td:last-child")?.lastChild?.textContent ?? "",
            ]),
          );
      const diff = [
        [" ", "line 4"],
        ["-", "line 5"],
        ["+", "line five"],
        [" ", "line 6"],
      ];
      assert.deepEqual(await ops(page), diff);

      // The gap's lines open again because the restored composer is on them.
      await page.reload();
      await page.waitForFunction(
        (value) =>
          document.querySelector<HTMLTextAreaElement>(
            "tr[data-composer] textarea",
          )?.value === value,
        body,
      );
      assert.equal(await range(page), "lines 4–6");
      assert.equal(
        await fileOf(page)
          .locator("button[data-expand='0']")
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        await fileOf(page)
          .locator("tr[data-new='6'] + tr[data-composer]")
          .count(),
        1,
      );
      assert.deepEqual(await ops(page), diff);

      await box.focus();
      await page.keyboard.press("Control+Enter");
      await threadUnder(page, 6).locator("[data-suggestion]").waitFor();
      await finishRound(page);
      const status = await agent.status();
      const [comment] = status.feedback.comments;
      assert.deepEqual(status.suggestions, [
        {
          comment: comment.id,
          state: "ready",
          path: LONG,
          side: "new",
          round: 1,
          start_line: 4,
          end_line: 6,
          current: ["line 4", "line 5", "line 6"],
          replacement: ["line 4", "line five", "line 6"],
        },
      ]);
      await page.close();
    });

    test("in the split layout either half of an expanded line takes the comment", async () => {
      const input = longInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(`${agent.url}#files/${LONG}`, "split");
      await fileOf(page).locator("table[data-layout='split']").waitFor();
      await expandAbove(page);
      const half = fileOf(page).locator(
        "table[data-patch] td[data-half='old'][data-new='3'] button[data-add-comment]",
      );
      await half.focus();
      await page.keyboard.press("Enter");
      assert.equal(await range(page), "line 3");
      await page.keyboard.type("Split.");
      await page.keyboard.press("Control+Enter");
      await fileOf(page)
        .locator("table[data-patch] tr[id$='-l3'] + tr article[data-comment]")
        .waitFor();
      await finishRound(page);
      const [comment] = (await agent.status()).feedback.comments;
      assert.deepEqual(
        [comment.anchor.kind, comment.anchor.start_line],
        ["text", 3],
      );
      await page.close();
    });
  },
);
