// When the review page reads a stop, in Chromium against a real server: only once most of its body stayed on screen
// for a moment, or when the reviewer marks it read; never because a jump passed it; and after Mark unread, only once
// the reviewer comes back to it. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { built, fixtureInput, type Server, startServer } from "./harness.ts";

let server: Server;
let browser: Browser;

/** Longer than the page waits before a stop kept on screen is read. */
const DWELL = 2600;

/** Two frames, so the page's first scroll-spy pass and focus moves have run. */
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

/** Each stop's reading as the contents mark it, by stop. */
const readings = (page: Page) =>
  page
    .locator("[data-stop-link]")
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLElement).dataset.read),
    );

/** Waits until the contents show a stop's reading, within a few dwell times. */
const reads = (page: Page, stop: number, read: string) =>
  page
    .locator(`[data-stop-link='${stop}'][data-read='${read}']`)
    .waitFor({ timeout: 3 * DWELL });

describe(
  "reading stops",
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

    /**
     * Five stops, each owning one new file whose every line it excerpts. The second is short; the others are taller
     * than the screen, so no one view of them shows most of their body.
     */
    const tallTour = () => {
      const input = fixtureInput();
      const stops = [
        ["The first tall stop", "a.txt", 58],
        ["The short stop", "b.txt", 3],
        ["The second tall stop", "c.txt", 58],
        ["The third tall stop", "d.txt", 58],
        ["The last tall stop", "e.txt", 58],
      ] as const;
      input.files_complete = false;
      input.files = stops.map(([, path, lines], at) => ({
        path,
        status: "added",
        group: "core",
        additions: lines,
        deletions: 0,
        fingerprint: String(at + 4).repeat(64),
        patch: `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, line) => `+${path} line ${line + 1}`).join("\n")}\n`,
      }));
      input.stops = stops.map(([title, path, lines]) => ({
        title,
        summary: "",
        attention: null,
        excerpts: [{ path, side: "new", start: 1, end: lines, caption: "" }],
        files: [],
        notes: [],
        questions: [],
      }));
      return input;
    };

    test("a stop is read only once most of it stayed on screen, and jumps read nothing they pass", async () => {
      const input = tallTour();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      const none = ["unread", "unread", "unread", "unread", "unread"];
      // E goes to the finish past every stop, and none of them is read, however long the page stays there.
      await page.keyboard.press("e");
      await page.waitForFunction(
        () =>
          document.activeElement?.matches("#finish input[name='verdict']") ===
          true,
      );
      await page.waitForTimeout(DWELL);
      assert.deepEqual(await readings(page), none);
      // The tall stops are taller than the screen shows of them at once.
      const tall = await page.evaluate(() => {
        const section = document.querySelector("section[data-stop='0']");
        return (
          (section?.getBoundingClientRect().height ?? 0) * 0.6 > innerHeight
        );
      });
      assert.equal(tall, true);

      // The contents' link to the short stop jumps over the first; kept on screen, the short stop is read, and only it.
      await page.locator("[data-stop-link='1']").click();
      assert.deepEqual(await readings(page), none);
      await reads(page, 1, "read");
      await page.waitForTimeout(DWELL);
      assert.deepEqual(await readings(page), [
        "unread",
        "read",
        "unread",
        "unread",
        "unread",
      ]);
      assert.equal(
        await text(page, "[data-contents] [data-read-count]"),
        "1 of 5 stops read",
      );

      // J twice passes the second tall stop and lands on the third, which shows less than most of itself: neither is
      // read.
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      assert.match(page.url(), /#tour\/4$/);
      await page.waitForTimeout(DWELL);
      assert.deepEqual(await readings(page), [
        "unread",
        "read",
        "unread",
        "unread",
        "unread",
      ]);

      // The first tall stop, read as a reviewer reads it: its top part on screen for a while, then its bottom part.
      await page.evaluate(() => {
        const top =
          document
            .querySelector("section[data-stop='0']")
            ?.getBoundingClientRect().top ?? 0;
        const bars =
          document.querySelector("[data-next]")?.getBoundingClientRect()
            .bottom ?? 0;
        scrollBy(0, top - bars);
      });
      await page.waitForTimeout(DWELL);
      assert.equal((await readings(page))[0], "unread");
      await page
        .locator("section[data-stop='0']")
        .evaluate((section) => section.scrollIntoView({ block: "end" }));
      await reads(page, 0, "read");
      assert.deepEqual(await readings(page), [
        "read",
        "read",
        "unread",
        "unread",
        "unread",
      ]);
      await page.close();
    });

    test("Mark unread holds while the stop stays on screen, and Mark read reads a stop at once", async () => {
      const input = tallTour();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      // The short stop, kept on screen, is read.
      await page.locator("[data-stop-link='1']").click();
      await reads(page, 1, "read");
      // Mark unread: it stays unread while it stays on screen.
      const short = page.locator("section[data-stop='1']");
      await short.locator("[data-mark-unread='1']").click();
      await reads(page, 1, "unread");
      await short.locator("[data-mark-read='1']").waitFor();
      await page.waitForTimeout(DWELL);
      assert.equal((await readings(page))[1], "unread");
      // Once the reviewer comes back to it and stays, it is read again.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.locator("[data-stop-link='1']").click();
      await reads(page, 1, "read");
      // Mark read reads a tall stop at once, and the server keeps the marks: a reload shows them.
      await page.locator("section[data-stop='2'] [data-mark-read='2']").click();
      await page
        .locator("[data-stop-link='2'][data-read='read']")
        .waitFor({ timeout: 1000 });
      await page.reload();
      await page.locator("[data-stop-link='2'][data-read='read']").waitFor();
      assert.deepEqual((await readings(page)).slice(1, 3), ["read", "read"]);
      await page.close();
    });
  },
);
