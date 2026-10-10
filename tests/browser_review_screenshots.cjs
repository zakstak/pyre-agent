/* Visual evidence for the PR review canvas: drives the real comment flow on a realistic fixture,
   writes screenshots and results to validation/pr-review-canvas, and fails on contrast or overflow.
   Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "validation/pr-review-canvas");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-shots-"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/showcase-review.json"), "utf8"));
const report = { result: "FAIL", browser: null, screenshots: [], states: [], contrast: [], checks: [] };

function render(review, name) {
  const input = path.join(temp, `${name}.json`), output = path.join(temp, `${name}.html`);
  fs.writeFileSync(input, JSON.stringify(review));
  const run = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/pr-review-canvas/scripts/render_review.py"), input, "--output", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return pathToFileURL(output).href;
}

// Every visible text node, measured against the first opaque background behind it.
function auditContrast() {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = "#000"; context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
  const luminance = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const background = element => {
    for (let node = element; node; node = node.parentElement) { const color = rgba(getComputedStyle(node).backgroundColor); if (color[3] > 0) return color; }
    return rgba(getComputedStyle(document.documentElement).backgroundColor);
  };
  const results = [], seen = new Set();
  for (const element of document.querySelectorAll("body *")) {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || element.closest(".sr-only")) continue;
    if (![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) continue;
    const style = getComputedStyle(element), fg = rgba(style.color), bg = background(element);
    const key = `${element.tagName}.${element.className}|${fg}|${bg}`; if (seen.has(key)) continue; seen.add(key);
    const a = luminance(fg), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    results.push({ element: `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/)[0] || ""}`, text: element.textContent.trim().slice(0, 32), ratio: Number(ratio.toFixed(2)), minimum: large ? 3 : 4.5 });
  }
  return results.sort((x, y) => x.ratio - y.ratio);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  report.browser = browser.version();
  try {
    const url = render(fixture, "showcase");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", acceptDownloads: true });
    const page = await context.newPage();
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    page.on("dialog", dialog => dialog.accept());
    const shot = async (name, locator) => {
      if (locator) await page.locator(locator).evaluate(element => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, name) }); report.screenshots.push(name);
    };
    const load = async () => { await page.goto(url); await page.waitForFunction(() => document.querySelector("#progress").textContent.includes("of 6")); };
    await load();
    await page.screenshot({ path: path.join(out, "overview-dark.png") }); report.screenshots.push("overview-dark.png");

    // A real pointer drag across part of one line, then the floating button.
    const code = page.locator("#file-1 tr", { hasText: "new Map<string, TokenBucket>" }).locator(".source code");
    await code.evaluate(element => element.scrollIntoView({ block: "center" }));
    const box = await code.boundingBox();
    await page.mouse.move(box.x + 60, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 330, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector("#comment-selection").hidden);
    assert.ok((await page.evaluate(() => getSelection().toString())).includes("buckets = new Map"));
    await shot("1-select-dark.png");
    await page.locator("#comment-selection").click();
    assert.ok(await page.locator("#comment-body").evaluate(element => element === document.activeElement));
    assert.equal(await page.locator("#file-1 .composer-row #comment-composer").count(), 1, "composer opens inside the diff");
    await page.locator("#comment-body").fill("This map is keyed by a client-supplied header and never evicted. Bound it, or key it by an authenticated tenant ID.");
    await shot("2-compose-dark.png", "#comment-composer");
    await page.locator("#save-comment").click();
    assert.equal(await page.locator("#file-1 .thread-row .inline-comment").count(), 1, "saved comment renders inline");
    assert.ok((await page.locator("#file-1 mark").allTextContents()).join("").includes("buckets = new Map"));
    report.checks.push("pointer selection opens an inline composer and saves an inline, highlighted thread");

    // Keyboard path: the row's + button and Ctrl+Enter.
    const row = page.locator("#file-0 tr", { hasText: "const elapsed = now" });
    await row.locator(".comment-line").focus(); await page.keyboard.press("Enter");
    await page.keyboard.type("Date.now can step backwards after an NTP correction, which drains tokens. Use performance.now().");
    await page.keyboard.press("Control+Enter");
    assert.equal(await page.locator("#file-0 .thread-row .inline-comment").count(), 1);
    report.checks.push("keyboard + button and Ctrl+Enter save a second inline thread");
    await page.locator("#toast-dismiss").click();
    await shot("3-thread-dark.png", "#file-1 .thread-row");

    await page.locator("#file-3 .reviewed").check();
    await page.locator("#general-notes").fill("Request changes: bound the bucket map before merge.");
    await shot("4-finish-dark.png", "#feedback");
    assert.deepEqual(await page.locator("#comment-index .jump-where").allTextContents(), ["src/ratelimit/token-bucket.ts · Line 32", "src/gateway/middleware.ts · Line 7"]);
    const pending = page.waitForEvent("download"); await page.locator("#export-feedback").click();
    const saved = path.join(temp, "feedback.json"); await (await pending).saveAs(saved);
    const feedback = JSON.parse(fs.readFileSync(saved, "utf8"));
    assert.equal(feedback.comments.length, 2); assert.ok(feedback.comments.every(comment => comment.attachment.state === "attached"));
    report.checks.push("comment index lists comments in file order; export contains both attached comments");

    const openDetails = await page.evaluate(() => [...document.querySelectorAll("details")].map(details => details.open));
    for (const scheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, scheme);
      await page.evaluate(() => { for (const details of document.querySelectorAll("details")) details.open = true; });
      const results = await page.evaluate(auditContrast);
      const failures = results.filter(result => result.ratio < result.minimum);
      report.contrast.push({ scheme, checked: results.length, lowest: results.slice(0, 5), failures });
      assert.deepEqual(failures, [], `${scheme} contrast failures`);
    }
    report.checks.push("every visible text element meets WCAG AA contrast in both modes");
    await page.evaluate(open => document.querySelectorAll("details").forEach((details, i) => { details.open = open[i]; }), openDetails);
    await shot("5-thread-light.png", "#file-1 .thread-row");
    await shot("6-finish-light.png", "#feedback");

    // A later snapshot moves one comment's code away: it becomes an orphan, then reattaches.
    const revised = structuredClone(fixture);
    revised.pr.head_sha = "d".repeat(40);
    revised.files[1].patch = revised.files[1].patch.replace("+  const buckets = new Map<string, TokenBucket>();", "+  const buckets = new LruCache<string, TokenBucket>({ max: 10_000 });");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(render(revised, "revised"));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.locator("#import-feedback").setInputFiles(saved);
    await page.waitForFunction(() => document.querySelector("#import-status").textContent.startsWith("Imported"));
    assert.equal(await page.locator("#orphan-list .inline-comment").count(), 1);
    assert.equal(await page.locator("#file-0 .thread-row .inline-comment").count(), 1, "unchanged code keeps its comment inline");
    await shot("7-orphan-dark.png", "#orphan-comments");
    await page.evaluate(() => {
      const code = [...document.querySelectorAll("#file-1 .source code")].find(element => element.textContent.includes("LruCache"));
      const range = document.createRange(); range.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.waitForFunction(() => !document.querySelector("#comment-selection").disabled);
    await page.getByRole("button", { name: "Attach to selected text", exact: true }).click();
    await page.locator("#save-comment").click();
    assert.equal(await page.locator("#orphan-comments").isVisible(), false);
    assert.equal(await page.locator("#file-1 .thread-row .inline-comment").count(), 1);
    report.checks.push("changed code turns a comment into an orphan; selecting new code reattaches it inline");

    // Phone and enlarged text: no page-level horizontal scrolling in either mode.
    await page.goto(url);
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, scheme);
      for (const width of [1440, 390, 320]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        report.states.push({ scheme, width, textScale: scale, overflow });
        assert.ok(overflow <= 0, `${scheme} ${width} ${scale}x overflow ${overflow}`);
      }
    }
    report.checks.push("no page overflow at 1440, 390, and 320 pixels, 100% and 200% text, both modes");
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.screenshot({ path: path.join(out, "8-phone-dark.png") }); report.screenshots.push("8-phone-dark.png");
    await page.locator("#file-1 .comment-line").nth(6).click();
    await page.keyboard.type("Bound this map.");
    await page.keyboard.press("Control+Enter");
    await page.locator("#toast-dismiss").click();
    await shot("9-phone-thread-dark.png", "#file-1 .thread-row");

    assert.deepEqual(external, [], "external requests"); assert.deepEqual(errors, [], "page errors");
    report.result = "PASS";
    await context.close();
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.result}: ${report.checks.length} checks, ${report.screenshots.length} screenshots in ${path.relative(root, out)}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
