import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { built, startServer } from "./harness.ts";

const attributes = (page: Page) => page.evaluate(() => [document.documentElement.dataset.palette, document.documentElement.dataset.theme]);

const background = (page: Page, selector: string) =>
  page.evaluate((at) => getComputedStyle(document.querySelector(at)!).backgroundColor, selector);

test("the appearance settings choose the mode and the palette, which every page keeps and draws before the app renders", { skip: !built }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/settings/appearance`);
  await page.locator("[data-palette-choice='lifted']").waitFor();
  assert.deepEqual(await attributes(page), ["lifted", "light"]);
  assert.equal(await page.locator("[data-palette-choice='lifted']").getAttribute("aria-pressed"), "true");

  // A swatch is drawn in its own palette, and shows both sides whatever mode the page is in.
  assert.notEqual(await background(page, "[data-palette-choice='forest'] [class*='color-scheme:light']"), await background(page, "[data-palette-choice='lifted'] [class*='color-scheme:light']"));
  assert.notEqual(await background(page, "[data-palette-choice='lifted'] [class*='color-scheme:light']"), await background(page, "[data-palette-choice='lifted'] [class*='color-scheme:dark']"));
  await page.locator("[data-mode='dark']").click();
  assert.deepEqual(await attributes(page), ["lifted", "dark"]);
  const lightSide = await background(page, "[data-palette-choice='lifted'] [class*='color-scheme:light']");
  await page.locator("[data-mode='light']").click();
  assert.equal(await background(page, "[data-palette-choice='lifted'] [class*='color-scheme:light']"), lightSide);

  // The sample shows the swatch under the pointer, in both modes, and the chosen palette otherwise.
  await page.locator("[data-palette-choice='forest']").hover();
  assert.equal(await page.locator("[data-preview]").getAttribute("data-preview"), "forest");
  assert.notEqual(await background(page, "[data-preview] [data-scheme='light']"), await background(page, "[data-preview] [data-scheme='dark']"));
  await page.locator("[data-palette-choice='forest']").click();
  await page.mouse.move(0, 0);
  assert.equal(await page.locator("[data-preview]").getAttribute("data-preview"), "forest");
  await page.locator("[data-mode='dark']").click();
  assert.deepEqual(await attributes(page), ["forest", "dark"]);
  const chosen = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Another page is drawn in the choice from its first paint: the head script sets both attributes before the app.
  await page.goto(server.origin);
  assert.deepEqual(await attributes(page), ["forest", "dark"]);
  await page.locator("[data-standing-filter='open']").waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), chosen);

  // System follows the system, and the default palette leaves no entry behind.
  await page.goto(`${server.origin}/settings/appearance`);
  await page.locator("[data-mode='system']").click();
  await page.locator("[data-palette-choice='lifted']").click();
  assert.deepEqual(
    await page.evaluate(() => [localStorage.getItem("internal-visual-style-theme"), localStorage.getItem("internal-visual-style-palette")]),
    [null, null],
  );
  assert.deepEqual(await attributes(page), ["lifted", "light"]);
});

test("the settings are sections with a search over them, and the old repositories path opens its section", { skip: !built }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/settings`);
  await page.locator("[data-palette-choice='lifted']").waitFor();
  assert.equal(await page.locator("[data-settings-section='appearance']").getAttribute("aria-current"), "page");
  assert.equal(await page.locator("[data-repositories]").count(), 0);

  await page.locator("[data-settings-search]").fill("scan");
  const results = page.locator("[data-settings-results] a");
  assert.deepEqual(await results.allTextContents(), ["Scan directoriesRepositories"]);
  await results.first().click();
  await page.locator("[data-repositories]").waitFor();
  assert.match(page.url(), /\/settings\/repositories#scan$/);
  assert.equal(await page.locator("[data-settings-section='repositories']").getAttribute("aria-current"), "page");
  assert.equal(await page.locator("[data-palette-choice]").count(), 0);

  await page.locator("[data-settings-search]").fill("zzz");
  assert.equal(await page.getByText("Nothing matches.").count(), 1);

  await page.goto(`${server.origin}/repositories`);
  await page.locator("[data-repositories]").waitFor();
  assert.equal(await page.locator("[data-settings-section='repositories']").getAttribute("aria-current"), "page");
  // A link to a setting lands on it even though the section renders after the snapshot arrives, and the targets
  // are there whatever the lists hold.
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`${server.origin}/settings/repositories#scan`);
  await page.locator("#scan").waitFor();
  // The browser found no #scan when it looked, so any scroll is the section's own landing.
  await page.waitForFunction(() => scrollY > 0);
  assert.equal(await page.locator("#monitored").count(), 1);
  await page.goto(`${server.origin}/settings/nope`);
  await page.getByRole("heading", { name: "No such page" }).waitFor();
});
