/* The served page in a real browser: automatic saving, restore on reload, the new-round offer, a second tab's conflict,
   and a stopped server. Starts serve_review.py on loopback with a temporary state directory.
   Screenshots go to a temporary directory, or OUTPUT_DIR if set. Do not commit them.
   Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
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
function renderRound(fixture, directory = state) {
  const round = run("review_state.py", "new-round", "--state-dir", directory);
  if (typeof fixture === "string") fs.copyFileSync(path.join(__dirname, "fixtures", fixture), path.join(round, "input.json"));
  else fs.writeFileSync(path.join(round, "input.json"), JSON.stringify(fixture));
  run("render_review.py", "--round", round);
}
function startServer(directory = state) {
  const server = spawn(python, [path.join(scripts, "serve_review.py"), "--state-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
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
    page.on("request", request => foreign.push(request.url()));
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

    // The same holds for a new comment draft before any save happens.
    await page.getByRole("button", { name: "Comment on src/notes/format.py line 6" }).click();
    await page.getByLabel("Comment", { exact: true }).fill("draft");
    await page.locator("#save-state", { hasText: "Saved, except the open draft" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await waitSaved(page);

    // A reload restores everything from the server, with no import.
    await page.reload();
    await waitSaved(page);
    assert.equal(await approve("src/notes/cli.py").isChecked(), true);
    assert.equal(await page.locator(".inline-comment").count(), 1);
    assert.match(await page.locator("#import-status").textContent(), /^Loaded saved feedback: 1 comment/);

    // A page on another origin cannot save, write, or read: the token and CORS stop it before any check runs.
    const before = fs.readFileSync(path.join(state, "feedback.json"));
    const attacker = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<script>
        const target = ${JSON.stringify(new URL(url).origin)}, results = [];
        const attempt = async (name, run) => { try { const response = await run(); results.push([name, response.type, response.status]); } catch (error) { results.push([name, "error", error.name]); } };
        (async () => {
          await attempt("json put", () => fetch(target + "/feedback", { method: "PUT", headers: { "Content-Type": "application/json", "X-Review-Token": "guess" }, body: "{}" }));
          await attempt("simple post", () => fetch(target + "/feedback", { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" }));
          await attempt("read page", () => fetch(target + "/"));
          await attempt("read feedback", () => fetch(target + "/feedback"));
          window.done = results;
        })();
      </script>`);
    }).listen(0, "127.0.0.1");
    await new Promise(resolve => attacker.once("listening", resolve));
    try {
      const evil = await context.newPage();
      await evil.goto(`http://127.0.0.1:${attacker.address().port}/attack.html`);
      const attempts = await evil.waitForFunction(() => window.done).then(handle => handle.jsonValue());
      // Each attempt fails outright or returns an opaque response the page cannot read.
      assert.deepEqual(attempts.map(([name]) => name), ["json put", "simple post", "read page", "read feedback"]);
      for (const [name, type, status] of attempts) assert.ok((type === "error" && status === "TypeError") || (type === "opaque" && status === 0), `${name}: ${type} ${status}`);
      assert.deepEqual(fs.readFileSync(path.join(state, "feedback.json")), before, "feedback changed after the attack");
      await evil.close();
    } finally { attacker.closeAllConnections(); attacker.close(); }

    // A newer round is offered, not loaded on its own.
    renderRound("worktree-review-round2.json");
    await page.locator("#server-notice", { hasText: "Round 2 is ready" }).waitFor({ timeout: 10000 });
    // The page keeps polling after the offer, which keeps the server running while the old page stays open.
    const polls = [];
    const counter = request => { if (new URL(request.url()).pathname === "/round") polls.push(request.url()); };
    page.on("request", counter);
    await page.waitForTimeout(3500);
    page.off("request", counter);
    assert.ok(polls.length >= 1, "no poll after the reload offer");
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
    // A requested download does not prove a saved file, so the warning stays after export too.
    const fallback = third.waitForEvent("download"); await third.getByRole("button", { name: "Export feedback (.json)" }).click(); await fallback;
    await third.reload().catch(() => {});
    assert.deepEqual(dialogs, ["beforeunload"]);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export feedback (.json)" }).click();
    assert.match((await download).suggestedFilename(), /^review-feedback-[0-9a-f]{12}\.json$/);
    // A change the page cannot validate, here notes past the 2 MiB text budget, is a failed save that keeps the warning.
    const budgetState = path.join(temp, "budget");
    const files = Array.from({ length: 110 }, (_, i) => ({ path: `notes/${i}.txt`, status: "added", group: "core", additions: 0, deletions: 0,
      fingerprint: i.toString(16).padStart(64, "0"), new_mode: "100644", patch_note: "empty" }));
    renderRound({ schema_version: 2, target: { kind: "worktree", title: "Budget", root: "/home/dev/budget", head_sha: "3".repeat(40), changed_files: 110 },
      files_complete: true, files }, budgetState);
    const { server: budgetServer, url: budgetUrl } = await startServer(budgetState);
    try {
      const budget = await context.newPage();
      const warnings = [];
      budget.on("dialog", dialog => { warnings.push(dialog.type()); dialog.accept(); });
      await budget.goto(budgetUrl);
      await waitSaved(budget);
      await budget.evaluate(() => { for (const notes of document.querySelectorAll(".file-notes")) { notes.value = "x".repeat(20000); notes.dispatchEvent(new Event("input")); } });
      await budget.locator("#save-state", { hasText: "Not saved" }).waitFor();
      assert.match(await budget.locator("#export-status").textContent(), /budget/);
      await budget.reload();
      assert.deepEqual(warnings, ["beforeunload"]);
      await budget.close();
    } finally { budgetServer.kill("SIGTERM"); }

    assert.deepEqual(foreign.filter(request => !request.startsWith("http://127.0.0.1:")), [], "requests outside loopback");
    assert.deepEqual(errors, [], "page errors");
    console.log(`PASS: served page loads saved feedback, saves approvals and comments automatically, restores on reload, offers round 2 and carries approvals, a second tab's save pauses this tab with a conflict, a page on another origin cannot save or read, a failed save keeps the unload warning even after export, a validation failure keeps it too, a stopped server is reported and export still works, no requests leave the server. Screenshots: ${out}`);
  } finally {
    await browser.close();
    if (server.exitCode === null) server.kill("SIGTERM");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
