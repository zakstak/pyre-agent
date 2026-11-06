// The reviewer's own writing in Chromium against a real server: unsent text the server keeps, pending comments the
// finish sends, editing and deleting comments, and suggested changes. Run after `pnpm build`: pnpm test:browser.
//
// The page saves drafts over its RPC socket without changing the review, so the tests wait for those calls to be
// answered, read from the socket's frames, instead of for a time.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";
import {
  type Agent,
  built,
  changedStore,
  fixtureInput,
  record,
  type Server,
  startServer,
  thenAnswered,
} from "./harness.ts";

let server: Server;
let browser: Browser;

const STORE = "src/notes/store.py";
const FORMAT = "src/notes/format.py";

/** Types into a box, and waits until the server saved it. */
const typeSaved = (page: Page, box: Locator, text: string) =>
  thenAnswered(page, "review.saveDraft", () => box.fill(text));

/** Two frames, so the page's first effects have run. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const shown = async (page: Page) => {
  await page
    .locator("section[data-stop]")
    .first()
    .waitFor({ state: "attached" });
  await settle(page);
};

/** Opens a review page, in a context of its own when one is given, as another browser would. */
const open = async (url: string, context?: BrowserContext) => {
  const page = await (context ?? browser).newPage({
    viewport: { width: 1280, height: 900 },
  });
  record(page);
  await page.goto(url);
  await shown(page);
  return page;
};

const reload = async (page: Page) => {
  await page.reload();
  await shown(page);
};

const table = (path: string) => `table[data-path='${path}'][data-patch]`;

const plusAt = (path: string, row: number) =>
  `${table(path)} tr[data-row='${row}'] button[data-add-comment]`;

const composer = "tr[data-composer]";

/** Waits until a text box holds `value`, as a restored draft does a moment after the page shows. */
const holds = (page: Page, selector: string, value: string) =>
  page.waitForFunction(
    ([selector, value]) =>
      (document.querySelector(selector) as HTMLTextAreaElement | null)
        ?.value === value,
    [selector, value] as const,
  );

/** Opens the composer on one row from the keyboard, or on a range with Shift+Enter on its last row's +. */
const openComposer = async (
  page: Page,
  path: string,
  row: number,
  last?: number,
) => {
  await page.locator(plusAt(path, row)).focus();
  await page.keyboard.press("Enter");
  if (last !== undefined) {
    await page.locator(plusAt(path, last)).focus();
    await page.keyboard.press("Shift+Enter");
  }
  await page.locator(`${composer} textarea`).waitFor();
};

/** A comment's article by its ID, which holds while its text changes or an editor replaces it. */
const byId = async (page: Page, found: Locator) =>
  page.locator(`#comment-${(await found.getAttribute("data-comment")) ?? ""}`);

/** Comments on a row with Comment, which leaves the comment pending, and answers with the comment's article. */
const addComment = async (
  page: Page,
  path: string,
  row: number,
  body: string,
) => {
  await openComposer(page, path, row);
  await page.locator(`${composer} textarea`).fill(body);
  await page.keyboard.press("Control+Enter");
  const article = page.locator("article[data-comment]", { hasText: body });
  await article.waitFor();
  return byId(page, article);
};

/** Asks a question on the whole change, which goes to the agents at once. */
const askNow = async (page: Page, body: string) => {
  await page.locator("#general-body").fill(body);
  await page
    .locator("#general form")
    .getByRole("button", { name: "Ask now", exact: true })
    .click();
  const article = page.locator("#general article[data-comment]", {
    hasText: body,
  });
  await article.waitFor();
  return byId(page, article);
};

const commentId = async (article: Locator) =>
  (await article.getAttribute("data-comment")) ?? "";

/** Opens a comment's menu and chooses an item: Edit or Delete. */
const choose = async (article: Locator, item: "edit" | "delete") => {
  await article.locator("[data-comment-menu]").click();
  await article.page().locator(`[data-${item}-comment]`).click();
};

const finish = async (page: Page) => {
  await page.locator("#finish button[type=submit]").click();
  await page.locator("#finish [data-submission]").waitFor();
};

/** The agent's status after a wait that returns at once, as an agent that just woke reads it. */
const woken = async (agent: Agent) => {
  const answer = await agent.call("GET", "/wait?revision=-1&timeout=1000");
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.status;
};

