// The review page in Chromium against a real server: the tour, comments and answers, live rounds, and the races the
// branch review found. Run after `pnpm build`: pnpm test:browser.
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

describe("review page", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("the tour walks with J and K, and a note link shows its own stop", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("article.stop:not([hidden]) h2").waitFor();
    assert.equal(
      await page.locator("article.stop:not([hidden]) h2").textContent(),
      "save() becomes atomic",
    );
    await page.keyboard.press("j");
    assert.equal(
      await page.locator("article.stop:not([hidden]) h2").textContent(),
      "The rename",
    );
    assert.match(page.url(), /#tour\/2$/);
    assert.equal(await page.locator(".stop-link.seen").count(), 2);
    // A note in the first stop, linked from the second: the first stop shows, and the hash stays the note's.
    await page.evaluate(() => {
      location.hash = "#s0e0-note-A";
    });
    await page.waitForFunction(
      () => !document.querySelector("#stop-1")?.hasAttribute("hidden"),
    );
    assert.match(page.url(), /#s0e0-note-A$/);
    // A link to anything else on the page is the browser's: the tour stays where it is.
    await page.keyboard.press("j");
    await page.evaluate(() => {
      location.hash = "#main";
    });
    assert.equal(
      await page.locator("article.stop:not([hidden]) h2").textContent(),
      "The rename",
    );
    await page.close();
  });

  test("a comment from the keyboard, an agent's answer arriving live, and an accept", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const plus = page.locator(
      "table[data-table='s0e0'] tr[data-row='13'] button.add-comment",
    );
    await plus.focus();
    await page.keyboard.press("Enter");
    assert.match(
      (await page.locator(".composer-row [data-range]").textContent()) ?? "",
      /src\/notes\/store\.py, line 12/,
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
        .locator("article.thread .reply.agent .chip")
        .first()
        .textContent(),
      "Not changed",
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
      .locator("table[data-table='s0e0'] tr[data-row='13'] button.add-comment")
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
    // The second stop's excerpt is another file: commenting there brings the kept text along.
    await page.keyboard.press("j");
    await page
      .locator("table[data-table='s1e0'] [data-selectable] button.add-comment")
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
      .locator("table[data-table='s0e0'] tr[data-row='13'] button.add-comment")
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

  test("a finish names the round it covers, and the dialog catches up when it closes", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("header.topbar [data-open-finish]").click();
    await agent.publish(changedStore(input));
    await page.waitForFunction(() => document.body.dataset.round === "2");
    await page.locator("#finish button[type=submit]").click();
    await page.waitForFunction(() =>
      /Round 2 was published after the page showed round 1/.test(
        document.querySelector("[data-toast]")?.textContent ?? "",
      ),
    );
    await page.locator("#finish [data-close-finish]").click();
    // The browser announces a closed dialog in a task of its own; the newer dialog takes its place then.
    await page.waitForFunction(
      () =>
        document.querySelector("#finish form")?.getAttribute("data-round") ===
        "2",
    );
    await page.locator("header.topbar [data-open-finish]").click();
    await page.locator("#finish input[value='approve']").check();
    await page.locator("#finish button[type=submit]").click();
    await page.waitForFunction(
      () => !(document.querySelector("#finish") as HTMLDialogElement).open,
    );
    const status = await agent.status();
    assert.deepEqual(
      [status.submission.round, status.submission.verdict],
      [2, "approve"],
    );
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
      await page.locator("#general article.thread .chip").first().textContent(),
      "Question",
    );
    await page.close();
  });

  test("side by side keeps across reloads, and a comment on a new half anchors to its line", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files`);
    await page.locator("[data-layout-toggle]").click();
    await page.locator("#files-view table.diff.split").first().waitFor();
    await page.reload();
    await page.locator("#files-view table.diff.split").first().waitFor();
    const half = page.locator(
      "#files-view table[data-path='src/notes/store.py'] td.half.new[data-row='14']",
    );
    await half.locator("button.add-comment").focus();
    await page.keyboard.press("Enter");
    assert.match(
      (await page.locator(".composer-row [data-range]").textContent()) ?? "",
      /line 13/,
    );
    await page.keyboard.type("Split view comment.");
    await page.keyboard.press("Control+Enter");
    await page.locator("#files-view article.thread").first().waitFor();
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
      .locator(
        "#files-view table[data-path='src/notes/store.py'] tr[data-row='13'] button.add-comment",
      )
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lock before the rename.");
    await page.keyboard.press("Control+Enter");
    await page.locator("#files-view article.thread").first().waitFor();
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
    await page
      .locator(
        "#files-view table[data-path='src/notes/cli.py'] [data-selectable] button.add-comment",
      )
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await page
      .locator(
        "#files-view article.file[data-path='src/notes/cli.py'] article.thread",
      )
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
    const file = page.locator("#files-view article.file[data-path='long.txt']");
    const expand = file.locator("[data-expand='0']");
    assert.equal(await expand.textContent(), "Show 8 unchanged lines");
    await expand.click();
    assert.equal(await file.locator("tbody[data-gap-lines='0'] tr").count(), 8);
    assert.equal(
      await file.locator("tbody[data-gap-lines='0']").isVisible(),
      true,
    );
    await file.locator("[data-action='approve']").click();
    await page.waitForFunction(() => {
      const body = document.querySelector(
        "#files-view article.file[data-path='long.txt'] details.file-body",
      );
      return body instanceof HTMLDetailsElement && !body.open;
    });
    assert.match(
      await file.locator("summary.file-toggle").innerText(),
      /Approved\. Show the change/,
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
    await page.locator("article.stop:not([hidden])").waitFor();
    failing = true;
    await agent.call("POST", "/drift", { paths: ["src/notes/store.py"] });
    await page.waitForTimeout(3600);
    assert.ok(attempts >= 2 && attempts <= 3, `${attempts} attempts`);
    failing = false;
    await page.locator(".notice.drift").waitFor({ timeout: 10_000 });
    await page.close();
  });
  test("a lost server shows a notice until it is back, and then actions work", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(`${agent.url}#files/src/notes/cli.py`);
    await page.locator("article.stop").first().waitFor({ state: "attached" });
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
    assert.match(
      (await notice.textContent()) ?? "",
      /Lost connection to the review server.*review-canvas status/,
    );
    assert.equal(await notice.isVisible(), true);
    await server.start();
    await page.waitForFunction(
      () => document.querySelector("[data-connection]")?.textContent === "",
      undefined,
      { timeout: 20_000 },
    );
    const file = page.locator(
      "#files-view article.file[data-path='src/notes/cli.py']",
    );
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
