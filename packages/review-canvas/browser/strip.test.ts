// The next strip in Chromium against a real server: what it names is where N goes, at every moment of a round,
// including after the finish while the agents' answers arrive. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { built, fixtureInput, type Server, startServer } from "./harness.ts";

let server: Server;
let browser: Browser;

const STORE = "src/notes/store.py";

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
  ((await page.locator(selector).textContent()) ?? "")
    .replace(/\s+/g, " ")
    .trim();

const plusAt = (row: number) =>
  `table[data-path='${STORE}'][data-patch] tr[data-row='${row}'] button[data-add-comment]`;

/** Leaves a pending comment on a row of store.py, which Finish review sends. */
const comment = async (page: Page, row: number, body: string) => {
  await page.locator(plusAt(row)).focus();
  await page.keyboard.press("Enter");
  await page.locator("tr[data-composer] textarea").fill(body);
  await page.keyboard.press("Control+Enter");
  const article = page.locator("article[data-comment]", { hasText: body });
  await article.waitFor();
  return (await article.getAttribute("data-comment")) ?? "";
};

/**
 * What the strip names, where its link points, and where N goes: the element focus lands in, by the ID of the
 * comment or file it is in, or "finish". Undefined when N goes nowhere.
 */
const strip = async (page: Page) => {
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("n");
  // N reveals its target first, which can take a few frames; where it goes nowhere, focus stays on the page.
  await page
    .waitForFunction(() => document.activeElement !== document.body, null, {
      timeout: 1500,
    })
    .catch(() => undefined);
  const landed = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return undefined;
    return (
      active.closest("article[data-comment]")?.id ??
      active.closest("article[data-path]")?.id ??
      active.closest("#finish")?.id
    );
  });
  return {
    says: await text(page, "[data-next] > div > :first-child"),
    target:
      (await page.locator("[data-next-go]").count()) === 0
        ? undefined
        : await page.locator("[data-next-go]").getAttribute("data-target"),
    n: landed,
  };
};

describe("the next strip", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("after a finish, each answer that arrives is what the strip names and where N goes, then the agents' turn", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const first = await comment(page, 13, "Lock first?");
    const second = await comment(page, 17, "Fsync too?");
    await page.locator("#finish button[type=submit]").click();
    await page.locator("#finish [data-submission]").waitFor();

    // Right after the finish: the agents have the turn, and N has nowhere to go.
    await page
      .locator("[data-next]", { hasText: "You finished round 1" })
      .waitFor();
    assert.deepEqual(await strip(page), {
      says: "You finished round 1 · comment only · the agents have the turn",
      target: undefined,
      n: undefined,
    });

    // An answer arrives: the strip names it, and N goes to it.
    await agent.answer(second, { disposition: "answered", body: "Yes." });
    await page.locator("[data-next-go][data-kind='answer']").waitFor();
    assert.deepEqual(await strip(page), {
      says: "Read Claude Code’s answer · src/notes/store.py:16",
      target: `comment-${second}`,
      n: `comment-${second}`,
    });

    // Another arrives, earlier in the page: the strip names it first, and counts the other.
    await agent.answer(first, { disposition: "rejected", body: "No need." });
    await page
      .locator(`[data-next-go][data-target='comment-${first}']`)
      .waitFor();
    assert.deepEqual(await strip(page), {
      says: "Read Claude Code’s answer · src/notes/store.py:12 · 1 more after this",
      target: `comment-${first}`,
      n: `comment-${first}`,
    });

    // Both read: the agents have the turn again.
    for (const id of [first, second]) {
      await page.locator(`#comment-${id} [data-accept]`).click();
      await page
        .locator(`#comment-${id}[data-turn='resolved']`)
        .waitFor({ state: "attached" });
    }
    await page
      .locator("[data-next]", { hasText: "You finished round 1" })
      .waitFor();
    assert.deepEqual(await strip(page), {
      says: "You finished round 1 · comment only · the agents have the turn",
      target: undefined,
      n: undefined,
    });
    await page.close();
  });
});
