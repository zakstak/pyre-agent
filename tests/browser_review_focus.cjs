/* Focus, toast, draft, and line-label regressions for the review canvas.
   Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-focus-"));
  const review = JSON.parse(fs.readFileSync(path.join(root, "skills/pr-review-canvas/assets/example-review.json"), "utf8"));
  // Old and new numbering differ, so a range across deleted and added rows must name both sides.
  review.files[1].patch = "@@ -100,3 +5,3 @@\n ctx\n-old one\n-old two\n+new one\n+new two\n";
  const input = path.join(temp, "review.json"), output = path.join(temp, "review.html");
  fs.writeFileSync(input, JSON.stringify(review));
  const run = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/pr-review-canvas/scripts/render_review.py"), input, "--output", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
    await page.goto(pathToFileURL(output).href);
    const focused = () => page.evaluate(() => { const e = document.activeElement; return e === document.body ? "BODY" : e.id || e.className; });
    const rowButton = text => page.locator("#file-1 tr", { hasText: text }).locator(".comment-line");
    const comment = async (text, body) => { await rowButton(text).click(); await page.locator("#comment-body").fill(body); await page.locator("#save-comment").click(); };

    // An idle toast exposes no focusable controls.
    assert.equal(await page.locator("#toast-dismiss").isHidden(), true);
    assert.equal(await page.locator("#undo-delete").isHidden(), true);

    // Mixed-side ranges name both sides; single rows use their own side.
    await page.evaluate(() => {
      const codes = [...document.querySelectorAll("#file-1 .source code")];
      const from = codes.find(code => code.textContent === "-old one"), to = codes.find(code => code.textContent === "+new two");
      const range = document.createRange(); range.setStart(from.firstChild, 1); range.setEnd(to.firstChild, 4);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.waitForFunction(() => !document.querySelector("#comment-selection").hidden);
    await page.locator("#comment-selection").click();
    assert.equal(await page.locator("#composer-context").textContent(), "src/retry.py · Old line 101 to line 7");
    // Escape from a composer opened by the floating button returns focus to that line's + button.
    await page.keyboard.press("Escape");
    assert.equal(await focused(), "comment-line");
    assert.equal(await page.evaluate(() => document.activeElement.closest("tr").textContent.includes("+new two")), true);
    await comment("-old two", "Deleted row");
    assert.equal(await page.locator(".inline-comment .comment-location").textContent(), "Old line 102");

    // Undo survives later messages and leaves only when dismissed.
    await comment("+new one", "Second");
    await page.getByRole("button", { name: "Delete comment" }).first().click();
    assert.equal(await focused(), "undo-delete");
    await rowButton("+new two").click(); await page.locator("#save-comment").click();
    assert.equal(await page.locator("#comment-status").textContent(), "Write a comment before saving.");
    assert.equal(await page.locator("#undo-delete").isVisible(), true, "Undo still offered after another message");
    await page.locator("#cancel-comment").click();
    await page.locator("#toast-dismiss").focus(); await page.keyboard.press("Enter");
    assert.notEqual(await focused(), "BODY", "Dismiss keeps focus on the page");
    assert.equal(await page.locator("#undo-delete").isHidden(), true);
    assert.equal(await page.locator("#toast-dismiss").isHidden(), true);

    // Undo restores into a collapsed file and focuses the comment.
    await page.getByRole("button", { name: "Delete comment" }).first().click();
    await page.locator("#file-1 .file-toggle").click();
    assert.equal(await page.locator("#file-1 .file-body").isHidden(), true);
    await page.locator("#undo-delete").click();
    assert.equal(await page.locator("#file-1 .file-body").isVisible(), true);
    assert.equal(await focused(), "inline-comment");

    // A draft is never hidden by marking its file reviewed, and never silently replaced.
    await rowButton("+new one").click(); await page.locator("#comment-body").fill("draft text");
    await page.locator("#file-1 .reviewed").check();
    assert.equal(await page.locator("#comment-composer").isVisible(), true);
    await page.locator("#file-1 .file-toggle").click();
    assert.equal(await page.locator("#comment-composer").isVisible(), false);
    await page.locator("#file-2 .file-toggle").evaluate(element => element.closest(".file-card").querySelector(".patch-details").open = true);
    await page.locator("#file-2 .comment-line").first().click();
    assert.equal(await page.locator("#comment-body").inputValue(), "draft text");
    assert.equal(await page.locator("#comment-composer").isVisible(), true, "the hidden draft is revealed");
    assert.equal(await page.locator("#comment-status").textContent(), "Finish or cancel the open comment first.");

    // Escape while an input method is composing does not discard the draft.
    await page.locator("#comment-body").dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
    assert.equal(await page.locator("#comment-composer").isVisible(), true);
    assert.equal(await page.locator("#comment-body").inputValue(), "draft text");

    // The index jump to a comment being edited goes to the composer.
    await page.locator("#cancel-comment").click();
    await page.getByRole("button", { name: "Edit comment" }).first().click();
    await page.locator("#comment-index .comment-jump").first().click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "comment-body");

    // Drafts are not exported, so an open draft keeps the state at Not exported.
    await page.locator("#comment-body").fill("edited draft");
    const download = page.waitForEvent("download"); await page.locator("#export-feedback").click(); await download;
    assert.equal(await page.locator("#save-state").textContent(), "Not exported");
    assert.match(await page.locator("#export-status").textContent(), /without the open comment draft/);
    await page.locator("#cancel-comment").click();
    const again = page.waitForEvent("download"); await page.locator("#export-feedback").click(); await again;
    assert.equal(await page.locator("#save-state").textContent(), "Exported");
    await rowButton("+new two").click(); await page.locator("#comment-body").pressSequentially("x");
    assert.equal(await page.locator("#save-state").textContent(), "Not exported", "typing a new draft clears Exported");
    await page.locator("#cancel-comment").click();

    // Selection stays fast on a diff near the 10,000-line limit. The old full scan took 65 to 90ms per event.
    const big = structuredClone(review);
    big.files[1].patch = "@@ -1,9990 +1,9990 @@\n" + Array.from({ length: 9990 }, (_, i) => ` line ${i} of a long file\n`).join("");
    fs.writeFileSync(input, JSON.stringify(big));
    const bigRun = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/pr-review-canvas/scripts/render_review.py"), input, "--output", output], { encoding: "utf8" });
    assert.equal(bigRun.status, 0, bigRun.stderr);
    await page.goto(pathToFileURL(output).href);
    const timing = await page.evaluate(async () => {
      const codes = document.querySelectorAll("#file-1 .source code"), times = [];
      for (const i of [5000, 5001, 5002, 5003, 5004, 9000]) {
        const range = document.createRange(); range.setStart(codes[i].firstChild, 2); range.setEnd(codes[i + 3].firstChild, 5);
        const start = performance.now(); getSelection().removeAllRanges(); getSelection().addRange(range);
        await new Promise(resolve => document.addEventListener("selectionchange", () => setTimeout(resolve, 0), { once: true }));
        times.push(performance.now() - start);
      }
      return { median: times.sort((a, b) => a - b)[3], status: document.querySelector("#selection-status").textContent };
    });
    assert.ok(timing.median < 30, `selection handling took ${timing.median}ms`);
    assert.match(timing.status, /^\d+ code characters selected in src\/retry\.py\.$/);

    assert.deepEqual(errors, []);
    console.log(`PASS: idle toast, mixed-side line labels, focus after floating-button cancel, persistent Undo, Dismiss focus, Undo into collapsed file, draft guard, IME Escape, jump to edited comment, draft export state, ${timing.median.toFixed(1)}ms selection on a 9,990-line diff.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
