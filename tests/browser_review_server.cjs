/* The served page in a real browser: automatic saving, restore on reload, the new-round offer, a second tab's conflict,
   and a stopped server. Starts serve_review.py on loopback with a temporary state directory.
   Screenshots go to a temporary directory, or OUTPUT_DIR if set. Do not commit them.
   Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(__dirname, "..");
const scripts = path.join(root, "skills/review-canvas/scripts");
const python = process.env.PYTHON || "python3";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-server-"));
const out = process.env.OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "review-server-evidence-"));
fs.mkdirSync(out, { recursive: true });
const state = path.join(temp, "state");

function run(script, ...args) {
  const result = spawnSync(python, [path.join(scripts, script), ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function renderRound(fixture) {
  const round = run("review_state.py", "new-round", "--state-dir", state);
  fs.copyFileSync(path.join(__dirname, "fixtures", fixture), path.join(round, "input.json"));
  run("render_review.py", "--round", round);
}
function startServer() {
  const server = spawn(python, [path.join(scripts, "serve_review.py"), "--state-dir", state], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/Review server: (\S+)/);
      if (match) resolve({ server, url: match[1] });
    });
    server.on("exit", code => reject(Error(`server exited with ${code}`)));
  });
}
const saved = () => JSON.parse(fs.readFileSync(path.join(state, "feedback.json"), "utf8"));

(async () => {
  renderRound("worktree-review.json");
  const { server, url } = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark", acceptDownloads: true });
    const page = await context.newPage();
    const errors = [], foreign = [];
    page.on("pageerror", error => errors.push(error.message));
    // The browser logs the conflict and, once the server stops, the refused connection. Both are expected here.
    let stopped = false;
    page.on("console", message => {
      if (message.type() === "error" && !/409 \(Conflict\)/.test(message.text()) && !(stopped && /ERR_CONNECTION_REFUSED/.test(message.text()))) errors.push(message.text());
    });
    page.on("request", request => { if (!request.url().startsWith(new URL(url).origin)) foreign.push(request.url()); });
    page.on("dialog", dialog => dialog.accept());
    const chip = page.locator("#save-state");
    const approve = file => page.getByRole("checkbox", { name: `Approve ${file}` });
    const waitSaved = async target => { await target.locator("#save-state", { hasText: /^Saved$/ }).waitFor(); };

    await page.goto(url);
    await waitSaved(page);
    assert.equal(await page.locator("#saving-server").isHidden(), true, "the explanation stays inside its disclosure");
    await page.locator(".how-saving-works > summary").click();
    assert.match(await page.locator("#saving-server").textContent(), /save automatically/);
    assert.equal(await page.locator("#saving-file").isHidden(), true);
    assert.match(await page.locator("#export-status").textContent(), /saves automatically/);

    // Changes save on their own, and the saved file is the page's feedback.
    await page.getByRole("button", { name: "Comment on src/notes/store.py line 16" }).click();
    await page.getByLabel("Comment", { exact: true }).fill("Fsync before the rename.");
    await page.getByRole("button", { name: "Save comment" }).click();
    await waitSaved(page);
    assert.equal(saved().comments[0].body, "Fsync before the rename.");
    await approve("src/notes/cli.py").check();
    await approve("src/notes/store.py").check();
    await waitSaved(page);
    assert.deepEqual(saved().approvals.map(record => record.path), ["src/notes/cli.py", "src/notes/store.py"]);
    await page.locator("#toast-dismiss").click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(out, "server-1-saved-dark.png") });

    // A reload restores everything from the server, with no import.
    await page.reload();
    await waitSaved(page);
    assert.equal(await approve("src/notes/cli.py").isChecked(), true);
    assert.equal(await page.locator(".inline-comment").count(), 1);
    assert.match(await page.locator("#import-status").textContent(), /^Loaded saved feedback: 1 comment/);

    // A newer round is offered, not loaded on its own.
    renderRound("worktree-review-round2.json");
    await page.locator("#server-notice", { hasText: "Round 2 is ready" }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator("#progress").textContent(), "2 of 10 approved", "the open round stays until the reviewer reloads");
    await page.screenshot({ path: path.join(out, "server-2-round-ready-dark.png") });
    await page.getByRole("button", { name: "Reload" }).click();
    await page.waitForFunction(() => document.querySelector('meta[name="review-canvas-round"]').content === "2");
    await waitSaved(page);
    assert.equal(await approve("src/notes/cli.py").isChecked(), true, "an unchanged file keeps its approval");
    assert.equal(await approve("src/notes/store.py").isChecked(), false);
    assert.equal(await page.locator("#file-0").getByText("Changed since approval").isVisible(), true);
    // The page saves the carried feedback against round 2, keeping round 1 notes separately.
    const round2 = JSON.parse(fs.readFileSync(path.join(state, "rounds/0002/input.json"), "utf8"));
    await page.waitForFunction(() => document.querySelector("#save-state").textContent === "Saved");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(saved().retained_reviews.length, 1);
    assert.equal(saved().comments[0].attachment.state, "orphan", "the fix changed the code around the comment");
    assert.equal(round2.target.root, saved().target.root);

    // A second tab saves first; this tab's next save conflicts and pauses instead of overwriting.
    const other = await context.newPage();
    other.on("dialog", dialog => dialog.accept());
    await other.goto(url);
    await waitSaved(other);
    await other.getByRole("checkbox", { name: "Approve src/notes/format.py" }).check();
    await waitSaved(other);
    await approve("src/notes/legacy.py").check();
    await page.locator("#server-notice", { hasText: "Feedback changed since this page loaded it" }).waitFor();
    assert.equal(await chip.textContent(), "Not saved");
    assert.deepEqual(saved().approvals.map(record => record.path).sort(), ["src/notes/cli.py", "src/notes/format.py", "src/notes/store.py"]);
    await page.screenshot({ path: path.join(out, "server-3-conflict-dark.png") });
    await other.close();

    // A stopped server is reported, and export still works.
    const third = await context.newPage();
    const dialogs = [];
    third.on("dialog", dialog => { dialogs.push(dialog.type()); dialog.accept(); });
    third.on("console", message => { if (message.type() === "error" && !(stopped && /ERR_CONNECTION_REFUSED/.test(message.text()))) errors.push(message.text()); });
    await third.goto(url);
    await waitSaved(third);
    stopped = true; server.kill("SIGTERM");
    await new Promise(resolve => server.on("exit", resolve));
    assert.equal(fs.existsSync(path.join(state, "server.json")), false);
    await page.locator("#server-notice", { hasText: "The review server stopped" }).waitFor({ timeout: 10000 });
    // A save that fails keeps the unload warning, so the reviewer cannot close the tab and lose the change unwarned.
    await third.getByRole("checkbox", { name: "Approve docs/logo.png" }).check();
    await third.locator("#save-state", { hasText: "Not saved" }).waitFor();
    await third.reload().catch(() => {});
    assert.deepEqual(dialogs, ["beforeunload"]);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export feedback (.json)" }).click();
    assert.match((await download).suggestedFilename(), /^review-feedback-[0-9a-f]{12}\.json$/);
    assert.deepEqual(foreign, [], "requests outside the review server");
    assert.deepEqual(errors, [], "page errors");
    console.log(`PASS: served page loads saved feedback, saves approvals and comments automatically, restores on reload, offers round 2 and carries approvals, a second tab's save pauses this tab with a conflict, a failed save keeps the unload warning, a stopped server is reported and export still works, no requests leave the server. Screenshots: ${out}`);
  } finally {
    await browser.close();
    if (server.exitCode === null) server.kill("SIGTERM");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
