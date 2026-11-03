// Attention flags in the stop lists, in Chromium against a real server: each flagged stop carries its kind and the
// decision it names as a subtitle cut to one line, and Flagged only lists just those stops, with J and K moving
// between them. Run after `pnpm build`: pnpm test:browser.
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

const RISK =
  "Same filesystem only: os.replace is atomic within one filesystem, and a temporary file elsewhere would copy instead";

/** The fixture's tour with a long risk on its first stop and a product call on a third, after an unflagged second. */
const flagged = () => {
  const input = fixtureInput();
  input.stops[0].attention = { kind: "risk", note: RISK };
  input.stops.push({
    title: "The greeting",
    summary: "",
    attention: { kind: "product", note: "Whether the greeting says au lait" },
    excerpts: [
      {
        path: "src/notes/legacy.py",
        side: "new",
        start: 2,
        end: 2,
        caption: "",
      },
    ],
    files: [],
    notes: [],
    questions: [],
  });
  return input;
};

/** The stops the contents list, by stop. */
const listed = (page: Page) =>
  page
    .locator("[data-contents] [data-stop-link]")
    .evaluateAll((links) =>
      links.map((link) => Number((link as HTMLElement).dataset.stopLink)),
    );

const hashIs = (page: Page, hash: string) =>
  page.waitForFunction((hash) => location.hash === hash, hash);

describe("attention flags", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("the contents mark each flagged stop with its kind and the decision, cut to one line", async () => {
    const input = flagged();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const link = (stop: number) => `[data-contents] [data-stop-link='${stop}']`;
    assert.equal(await text(page, `${link(0)} [data-flag='risk']`), "Risk");
    assert.equal(await text(page, `${link(0)} [data-flag-note]`), RISK);
    assert.equal(
      await page.locator(`${link(0)} [data-flag-line]`).getAttribute("title"),
      `Risk: ${RISK}`,
    );
    // The subtitle stays on one line, cut with an ellipsis.
    const cut = await page
      .locator(`${link(0)} [data-flag-note]`)
      .evaluate((note) => ({
        overflow: getComputedStyle(note).textOverflow,
        wraps: getComputedStyle(note).whiteSpace !== "nowrap",
        clipped: note.scrollWidth > note.clientWidth,
      }));
    assert.deepEqual(cut, {
      overflow: "ellipsis",
      wraps: false,
      clipped: true,
    });
    assert.equal(await page.locator(`${link(1)} [data-flag]`).count(), 0);
    assert.equal(
      await text(page, `${link(2)} [data-flag='product']`),
      "Product call",
    );
    // The guide's stop list marks the kind too.
    await page.locator("button[data-view='source']").click();
    await page.locator("#guide-stop-1 [data-flag='risk']").waitFor();
    assert.equal(await page.locator("#guide-stop-2 [data-flag]").count(), 0);
    assert.equal(
      await text(page, "#guide-stop-3 [data-flag='product']"),
      "Product call",
    );
    await page.locator("button[data-view='guided']").click();
    await page.close();
  });

  test("Flagged only lists the flagged stops, and J and K move between them while it is on", async () => {
    const input = flagged();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    assert.deepEqual(await listed(page), [0, 1, 2, 3]);
    const only = page.locator("[data-contents] input[data-flagged-only]");
    assert.match(
      await text(page, "[data-contents] label:has(input[data-flagged-only])"),
      /^Flagged only 2 of 4$/,
    );
    await only.check();
    assert.deepEqual(await listed(page), [0, 2]);
    // Keys in the checkbox are its own; the page keys work once focus leaves it.
    await page.keyboard.press("Tab");
    // From the first stop, J skips the unflagged second and goes to the third; past the last, a toast says so.
    await page.keyboard.press("j");
    await hashIs(page, "#tour/3");
    await page.keyboard.press("j");
    await page.getByText("This is the last flagged stop.").waitFor();
    assert.equal(await page.evaluate(() => location.hash), "#tour/3");
    await page.keyboard.press("k");
    await hashIs(page, "#tour/1");
    await page.keyboard.press("k");
    await page.getByText("This is the first flagged stop.").waitFor();
    // The guide lists only the flagged stops too.
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator("button[data-view='source']").click();
    await page.locator("#guide-stop-1").waitFor();
    assert.deepEqual(
      await page
        .locator("li[data-guide-stop]")
        .evaluateAll((items) =>
          items.map((item) => Number((item as HTMLElement).dataset.guideStop)),
        ),
      [0, 2],
    );
    await page.locator("button[data-view='guided']").click();
    await page.locator("section[data-stop]").first().waitFor();
    // Off again, every stop is listed and J goes to the next stop.
    await page.locator("[data-contents] input[data-flagged-only]").uncheck();
    assert.deepEqual(await listed(page), [0, 1, 2, 3]);
    await page.locator("[data-stop-link='0']").click();
    await hashIs(page, "#tour/1");
    await page.keyboard.press("j");
    await hashIs(page, "#tour/2");
    await page.close();
  });

  test("a tour with no flagged stop has no Flagged only", async () => {
    const input = fixtureInput();
    input.stops[0].attention = null;
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    assert.equal(await page.locator("input[data-flagged-only]").count(), 0);
    assert.equal(await page.locator("[data-flag]").count(), 0);
    await page.close();
  });
});
