/**
 * Optional real-browser checks (generator has no Node/browser dependencies).
 * Run: node tests/browser_review.cjs
 * Needs Playwright available to require(), plus Chromium. Override executable via
 * CHROMIUM_PATH and module location via PLAYWRIGHT_MODULE if needed. Use PYTHON
 * to override python3. All generated fixtures/downloads/screenshots go to /tmp.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-browser-"));
  const source = path.join(root, "skills/pr-review-canvas/assets/example-review.json");
  const html = path.join(temp, "review.html");
  const script = path.join(root, "skills/pr-review-canvas/scripts/render_review.py");
  function render(input, output) {
    const result = spawnSync(process.env.PYTHON || "python3", [script, input, "--output", output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  render(source, html);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, acceptDownloads: true, colorScheme: "light" });
    const page = await context.newPage();
    const network = [];
    const errors = [];
    page.on("request", request => { if (/^https?:/i.test(request.url())) network.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => document.getElementById("filter-status").textContent.includes("of 3"));
    assert.deepEqual(await page.locator("article h3").allTextContents(), ["src/retry.py", "config/retry.json", "generated/retry-map.bin"]);
    assert.equal(await page.locator("#file-1 .patch-details").evaluate(el => el.open), true);
    assert.equal(await page.locator("#file-2 .patch-details").evaluate(el => el.open), false);
    // Mechanical files start collapsed behind their header toggle.
    assert.equal(await page.locator("#file-0 .file-body").isHidden(), true);
    assert.equal(await page.locator("#file-0 .file-toggle").getAttribute("aria-expanded"), "false");
    await page.locator("#file-0 .file-toggle").click();
    assert.equal(await page.locator("#file-0 .file-body").isVisible(), true);
    await page.locator("#file-0 .file-toggle").click();
    await page.screenshot({ path: path.join(temp, "desktop.png"), fullPage: true });

    await page.locator("#search").fill("src/retry");
    assert.equal(await page.locator("article:visible").count(), 1);
    await page.locator("#collapse-all").click();
    assert.equal(await page.locator("#file-1 .patch-details").evaluate(el => el.open), false);
    await page.locator("#expand-all").click();
    assert.equal(await page.locator("#file-1 .patch-details").evaluate(el => el.open), true);
    // A filtered-out wiring diff must retain its collapsed state.
    assert.equal(await page.locator("#file-2 .patch-details").evaluate(el => el.open), false);
    await page.locator("#search").fill("no-such-file");
    assert.equal(await page.locator("#no-results").isVisible(), true);
    await page.locator("#search").fill("");
    await page.locator("#file-1 .reviewed").check();
    assert.equal(await page.locator("#progress").textContent(), "1 of 3 reviewed");
    // Marking a file reviewed collapses it and checks it off in the file list.
    assert.equal(await page.locator("#file-1 .file-body").isHidden(), true);
    assert.equal(await page.locator('.file-nav li[data-file="file-1"]').evaluate(el => el.classList.contains("is-reviewed")), true);
    await page.locator("#review-filter").selectOption("remaining");
    assert.equal(await page.locator("article:visible").count(), 2);
    await page.locator("#review-filter").selectOption("reviewed");
    assert.equal(await page.locator("article:visible").count(), 1);
    await page.locator("#review-filter").selectOption("all");
    await page.locator("#file-1 .notes-details > summary").click();
    const note = '</textarea><img src="https://evil.invalid/note" onerror="globalThis.PWNED=1"> Check zero limit.';
    await page.locator("#notes-1").fill(note);
    await page.locator("#general-notes").fill("Please clarify the attempt-count contract.");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-feedback").click();
    const download = await downloadPromise;
    const downloaded = path.join(temp, download.suggestedFilename());
    await download.saveAs(downloaded);
    const feedback = JSON.parse(fs.readFileSync(downloaded, "utf8"));
    assert.equal(feedback.feedback_schema_version, 2);
    assert.equal(feedback.files.length, 3);
    const core = feedback.files.find(file => file.path === "src/retry.py");
    assert.equal(core.reviewed, true);
    assert.equal(core.notes, note);
    assert.equal(feedback.files.filter(file => file.reviewed).length, 1);
    assert.equal(feedback.general_notes, "Please clarify the attempt-count contract.");
    assert.equal(feedback.pr.head_sha.length, 40);
    assert.equal(feedback.input_sha256.length, 64);
    assert.equal(feedback.files.some(file => "patch" in file), false);
    assert.deepEqual(JSON.parse(await page.locator("#feedback-json").inputValue()), feedback);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, pwned: Boolean(globalThis.PWNED) })), { local: 0, session: 0, pwned: false });

    // New document state does not silently persist notes or review flags.
    const beforeUnloadPromise = page.waitForEvent("dialog").then(async dialog => {
      assert.equal(dialog.type(), "beforeunload");
      await dialog.accept();
    });
    await Promise.all([page.reload(), beforeUnloadPromise]);
    await page.waitForFunction(() => document.getElementById("filter-status").textContent.includes("of 3"));
    assert.equal(await page.locator("#notes-1").inputValue(), "");
    assert.equal(await page.locator("#file-1 .reviewed").isChecked(), false);
    assert.equal(await page.locator("#general-notes").inputValue(), "");

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(temp, "mobile.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(temp, "dark-mobile.png"), fullPage: true });

    const malicious = JSON.parse(fs.readFileSync(source, "utf8"));
    const payload = '</script><img src="https://evil.invalid/x" onerror="globalThis.PWNED=1"><script>globalThis.PWNED=1</script><svg/onload=alert(1)>';
    malicious.pr.title = payload;
    malicious.summary = payload;
    malicious.files[1].path = payload;
    malicious.files[1].patch = "+" + payload;
    malicious.files[1].summary = payload;
    malicious.files[1].pseudocode = payload;
    malicious.files[1].trace = { input: payload, before: payload, after: payload };
    malicious.files[1].callouts = [{ tag: "Injection probe", text: payload }];
    const maliciousInput = path.join(temp, "malicious.json");
    const maliciousHtml = path.join(temp, "malicious.html");
    fs.writeFileSync(maliciousInput, JSON.stringify(malicious));
    render(maliciousInput, maliciousHtml);
    await page.goto(pathToFileURL(maliciousHtml).href);
    await page.waitForFunction(() => document.getElementById("filter-status").textContent.includes("of 3"));
    assert.equal(await page.locator("h1").textContent(), payload);
    assert.equal(await page.locator("#file-1 h3").textContent(), payload);
    assert.equal(await page.locator("img, svg, iframe").count(), 0);
    assert.equal(await page.locator("script").count(), 1);
    assert.equal(await page.evaluate(() => Boolean(globalThis.PWNED)), false);
    assert.deepEqual(network, [], "Unexpected external network request");
    assert.deepEqual(errors, [], "Browser errors, including CSP failures");

    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noScript.newPage();
    await plain.goto(pathToFileURL(html).href);
    assert.equal(await plain.locator("noscript .warning").isVisible(), true);
    assert.equal(await plain.locator("article").count(), 3);
    console.log(`PASS: desktop/mobile/dark, filtering, grouping, folding, review flags, notes, real JSON download, reload privacy, injection, no network, CSP, no-JS fallback. Artifacts: ${temp}`);
    await noScript.close();
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
