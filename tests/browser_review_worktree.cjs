/* Working tree target in a real browser: header, patch notes, approval by fingerprint across rounds,
   side-aware anchors, and CRLF quotes, all through the file:// export and import flow.
   Uses already available Playwright and Chromium. Overrides match browser_review.cjs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(__dirname, "fixtures");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-worktree-"));
function render(name) {
  const output = path.join(temp, name.replace(/\.json$/, ".html"));
  const run = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/review-canvas/scripts/render_review.py"), path.join(fixtures, name), "--output", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return pathToFileURL(output).href;
}

(async () => {
  const round1 = render("worktree-review.json"), round2 = render("worktree-review-round2.json");
  const savedFeedback = path.join(fixtures, "worktree-feedback.json");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 960 }, acceptDownloads: true });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    page.on("dialog", dialog => dialog.accept());
    const load = async url => { await page.goto(url); await page.waitForFunction(() => document.querySelector("#progress").textContent.includes("of 10")); };
    const importFile = async (file, expected = "Imported") => {
      await page.getByLabel("Import saved feedback").setInputFiles(file);
      await page.waitForFunction(expected => document.querySelector("#import-status").textContent.includes(expected), expected);
      return page.locator("#import-status").textContent();
    };
    const exportFeedback = async () => {
      const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Export feedback (.json)" }).click();
      const download = await pending, target = path.join(temp, `${Date.now()}-${download.suggestedFilename()}`);
      await download.saveAs(target); return JSON.parse(fs.readFileSync(target, "utf8"));
    };
    const approve = file => page.getByRole("checkbox", { name: `Approve ${file}` });
    const card = file => page.locator("article.file-card", { has: page.locator(".file-path", { hasText: file }) });

    await load(round1);
    // The header names the working tree, its branch, and the HEAD it is compared with.
    assert.equal(await page.title(), "Write notes atomically · Working tree review");
    assert.equal(await page.locator(".topbar-product").textContent(), "Working tree review");
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Write notes atomically");
    assert.equal(await page.locator(".worktree-origin").textContent(), "Uncommitted changes in /home/dev/notes-cli" + "branch atomic-save");
    assert.match(await page.locator(".pr-facts").textContent(), /Against HEAD 4f2a9c1/);
    assert.equal(await page.getByText("Open on GitHub").count(), 0);
    assert.equal(await page.locator("#progress").textContent(), "0 of 10 approved");

    // Each kind of collector entry is labeled, and a mode change or rename is visible in the file header.
    for (const [file, label] of [[".env.local", "Likely secret file."], ["docs/logo.png", "Binary file."], ["docs/current", "Symbolic link."],
      ["scripts/release.sh", "No content change."], ["notes/.keep", "Empty file."], ["src/notes/legacy.py", "Characters replaced."]]) {
      assert.equal(await card(file).locator(".file-notice strong").first().textContent(), label, file);
    }
    assert.equal(await card("scripts/release.sh").locator(".chip", { hasText: "mode" }).textContent(), "mode 100644 → 100755");
    assert.equal(await card("src/notes/format.py").locator(".file-from").textContent(), "from src/notes/render.py");
    assert.equal(await card(".env.local").locator(".diff").count(), 0, "secret contents are not on the page");
    // CR survives HTML parsing, so a CRLF row's text matches the patch byte for byte.
    assert.deepEqual(await card("tests/data/windows.txt").locator(".source code").allTextContents(), ["@@ -0,0 +1,2 @@", "+first line\r", "+second line\r"]);

    // Round 1: restore the saved feedback, then comment on an old-side line and a CRLF line.
    let status = await importFile(savedFeedback);
    assert.match(status, /3 of 10 files approved, 0 changed since approval/);
    // The page now matches the file, so importing it again leaves nothing to export.
    assert.equal(await page.locator("#save-state").isHidden(), true);
    await importFile(savedFeedback);
    assert.equal(await page.locator("#save-state").isHidden(), true);
    assert.equal(await page.locator("#progress").textContent(), "3 of 10 approved");
    for (const file of ["scripts/release.sh", "src/notes/cli.py", "src/notes/store.py"]) assert.equal(await approve(file).isChecked(), true, file);
    assert.equal(await page.locator("#file-0 .thread-row .inline-comment").count(), 1, "the saved comment attaches");
    await page.getByRole("button", { name: "Comment on src/notes/store.py old line 10" }).click();
    await page.getByLabel("Comment", { exact: true }).fill("The old code wrote in place.");
    await page.getByRole("button", { name: "Save comment" }).click();
    await card("tests/data/windows.txt").locator(".file-toggle").click();
    await page.getByRole("button", { name: "Comment on tests/data/windows.txt line 1" }).click();
    await page.getByLabel("Comment", { exact: true }).fill("Keep CRLF here on purpose?");
    await page.getByRole("button", { name: "Save comment" }).click();
    let feedback = await exportFeedback();
    assert.equal(feedback.feedback_schema_version, 3);
    assert.equal(feedback.target.kind, "worktree");
    const oldSide = feedback.comments.find(comment => comment.body.startsWith("The old code"));
    assert.deepEqual([oldSide.anchor.side, oldSide.anchor.start_line, oldSide.anchor.end_line], ["old", 10, 10]);
    const crlf = feedback.comments.find(comment => comment.body.startsWith("Keep CRLF"));
    assert.deepEqual([crlf.anchor.side, crlf.anchor.start_line, crlf.anchor.quote], ["new", 1, "+first line\r"]);
    const saved = feedback.comments[0];
    assert.deepEqual([saved.anchor.side, saved.anchor.start_line], ["new", 16]);

    // Round 2: store.py changed, so its approval no longer matches. Unchanged files stay approved.
    await load(round2);
    status = await importFile(savedFeedback);
    assert.match(status, /2 of 10 files approved, 1 changed since approval/);
    assert.equal(await page.locator("#progress").textContent(), "2 of 10 approved");
    assert.equal(await approve("src/notes/store.py").isChecked(), false);
    assert.equal(await card("src/notes/store.py").getByText("Changed since approval").isVisible(), true);
    assert.equal(await page.locator('.file-nav li[data-file="file-0"] .nav-state').textContent(), ", changed since approval");
    for (const file of ["scripts/release.sh", "src/notes/cli.py"]) assert.equal(await approve(file).isChecked(), true, file);
    // The fix rewrote the code around the comment, so the comment waits as an orphan.
    assert.equal(await page.locator("#orphan-list .inline-comment").count(), 1);
    assert.equal(await page.locator("#orphan-list .inline-comment .chip").textContent(), "From an earlier round");
    await page.getByLabel("Show").selectOption("remaining");
    assert.equal(await card("src/notes/store.py").isVisible(), true);
    assert.equal(await card("src/notes/cli.py").isVisible(), false);
    await page.getByLabel("Show").selectOption("all");

    // Re-approving records the new version.
    await approve("src/notes/store.py").check();
    assert.equal(await card("src/notes/store.py").getByText("Changed since approval").isHidden(), true);
    feedback = await exportFeedback();
    const round2Input = JSON.parse(fs.readFileSync(path.join(fixtures, "worktree-review-round2.json"), "utf8"));
    assert.equal(feedback.approvals.find(record => record.path === "src/notes/store.py").fingerprint, round2Input.files[0].fingerprint);
    assert.equal(feedback.approvals.length, 3);
    assert.equal(feedback.retained_reviews.length, 1, "round 1 notes are kept separately");
    // Importing the older round again keeps the approval for the current version.
    await importFile(savedFeedback);
    assert.equal(await approve("src/notes/store.py").isChecked(), true);

    // A cleared approval in this tab is never overwritten by an older file.
    await approve("src/notes/cli.py").uncheck();
    await importFile(savedFeedback, "Import rejected");
    assert.match(await page.locator("#import-status").textContent(), /Conflicting approval/);
    assert.equal(await approve("src/notes/cli.py").isChecked(), false);

    // Older feedback versions fail with a message that names the version.
    const old = JSON.parse(fs.readFileSync(savedFeedback, "utf8")); old.feedback_schema_version = 2;
    const oldPath = path.join(temp, "old-version.json"); fs.writeFileSync(oldPath, JSON.stringify(old));
    await importFile(oldPath, "Import rejected");
    assert.match(await page.locator("#import-status").textContent(), /version 2 is not supported/);

    // Feedback for another working tree is refused.
    const other = JSON.parse(fs.readFileSync(savedFeedback, "utf8")); other.target.root = "/home/dev/elsewhere";
    for (const comment of other.comments) comment.anchor.snapshot.target.root = "/home/dev/elsewhere";
    const otherPath = path.join(temp, "other-root.json"); fs.writeFileSync(otherPath, JSON.stringify(other));
    await importFile(otherPath, "Import rejected");
    assert.match(await page.locator("#import-status").textContent(), /another review target/);

    // Carrying feedback into a new round keeps only the newest 50 earlier snapshots, so the merge stays valid.
    await load(round2);
    const long = JSON.parse(fs.readFileSync(savedFeedback, "utf8"));
    long.retained_reviews = Array.from({ length: 50 }, (_, i) => ({ target: long.target, input_sha256: i.toString(16).padStart(64, "0"), general_notes: `round ${i}`, files: [] }));
    const longPath = path.join(temp, "fifty-retained.json"); fs.writeFileSync(longPath, JSON.stringify(long));
    await importFile(longPath);
    const carried = await exportFeedback();
    assert.equal(carried.retained_reviews.length, 50);
    assert.equal(carried.retained_reviews.some(review => review.general_notes === "round 0"), false, "the oldest snapshot is dropped");
    assert.equal(carried.retained_reviews.at(-1).input_sha256, long.input_sha256, "round 1 is kept as the newest");

    // When the code returns to round 1, round 1's notes come back from the retained list instead of staying there.
    const digest = name => spawnSync(process.env.PYTHON || "python3", ["-c", "import json,sys;sys.path.insert(0,sys.argv[1]);import render_review as r;print(r.input_digest(r.load_review(sys.argv[2])))",
      path.join(root, "skills/review-canvas/scripts"), path.join(fixtures, name)], { encoding: "utf8" }).stdout.trim();
    const back = JSON.parse(fs.readFileSync(savedFeedback, "utf8"));
    const round1Snapshot = { target: back.target, input_sha256: back.input_sha256, general_notes: "round one overall",
      files: back.files.map(file => ({ ...file, notes: file.path === "src/notes/cli.py" ? "round one note" : "" })) };
    back.input_sha256 = digest("worktree-review-round2.json");
    back.retained_reviews = [round1Snapshot];
    const backPath = path.join(temp, "returning.json"); fs.writeFileSync(backPath, JSON.stringify(back));
    await load(round1);
    await importFile(backPath);
    assert.equal(await page.locator("#general-notes").inputValue(), "round one overall");
    assert.equal(await card("src/notes/cli.py").locator(".file-notes").inputValue(), "round one note");
    const returned = await exportFeedback();
    assert.deepEqual(returned.retained_reviews.map(review => review.input_sha256), [back.input_sha256]);

    // A PR file without a fingerprint cannot be approved.
    const pr = JSON.parse(fs.readFileSync(path.join(root, "skills/review-canvas/assets/example-review.json"), "utf8"));
    delete pr.files[1].fingerprint;
    const prInput = path.join(temp, "no-fingerprint.json"); fs.writeFileSync(prInput, JSON.stringify(pr));
    const prOutput = path.join(temp, "no-fingerprint.html");
    const run = spawnSync(process.env.PYTHON || "python3", [path.join(root, "skills/review-canvas/scripts/render_review.py"), prInput, "--output", prOutput], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    await page.goto(pathToFileURL(prOutput).href);
    assert.equal(await approve("src/retry.py").isDisabled(), true);
    assert.equal(await page.getByText("Approval off for 1 file").isVisible(), true);

    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    console.log(`PASS: working tree header, patch notes, mode and rename labels, CRLF rows, approval carry-over and changed-since-approval, re-approval, approval conflict, version and target rejection, old-side and CRLF anchors, PR file without fingerprint. Artifacts: ${temp}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
