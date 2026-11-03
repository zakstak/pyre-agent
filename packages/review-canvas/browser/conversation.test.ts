// The conversation on the review page in Chromium against a real server: comments from the git host with their bots
// and Markdown, questions that stay on the stop they are about, and whether an agent listens to what the reviewer
// sends. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import {
  built,
  fixtureInput,
  record,
  type Server,
  startServer,
  thenAnswered,
} from "./harness.ts";

let server: Server;
let browser: Browser;

const PR = "https://github.com/acme/notes/pull/7";

/** Two frames, so the page's first effects have run. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const open = async (url: string, init?: (page: Page) => void) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  record(page);
  init?.(page);
  await page.goto(url);
  await page
    .locator("section[data-stop]")
    .first()
    .waitFor({ state: "attached" });
  await settle(page);
  return page;
};

const text = async (page: Page, selector: string) =>
  ((await page.locator(selector).first().textContent()) ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** The first stop, which suggests a question. */
const FIRST = "section[data-stop='0']";

describe("the conversation", { skip: !built && "run pnpm build first" }, () => {
  before(async () => {
    server = await startServer();
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("a bot from the git host shows as a bot, and comment bodies render as Markdown that runs nothing and loads nothing", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const imported = await agent.call("POST", "/github", {
      pull_request: PR,
      items: [
        {
          kind: "review",
          id: "PRR_1",
          author: "chatgpt-codex-connector[bot]",
          url: `${PR}#pullrequestreview-1`,
          created_at: "2026-11-03T09:00:00.000Z",
          body: [
            "<!-- codex: internal marker -->",
            "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>  Guard the lock**",
            "",
            "<details> <summary>About Codex in GitHub</summary>",
            "<br/>",
            "",
            "Reviews run when you [open a PR](https://chatgpt.com/codex).",
            "</details>",
            "",
            '<script>window.ran = true</script><img src="https://example.com/x.png" onerror="window.ran = true">',
          ].join("\n"),
        },
        {
          kind: "conversation",
          id: "IC_2",
          author: "octocat",
          url: `${PR}#issuecomment-2`,
          created_at: "2026-11-03T09:01:00.000Z",
          body: "Looks good, but `save()` needs a test.",
        },
      ],
    });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    // Every request the page makes, from its first: nothing from the comments may load.
    const requests: Array<string> = [];
    const page = await open(agent.url, (opened) =>
      opened.on("request", (request) => requests.push(request.url())),
    );
    const bot = page.locator("#general article[data-comment]").first();
    const person = page.locator("#general article[data-comment]").nth(1);
    await bot.waitFor();
    // The bot shows by its name, without the suffix, with the bot mark; a person by their @login.
    assert.match(
      await bot.locator("p").first().innerText(),
      /^chatgpt-codex-connector\s*bot\b/,
    );
    assert.match(await person.locator("p").first().innerText(), /^@octocat/);
    // Markdown renders: bold, code, a closed disclosure whose Markdown shows when opened.
    assert.match(
      await bot.locator("[data-markdown] strong").first().innerText(),
      /^P1 Badge\s+Guard the lock$/,
    );
    assert.equal(
      await person.locator("[data-markdown] code").innerText(),
      "save()",
    );
    const details = bot.locator("[data-markdown] details");
    assert.equal(
      await details.locator("summary").innerText(),
      "About Codex in GitHub",
    );
    const inside = details.locator("a", { hasText: "open a PR" });
    assert.equal(await inside.isVisible(), false);
    await details.locator("summary").click();
    assert.equal(await inside.isVisible(), true);
    assert.equal(await inside.getAttribute("target"), "_blank");
    assert.match((await inside.getAttribute("rel")) ?? "", /noopener/);
    // HTML comments go; no script runs; images are links, never loaded.
    const body = await bot.innerText();
    assert.doesNotMatch(body, /internal marker|<!--|<details>|<sub>|script/);
    assert.equal(await bot.locator("img, script").count(), 0);
    assert.deepEqual(
      await bot
        .locator("a[data-image]")
        .evaluateAll((links) =>
          links.map((link) => [link.textContent, link.getAttribute("href")]),
        ),
      [
        ["P1 Badge", "https://img.shields.io/badge/P1-orange"],
        ["image", "https://example.com/x.png"],
      ],
    );
    assert.equal(await page.evaluate(() => "ran" in window), false);
    await settle(page);
    assert.deepEqual(
      requests.filter((url) => !url.startsWith(server.origin)),
      [],
    );
    await page.close();
  });

  test("a stop's question opens a box in the stop, and the question, the agent's view of it, and the answer stay there", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(`${FIRST} button[data-question]`).click();
    const box = page.locator(`${FIRST} [data-stop-composer] textarea`);
    assert.equal(await box.inputValue(), "Should a failed write clean up?");
    await page.waitForFunction(
      () => document.activeElement?.id === "stop-1-ask",
    );
    // The comment on the whole change is untouched.
    assert.equal(await page.locator("#general-body").inputValue(), "");
    await thenAnswered(page, "review.saveDraft", () =>
      box.fill("Should a failed write clean up its temporary file?"),
    );
    // The box's text is kept like any other: a reload puts it back in the stop.
    await page.reload();
    await page.locator(`${FIRST} [data-stop-composer] textarea`).waitFor();
    assert.equal(
      await page.locator(`${FIRST} [data-stop-composer] textarea`).inputValue(),
      "Should a failed write clean up its temporary file?",
    );
    await page
      .locator(`${FIRST} [data-stop-composer]`)
      .getByRole("button", { name: "Ask now", exact: true })
      .click();
    const thread = page.locator(
      `${FIRST} [data-stop-talk] article[data-comment]`,
    );
    await thread.waitFor();
    assert.equal(
      await page.locator(`${FIRST} [data-stop-composer]`).count(),
      0,
    );
    assert.equal(
      await page.locator("#general article[data-comment]").count(),
      0,
    );
    // The agent sees which stop the question is about.
    const status = await agent.status();
    assert.equal(status.questions.length, 1);
    const asked = status.feedback.comments.find(
      (comment: { id: string }) => comment.id === status.questions[0],
    );
    assert.equal(asked.kind, "stop");
    assert.deepEqual(asked.anchor.stop, {
      kind: "stop",
      title: "save() becomes atomic",
      occurrence: 0,
    });
    assert.deepEqual(asked.anchor.excerpts, [
      { path: "src/notes/store.py", side: "new", start_line: 11, end_line: 17 },
    ]);
    assert.deepEqual(asked.attachment, { state: "attached", stop: 0 });
    // The answer lands under the question, in the stop, and the strip names the stop.
    await agent.answer(status.questions[0], {
      disposition: "answered",
      body: "Yes: `mkstemp` leaves it otherwise.",
    });
    await thread.locator("li[data-reply='agent']").waitFor();
    assert.equal(
      await thread
        .locator("li[data-reply='agent'] [data-markdown] code")
        .innerText(),
      "mkstemp",
    );
    assert.match(
      await text(page, "[data-next]"),
      /Read Claude Code’s answer · on stop 1 · save\(\) becomes atomic/,
    );
    await page.close();
  });

  test("Ask about this stop works in the source view's guide too, and Esc keeps the text for later", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page
      .locator("[role='group'][aria-label='View'] button[data-view='source']")
      .click();
    const stop = page.locator("[data-guide-stop='1']");
    await stop.locator("button[data-ask-stop]").click();
    const box = stop.locator("[data-stop-composer] textarea");
    await box.fill("Why rename the module now?");
    await box.press("Escape");
    assert.equal(await stop.locator("[data-stop-composer]").count(), 0);
    await page.waitForFunction(
      () =>
        document.activeElement?.matches(
          "[data-guide-stop='1'] button[data-ask-stop]",
        ) === true,
    );
    await stop.locator("button[data-ask-stop]").click();
    assert.equal(await box.inputValue(), "Why rename the module now?");
    await stop
      .locator("[data-stop-composer]")
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    const thread = stop.locator("article[data-comment]");
    await thread.waitFor();
    assert.equal(await thread.getAttribute("data-standing"), "pending");
    // A pending comment on a stop waits for the finish like any other, and the pending list names its stop.
    assert.equal((await agent.status()).to_answer.length, 0);
    await page.locator("[data-pending-count]").click();
    assert.equal(
      await text(page, "[data-pending-list] [data-pending-comment] code"),
      "Stop 2 · The rename",
    );
    await page.close();
  });

  test("a round that drops a stop moves its thread to the comments on the whole change, naming the stop", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator(`${FIRST} button[data-question]`).click();
    await page
      .locator(`${FIRST} [data-stop-composer]`)
      .getByRole("button", { name: "Ask now", exact: true })
      .click();
    await page
      .locator(`${FIRST} [data-stop-talk] article[data-comment]`)
      .waitFor();
    await agent.publish({ ...input, stops: input.stops.slice(1) });
    const moved = page.locator("#general article[data-comment]");
    await moved.waitFor();
    assert.equal(
      await text(page, "#general [data-dropped-stop]"),
      "On the stop “save() becomes atomic” of round 1, which round 2’s tour no longer has.",
    );
    assert.equal(
      await page.locator("[data-stop-talk] article[data-comment]").count(),
      0,
    );
    const [question] = (await agent.status()).questions;
    const comment = (await agent.status()).feedback.comments.find(
      (item: { id: string }) => item.id === question,
    );
    assert.deepEqual(comment.attachment, {
      state: "orphan",
      reason: "Round 2's tour has no stop “save() becomes atomic”.",
    });
    await page.close();
  });

  test("the top bar says whether an agent listens, and a question or a finish sent while none does says so until one checks in", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    const presence = page.locator("[data-presence]");
    await presence.waitFor();
    // Registering and publishing were the agent's last signs; it waits for nothing now.
    assert.equal(await presence.getAttribute("data-presence"), "away");
    assert.match(await presence.innerText(), /^Claude Code last seen \S/);

    // A question asked while no agent listens says so under it.
    await page.locator(`${FIRST} button[data-question]`).click();
    await page
      .locator(`${FIRST} [data-stop-composer]`)
      .getByRole("button", { name: "Ask now", exact: true })
      .click();
    const note = page.locator(`${FIRST} [data-not-listening]`);
    await note.waitFor();
    assert.equal(
      await note.innerText(),
      "Claude Code isn’t listening; it will see this when it checks in.",
    );
    // The agent checks in: it read the question, so the note goes.
    await agent.status();
    await note.waitFor({ state: "detached" });
    assert.equal(await presence.getAttribute("data-presence"), "away");

    // An agent that waits listens; a question asked then needs no note.
    const waited = agent.call(
      "GET",
      `/wait?revision=${(await agent.status()).revision}&timeout=20000`,
    );
    await page.locator("[data-presence='listening']").waitFor();
    assert.equal(await presence.innerText(), "Claude Code listening");
    await page.locator("#general-body").fill("And the lock file?");
    await page
      .locator("#general form")
      .getByRole("button", { name: "Ask now", exact: true })
      .click();
    await page.locator("#general article[data-comment]").waitFor();
    assert.equal((await waited).status.questions.length, 2);
    await settle(page);
    assert.equal(await page.locator("[data-not-listening]").count(), 0);
    // Its wait just returned: it stays listening for a moment, as `wait` polls again.
    assert.equal(await presence.getAttribute("data-presence"), "listening");
    await page.close();
  });

  test("a finished round says when no agent listens, until one checks in", async () => {
    const input = fixtureInput();
    const agent = await server.register(input);
    await agent.publish(input);
    const page = await open(agent.url);
    await page.locator("#finish button[type=submit]").click();
    await page.locator("#finish [data-submission]").waitFor();
    const note = page.locator("#finish [data-not-listening]");
    await note.waitFor();
    assert.equal(
      await note.innerText(),
      "Claude Code isn’t listening; it will see this when it checks in.",
    );
    await agent.call("GET", "/wait?revision=-1&timeout=1000");
    await note.waitFor({ state: "detached" });
    await page.close();
  });
});
