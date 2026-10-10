/* Threads in a real browser: agent replies from the review input, the reviewer's accept, reopen, and reply actions,
   state derived from the last reply, and reply merging on import. Screenshots go to a temporary directory, or
   OUTPUT_DIR if set. Do not commit them. Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const contract = require("../skills/review-canvas/assets/feedback.js");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(__dirname, "fixtures");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-threads-"));
const out = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "review-threads-evidence-"));
fs.mkdirSync(out, { recursive: true });

(async () => {
  const html = path.join(temp, "round2.html");
  const run = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/review-canvas/scripts/render_review.py"), path.join(fixtures, "worktree-review-round2.json"), "--output", html], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: "dark", acceptDownloads: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("dialog", dialog => dialog.accept());
    const comment = id => page.locator(`.inline-comment[data-comment-id="${id}"]`);
    const state = id => comment(id).locator(".thread-state").textContent();
    const importFile = async (file, expected = "Imported") => {
      await page.getByLabel("Import saved feedback").setInputFiles(file);
      await page.waitForFunction(expected => document.querySelector("#import-status").textContent.includes(expected), expected);
    };
    const exportFeedback = async () => {
      const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Export feedback (.json)" }).click();
      const target = path.join(temp, `${Date.now()}.json`); await (await pending).saveAs(target);
      return { target, data: contract.parseFeedback(fs.readFileSync(target, "utf8")) };
    };
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => document.querySelector("#progress").textContent.includes("of 10"));

    // Before the comments load, the page says the agent answered comments it cannot show yet.
    assert.match(await page.locator("#unmatched-replies").textContent(), /answered 4 comments that are not in this page's feedback/);
    // The answers stay readable even when their comment is missing or was deleted.
    assert.match(await page.locator("#unmatched-replies li").first().textContent(), /^Fixed: save\(\) now flushes/);
    await importFile(path.join(fixtures, "worktree-feedback.json"));
    assert.equal(await page.locator("#unmatched-replies").isHidden(), true);
    await page.getByRole("button", { name: "Expand all" }).click();

    // Each agent disposition shows under its comment, and the thread waits for the reviewer.
    assert.equal(await state("fixture-comment-1"), "Answered: fixed");
    assert.equal(await state("fixture-comment-2"), "Answered: rejected");
    assert.equal(await state("fixture-comment-3"), "Answered: question");
    assert.equal(await state("fixture-comment-4"), "Answered: deferred");
    assert.match(await comment("fixture-comment-1").locator(".reply").textContent(), /Fixed in this round's version of src\/notes\/store\.py\./);
    assert.match(await comment("fixture-comment-4").locator(".reply").textContent(), /Blocker: Needs a decision/);
    assert.match(await page.locator("#review-summary").textContent(), /4 comments, 1 unattached, 4 answered by the agent/);
    await comment("fixture-comment-2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, "threads-1-answers-dark.png") });

    // The reviewer accepts one answer, reopens one with a reason, and replies to the question. Accepting one thread
    // keeps a reply typed in another.
    await comment("fixture-comment-4").getByRole("button", { name: "Reply to the agent" }).click();
    await comment("fixture-comment-4").locator("textarea").fill("keep me");
    await comment("fixture-comment-1").getByRole("button", { name: "Accept the agent's answer" }).click();
    assert.equal(await comment("fixture-comment-4").locator("textarea").inputValue(), "keep me");
    await comment("fixture-comment-4").getByRole("button", { name: "Cancel reply" }).click();
    assert.equal(await state("fixture-comment-1"), "Resolved");
    await comment("fixture-comment-2").getByRole("button", { name: "Reopen comment" }).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "reply-fixture-comment-2");
    await comment("fixture-comment-2").getByRole("button", { name: "Reopen comment" }).click();
    assert.match(await page.locator("#comment-status").textContent(), /Write a reply before saving/);
    await comment("fixture-comment-2").getByLabel("Why reopen?").fill("It prints a traceback when the notes file itself is missing.");
    await comment("fixture-comment-2").getByRole("button", { name: "Reopen comment" }).click();
    assert.equal(await state("fixture-comment-2"), "Reopened");
    await comment("fixture-comment-3").getByRole("button", { name: "Reply to the agent" }).click();
    await comment("fixture-comment-3").getByLabel("Reply to the agent").fill("Keep ISO 8601.");
    await page.keyboard.press("Control+Enter");
    assert.equal(await state("fixture-comment-3"), "Replied");
    // An answered comment cannot be deleted, so the agent's replies never lose their thread.
    // Editing it would leave a stale answer marked done, so the reviewer replies or reopens instead.
    assert.equal(await comment("fixture-comment-4").getByRole("button", { name: "Delete comment" }).count(), 0);
    assert.equal(await comment("fixture-comment-4").getByRole("button", { name: "Edit comment" }).count(), 0);
    // Escape cancels a reply draft without saving it.
    await comment("fixture-comment-4").getByRole("button", { name: "Reply to the agent" }).click();
    await comment("fixture-comment-4").getByLabel("Reply to the agent").fill("draft");
    // Opening another thread's reply box never discards this draft.
    await comment("fixture-comment-3").getByRole("button", { name: "Reply to the agent" }).click();
    assert.equal(await comment("fixture-comment-4").getByLabel("Reply to the agent").inputValue(), "draft");
    assert.equal(await comment("fixture-comment-3").locator("textarea").count(), 0);
    assert.match(await page.locator("#comment-status").textContent(), /Finish or cancel the open reply first/);
    await comment("fixture-comment-4").getByLabel("Reply to the agent").focus();
    await page.keyboard.press("Escape");
    assert.equal(await state("fixture-comment-4"), "Answered: deferred");
    // Page order: format.py and legacy.py (core), cli.py (wiring), then the unattached store.py comment.
    assert.deepEqual(await page.locator("#comment-index .chip").allTextContents(), ["Replied", "Answered: deferred", "Reopened", "Resolved"]);
    await comment("fixture-comment-2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, "threads-2-reviewer-actions-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: path.join(out, "threads-3-reviewer-actions-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // Feedback carries only the reviewer's replies; the agent's stay in the review input.
    const saved = await exportFeedback();
    assert.equal(await page.locator("#save-state").textContent(), "Exported");
    // A reply draft counts as unexported work, like a comment draft.
    await comment("fixture-comment-4").getByRole("button", { name: "Reply to the agent" }).click();
    await comment("fixture-comment-4").getByLabel("Reply to the agent").pressSequentially("x");
    assert.equal(await page.locator("#save-state").textContent(), "Not exported");
    const partial = page.waitForEvent("download"); await page.getByRole("button", { name: "Export feedback (.json)" }).click(); await partial;
    assert.match(await page.locator("#export-status").textContent(), /without the open comment draft/);
    await page.keyboard.press("Escape");
    const replies = Object.fromEntries(saved.data.comments.map(item => [item.id, (item.replies || []).map(reply => [reply.actor, reply.action, reply.body])]));
    assert.deepEqual(replies["fixture-comment-1"], [["reviewer", "accept", ""]]);
    assert.deepEqual(replies["fixture-comment-2"], [["reviewer", "reopen", "It prints a traceback when the notes file itself is missing."]]);
    assert.deepEqual(replies["fixture-comment-3"], [["reviewer", "reply", "Keep ISO 8601."]]);
    assert.deepEqual(replies["fixture-comment-4"], []);
    // The fixture's agent clock runs ahead of this one; each reviewer reply still sorts after the answer it follows.
    for (const item of saved.data.comments) for (const reply of item.replies || []) assert.ok(Date.parse(reply.created_at) > Date.parse("2026-10-10T10:00:00Z"));

    // Importing the earlier round's file merges by reply ID instead of conflicting.
    await importFile(path.join(fixtures, "worktree-feedback.json"));
    assert.equal(await state("fixture-comment-1"), "Resolved");
    const conflict = structuredClone(saved.data);
    conflict.comments.find(item => item.id === "fixture-comment-3").replies[0].body = "Use the locale.";
    const conflictPath = path.join(temp, "conflict.json"); fs.writeFileSync(conflictPath, JSON.stringify(conflict));
    await importFile(conflictPath, "Import rejected");
    assert.match(await page.locator("#import-status").textContent(), /Conflicting reply ID/);

    // A fresh page restores every state from the saved round 2 feedback fixture.
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#progress").textContent.includes("of 10"));
    await importFile(path.join(fixtures, "worktree-feedback-round2.json"));
    await page.getByRole("button", { name: "Expand all" }).click();
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map(n => state(`fixture-comment-${n}`))), ["Resolved", "Reopened", "Replied", "Answered: deferred"]);
    assert.match(await page.locator("#review-summary").textContent(), /1 answered by the agent/);

    assert.deepEqual(errors, []);
    console.log(`PASS: agent dispositions with fixed_in and blocker, unmatched-reply notice, accept, reopen with a required reason, reply with Ctrl+Enter, Escape cancels, index states, feedback holds only reviewer replies, reply merge on import, conflicting reply ID, states restored from a fixture. Screenshots: ${out}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
