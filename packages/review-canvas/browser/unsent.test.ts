// Unsent text in Chromium against a real server, when the reviewer leaves less than a debounce after the last
// keystroke: leaving the box saves it at once, and a page hidden, closed, or navigated away sends it in a request
// that outlives the page. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
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
// One context, as one browser: closing a page leaves the browser running, so its last requests can finish.
let context: BrowserContext;

/** How long after the last keystroke the page saves a draft on its own: src/client/review/drafts.ts. */
const DRAFT_DELAY_MS = 500;

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const open = async (url: string, from: BrowserContext = context) => {
  const page = await from.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  record(page);
  await page.goto(url);
  await page
    .locator("section[data-stop]")
    .first()
    .waitFor({ state: "attached" });
  await settle(page);
  return page;
};

/** Opens the review in another browser and waits until a box holds `value`, as a restored draft does. */
const restored = async (url: string, selector: string, value: string) => {
  const other = await browser.newContext();
  try {
    const page = await open(url, other);
    await page.waitForFunction(
      ([selector, value]) =>
        (document.querySelector(selector) as HTMLTextAreaElement | null)
          ?.value === value,
      [selector, value] as const,
      { timeout: 5000 },
    );
  } finally {
    await other.close();
  }
};

/** A review with one round, for one test. */
const review = async () => {
  const input = fixtureInput();
  const agent = await server.register(input);
  await agent.publish(input);
  return agent;
};

describe("unsent text", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
    context = await browser.newContext();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("leaving a box saves its text at once, without waiting for the reviewer to pause", async () => {
    const agent = await review();
    const page = await open(agent.url);
    const box = page.locator("#general-body");
    await box.fill("Left at once");
    const left = Date.now();
    await thenAnswered(page, "review.saveDraft", () => box.blur());
    const took = Date.now() - left;
    assert.ok(
      took < DRAFT_DELAY_MS / 2,
      `saved ${took} ms after leaving the box`,
    );
    await page.close();
    await restored(agent.url, "#general-body", "Left at once");
  });

  test("a page put away sends its unsent text at once, in a request that outlives it", async () => {
    const agent = await review();
    const page = await open(agent.url);
    await page.locator("#finish-body").fill("Switched tabs");
    const kept = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/reviews/${agent.review}/drafts`),
      { timeout: 2000 },
    );
    // Headless Chromium keeps every tab visible, so the page is told it was put away as a browser tells it.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal((await kept).status(), 200);
    await page.close();
    await restored(agent.url, "#finish-body", "Switched tabs");
  });

  test("text typed just before the tab closes is back when the review opens again", async () => {
    const agent = await review();
    const page = await open(agent.url);
    await page.locator("#finish-body").fill("Closed at once");
    await page.close({ runBeforeUnload: true });
    await restored(agent.url, "#finish-body", "Closed at once");
  });

  test("text typed just before a link leaves the review is back when it opens again", async () => {
    const agent = await review();
    const page = await open(agent.url);
    await page.locator("#general-body").fill("Went home");
    await page.locator("[data-topbar] a[href='/']").click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.close();
    await restored(agent.url, "#general-body", "Went home");
  });
});
