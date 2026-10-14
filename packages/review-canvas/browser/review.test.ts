// The review page in Chromium against a real server: the one-scroll walkthrough, the next strip, comments and
// answers, live rounds, and the races the branch review found. Run after `pnpm build`: pnpm test:browser.
//
// The page renders after its socket connects, so each test waits for content rather than for the load event.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import {
  built,
  changedStore,
  fixtureInput,
  type Server,
  startServer,
} from "./harness.ts";

let server: Server;
let browser: Browser;

/** Two frames, so the page's first scroll-spy pass and focus moves have run. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Waits until the review page shows its stops. */
const shown = async (page: Page) => {
  await page.locator("section[data-stop]").first().waitFor({ state: "attached" });
  await settle(page);
};

const open = async (
  url: string,
  init?: (page: Page) => Promise<void>,
  viewport = { width: 1280, height: 900 },
) => {
  const page = await browser.newPage({ viewport });
  await init?.(page);
  await page.goto(url);
  await shown(page);
  return page;
};

/** Waits until the page shows round `round`. */
const onRound = (page: Page, round: number) =>
  page
    .locator("[data-round-current]")
    .filter({ hasText: new RegExp(`^Round ${round} · `) })
    .waitFor();

/** The title of the stop whose heading has focus. */
const focusedStop = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest("section[data-stop]")?.querySelector("h2 > span:last-child")
        ?.textContent ?? "",
  );

/** The table of one file's diff; each file renders once. The read-only "since" table carries no patch digest. */
const table = (path: string) => `table[data-path='${path}'][data-patch]`;

const plusAt = (path: string, row: number) =>
  `${table(path)} tr[data-row='${row}'] button[data-add-comment]`;

const composer = "tr[data-composer]";

const text = async (page: Page, selector: string) =>
  ((await page.locator(selector).textContent()) ?? "").replace(/\s+/g, " ").trim();

/** Marks every file viewed through its Viewed button, one at a time. */
const viewAll = async (page: Page) => {
  for (;;) {
    const button = page.locator("button[data-viewed][aria-pressed='false']").first();
    if ((await button.count()) === 0) return;
    const path = await button.evaluate((element) => element.closest("article")?.dataset.path ?? "");
    await button.click();
    await page.locator(`article[data-path='${path}'] button[data-viewed][aria-pressed='true']`).waitFor();
  }
};