describe(
  "the reviewer's writing",
  { skip: !built && "run pnpm build first" },
  () => {
    before(async () => {
      server = await startServer();
      browser = await chromium.launch();
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("every box's unsent text is back after a reload, a server restart, and in another browser", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      // A question sent now takes a reply; a pending comment takes an edit.
      const question = await askNow(page, "Why a rename?");
      const questionId = await commentId(question);
      const pending = await addComment(page, STORE, 13, "Lock first.");
      const pendingId = await commentId(pending);

      await question
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await typeSaved(
        page,
        page.locator(`#reply-${questionId}`),
        "Half a reply",
      );
      await choose(pending, "edit");
      await typeSaved(
        page,
        page.locator(`#edit-${pendingId}`),
        "Lock first, then rename.",
      );
      await openComposer(page, STORE, 17);
      await typeSaved(
        page,
        page.locator(`${composer} textarea`),
        "Half a line comment",
      );
      await typeSaved(page, page.locator("#general-body"), "Half a question");
      await page.locator("#finish input[value='request_changes']").check();
      await typeSaved(page, page.locator("#finish-body"), "Half a summary");

      const restored = async (view: Page) => {
        await holds(view, `#reply-${questionId}`, "Half a reply");
        await holds(view, `#edit-${pendingId}`, "Lock first, then rename.");
        await holds(view, `${composer} textarea`, "Half a line comment");
        assert.equal(
          (await view.locator(`${composer} [data-range]`).textContent()) ?? "",
          "line 16",
        );
        await holds(view, "#general-body", "Half a question");
        await holds(view, "#finish-body", "Half a summary");
        assert.equal(
          await view
            .locator("#finish input[value='request_changes']")
            .isChecked(),
          true,
        );
      };
      await reload(page);
      await restored(page);
      await server.stop();
      await server.start();
      await reload(page);
      await restored(page);
      const other = await browser.newContext();
      try {
        await restored(await open(agent.url, other));
      } finally {
        await other.close();
      }
      // None of it reached the agents: the comment is pending, and the edit is unsent.
      const status = await agent.status();
      assert.deepEqual(
        status.feedback.comments.map((comment: any) => comment.body),
        ["Why a rename?"],
      );
      await page.close();
    });

    test("sending or cancelling a box empties what the server keeps for it", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      const question = await askNow(page, "Why a rename?");
      const questionId = await commentId(question);
      const pending = await addComment(page, STORE, 13, "Lock first.");
      const pendingId = await commentId(pending);

      // Cancelled: the composer with Esc, the reply and the edit with Cancel.
      await openComposer(page, STORE, 17);
      await typeSaved(page, page.locator(`${composer} textarea`), "Never mind");
      await thenAnswered(page, "review.discardDraft", () =>
        page.locator(`${composer} textarea`).press("Escape"),
      );
      await question
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await typeSaved(page, page.locator(`#reply-${questionId}`), "Never mind");
      await thenAnswered(page, "review.discardDraft", () =>
        question.getByRole("button", { name: "Cancel", exact: true }).click(),
      );
      await choose(pending, "edit");
      await typeSaved(page, page.locator(`#edit-${pendingId}`), "Never mind");
      await thenAnswered(page, "review.discardDraft", () =>
        pending.getByRole("button", { name: "Cancel", exact: true }).click(),
      );
      await reload(page);
      assert.equal(await page.locator(composer).count(), 0);
      assert.equal(await page.locator(`#reply-${questionId}`).count(), 0);
      assert.equal(await page.locator(`#edit-${pendingId}`).count(), 0);
      // A cancelled comment's text is not offered for the next one.
      await openComposer(page, STORE, 17);
      assert.equal(await page.locator(`${composer} textarea`).inputValue(), "");
      await page.locator(`${composer} textarea`).press("Escape");

      // Sent: each box's action empties its slot on the server.
      await openComposer(page, STORE, 17);
      await typeSaved(
        page,
        page.locator(`${composer} textarea`),
        "Sent comment",
      );
      await page.keyboard.press("Control+Enter");
      await page
        .locator("article[data-comment]", { hasText: "Sent comment" })
        .waitFor();
      await question
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await typeSaved(page, page.locator(`#reply-${questionId}`), "Sent reply");
      await page.keyboard.press("Control+Enter");
      await question
        .locator("li[data-reply='reviewer']", { hasText: "Sent reply" })
        .waitFor();
      await choose(pending, "edit");
      await typeSaved(page, page.locator(`#edit-${pendingId}`), "Sent edit");
      await page.keyboard.press("Control+Enter");
      await pending.locator("[data-edit-box]").waitFor({ state: "detached" });
      await typeSaved(page, page.locator("#general-body"), "Sent question");
      await page.locator("#general form button[type=submit]").click();
      await page
        .locator("#general article[data-comment]", { hasText: "Sent question" })
        .waitFor();
      await typeSaved(page, page.locator("#finish-body"), "Sent summary");
      await finish(page);

      // A new round opens the finish again: its summary is not kept either.
      await agent.publish({ ...input, summary: "Round two." });
      await reload(page);
      await page.locator("#finish-body").waitFor();
      await settle(page);
      assert.equal(await page.locator(composer).count(), 0);
      assert.equal(await page.locator(`#reply-${questionId}`).count(), 0);
      assert.equal(await page.locator(`#edit-${pendingId}`).count(), 0);
      assert.equal(await page.locator("#general-body").inputValue(), "");
      assert.equal(await page.locator("#finish-body").inputValue(), "");
      await pending.getByText("Sent edit", { exact: true }).waitFor();
      await page.close();
    });

    test("a saved comment whose code a new round changed is offered again after a reload", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      await openComposer(page, STORE, 13);
      await typeSaved(page, page.locator(`${composer} textarea`), "Kept text");
      await page.close();
      // The next round changes store.py's patch, so the rows the draft was on are gone.
      await agent.publish(changedStore(input));
      const next = await open(agent.url);
      await next.getByText(/The code under your comment changed/).waitFor();
      assert.equal(await next.locator(composer).count(), 0);
      await openComposer(next, STORE, 18);
      assert.equal(
        await next.locator(`${composer} textarea`).inputValue(),
        "Kept text",
      );
      await next.close();
    });

    test("pending comments stay from the agents until the finish, which sends them as edited", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      const first = await addComment(page, STORE, 13, "First thought.");
      const second = await addComment(page, STORE, 15, "Second thought.");
      const third = await addComment(page, FORMAT, 3, "Third thought.");
      for (const article of [first, second, third]) {
        assert.equal(await article.getAttribute("data-standing"), "pending");
        assert.equal(
          await article.locator("[data-chip]").textContent(),
          "Pending",
        );
      }
      assert.equal(
        await page.locator("[data-next] [data-pending-count]").textContent(),
        "3 pending",
      );
      assert.equal(
        (await page.locator("#finish [data-finish-pending]").textContent()) ??
          "",
        "Finishing sends your 3 pending comments to the agents.",
      );
      let status = await agent.status();
      assert.deepEqual(status.to_answer, []);
      assert.deepEqual(status.feedback.comments, []);
      assert.deepEqual((await woken(agent)).to_answer, []);

      // A pending comment can be edited and deleted freely.
      await choose(second, "edit");
      await page
        .locator(`#edit-${await commentId(second)}`)
        .fill("Second thought, edited.");
      await second
        .getByRole("button", { name: "Update comment", exact: true })
        .click();
      await second.getByText("Second thought, edited.").waitFor();
      // Nobody saw it, so it is not marked edited.
      assert.equal(await second.locator("[data-edited]").count(), 0);
      await choose(third, "delete");
      await page
        .locator("[data-delete-dialog]")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await third.waitFor({ state: "detached" });
      await page.locator("[data-next] [data-pending-count='2']").waitFor();
      status = await agent.status();
      assert.deepEqual(status.feedback.comments, []);

      await finish(page);
      assert.equal(await page.locator("[data-pending-count]").count(), 0);
      for (const view of [await agent.status(), await woken(agent)]) {
        assert.equal(view.to_answer.length, 2);
        assert.deepEqual(
          view.feedback.comments.map((comment: any) => [
            comment.body,
            comment.source.state,
          ]),
          [
            ["First thought.", "sent"],
            ["Second thought, edited.", "sent"],
          ],
        );
      }
      await page.close();
    });

    test("the pending count lists the pending comments, and choosing one goes to it and focuses it", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      const ids = [
        await commentId(await addComment(page, STORE, 13, "On store.")),
        await commentId(await addComment(page, FORMAT, 3, "On format.")),
      ];
      await page.locator("#general-body").fill("On the whole change.");
      await page.locator("#general form button[type=submit]").click();
      const general = page.locator("#general article[data-comment]");
      await general.waitFor();
      ids.push(await commentId(general));
      // The strip sticks at the top of the page, wherever the reviewer is.
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const id of ids) {
        await page.locator("[data-pending-count]").click();
        const items = page.locator(
          "[data-pending-list] [data-pending-comment]",
        );
        await items.first().waitFor();
        // In the order the page shows them, with where each is.
        assert.deepEqual(
          await items.evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-pending-comment")),
          ),
          ids,
        );
        await page.locator(`[data-pending-comment='${id}']`).click();
        await page.waitForFunction(
          (id) => document.activeElement?.id === `comment-${id}`,
          id,
        );
        const box = await page.locator(`#comment-${id}`).boundingBox();
        assert.ok(
          box !== null && box.y >= 0 && box.y < 900,
          `comment ${id} shows`,
        );
      }
      await page.locator("[data-pending-list]").waitFor({ state: "detached" });
      // The keyboard: Enter opens the list, arrows move, Enter chooses.
      await page.locator("[data-pending-count]").focus();
      await page.keyboard.press("Enter");
      await page.locator("[data-pending-list]").waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (ids) =>
          ids.some((id) => document.activeElement?.id === `comment-${id}`),
        ids,
      );
      await page.close();
    });

    test("a sent comment is edited for the agents, deleted only without replies, and withdrawn with them", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      const lone = await askNow(page, "Lone question?");
      const talked = await askNow(page, "Talked-over question?");
      const talkedId = await commentId(talked);

      // Sent and edited: the agents see the new text, marked edited, with when.
      await choose(talked, "edit");
      await page
        .locator(`#edit-${talkedId}`)
        .fill("Talked-over question, edited?");
      await page.keyboard.press("Control+Enter");
      await talked.locator("[data-edited]").waitFor();
      const edited = (await agent.status()).feedback.comments.find(
        (comment: any) => comment.id === talkedId,
      );
      assert.equal(edited.body, "Talked-over question, edited?");
      assert.equal(edited.source.state, "edited");
      assert.equal(
        await talked.locator("[data-edited]").getAttribute("data-edited"),
        edited.source.edited_at,
      );

      // With replies, a comment cannot be deleted; withdrawing takes it back.
      await agent.answer(talkedId, {
        disposition: "answered",
        body: "Because.",
      });
      await talked.locator("li[data-reply='agent']").waitFor();
      await talked.getByRole("button", { name: "Reply", exact: true }).click();
      await page.locator(`#reply-${talkedId}`).fill("Still unsure.");
      await page.keyboard.press("Control+Enter");
      await talked.locator("li[data-reply='reviewer']").waitFor();
      await talked.locator("[data-comment-menu]").click();
      await page.locator("[data-edit-comment]").waitFor();
      assert.equal(await page.locator("[data-delete-comment]").count(), 0);
      await page.keyboard.press("Escape");
      await talked
        .getByRole("button", { name: "Withdraw", exact: true })
        .click();
      await page
        .locator(`#comment-${talkedId}[data-turn='resolved']`)
        .waitFor();
      // The reviewer's last word takes the comment back: an accept with nothing in it.
      assert.equal(
        await page
          .locator(`#comment-${talkedId} li[data-reply='reviewer']`)
          .last()
          .textContent()
          .then((text) => /accepted/.test(text ?? "")),
        true,
      );

      // Without replies, a sent comment can be deleted, and the agents no longer see it.
      const loneId = await commentId(lone);
      await choose(lone, "delete");
      await page
        .locator("[data-delete-dialog]")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await page.locator(`#comment-${loneId}`).waitFor({ state: "detached" });
      const status = await agent.status();
      assert.deepEqual(
        status.feedback.comments.map((comment: any) => comment.id),
        [talkedId],
      );
      assert.deepEqual(status.to_answer, []);
      await page.close();
    });

    test("a comment from the git host has no menu to edit or delete it", async () => {
      const input = fixtureInput();
      const url = `https://github.com/acme/notes/pull/${process.pid}${Date.now() % 100000}`;
      input.target = {
        kind: "pull_request",
        provider: "github",
        title: "Notes",
        url,
        head_sha: input.target.head_sha,
        changed_files: input.files.length,
      };
      const agent = await server.register(input);
      await agent.publish(input);
      const imported = await agent.call("POST", "/github", {
        pull_request: url,
        items: [
          {
            kind: "conversation",
            id: "issue_1",
            author: "octocat",
            url: `${url}#issuecomment-1`,
            body: "From GitHub.",
            created_at: "2026-10-15T12:00:00.000Z",
          },
        ],
      });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      const page = await open(agent.url);
      const github = page.locator("#general article[data-comment]", {
        hasText: "From GitHub.",
      });
      await github.waitFor();
      assert.equal(await github.locator("[data-comment-menu]").count(), 0);
      const own = await askNow(page, "Mine.");
      assert.equal(await own.locator("[data-comment-menu]").count(), 1);
      await page.close();
    });

    test("Suggest change fills a block with three lines, previews the diff, and reaches the agents structured", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      // Rows 13 to 15 are new lines 12 to 14 of store.py.
      await openComposer(page, STORE, 13, 15);
      const box = page.locator(`${composer} textarea`);
      await box.fill("Name the handle:");
      await page.locator(`${composer} [data-suggest]`).click();
      const lines = [
        "    target = Path(path)",
        '    handle, temporary = tempfile.mkstemp(dir=target.parent, prefix=".notes-")',
        '    with os.fdopen(handle, "w", encoding="utf-8") as stream:',
      ];
      assert.equal(
        await box.inputValue(),
        ["Name the handle:", "```suggestion", ...lines, "```"].join("\n"),
      );
      // The caret is at the end of the block's last line, ready to change it.
      assert.equal(
        await box.evaluate((area: HTMLTextAreaElement) =>
          area.value.slice(area.selectionStart),
        ),
        "\n```",
      );
      const proposed = [
        "    target = Path(path)",
        '    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".notes-")',
        '    with os.fdopen(fd, "w", encoding="utf-8") as stream:',
      ];
      await box.fill(
        ["Name the handle:", "```suggestion", ...proposed, "```"].join("\n"),
      );
      const preview = page.locator(`${composer} [data-suggestion]`);
      await preview.waitFor();
      assert.deepEqual(
        await preview
          .locator("tr[data-op]")
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-op")),
          ),
        [" ", "-", "-", "+", "+"],
      );
      await page.keyboard.press("Control+Enter");
      const article = await byId(
        page,
        page.locator("article[data-comment]", { hasText: "Name the handle:" }),
      );
      await article.locator("[data-suggestion]").waitFor();
      // The block shows as its diff, not as text.
      assert.equal(await article.getByText("```suggestion").count(), 0);
      await finish(page);
      for (const view of [await agent.status(), await woken(agent)]) {
        assert.deepEqual(view.suggestions, [
          {
            comment: await commentId(article),
            state: "ready",
            path: STORE,
            side: "new",
            round: 1,
            start_line: 12,
            end_line: 14,
            current: lines,
            replacement: proposed,
          },
        ]);
      }

      // While editing, the preview follows the text; a block left open is reported, here and to the agents.
      await choose(article, "edit");
      const edit = page.locator(`#edit-${await commentId(article)}`);
      await edit.fill("```suggestion\n    target = Path(path)");
      await page
        .locator("[data-edit-box] [data-suggestion-problem='unclosed']")
        .waitFor();
      assert.equal(
        await page.locator("[data-edit-box] [data-suggestion]").count(),
        0,
      );
      await page.keyboard.press("Control+Enter");
      await article.locator("[data-suggestion-problem='unclosed']").waitFor();
      assert.deepEqual((await agent.status()).suggestions, [
        {
          comment: await commentId(article),
          state: "malformed",
          problem: "unclosed",
        },
      ]);
      await page.close();
    });

    test("two suggestion blocks in one comment are reported, and deleted lines alone offer no suggestion", async () => {
      const input = fixtureInput();
      const agent = await server.register(input);
      await agent.publish(input);
      const page = await open(agent.url);
      // Row 12 is the deleted line 12 of the old store.py.
      await openComposer(page, STORE, 12);
      assert.equal(await page.locator(`${composer} [data-suggest]`).count(), 0);
      await page.locator(`${composer} textarea`).press("Escape");
      await openComposer(page, STORE, 13);
      await page
        .locator(`${composer} textarea`)
        .fill("```suggestion\na\n```\n```suggestion\nb\n```");
      await page
        .locator(`${composer} [data-suggestion-problem='several']`)
        .waitFor();
      await page.keyboard.press("Control+Enter");
      const article = await byId(
        page,
        page.locator("article[data-comment]").first(),
      );
      await article.locator("[data-suggestion-problem='several']").waitFor();
      await finish(page);
      assert.deepEqual((await agent.status()).suggestions, [
        {
          comment: await commentId(article),
          state: "malformed",
          problem: "several",
        },
      ]);
      await page.close();
    });
  },
);
