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

/** The stops the source view's guide lists, by stop. */
const guideListed = (page: Page) =>
  page
    .locator("li[data-guide-stop]")
    .evaluateAll((items) =>
      items.map((item) => Number((item as HTMLElement).dataset.guideStop)),
    );

const hashIs = (page: Page, hash: string) =>
  page.waitForFunction((hash) => location.hash === hash, hash);

const onRound = (page: Page, round: number) =>
  page
    .locator("[data-round-current]")
    .filter({ hasText: new RegExp(`^Round ${round} · `) })
    .waitFor();

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
    assert.deepEqual(await guideListed(page), [0, 2]);
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

  test("going to a comment on an unflagged stop in the source view's guide lists that stop again", async () => {
    const input = flagged();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("button[data-view='source']").click();
    const stop = page.locator("[data-guide-stop='1']");
    await stop.locator("button[data-ask-stop]").click();
    await stop
      .locator("[data-stop-composer] textarea")
      .fill("Why rename the module now?");
    await stop
      .locator("[data-stop-composer]")
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    const thread = stop.locator("article[data-comment]");
    await thread.waitFor();
    const id = await thread.getAttribute("data-comment");
    // Flagged only hides the unflagged stop, and its comment with it.
    const only = page.locator("[data-guide] input[data-flagged-only]");
    await only.check();
    await stop.waitFor({ state: "detached" });
    // The pending list goes to the comment: the stop is listed again, and the comment has focus.
    await page.locator("[data-pending-count]").click();
    await page
      .locator(`[data-pending-list] [data-pending-comment='${id}']`)
      .click();
    await page.waitForFunction(
      (id) => document.activeElement?.id === `comment-${id}`,
      id,
    );
    assert.equal(await only.isChecked(), false);
    await page.locator("button[data-view='guided']").click();
    await page.close();
  });

  test("a round with no flagged stop lists every stop while Flagged only is on, and a later flagged round lists only its flags", async () => {
    const input = flagged();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("[data-contents] input[data-flagged-only]").check();
    assert.deepEqual(await listed(page), [0, 2]);
    // Round 2 drops every flag: the switch goes, and with it the filter.
    const unflagged = {
      ...input,
      stops: input.stops.map((stop: object) => ({ ...stop, attention: null })),
    };
    const second = await agent.publish(unflagged);
    assert.equal(second.ok, true, JSON.stringify(second));
    await onRound(page, 2);
    assert.equal(await page.locator("input[data-flagged-only]").count(), 0);
    assert.deepEqual(await listed(page), [0, 1, 2, 3]);
    // J goes to the next stop, not to a toast that no stop is flagged.
    await page.locator("[data-stop-link='0']").click();
    await hashIs(page, "#tour/1");
    await page.keyboard.press("j");
    await hashIs(page, "#tour/2");
    // The source view's guide lists every stop too.
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator("button[data-view='source']").click();
    await page.locator("#guide-stop-1").waitFor();
    assert.deepEqual(await guideListed(page), [0, 1, 2, 3]);
    await page.locator("button[data-view='guided']").click();
    await page.locator("section[data-stop]").first().waitFor();
    // Round 3 flags the third stop again: the switch is back, still on as the reviewer left it.
    const third = await agent.publish({
      ...unflagged,
      stops: unflagged.stops.map((stop: object, index: number) =>
        index === 2
          ? { ...stop, attention: { kind: "product", note: "The greeting" } }
          : stop,
      ),
    });
    assert.equal(third.ok, true, JSON.stringify(third));
    await onRound(page, 3);
    assert.equal(
      await page
        .locator("[data-contents] input[data-flagged-only]")
        .isChecked(),
      true,
    );
    assert.deepEqual(await listed(page), [2]);
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
