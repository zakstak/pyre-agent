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
    // The second stop's excerpt is another file, folded as unchanged since round 1: commenting there, once it is
    // open, brings the kept text along.
    await page.keyboard.press("j");
    await page.locator("article.file[data-path='src/notes/format.py'] [data-fold]").click();
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
    // The section shows the submission, and the strip says the agents have the turn.
    await page.locator("#finish .submission").waitFor();
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

  test("the next strip names an answer, a drift, the first file not viewed, then the finish, and n goes there", async () => {
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

    // A drift in this round comes before the files.
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.waitForFunction(() => /Look at what changed/.test(document.querySelector("[data-next-go]")?.textContent ?? ""));
    assert.equal(await text(), "→Look at what changed · 1 file changed since this round");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("n");
    assert.equal(await focused(), "p#drift");

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
    await page.locator("#general .reply.agent").waitFor();
    assert.equal(
      await page.locator("#general article.thread .tag").first().textContent(),
      "Question",
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
    assert.equal(await expand.textContent(), "Show 8 unchanged lines");
    await expand.click();
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
    assert.equal(await file.locator("[data-fold]").textContent(), "Show diff");
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
});