describe("review page", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("J and K move between stops and mark them read, and a note link reveals its own row", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    // One scroll: every stop and every file is on the page at once.
    assert.deepEqual(await page.locator("section[data-stop] h2 > span:last-child").allTextContents(), [
      "save() becomes atomic",
      "The rename",
      "Other files",
    ]);
    await page.keyboard.press("j");
    assert.equal(await focusedStop(page), "The rename");
    assert.match(page.url(), /#tour\/2$/);
    // The stop moved to, and the one scrolled past on the way.
    await page.locator("[data-stop-link='0'][data-read]").waitFor();
    assert.deepEqual(await page.locator("[data-stop-link][data-read]").evaluateAll((links) => links.map((link) => (link as HTMLElement).dataset.stopLink)), ["0", "1"]);
    await page.keyboard.press("k");
    assert.equal(await focusedStop(page), "save() becomes atomic");
    assert.match(page.url(), /#tour\/1$/);
    // A note in the first stop: its row shows, and the hash stays the note's.
    await page.keyboard.press("j");
    await page.evaluate(() => {
      location.hash = "#s0e0-note-A";
    });
    await page.locator("#s0e0-note-A").waitFor();
    assert.equal(await page.locator("#s0e0-note-A").isVisible(), true);
    assert.match(page.url(), /#s0e0-note-A$/);
    // J moves on from the stop the note is in.
    await page.keyboard.press("j");
    assert.match(page.url(), /#tour\/2$/);
    // A link to anything else on the page is the browser's: J and K keep their place.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.addEventListener("hashchange", () => resolve(), { once: true });
          location.hash = "#main";
        }),
    );
    await page.keyboard.press("j");
    assert.equal(await page.evaluate(() => location.hash), "#tour/3");
    await page.close();
  });

  test("a comment from the keyboard, an agent's answer arriving live, and an accept", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    assert.equal(await text(page, `${composer} [data-range]`), "line 12");
    await page.keyboard.type("Lock before the rename.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article[data-comment][data-turn='agent']").first().waitFor();
    const [comment] = (await agent.status()).to_answer;
    await agent.answer(comment, {
      disposition: "rejected",
      body: "The rename is atomic.",
    });
    await page.locator("article[data-comment][data-turn='reviewer']").first().waitFor();
    assert.equal(
      await page.locator("article[data-comment] li[data-reply='agent'] [data-chip]").first().textContent(),
      "Rejected",
    );
    await page
      .locator("article[data-comment][data-turn='reviewer'] [data-thread-actions]")
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await page.locator("article[data-comment][data-turn='resolved']").first().waitFor();
    await page.close();
  });

  test("a draft on code a new round changed is not moved, and its text fills the next composer", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Written on round 1.");
    await agent.publish(changedStore(input));
    await onRound(page, 2);
    assert.equal(await page.locator(composer).count(), 0);
    await page.getByText(/The code under your comment changed/).waitFor();
    // The second stop's excerpt is another file, unchanged since round 1, which the new round folds; it was open on
    // the page, so it stays open. Commenting there brings the kept text along.
    await page.keyboard.press("j");
    assert.equal(await page.locator("article[data-path='src/notes/format.py']").getAttribute("data-folded"), "false");
    await page
      .locator(`${table("src/notes/format.py")} [data-selectable] button[data-add-comment]`)
      .first()
      .focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(`${composer} textarea`).inputValue(), "Written on round 1.");
    await page.close();
  });

  test("an inline draft survives a fresh start that closes its review", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Keep this unfinished comment.");
    await server.register(input, "Fresh start", { fresh: true });
    await page.locator("[data-round-current]").filter({ hasText: "Round 1 · closed" }).waitFor();
    await page.getByText("replaced by a fresh start").waitFor();
    assert.equal(await page.locator(`${composer} textarea`).inputValue(), "Keep this unfinished comment.");
    await page.close();
  });

  test("an action on a round the page has not shown yet is refused", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    // Hold the snapshots the server streams, so the new round is published but the page has not shown it.
    let hold = false;
    const held: Array<() => void> = [];
    const page = await open(agent.url, async (page) => {
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer();
        upstream.onMessage((message) => {
          if (hold && typeof message === "string" && message.includes('"_tag":"Chunk"'))
            held.push(() => socket.send(message));
          else socket.send(message);
        });
      });
    });
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Rows of round 1.");
    hold = true;
    await agent.publish(changedStore(input));
    await page.waitForTimeout(500);
    assert.ok(held.length > 0, "the new round's snapshot is held");
    assert.equal(await text(page, "[data-round-current]"), "Round 1 · open");
    await page.locator(composer).getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByText(/changed since the page showed it|changed since the page loaded/).waitFor();
    const status = await agent.status();
    assert.equal(status.feedback.comments.length, 0);
    hold = false;
    for (const send of held.splice(0)) send();
    await onRound(page, 2);
    await page.close();
  });

  test("a finish names the round it covers, and the finish section catches up when it is refused", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("[data-open-finish]").click();
    // Finish review in the top bar goes to the finish section and its first verdict.
    await page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.name === "verdict");
    await agent.publish(changedStore(input));
    await onRound(page, 2);
    // The reviewer is in the finish section, so it still names the round they were reading.
    assert.equal(await page.locator("#finish form").getAttribute("data-round"), "1");
    await page.locator("#finish button[type=submit]").click();
    await page.getByText(/Round 2 was published after the page showed round 1/).waitFor();
    await page.locator("#finish form[data-round='2']").waitFor();
    await page.locator("#finish input[value='approve']").check();
    await page.locator("#finish textarea").fill("Ship it.");
    await page.locator("#finish button[type=submit]").click();
    // The section shows the submission, and the strip says the agents have the turn. Focus stays in the section.
    await page.locator("#finish [data-submission]").waitFor();
    await page.waitForFunction(() => document.activeElement?.id === "finish-title");
    assert.match(await text(page, "#finish-title"), /^Round 2 finished · approve · /);
    assert.match(await text(page, "#finish [data-submission]"), /^You approved at .*: Ship it\.$/);
    assert.equal(await page.locator("#finish form").count(), 0);
    assert.match(await text(page, "[data-next]"), /You finished round 2 · approve · the agents have the turn/);
    const status = await agent.status();
    assert.deepEqual([status.submission.round, status.submission.verdict], [2, "approve"]);
    await page.close();
  });

  test("the next strip names an answer, the first file not viewed, then the finish, and n goes there; a drift is a line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const next = page.locator("[data-next-go]");
    const strip = () => text(page, "[data-next-go]");
    const focusIs = (selector: string) =>
      page.waitForFunction((selector) => document.activeElement?.matches(selector) === true, selector);
    // Nothing viewed and nothing to read: the first file of the first stop.
    assert.equal(await strip(), "→Review src/notes/store.py · stop 1 · 10 files left");
    assert.equal(await next.getAttribute("data-target"), "files/src/notes/store.py");
    assert.equal(await next.getAttribute("data-kind"), "file");
    await page.keyboard.press("n");
    await focusIs("article[data-path='src/notes/store.py'] button[data-viewed]");

    // An answer to read comes first, with its thread's name and its place.
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first?");
    await page.locator(composer).getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator("article[data-comment]").first().waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "No need." });
    await page.waitForFunction(() => /Read/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    assert.equal(await strip(), "→Read Claude Code’s answer · src/notes/store.py:12");
    assert.equal(await next.getAttribute("data-target"), `comment-${question}`);
    assert.equal(await next.getAttribute("data-kind"), "answer");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("n");
    await focusIs(`#comment-${question} button[title='The answer settles the comment']`);
    await page.keyboard.press("Enter");
    await page.locator("article[data-comment][data-turn='resolved']").waitFor();
    await page.waitForFunction(() => /Review/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    // Focus lands on the thread's next move, not on the page.
    await page.waitForFunction(
      (id) => {
        const active = document.activeElement;
        return active?.closest(`#comment-${id} [data-thread-actions]`) != null && active.textContent === "Reopen";
      },
      question,
    );

    // A drift is one line under the rounds, its file a link; the strip has nothing to do about it and goes on.
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.locator("#drift").waitFor();
    assert.match(
      await text(page, "#drift"),
      /^Changed since this round: src\/notes\/store\.py · checked .+ · the agents publish a new round with the change\.$/,
    );
    assert.equal(await page.locator("#drift a").getAttribute("href"), "#files/src/notes/store.py");
    assert.equal(await strip(), "→Review src/notes/store.py · stop 1 · 10 files left");

    // A new round replaces the drift; with every file viewed, the strip asks for the finish.
    await agent.publish(changedStore(input));
    await onRound(page, 2);
    assert.equal(await page.locator("#drift").count(), 0);
    await viewAll(page);
    await page.waitForFunction(() => /Finish round 2/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    assert.equal(await strip(), "→Finish round 2 · everything viewed, nothing waiting");
    assert.equal(await next.getAttribute("data-target"), "finish");
    assert.equal(await page.locator("[data-viewed-count]").getAttribute("aria-label"), "10 of 10 files viewed");
    assert.equal(await text(page, "[data-viewed-count]"), "10/10");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("n");
    await focusIs("#finish input[name='verdict']");
    await page.close();
  });

  test("a later stop's excerpt of an earlier stop's file points back at its rows instead of repeating them", async () => {
    const input = fixtureInput();
    input.stops[1].excerpts.push({ path: "src/notes/store.py", side: "new", start: 14, end: 15, caption: "Again" });
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    // store.py renders once, in the stop that owns it.
    assert.equal(await page.locator(table("src/notes/store.py")).count(), 1);
    const back = page.locator("#stop-2 [data-also] a");
    assert.equal(await text(page, "#stop-2 [data-also] a"), "src/notes/store.py lines 14–15 ↑");
    /** The new line numbers of the rows painted with the highlight colour. */
    const lit = () =>
      page.evaluate((selector) => {
        const probe = document.createElement("div");
        probe.style.background = "var(--pyre-highlight)";
        document.body.append(probe);
        const highlight = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return [...document.querySelectorAll<HTMLElement>(`${selector} tr[data-row]`)]
          .filter((row) => getComputedStyle(row).backgroundColor === highlight)
          .map((row) => row.dataset.new ?? "");
      }, table("src/notes/store.py"));
    assert.deepEqual(await lit(), []);
    await back.click();
    await page.waitForFunction(() => location.hash === "");
    for (let at = 0; at < 20 && (await lit()).length === 0; at++) await page.waitForTimeout(50);
    assert.deepEqual(await lit(), ["14", "15"]);
    const deadline = Date.now() + 4000;
    while ((await lit()).length > 0 && Date.now() < deadline) await page.waitForTimeout(100);
    assert.deepEqual(await lit(), []);
    await page.close();
  });

  test("Reply opens a text box in place, Esc closes it with the text kept, and the reply sends", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("#general-body").fill("Why a rename?");
    await page.locator("#general form").getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator("#general article[data-comment]").waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "Atomicity." });
    const thread = page.locator(`#comment-${question}`);
    await thread.locator("li[data-reply='agent']").waitFor();
    const editor = thread.getByRole("textbox", { name: "Reply" });
    const reply = thread.locator("[data-thread-actions]").getByRole("button", { name: "Reply", exact: true });
    assert.equal(await editor.isVisible(), false);
    await reply.click();
    assert.equal(await editor.isVisible(), true);
    await page.keyboard.type("And on Windows?");
    await page.keyboard.press("Escape");
    assert.equal(await editor.isVisible(), false);
    await page.waitForFunction(
      (id) =>
        document.activeElement?.closest(`#comment-${id} [data-thread-actions]`) != null &&
        document.activeElement.textContent === "Reply",
      question,
    );
    await page.keyboard.press("Enter");
    assert.equal(await editor.inputValue(), "And on Windows?");
    await page.keyboard.press("Control+Enter");
    await page.locator(`#comment-${question}[data-turn='agent']`).waitFor();
    assert.match(await text(page, `#comment-${question} li[data-reply='reviewer']`), /And on Windows\?/);
    // The editor closes with the reply sent, and focus goes to the thread's next move.
    await page.waitForFunction(
      (id) => document.activeElement?.closest(`#comment-${id} [data-thread-actions]`) != null,
      question,
    );
    assert.equal(await editor.isVisible(), false);
    await page.close();
  });

  test("a question asked now reaches the agent at once, and its answer shows", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("button[data-question]").first().click();
    assert.equal(await page.locator("#general-body").inputValue(), "Should a failed write clean up?");
    await page.waitForFunction(() => document.activeElement?.id === "general-body");
    await page.locator("#general form").getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator("#general article[data-comment]").waitFor();
    // A question waits for the agent at once; its answer is the reviewer's turn. One chip says so each time.
    assert.deepEqual(await page.locator("#general article[data-comment] [data-chip]").allTextContents(), [
      "Waiting for Claude Code",
    ]);
    const status = await agent.status();
    assert.equal(status.questions.length, 1);
    await agent.answer(status.questions[0], {
      disposition: "answered",
      body: "Yes; mkstemp leaves it otherwise.",
    });
    await page.locator("#general li[data-reply='agent']").waitFor();
    assert.deepEqual(await page.locator("#general article[data-comment] [data-chip]").allTextContents(), [
      "Your turn",
      "Answered",
    ]);
    await page.close();
  });

  test("hiding whitespace keeps across reloads", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    const box = page.locator("input[data-whitespace]");
    assert.equal(await box.isChecked(), false);
    await page.getByLabel("Hide whitespace").check();
    assert.equal(await page.evaluate(() => localStorage.getItem("review-canvas-whitespace")), JSON.stringify("hide"));
    await page.reload();
    await box.waitFor();
    assert.equal(await box.isChecked(), true);
    await box.uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem("review-canvas-whitespace")), JSON.stringify("show"));
    await page.close();
  });

  test("side by side keeps across reloads, and a comment on a new half anchors to its line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    await page.locator("button[data-layout='split']").click();
    await page.locator("table[data-layout='split']").first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("review-canvas-layout")), JSON.stringify("split"));
    await page.reload();
    await page.locator("table[data-layout='split']").first().waitFor();
    assert.equal(await page.locator("table[data-layout='unified']").count(), 0);
    assert.equal(await page.locator("button[data-layout='split']").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("button[data-layout='unified']").getAttribute("aria-pressed"), "false");
    const half = page.locator(`${table("src/notes/store.py")} td[data-half='new'][data-row='14']`);
    await half.locator("button[data-add-comment]").focus();
    await page.keyboard.press("Enter");
    assert.equal(await text(page, `${composer} [data-range]`), "line 13");
    await page.keyboard.type("Split view comment.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article[data-comment]").first().waitFor();
    const [comment] = (await agent.status()).feedback.comments;
    assert.deepEqual([comment.anchor.side, comment.anchor.start_line], ["new", 13]);
    await page.close();
  });

  test("a comment whose lines left the round moves to lines the reviewer picks", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock before the rename.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article[data-comment]").first().waitFor();
    // Round 2 drops store.py: the comment has no lines, and shows apart with a way to move it.
    await agent.publish({
      ...input,
      files_complete: false,
      files: input.files.filter((file: { path: string }) => file.path !== "src/notes/store.py"),
    });
    const move = page.locator("#departed").getByRole("button", { name: "Move to other lines", exact: true });
    await move.click();
    await page.getByText(/Select the lines this comment is about/).waitFor();
    // cli.py is listed without an excerpt, so it starts folded; Show diff opens it.
    const cli = page.locator("article[data-path='src/notes/cli.py']");
    assert.equal(await cli.getAttribute("data-folded"), "true");
    await cli.getByRole("button", { name: "Show diff", exact: true }).click();
    await page.locator(`${table("src/notes/cli.py")} [data-selectable] button[data-add-comment]`).first().focus();
    await page.keyboard.press("Enter");
    await cli.locator("article[data-comment]").waitFor();
    await page.getByText("The comment moved to the lines you chose.").waitFor();
    assert.equal(await page.locator("#departed").count(), 0);
    assert.equal(await page.locator(composer).count(), 0);
    const [comment] = (await agent.status()).feedback.comments;
    assert.equal(comment.anchor.path, "src/notes/cli.py");
    await page.close();
  });

  test("an approved file folds away, and unchanged lines open on demand", async () => {
    const input = fixtureInput();
    const lines = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`);
    const after = lines.map((line, at) => (at === 9 ? "ten" : line));
    input.files_complete = false;
    input.files.push({
      path: "long.txt",
      status: "modified",
      group: "core",
      additions: 1,
      deletions: 1,
      fingerprint: "2".repeat(64),
      patch: "@@ -9,3 +9,3 @@\n line 9\n-line 10\n+ten\n line 11\n",
      new_content: `${after.join("\n")}\n`,
    });
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/long.txt`);
    const file = page.locator("article[data-path='long.txt']");
    const expand = file.locator("button[data-expand='0']");
    await expand.waitFor();
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    await file.getByRole("button", { name: "Show 8 more lines", exact: true }).click();
    await file.getByRole("button", { name: "Hide 8 lines", exact: true }).waitFor();
    assert.equal(await expand.getAttribute("aria-expanded"), "true");
    const unchanged = file.locator("tbody[data-gap='0'] + tbody[data-gap-lines]");
    assert.equal(await unchanged.locator("tr[data-unchanged]").count(), 8);
    assert.equal(await unchanged.isVisible(), true);
    // Unchanged lines take no comment.
    assert.equal(await unchanged.locator("button[data-add-comment]").count(), 0);
    await file.locator("button[data-viewed]").click();
    await file.locator("button[data-viewed][aria-pressed='true']").waitFor();
    assert.equal(await file.getAttribute("data-folded"), "true");
    assert.equal(await file.locator("table").count(), 0);
    assert.equal(await file.locator("button[data-fold]").getAttribute("aria-label"), "Show diff");
    assert.equal(await file.locator("button[data-fold]").getAttribute("aria-expanded"), "false");
    assert.equal(await file.getAttribute("data-viewed"), "true");
    assert.equal(await page.locator("[data-toc-file='long.txt'] svg[aria-label='viewed']").count(), 1);
    assert.deepEqual((await agent.status()).approved, ["long.txt"]);
    await page.close();
  });

  test("agent prose keeps its line breaks and code spans, and markup in it stays text", async () => {
    const input = fixtureInput();
    input.stops[0].summary = "First line.\nSecond line.";
    input.stops[0].attention.note = "Same `rename()` only.";
    input.stops[0].notes[0].body = "Watch this:\n<script>window.pwned = true</script> `<b>` and `fsync`";
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const stop = page.locator("section[data-stop]").first();
    const summary = stop.locator("p").filter({ hasText: "First line." });
    const lines = await summary.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => rect.top)).size;
    });
    assert.equal(lines, 2);
    assert.equal(await stop.locator("[data-attention] code").textContent(), "rename()");
    const note = stop.locator("tr[data-note]").first();
    assert.deepEqual(await note.locator("code").allTextContents(), ["<b>", "fsync"]);
    assert.match((await note.textContent()) ?? "", /<script>window\.pwned = true<\/script>/);
    assert.equal(await note.locator("script, b").count(), 0);
    assert.equal(await page.evaluate(() => "pwned" in window), false);
    await page.close();
  });

  test("a keyboard reviewer selects a range with Shift+Enter, and Esc returns focus to the line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/store.py`);
    // Lines 3 to 5 are outside the stop's excerpt: they fold, and get their + buttons when shown.
    const plus = (line: number) =>
      page.locator(`${table("src/notes/store.py")} tr[data-new='${line}'] button[data-add-comment]`);
    assert.equal(await plus(3).count(), 0);
    await page.locator(`${table("src/notes/store.py")} button[data-expand='r0']`).click();
    await plus(3).focus();
    await page.keyboard.press("Enter");
    await page.locator(`${composer} textarea`).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(composer).count(), 0);
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      `${table("src/notes/store.py")} tr[data-new='3'] button[data-add-comment]`,
    );
    await page.keyboard.press("Enter");
    await plus(5).focus();
    await page.keyboard.press("Shift+Enter");
    assert.equal(await text(page, `${composer} [data-range]`), "lines 3–5");
    await page.keyboard.type("Group these imports.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article[data-comment]").first().waitFor();
    const [comment] = (await agent.status()).feedback.comments;
    assert.deepEqual([comment.anchor.start_line, comment.anchor.end_line], [3, 5]);
    await page.close();
  });

  test("a narrow page folds the contents into a disclosure and shows split files unified", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // The reviewer chose split on another visit.
    await page.goto(server.origin);
    await page.evaluate(() => localStorage.setItem("review-canvas-layout", JSON.stringify("split")));
    await page.goto(agent.url);
    await shown(page);
    const summary = page.locator("[data-contents] summary");
    await summary.waitFor();
    assert.equal(await text(page, "[data-contents] summary"), "Contents · 0 / 10");
    const second = page.locator("[data-stop-link='1']");
    assert.equal(await second.isVisible(), false);
    await summary.click();
    await second.click();
    assert.equal(await focusedStop(page), "The rename");
    assert.match(page.url(), /#tour\/2$/);
    assert.equal(await second.isVisible(), false);
    // A live update keeps the folded contents folded.
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.locator("#drift").waitFor();
    assert.equal(await second.isVisible(), false);
    // The stored choice asks for split; this width shows unified, and leaves the choice alone.
    await page.goto(`${agent.url}#files/src/notes/store.py`);
    await page.locator("table[data-layout]").first().waitFor();
    assert.equal(await page.locator("table[data-layout='split']").count(), 0);
    assert.equal(await page.locator("button[data-layout='split']").isVisible(), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("table[data-layout='split']").first().waitFor();
    assert.equal(await summary.isVisible(), false);
    assert.equal(await second.isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("review-canvas-layout")), JSON.stringify("split"));
    await page.close();
  });

  test("a lost server shows a notice until it is back, and then actions work", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/cli.py`);
    const notice = page.locator("[data-connection][role='status']");
    assert.equal(await notice.textContent(), "");
    assert.equal(await notice.isVisible(), false);
    await page.getByText(/^Connected · updated /).waitFor();
    await server.stop();
    await page.waitForFunction(
      () => (document.querySelector("[data-connection]")?.textContent ?? "") !== "",
      undefined,
      { timeout: 20_000 },
    );
    assert.match((await notice.textContent()) ?? "", /^(Reconnecting…|Disconnected)$/);
    assert.match((await notice.getAttribute("title")) ?? "", /Lost connection to the review server.*review-canvas status/);
    assert.equal(await notice.isVisible(), true);
    assert.equal(await page.getByText(/^Connected · updated /).count(), 0);
    await server.start();
    await page.waitForFunction(
      () => document.querySelector("[data-connection]")?.textContent === "",
      undefined,
      { timeout: 20_000 },
    );
    assert.equal(await notice.getAttribute("title"), null);
    const file = page.locator("article[data-path='src/notes/cli.py']");
    await file.locator("button[data-viewed]").click();
    for (let at = 0; at < 50 && !(await agent.status()).approved.includes("src/notes/cli.py"); at++)
      await page.waitForTimeout(100);
    assert.deepEqual((await agent.status()).approved, ["src/notes/cli.py"]);
    await file.locator("button[data-viewed][aria-pressed='true']").waitFor();
    await page.close();
  });

  test("folds hold: what the reviewer opened or closed survives a reload, and a file an answer held open stays open after Accept", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const file = (path: string) => page.locator(`article[data-path='${path}']`);
    const folded = (path: string) => file(path).getAttribute("data-folded");
    // cli.py is listed without an excerpt, so it starts folded; store.py is excerpted, so it starts open.
    assert.equal(await folded("src/notes/cli.py"), "true");
    assert.equal(await folded("src/notes/store.py"), "false");
    await file("src/notes/cli.py").locator("button[data-fold]").click();
    await file("src/notes/store.py").locator("button[data-fold]").click();
    await page.reload();
    await shown(page);
    assert.equal(await folded("src/notes/cli.py"), "false");
    assert.equal(await folded("src/notes/store.py"), "true");
    // A question on legacy.py, in the closing stop, which folds.
    assert.equal(await folded("src/notes/legacy.py"), "true");
    await file("src/notes/legacy.py").locator("button[data-fold]").click();
    await file("src/notes/legacy.py").locator("button[data-add-comment]").first().focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Still needed?");
    await page.locator(composer).getByRole("button", { name: "Ask now", exact: true }).click();
    await file("src/notes/legacy.py").locator("article[data-comment]").waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "No." });
    await page.close();

    // A fresh tab: the answer holds legacy.py open, though the page would fold it.
    const fresh = await open(agent.url);
    const legacy = fresh.locator("article[data-path='src/notes/legacy.py']");
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    await fresh.keyboard.press("n");
    await fresh.waitForFunction(
      () => document.activeElement?.matches("button[title='The answer settles the comment']") === true,
    );
    await fresh.keyboard.press("Enter");
    await fresh.locator(`#comment-${question}[data-turn='resolved']`).waitFor();
    // Accepting moved the strip on; the file the reviewer was reading stays open, and focus stays in the thread.
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    await fresh.waitForFunction(
      (id) =>
        document.activeElement?.closest(`#comment-${id} [data-thread-actions]`) != null &&
        document.activeElement.textContent === "Reopen",
      question,
    );
    await fresh.reload();
    await shown(fresh);
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    // Marking it viewed folds it.
    await legacy.locator("button[data-viewed]").click();
    await fresh.locator("article[data-path='src/notes/legacy.py'][data-folded='true']").waitFor();
    await fresh.close();
  });

  test("Esc in a composer that a live update re-rendered returns focus to its line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const plus = page.locator(plusAt("src/notes/store.py", 13));
    await plus.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Half a thought");
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.locator("#drift").waitFor();
    assert.equal(await page.locator(`${composer} textarea`).inputValue(), "Half a thought");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(composer).count(), 0);
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      plusAt("src/notes/store.py", 13),
    );
    await page.close();
  });

  test("answers come in page order whatever their age, and a drift leaves the strip on them", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    // The older question is on the whole change, at the end of the page; the newer one is in the first stop.
    await page.locator("#general-body").fill("Why a rename?");
    await page.locator("#general form").getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator("#general article[data-comment]").waitFor();
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first?");
    await page.locator(composer).getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator(`${table("src/notes/store.py")} article[data-comment]`).waitFor();
    const questions: Array<string> = (await agent.status()).questions;
    for (const id of questions) await agent.answer(id, { disposition: "answered", body: "Because." });
    await agent.call("POST", "/drift", { paths: ["src/notes/format.py"] });
    await page.locator("#drift").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-for-you]")?.getAttribute("aria-label") === "2 answers to read");
    assert.equal(await text(page, "[data-next-go]"), "→Read Claude Code’s answer · src/notes/store.py:12 · 1 more after this");
    const inline = await page.locator(`${table("src/notes/store.py")} article[data-comment]`).getAttribute("id");
    assert.equal(await page.locator("[data-next-go]").getAttribute("data-target"), inline);
    await page.close();
  });

  test("a plain comment is pending until the finish, and counts as neither the reviewer's nor the agents'", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(plusAt("src/notes/store.py", 13)).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first.");
    await page.keyboard.press("Control+Enter");
    const comment = page.locator(`${table("src/notes/store.py")} article[data-comment]`);
    await comment.waitFor();
    assert.equal(await comment.getAttribute("data-standing"), "pending");
    assert.equal(await comment.locator("[data-chip]").textContent(), "Pending");
    assert.equal(await comment.locator("[data-chip]").getAttribute("title"), "Sent with your review");
    assert.equal(await page.locator("[data-next] [data-for-you], [data-next] [data-waiting]").count(), 0);
    // A question goes out at once: it waits for the agent.
    await page.locator("#general-body").fill("Why?");
    await page.locator("#general form").getByRole("button", { name: "Ask now", exact: true }).click();
    await page.locator("#general article[data-comment]").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-waiting]")?.getAttribute("aria-label") === "1 comment waiting for agents");
    // The finish carries the comment: now it waits for the agent too.
    await page.locator("#finish button[type=submit]").click();
    await page.locator("#finish [data-submission]").waitFor();
    await page.waitForFunction(() => document.querySelector("[data-waiting]")?.getAttribute("aria-label") === "2 comments waiting for agents");
    assert.equal(await comment.locator("[data-chip]").textContent(), "Waiting for Claude Code");
    // After the finish, the general composer no longer explains what a comment waits for.
    assert.equal(await page.locator("#general").getByText(/A comment waits for Finish review/).count(), 0);
    await page.locator("#general-body").fill("Sent after finishing.");
    await page.locator("#general form").getByRole("button", { name: "Comment", exact: true }).click();
    const sent = page.locator("#general article[data-comment]").filter({ hasText: "Sent after finishing." });
    await sent.waitFor();
    assert.equal(await sent.getAttribute("data-standing"), "agent");
    await agent.publish(input);
    await onRound(page, 2);
    assert.equal(await sent.getAttribute("data-standing"), "agent");
    assert.match((await sent.locator("[data-chip]").textContent()) ?? "", /Waiting for/);
    await page.waitForFunction(() => document.querySelector("[data-waiting]")?.getAttribute("aria-label") === "3 comments waiting for agents");
    await page.close();
  });

  test("hidden lines at a gap are one control: the folded rows first, then the unchanged lines", async () => {
    const input = fixtureInput();
    const lines = Array.from({ length: 12 }, (_, at) => `l${at + 1}`);
    input.files_complete = false;
    input.files.push({
      path: "gap.txt",
      status: "modified",
      group: "core",
      additions: 1,
      deletions: 1,
      fingerprint: "3".repeat(64),
      patch: "@@ -4,8 +4,8 @@\n l4\n l5\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n",
      new_content: `${lines.map((line, at) => (at === 8 ? "L9" : line)).join("\n")}\n`,
    });
    input.stops[0].excerpts.push({ path: "gap.txt", side: "new", start: 9, end: 9, caption: "" });
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/gap.txt`);
    const gapTable = page.locator(table("gap.txt"));
    await gapTable.waitFor();
    // Above the hunk: three unchanged lines and the folded rows of the patch, behind one control.
    const first = gapTable.locator("button[data-expand]").first();
    const key = (await first.getAttribute("data-expand")) ?? "";
    const folded = Number(await first.getAttribute("data-folded"));
    const context = Number(await first.getAttribute("data-context"));
    assert.ok(folded > 0 && context === 3, `${folded} folded, ${context} unchanged`);
    const control = gapTable.locator(`tbody[data-gap='${key}'] button`);
    // The control is an icon in the gutter; its words are its label.
    const label = async () => (await control.getAttribute("aria-label")) ?? "";
    assert.equal(await label(), `Show ${folded + context} more lines`);
    // No two controls sit next to each other.
    const adjacent = await gapTable.evaluate((element) =>
      [...element.querySelectorAll("tbody[data-gap]")].some((gap) => gap.nextElementSibling?.matches("tbody[data-gap]") ?? false),
    );
    assert.equal(adjacent, false);
    await first.click();
    assert.equal(await gapTable.locator("tbody[data-gap-lines='folded']").isVisible(), true);
    assert.equal(await gapTable.locator("tbody[data-gap-lines='unchanged']").count(), 0);
    assert.equal(await label(), "Show 3 more lines");
    assert.equal(await control.getAttribute("aria-expanded"), "false");
    // The folded rows take comments once shown; the unchanged lines never do.
    assert.ok((await gapTable.locator("tbody[data-gap-lines='folded'] button[data-add-comment]").count()) > 0);
    await first.click();
    assert.equal(await gapTable.locator("tbody[data-gap-lines='unchanged']").isVisible(), true);
    assert.equal(await gapTable.locator("tbody[data-gap-lines='unchanged'] tr[data-unchanged]").count(), 3);
    assert.equal(await gapTable.locator("tbody[data-gap-lines='unchanged'] button[data-add-comment]").count(), 0);
    assert.equal(await label(), `Hide ${folded + context} lines`);
    assert.equal(await control.getAttribute("aria-expanded"), "true");
    await page.close();
  });

  test("a file's header sticks under the next strip while its diff is in view", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/store.py`, undefined, { width: 1280, height: 420 });
    const path = "src/notes/store.py";
    await page.evaluate((path) => {
      const block = document.querySelector<HTMLElement>(`article[data-path='${path}']`);
      if (block !== null) window.scrollTo({ top: window.scrollY + block.getBoundingClientRect().top + 200 });
    }, path);
    await settle(page);
    const [head, strip, block] = await page.evaluate((path) => [
      document.querySelector(`article[data-path='${path}'] > header[data-file-head]`)?.getBoundingClientRect().top ?? 0,
      document.querySelector("[data-next]")?.getBoundingClientRect().bottom ?? 0,
      document.querySelector(`article[data-path='${path}']`)?.getBoundingClientRect().top ?? 0,
    ], path);
    assert.ok(Math.abs(head - strip) <= 1, `header at ${head}, strip ends at ${strip}`);
    assert.ok(block < head, "the block scrolled under its header");
    await page.close();
  });

  test("the contents list the stops, then every file once by folder, in dense rows that cut a long name at its end", async () => {
    const input = fixtureInput();
    input.files_complete = false;
    input.files.push({
      path: "src/notifications/a-file-name-far-too-long-for-the-contents-sidebar.ts",
      status: "added",
      group: "core",
      additions: 1,
      deletions: 0,
      fingerprint: "4".repeat(64),
      patch: "@@ -0,0 +1,1 @@\n+x\n",
      new_content: "x\n",
    });
    input.stops[0].files.push({ path: input.files.at(-1).path });
    const agent = await server.register(input);
    const published = await agent.publish(input);
    assert.equal(published.ok, true, JSON.stringify(published));
    const page = await open(agent.url);
    await page.locator("[data-toc-file]").first().waitFor();
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-toc-file]")].map((row) => {
        const name = row.firstElementChild as HTMLElement | null;
        // The folder line the row sits under, if any.
        const folder = row.closest("ul")?.previousElementSibling?.textContent ?? "";
        return {
          path: row.dataset.tocFile ?? "",
          name: name?.textContent ?? "",
          folder,
          height: row.getBoundingClientRect().height,
          fontSize: getComputedStyle(row).fontSize,
          cut: name === null ? false : name.scrollWidth > name.clientWidth + 1,
        };
      }),
    );
    assert.equal(new Set(rows.map((row) => row.path)).size, rows.length, "every file is listed once");
    for (const row of rows) {
      assert.equal(row.height, 28, `${row.path} is ${row.height}px tall`);
      assert.equal(row.fontSize, "14px");
      assert.equal(`${row.folder}${row.name}`, row.path, `${row.path} shows under its folder by its file name`);
    }
    const long = rows.find((row) => row.path.endsWith("contents-sidebar.ts"));
    assert.equal(long?.cut, true);
    const kickers = await page.locator("nav[aria-label='Stops and files'] > p").allTextContents();
    assert.deepEqual(kickers, ["Walkthrough", "Files"]);
    assert.equal(await page.locator("[data-stop-link] ~ * [data-toc-file], li:has(> [data-stop-link]) [data-toc-file]").count(), 0);
    await page.close();
  });

  test("a narrow page shows one line-number column, and the + button sits over it", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/store.py`, undefined, { width: 390, height: 844 });
    const store = page.locator(table("src/notes/store.py"));
    await store.waitFor();
    const shownCell = (selector: string) =>
      store.locator(selector).first().evaluate((element) => getComputedStyle(element).display !== "none");
    // An added line shows its new number; a deleted line its old one; never both.
    assert.equal(await shownCell("tr[data-kind='add'] [data-ln='new']"), true);
    assert.equal(await shownCell("tr[data-kind='add'] [data-ln='old']"), false);
    assert.equal(await shownCell("tr[data-kind='del'] [data-ln='old']"), true);
    assert.equal(await shownCell("tr[data-kind='del'] [data-ln='new']"), false);
    const row = store.locator("tr[data-row='13']");
    await row.locator("button[data-add-comment]").focus();
    const [gutter, button, marker, number] = await row.evaluate((element) => [
      element.children[0]?.getBoundingClientRect().toJSON(),
      element.querySelector("button[data-add-comment]")?.getBoundingClientRect().toJSON(),
      element.children[1]?.getBoundingClientRect().toJSON(),
      element.querySelector("[data-ln='new']")?.getBoundingClientRect().toJSON(),
    ]);
    assert.ok(
      Math.abs(button.left - gutter.left) <= 0.5 && button.right >= number.right - 0.5,
      `the + (${button.left}–${button.right}) covers the number (${number.left}–${number.right}) from the gutter's edge (${gutter.left})`,
    );
    assert.ok(button.width >= 24 && button.height >= 24, `the + is ${button.width}×${button.height}`);
    assert.ok(gutter.width + marker.width <= 64, `the gutters take ${gutter.width + marker.width}px`);
    await page.close();
  });

  test("a first J from above the first stop goes to the first stop", async () => {
    const input = fixtureInput();
    input.summary = Array.from({ length: 30 }, (_, at) => `Line ${at + 1} of a long summary.`).join("\n");
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    assert.ok(
      await page.evaluate(() => (document.querySelector("#stop-1-title")?.getBoundingClientRect().top ?? 0) > window.innerHeight),
      "stop 1 starts below the screen",
    );
    await page.keyboard.press("j");
    assert.equal(await focusedStop(page), "save() becomes atomic");
    assert.match(page.url(), /#tour\/1$/);
    await page.close();
  });
});
