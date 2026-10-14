// The review page in Chromium against a real server: the one-scroll walkthrough, the next strip, comments and
// answers, live rounds, and the races the branch review found. Run after `pnpm build`: pnpm test:browser.
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

const open = async (url: string, init?: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await init?.(page);
  await page.goto(url);
  return page;
};

const toast = (page: Page) => page.locator("[data-toast]");

/** The title of the stop whose heading has focus. */
const focusedStop = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest("section.stop")?.querySelector(".stop-title")
        ?.textContent ?? "",
  );

/** The table of one file's diff; each file renders once. */
const table = (path: string) => `table.diff[data-path='${path}']`;

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
    await page.locator("section.stop").first().waitFor();
    // One scroll: every stop and every file is on the page at once.
    assert.deepEqual(await page.locator("section.stop .stop-title").allTextContents(), [
      "save() becomes atomic",
      "The rename",
      "Other files",
    ]);
    await page.keyboard.press("j");
    assert.equal(await focusedStop(page), "The rename");
    assert.match(page.url(), /#tour\/2$/);
    assert.equal(await page.locator(".toc-stop.read").count(), 2);
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
    const plus = page.locator(
      `${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`,
    );
    await plus.focus();
    await page.keyboard.press("Enter");
    assert.match(
      (await page.locator(".composer-row [data-range]").textContent()) ?? "",
      /^line 12$/,
    );
    await page.keyboard.type("Lock before the rename.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article.thread[data-turn='agent']").first().waitFor();
    const [comment] = (await agent.status()).to_answer;
    await agent.answer(comment, {
      disposition: "rejected",
      body: "The rename is atomic.",
    });
    await page
      .locator("article.thread[data-turn='reviewer']")
      .first()
      .waitFor();
    assert.equal(
      await page
        .locator("article.thread .reply.agent .tag")
        .first()
        .textContent(),
      "Rejected",
    );
    await page
      .locator(
        "article.thread[data-turn='reviewer'] button[data-reply='accept']",
      )
      .first()
      .click();
    await page
      .locator("article.thread[data-turn='resolved']")
      .first()
      .waitFor();
    await page.close();
  });

  test("a draft on code a new round changed is not moved, and its text fills the next composer", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page
      .locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`)
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Written on round 1.");
    await agent.publish(changedStore(input));
    await page.waitForFunction(() => document.body.dataset.round === "2");
    assert.equal(await page.locator(".composer-row").count(), 0);
    assert.match(
      (await toast(page).textContent()) ?? "",
      /The code under your comment changed/,
    );
    // The second stop's excerpt is another file, unchanged since round 1, which the new round's markup folds; it was
    // open on the page, so it stays open. Commenting there brings the kept text along.
    await page.keyboard.press("j");
    assert.equal(await page.locator("article.file[data-path='src/notes/format.py']").getAttribute("data-folded"), "false");
    await page
      .locator(`${table("src/notes/format.py")} [data-selectable] button.add-comment`)
      .first()
      .focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator(".composer-row textarea").inputValue(),
      "Written on round 1.",
    );
    await page.close();
  });

  test("an action from old markup is refused while its refresh is held back", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    let hold = false;
    let release = () => {};
    const page = await open(agent.url, async (page) => {
      // Hold the page's refresh, so the new round is announced but its markup has not arrived.
      await page.route(/\/reviews\/[^/]+$/, async (route) => {
        if (route.request().method() === "GET" && hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await route.continue();
      });
    });
    await page
      .locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`)
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Rows of round 1.");
    hold = true;
    await agent.publish(changedStore(input));
    await page.waitForTimeout(500);
    await page.locator(".composer-row button[type=submit]").click();
    await page.waitForFunction(() =>
      /changed since the page showed it|changed since the page loaded/.test(
        document.querySelector("[data-toast]")?.textContent ?? "",
      ),
    );
    const status = await agent.status();
    assert.equal(status.feedback.comments.length, 0);
    hold = false;
    release();
    await page.waitForFunction(() => document.body.dataset.round === "2");
    await page.close();
  });

  test("a finish names the round it covers, and the finish section catches up when it is refused", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("header.topbar [data-open-finish]").click();
    // Finish review in the top bar goes to the finish section and its first verdict.
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
      "verdict",
    );
    await agent.publish(changedStore(input));
    await page.waitForFunction(() => document.body.dataset.round === "2");
    // The reviewer is in the finish section, so it still names the round they were reading.
    assert.equal(await page.locator("#finish form").getAttribute("data-round"), "1");
    await page.locator("#finish button[type=submit]").click();
    await page.waitForFunction(() =>
      /Round 2 was published after the page showed round 1/.test(
        document.querySelector("[data-toast]")?.textContent ?? "",
      ),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#finish form")?.getAttribute("data-round") ===
        "2",
    );
    await page.locator("#finish input[value='approve']").check();
    await page.locator("#finish textarea").fill("Ship it.");
    await page.locator("#finish button[type=submit]").click();
    // The section shows the submission, and the strip says the agents have the turn. Focus stays in the section.
    await page.locator("#finish .submission").waitFor();
    await page.waitForFunction(() => document.activeElement?.id === "finish-title");
    assert.match((await page.locator("#finish-title").textContent()) ?? "", /^Round 2 finished · approve · /);
    assert.match((await page.locator("#finish .submission").textContent()) ?? "", /^You approved at .*: Ship it\.$/);
    assert.equal(await page.locator("#finish form").count(), 0);
    assert.match(
      (await page.locator(".next").textContent())?.replace(/\s+/g, " ") ?? "",
      /You finished round 2 · approve · the agents have the turn/,
    );
    const status = await agent.status();
    assert.deepEqual(
      [status.submission.round, status.submission.verdict],
      [2, "approve"],
    );
    await page.close();
  });

  test("the next strip names an answer, the first file not viewed, then the finish, and n goes there; a drift is a line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const next = page.locator("[data-next-go]");
    const text = async () => ((await next.textContent()) ?? "").replace(/\s+/g, " ").trim();
    const focused = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        return element === null
          ? ""
          : `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`} ${element.dataset.action ?? element.dataset.reply ?? (element as HTMLInputElement).name ?? ""} ${element.dataset.path ?? ""}`.trim();
      });
    // Nothing viewed and nothing to read: the first file of the first stop.
    assert.equal(await text(), "→Review src/notes/store.py · stop 1 · 10 files left");
    assert.equal(await next.getAttribute("data-target"), "files/src/notes/store.py");
    await page.keyboard.press("n");
    assert.equal(await focused(), "button approve src/notes/store.py");

    // An answer to read comes first, with its thread's name and its place.
    await page.locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first?");
    await page.locator(".composer-row button[data-ask]").click();
    await page.locator("article.thread").first().waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "No need." });
    await page.waitForFunction(() => /Read/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    assert.equal(await text(), "→Read Claude Code’s answer · src/notes/store.py:12");
    assert.equal(await next.getAttribute("data-target"), `comment-${question}`);
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("n");
    assert.equal(await focused(), "button accept");
    await page.keyboard.press("Enter");
    await page.locator("article.thread[data-turn='resolved']").waitFor();
    await page.waitForFunction(() => /Review/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    // Focus lands on the thread's next move, not on the page.
    await page.waitForFunction(() => document.activeElement?.matches("[data-action='reopen']") === true);

    // A drift is one line under the rounds, its file a link; the strip has nothing to do about it and goes on.
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.locator("#drift").waitFor();
    assert.match(
      ((await page.locator("#drift").textContent()) ?? "").replace(/\s+/g, " "),
      /^Changed since this round: src\/notes\/store\.py · checked .+ · the agents publish a new round with the change\.$/,
    );
    assert.equal(await page.locator("#drift a").getAttribute("href"), "#files/src/notes/store.py");
    assert.equal(await text(), "→Review src/notes/store.py · stop 1 · 10 files left");

    // A new round replaces the drift; with every file viewed, the strip asks for the finish.
    await agent.publish(changedStore(input));
    await page.waitForFunction(() => document.body.dataset.round === "2");
    await page.evaluate(async () => {
      let revision = Number(document.body.dataset.revision);
      for (const button of document.querySelectorAll<HTMLElement>("[data-action='approve'][aria-pressed='false']")) {
        const response = await fetch(`/reviews/${document.body.dataset.review}/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: { kind: "approve", path: button.dataset.path, fingerprint: button.dataset.fingerprint },
            revision,
          }),
        });
        revision = ((await response.json()) as { revision: number }).revision;
      }
    });
    await page.waitForFunction(() => /Finish round 2/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    assert.equal(await text(), "→Finish round 2 · everything viewed, nothing waiting");
    assert.match((await page.locator(".viewed-count").textContent()) ?? "", /10 of 10 viewed/);
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("n");
    assert.equal(await focused(), "input verdict");
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
    const back = page.locator("#stop-2 .also a");
    assert.equal(((await back.textContent()) ?? "").trim(), "src/notes/store.py lines 14–15 ↑");
    await back.click();
    const lit = page.locator(`${table("src/notes/store.py")} tr.flash`);
    assert.equal(await lit.count(), 2);
    assert.deepEqual(await lit.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.new)), ["14", "15"]);
    await page.waitForFunction(() => document.querySelectorAll("tr.flash").length === 0, undefined, { timeout: 4000 });
    await page.close();
  });

  test("Reply opens a text box in place, Esc closes it with the text kept, and the reply sends", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(".general-composer textarea").fill("Why a rename?");
    await page.locator(".general-composer button[data-ask]").click();
    await page.locator("#general article.thread").waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "Atomicity." });
    const thread = page.locator(`#comment-${question}`);
    await thread.locator(".reply.agent").waitFor();
    const editor = thread.locator(".reply-editor");
    assert.equal(await editor.isVisible(), false);
    await thread.locator("[data-reply-open]").click();
    assert.equal(await editor.isVisible(), true);
    await page.keyboard.type("And on Windows?");
    await page.keyboard.press("Escape");
    assert.equal(await editor.isVisible(), false);
    assert.equal(await thread.locator("[data-reply-open]").evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press("Enter");
    assert.equal(await thread.locator("textarea").inputValue(), "And on Windows?");
    await page.keyboard.press("Control+Enter");
    await page.locator(`#comment-${question}[data-turn='agent']`).waitFor();
    assert.match((await page.locator(`#comment-${question} .reply.reviewer`).textContent()) ?? "", /And on Windows\?/);
    // The editor closes with the reply sent, and focus goes to the thread's next move.
    await page.waitForFunction(
      (id) => document.activeElement?.closest(`#comment-${id} .thread-actions`) != null,
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
    await page.locator("button.question").first().click();
    assert.equal(
      await page.locator("#general-body").inputValue(),
      "Should a failed write clean up?",
    );
    await page.locator(".general-composer button[data-ask]").click();
    await page.locator("#general article.thread").waitFor();
    const status = await agent.status();
    assert.equal(status.questions.length, 1);
    await agent.answer(status.questions[0], {
      disposition: "answered",
      body: "Yes; mkstemp leaves it otherwise.",
    });
    // A question waits for the agent at once; its answer is the reviewer's turn. One chip says so each time.
    assert.equal(
      await page.locator("#general article.thread > .msg .tag").textContent(),
      "Waiting for Claude Code",
    );
    await page.locator("#general .reply.agent").waitFor();
    assert.deepEqual(
      await page.locator("#general article.thread .tag").allTextContents(),
      ["Your turn", "Answered"],
    );
    await page.close();
  });

  test("side by side keeps across reloads, and a comment on a new half anchors to its line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    await page.locator("[data-layout='split']").click();
    await page.locator("table.diff.split").first().waitFor();
    await page.reload();
    await page.locator("table.diff.split").first().waitFor();
    assert.equal(await page.locator("[data-layout='split']").getAttribute("aria-pressed"), "true");
    const half = page.locator(
      `${table("src/notes/store.py")} td.half.new[data-row='14']`,
    );
    await half.locator("button.add-comment").focus();
    await page.keyboard.press("Enter");
    assert.match(
      (await page.locator(".composer-row [data-range]").textContent()) ?? "",
      /line 13/,
    );
    await page.keyboard.type("Split view comment.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article.thread").first().waitFor();
    const [comment] = (await agent.status()).feedback.comments;
    assert.deepEqual(
      [comment.anchor.side, comment.anchor.start_line],
      ["new", 13],
    );
    await page.close();
  });

  test("a comment whose lines left the round moves to lines the reviewer picks", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    await page
      .locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`)
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock before the rename.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article.thread").first().waitFor();
    // Round 2 drops store.py: the comment has no lines, and shows apart with a way to move it.
    await agent.publish({
      ...input,
      files_complete: false,
      files: input.files.filter(
        (file: { path: string }) => file.path !== "src/notes/store.py",
      ),
    });
    await page.locator("#departed [data-reattach]").waitFor();
    await page.locator("#departed [data-reattach]").click();
    // cli.py is listed without an excerpt, so it starts folded; Show diff opens it.
    await page.locator("article.file[data-path='src/notes/cli.py'] [data-fold]").click();
    await page
      .locator(`${table("src/notes/cli.py")} [data-selectable] button.add-comment`)
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await page
      .locator("article.file[data-path='src/notes/cli.py'] article.thread")
      .waitFor();
    assert.equal(await page.locator("#departed").count(), 0);
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
    const file = page.locator("article.file[data-path='long.txt']");
    const expand = file.locator("[data-expand='0']");
    assert.equal(await expand.textContent(), "Show 8 more lines");
    await expand.click();
    assert.equal(await expand.textContent(), "Hide 8 lines");
    assert.equal(await file.locator("tbody[data-gap-lines='0'] tr").count(), 8);
    assert.equal(
      await file.locator("tbody[data-gap-lines='0']").isVisible(),
      true,
    );
    await file.locator("[data-action='approve']").click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("article.file[data-path='long.txt'] .file-body")?.hidden === true,
    );
    assert.equal(await file.locator("[data-fold]").getAttribute("aria-label"), "Show diff");
    assert.equal(await file.locator("[data-action='approve']").getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.locator(".toc-file[data-toc-file='long.txt'] .toc-mark").textContent(),
      "✓",
    );
    assert.deepEqual((await agent.status()).approved, ["long.txt"]);
    await page.close();
  });

  test("a page opened hidden holds no event stream until it is shown", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const streams: Array<string> = [];
    const page = await open(agent.url, async (page) => {
      await page.addInitScript(() => {
        let hidden = true;
        Object.defineProperty(document, "hidden", { get: () => hidden });
        Object.defineProperty(document, "visibilityState", {
          get: () => (hidden ? "hidden" : "visible"),
        });
        (window as unknown as { show: () => void }).show = () => {
          hidden = false;
          document.dispatchEvent(new Event("visibilitychange"));
        };
      });
      page.on("request", (request) => {
        if (request.url().endsWith("/events")) streams.push(request.url());
      });
    });
    await page.waitForTimeout(500);
    assert.equal(streams.length, 0);
    await page.evaluate(() =>
      (window as unknown as { show: () => void }).show(),
    );
    await page.waitForTimeout(500);
    assert.equal(streams.length, 1);
    await page.close();
  });

  test("a failing refresh backs off instead of retrying at once", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    let failing = false;
    let attempts = 0;
    const page = await open(agent.url, async (page) => {
      await page.route(/\/reviews\/[^/]+$/, async (route) => {
        if (failing && route.request().method() === "GET") {
          attempts++;
          await route.abort();
        } else await route.continue();
      });
    });
    await page.locator("section.stop").first().waitFor();
    failing = true;
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.waitForTimeout(3600);
    assert.ok(attempts >= 2 && attempts <= 3, `${attempts} attempts`);
    failing = false;
    await page.locator("#drift").waitFor({ timeout: 10_000 });
    await page.close();
  });
  test("agent prose keeps its line breaks and code spans, and markup in it stays text", async () => {
    const input = fixtureInput();
    input.stops[0].summary = "First line.\nSecond line.";
    input.stops[0].attention.note = "Same `rename()` only.";
    input.stops[0].notes[0].body =
      "Watch this:\n<script>window.pwned = true</script> `<b>` and `fsync`";
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const stop = page.locator("section.stop").first();
    await stop.waitFor();
    const summary = stop.locator(".stop-summary p");
    const lines = await summary.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => rect.top)).size;
    });
    assert.equal(lines, 2);
    assert.equal(
      await stop.locator(".attention code").textContent(),
      "rename()",
    );
    const note = stop.locator("tr.note").first();
    assert.deepEqual(await note.locator("code").allTextContents(), [
      "<b>",
      "fsync",
    ]);
    assert.match(
      (await note.textContent()) ?? "",
      /<script>window\.pwned = true<\/script>/,
    );
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
      page.locator(
        `${table("src/notes/store.py")} tr[data-new='${line}'] button.add-comment`,
      );
    assert.equal(await plus(3).count(), 0);
    await page.locator(`${table("src/notes/store.py")} [data-expand='r0']`).click();
    await plus(3).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".composer-row").count(), 0);
    assert.equal(
      await plus(3).evaluate((button) => document.activeElement === button),
      true,
    );
    await page.keyboard.press("Enter");
    await plus(5).focus();
    await page.keyboard.press("Shift+Enter");
    assert.match(
      (await page.locator(".composer-row [data-range]").textContent()) ?? "",
      /^lines 3–5$/,
    );
    await page.keyboard.type("Group these imports.");
    await page.keyboard.press("Control+Enter");
    await page.locator("article.thread").first().waitFor();
    const [comment] = (await agent.status()).feedback.comments;
    assert.deepEqual(
      [comment.anchor.start_line, comment.anchor.end_line],
      [3, 5],
    );
    await page.close();
  });

  test("a narrow page folds the contents into a disclosure and shows split files unified", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page
      .context()
      .addCookies([
        { name: "review-canvas-layout", value: "split", url: server.origin },
      ]);
    await page.goto(agent.url);
    const summary = page.locator(".contents-summary");
    await summary.waitFor();
    assert.equal(
      (await summary.textContent())?.replace(/\s+/g, " "),
      "Contents · 0 / 10",
    );
    const second = page.locator(".toc-stop[data-stop-link='1']");
    assert.equal(await second.isVisible(), false);
    await summary.click();
    await second.click();
    assert.equal(await focusedStop(page), "The rename");
    assert.match(page.url(), /#tour\/2$/);
    assert.equal(await second.isVisible(), false);
    // A live refresh brings markup rendered open; the folded contents stay folded.
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.locator("#drift").waitFor();
    assert.equal(await second.isVisible(), false);
    // The cookie asks for split; this width shows unified, and leaves the cookie alone.
    await page.goto(`${agent.url}#files/src/notes/store.py`);
    await page.waitForFunction(
      () =>
        document.querySelector("table.diff") !== null &&
        document.querySelector("table.diff.split") === null,
    );
    assert.equal(await page.locator("[data-layout='split']").isVisible(), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("table.diff.split").first().waitFor();
    assert.equal(await summary.isVisible(), false);
    assert.equal(await second.isVisible(), true);
    const cookies = await page.context().cookies(server.origin);
    assert.equal(
      cookies.find((cookie) => cookie.name === "review-canvas-layout")?.value,
      "split",
    );
    await page.close();
  });

  test("a wide page shows the contents without its script", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(agent.url);
    assert.equal(
      await page.locator(".toc-stop[data-stop-link='1']").isVisible(),
      true,
    );
    await context.close();
  });

  test("a lost server shows a notice until it is back, and then actions work", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/cli.py`);
    await page.locator("section.stop").first().waitFor({ state: "attached" });
    const notice = page.locator("[data-connection][role='status']");
    assert.equal(await notice.textContent(), "");
    assert.equal(await notice.isVisible(), false);
    await server.stop();
    await page.waitForFunction(
      () =>
        (document.querySelector("[data-connection]")?.textContent ?? "") !== "",
      undefined,
      { timeout: 20_000 },
    );
    assert.match((await notice.textContent()) ?? "", /^(Reconnecting…|Disconnected)$/);
    assert.match(
      (await notice.getAttribute("title")) ?? "",
      /Lost connection to the review server.*review-canvas status/,
    );
    assert.equal(await notice.isVisible(), true);
    await server.start();
    await page.waitForFunction(
      () => document.querySelector("[data-connection]")?.textContent === "",
      undefined,
      { timeout: 20_000 },
    );
    const file = page.locator("article.file[data-path='src/notes/cli.py']");
    await file.locator("[data-action='approve']").click();
    for (
      let at = 0;
      at < 50 && !(await agent.status()).approved.includes("src/notes/cli.py");
      at++
    )
      await page.waitForTimeout(100);
    assert.deepEqual((await agent.status()).approved, ["src/notes/cli.py"]);
    await page.close();
  });

  test("folds hold: what the reviewer opened or closed survives a reload, and a file an answer held open stays open after Accept", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const file = (path: string) => page.locator(`article.file[data-path='${path}']`);
    const folded = (path: string) => file(path).getAttribute("data-folded");
    // cli.py is listed without an excerpt, so it starts folded; store.py is excerpted, so it starts open.
    assert.equal(await folded("src/notes/cli.py"), "true");
    assert.equal(await folded("src/notes/store.py"), "false");
    await file("src/notes/cli.py").locator("[data-fold]").click();
    await file("src/notes/store.py").locator("[data-fold]").click();
    await page.reload();
    await file("src/notes/cli.py").waitFor();
    assert.equal(await folded("src/notes/cli.py"), "false");
    assert.equal(await folded("src/notes/store.py"), "true");
    // A question on legacy.py, in the closing stop, which folds.
    assert.equal(await folded("src/notes/legacy.py"), "true");
    await file("src/notes/legacy.py").locator("[data-fold]").click();
    await file("src/notes/legacy.py").locator("button.add-comment").first().focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Still needed?");
    await page.locator(".composer-row button[data-ask]").click();
    await file("src/notes/legacy.py").locator("article.thread").waitFor();
    const [question] = (await agent.status()).questions;
    await agent.answer(question, { disposition: "answered", body: "No." });
    await page.close();

    // A fresh tab: the answer holds legacy.py open, though the page would fold it.
    const fresh = await open(agent.url);
    const legacy = fresh.locator("article.file[data-path='src/notes/legacy.py']");
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    await fresh.keyboard.press("n");
    await fresh.keyboard.press("Enter");
    await fresh.locator(`#comment-${question}[data-turn='resolved']`).waitFor();
    // Accepting moved the strip on; the file the reviewer was reading stays open, and focus stays in the thread.
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    await fresh.waitForFunction(() => document.activeElement?.matches("[data-action='reopen']") === true);
    await fresh.reload();
    await legacy.waitFor();
    assert.equal(await legacy.getAttribute("data-folded"), "false");
    // Marking it viewed folds it.
    await legacy.locator("[data-action='approve']").click();
    await fresh.waitForFunction(
      () => document.querySelector("article.file[data-path='src/notes/legacy.py']")?.getAttribute("data-folded") === "true",
    );
    await fresh.close();
  });

  test("Esc in a composer a refresh rebuilt returns focus to its line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const plus = page.locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`);
    await plus.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Half a thought");
    const revision = await page.evaluate(() => document.body.dataset.revision);
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.waitForFunction((before) => document.body.dataset.revision !== before, revision);
    assert.equal(await page.locator(".composer-row textarea").inputValue(), "Half a thought");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".composer-row").count(), 0);
    assert.equal(await plus.evaluate((button) => document.activeElement === button), true);
    await page.close();
  });

  test("answers come in page order whatever their age, and a drift leaves the strip on them", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    // The older question is on the whole change, at the end of the page; the newer one is in the first stop.
    await page.locator(".general-composer textarea").fill("Why a rename?");
    await page.locator(".general-composer button[data-ask]").click();
    await page.locator("#general article.thread").waitFor();
    await page.locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first?");
    await page.locator(".composer-row button[data-ask]").click();
    await page.locator(`${table("src/notes/store.py")} article.thread`).waitFor();
    const questions: Array<string> = (await agent.status()).questions;
    for (const id of questions) await agent.answer(id, { disposition: "answered", body: "Because." });
    await agent.call("POST", "/drift", { paths: ["src/notes/format.py"] });
    await page.locator("#drift").waitFor();
    await page.waitForFunction(() => /2 for you/.test(document.querySelector(".next-stats")?.textContent ?? ""));
    const text = ((await page.locator("[data-next-go]").textContent()) ?? "").replace(/\s+/g, " ").trim();
    assert.equal(text, "→Read Claude Code’s answer · src/notes/store.py:12 · 1 more after this");
    const inline = await page.locator(`${table("src/notes/store.py")} article.thread`).getAttribute("id");
    assert.equal(await page.locator("[data-next-go]").getAttribute("data-target"), inline);
    await page.close();
  });

  test("a plain comment is pending until the finish, and counts as neither the reviewer's nor the agents'", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(`${table("src/notes/store.py")} tr[data-row='13'] button.add-comment`).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock first.");
    await page.keyboard.press("Control+Enter");
    const comment = page.locator(`${table("src/notes/store.py")} article.thread`);
    await comment.waitFor();
    assert.equal(await comment.getAttribute("data-standing"), "pending");
    assert.equal(await comment.locator(".tag").textContent(), "Pending");
    assert.equal(await comment.locator(".tag").getAttribute("title"), "Sent with your review");
    assert.equal(await page.locator(".next-stats .for-you, .next-stats .waiting").count(), 0);
    // A question goes out at once: it waits for the agent.
    await page.locator(".general-composer textarea").fill("Why?");
    await page.locator(".general-composer button[data-ask]").click();
    await page.locator("#general article.thread").waitFor();
    await page.waitForFunction(() => /1 waiting for agents/.test(document.querySelector(".next-stats")?.textContent ?? ""));
    // The finish carries the comment: now it waits for the agent too.
    await page.locator("#finish button[type=submit]").click();
    await page.locator("#finish .submission").waitFor();
    await page.waitForFunction(() => /2 waiting for agents/.test(document.querySelector(".next-stats")?.textContent ?? ""));
    assert.equal(await comment.locator(".tag").textContent(), "Waiting for Claude Code");
    // After the finish, the general composer no longer explains what a comment waits for.
    assert.equal(await page.locator(".general-composer .hint").count(), 0);
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
    const controls = gapTable.locator("[data-expand]");
    const first = controls.first();
    const folded = Number(await first.getAttribute("data-folded"));
    const context = Number(await first.getAttribute("data-context"));
    assert.ok(folded > 0 && context === 3, `${folded} folded, ${context} unchanged`);
    assert.equal(await first.textContent(), `Show ${folded + context} more lines`);
    // No two controls sit next to each other.
    const adjacent = await gapTable.evaluate((element) =>
      [...element.querySelectorAll("tbody.gap")].some((gap) => {
        let next = gap.nextElementSibling;
        while (next?.matches("tbody[hidden]")) next = next.nextElementSibling;
        return next?.matches("tbody.gap") ?? false;
      }),
    );
    assert.equal(adjacent, false);
    await first.click();
    assert.equal(await gapTable.locator("tbody.gap-lines.folded[data-gap='0']").isVisible(), true);
    assert.equal(await gapTable.locator("tbody.gap-lines:not(.folded)[data-gap='0']").isVisible(), false);
    assert.equal(await first.textContent(), "Show 3 more lines");
    await first.click();
    assert.equal(await gapTable.locator("tbody.gap-lines:not(.folded)[data-gap='0']").isVisible(), true);
    assert.equal(await first.textContent(), `Hide ${folded + context} lines`);
    await page.close();
  });

  test("a file's header sticks under the next strip while its diff is in view", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
    await page.goto(`${agent.url}#files/src/notes/store.py`);
    const article = page.locator("article.file[data-path='src/notes/store.py']");
    await article.waitFor();
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>("article.file[data-path='src/notes/store.py']");
      if (block !== null) window.scrollTo({ top: window.scrollY + block.getBoundingClientRect().top + 200 });
    });
    await page.waitForFunction(() =>
      document.querySelector("article.file[data-path='src/notes/store.py']")?.classList.contains("is-stuck"),
    );
    const [head, strip, block] = await page.evaluate(() => [
      document.querySelector("article.file[data-path='src/notes/store.py'] > .file-head")?.getBoundingClientRect().top ?? 0,
      document.querySelector(".next")?.getBoundingClientRect().bottom ?? 0,
      document.querySelector("article.file[data-path='src/notes/store.py']")?.getBoundingClientRect().top ?? 0,
    ]);
    assert.ok(Math.abs(head - strip) <= 1, `header at ${head}, strip ends at ${strip}`);
    assert.ok(block < head, "the block scrolled under its header");
    await page.close();
  });

  test("sidebar rows are dense, and a name too long for its row drops its whole folder before it cuts the name's end", async () => {
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
    await page.locator(".toc-file").first().waitFor();
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".toc-file")].map((row) => {
        const dir = row.querySelector<HTMLElement>(".dir");
        const base = row.querySelector<HTMLElement>(".base");
        const box = row.getBoundingClientRect();
        return {
          path: row.dataset.tocFile ?? "",
          height: box.height,
          fontSize: getComputedStyle(row).fontSize,
          // A folder that shows sits on the name's line, wholly inside the row.
          dirShown:
            dir === null
              ? null
              : Math.abs(dir.getBoundingClientRect().top - (base?.getBoundingClientRect().top ?? 0)) < 1,
          dirWhole: dir === null ? null : dir.scrollWidth <= dir.clientWidth + 1,
          baseCut: base === null ? false : base.scrollWidth > base.clientWidth + 1,
        };
      }),
    );
    for (const row of rows) {
      assert.equal(row.height, 28, `${row.path} is ${row.height}px tall`);
      assert.equal(row.fontSize, "14px");
      if (row.dirShown === true) assert.equal(row.dirWhole, true, `${row.path} shows part of its folder`);
    }
    const long = rows.find((row) => row.path.endsWith("contents-sidebar.ts"));
    assert.deepEqual([long?.dirShown, long?.baseCut], [false, true]);
    assert.ok(rows.some((row) => row.dirShown === true), "short names keep their folder");
    await page.close();
  });

  test("a narrow page shows one line-number column, and the + button sits over it", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${agent.url}#files/src/notes/store.py`);
    const store = page.locator(table("src/notes/store.py"));
    await store.waitFor();
    const shown = (selector: string) =>
      store.locator(selector).first().evaluate((element) => getComputedStyle(element).display !== "none");
    // An added line shows its new number; a deleted line its old one; never both.
    assert.equal(await shown("tr.addition .ln-new"), true);
    assert.equal(await shown("tr.addition .ln-old"), false);
    assert.equal(await shown("tr.deletion .ln-old"), true);
    assert.equal(await shown("tr.deletion .ln-new"), false);
    const row = store.locator("tr[data-row='13']");
    const plus = row.locator("button.add-comment");
    await plus.focus();
    const [gutter, button, marker, number] = await row.evaluate((element) => [
      element.querySelector("td.line-number")?.getBoundingClientRect().toJSON(),
      element.querySelector("button.add-comment")?.getBoundingClientRect().toJSON(),
      element.querySelector("td.marker")?.getBoundingClientRect().toJSON(),
      element.querySelector(".ln-new")?.getBoundingClientRect().toJSON(),
    ]);
    assert.ok(Math.abs(button.left - gutter.left) <= 0.5 && button.right >= number.right - 0.5, "the + covers the number");
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
    await page.locator("section.stop").first().waitFor();
    assert.ok(
      await page.evaluate(() => (document.querySelector("#stop-1 h2")?.getBoundingClientRect().top ?? 0) > window.innerHeight),
      "stop 1 starts below the screen",
    );
    await page.keyboard.press("j");
    assert.equal(await focusedStop(page), "save() becomes atomic");
    assert.match(page.url(), /#tour\/1$/);
    await page.close();
  });
});
