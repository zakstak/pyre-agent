// One stack walkthrough across three PR reviews in Chromium against a real server: next and previous across PR
// boundaries, resume after reload, Viewed marks shared with the per-PR review, a sibling left out, a layer that moves to
// a new head, and a historical stack's limitation. Run after `pnpm build`: pnpm test:browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { type Agent, built, startServer } from "./harness.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pr = JSON.parse(
  readFileSync(join(root, "fixtures/input/pull-request.json"), "utf8"),
);
const url = (n: number) => `https://github.com/example/retry-demo/pull/${n}`;
const head = (n: number) => String(n).padStart(2, "0").repeat(20);
const layerInput = (n: number, sha = head(n)) => ({
  ...pr,
  target: { ...pr.target, url: url(n), title: `PR ${n}`, head_sha: sha },
});

const step = (n: number, title: string, path: string) => ({
  layer: url(n),
  title,
  summary: `Why ${title.toLowerCase()} matters.`,
  attention: null,
  excerpts: [],
  files: [{ path }],
  notes: [],
  questions: [],
});

const position = async (page: Page) =>
  ((await page.locator("[data-stack-position]").textContent()) ?? "").trim();

/** Waits until the page shows the step whose rail button is `key`. */
const at = (page: Page, key: string) =>
  page.locator(`button[data-step='${key}'][aria-current='step']`).waitFor();

test(
  "one walkthrough crosses PR boundaries, resumes after reload, and shares Viewed marks with each PR",
  { skip: !built },
  async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());

    const agents: Array<Agent> = [];
    for (const n of [68, 65, 69]) {
      const agent = await server.register(
        layerInput(n),
        `Claude Code: layer ${n}`,
      );
      const published = await agent.publish(layerInput(n));
      assert.equal(published.ok, true, JSON.stringify(published));
      agents.push(agent);
    }
    const publish = (historical: boolean) =>
      server.agent("POST", "/agent/stacks", {
        walkthrough: {
          format: "review-canvas.stack/1",
          title: "Retry limits, base to tip",
          summary:
            "The limit moves from config into the retry loop, then the API.",
          tip: url(69),
          steps: [
            step(68, "Retry loop", "src/retry.py"),
            step(65, "Config limit", "config/retry.json"),
            step(69, "Tip wiring", "src/retry.py"),
          ],
        },
        historical,
        path: [68, 65, 69].map((n) => ({
          url: url(n),
          title: `PR ${n}`,
          head_sha: head(n),
        })),
        excluded: [{ url: url(66), title: "Sibling docs" }],
        sessions: agents.map((agent) => ({
          review: agent.review,
          token: agent.token,
        })),
      });
    const published = await publish(false);
    assert.equal(published.ok, true, JSON.stringify(published));

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(published.url);
    await at(page, "L0:S0");
    assert.equal(await position(page), "Step 1 of 6");
    await page.getByText("Layer 1 of 3 · base", { exact: true }).waitFor();
    await page.getByText(/Not on this path:.*#66 Sibling docs/).waitFor();
    // The step's file is the layer review's own block: marking it viewed approves it in #68's review.
    await page
      .locator(
        "article[data-path='src/retry.py'] button[data-viewed][aria-pressed='false']",
      )
      .click();
    await page
      .locator(
        "article[data-path='src/retry.py'] button[data-viewed][aria-pressed='true']",
      )
      .waitFor();

    await page.getByRole("button", { name: "Next: Other files" }).click();
    await at(page, "L0:other");
    await page.getByRole("button", { name: "Next: Config limit" }).click();
    await at(page, "L1:S0");
    await page.getByText("Layer 2 of 3", { exact: true }).waitFor();
    assert.equal(await position(page), "Step 3 of 6");
    assert.equal(
      await page.locator("button[data-step='L0:S0']").getAttribute("data-read"),
      "read",
    );
    assert.equal(
      await page
        .locator("button[data-step='L0:other']")
        .getAttribute("data-read"),
      "read",
    );

    // Previous goes back across the PR boundary without marking anything.
    await page.getByRole("button", { name: "Previous: Other files" }).click();
    await at(page, "L0:other");
    await page.locator("button[data-step='L1:S0']").click();
    await at(page, "L1:S0");
    assert.equal(
      await page.locator("button[data-step='L1:S0']").getAttribute("data-read"),
      "unread",
    );

    // A reload, and a second tab, resume at the same step from the server's progress.
    await page.reload();
    await at(page, "L1:S0");
    const other = await browser.newPage();
    await other.goto(published.url);
    await at(other, "L1:S0");
    await other.close();
    await page.getByText(/2 of 6 steps read/).waitFor();

    // The per-PR review keeps its own tour, sees the approval, and links back to the walkthrough.
    const first = agents[0];
    assert.ok(first !== undefined);
    const status = await first.status();
    assert.deepEqual(status.approved, ["src/retry.py"]);
    const review = await browser.newPage();
    await review.goto(first.url);
    await review.locator("section[data-stop]").first().waitFor();
    await review
      .getByRole("link", {
        name: "Stack walkthrough: Retry limits, base to tip",
      })
      .waitFor();
    await review.close();

    // The tip moves to a new head: its step loses its excerpts and the page says why, without a reload.
    const tip = agents[2];
    assert.ok(tip !== undefined);
    await tip.publish(layerInput(69, head(90)));
    await page.locator("button[data-step='L2:S0']").click();
    await at(page, "L2:S0");
    await page
      .getByText(
        /The agent wrote these steps for 6969696; the review now shows 9090909/,
      )
      .waitFor();
    assert.equal(
      await page.locator("[data-stack-step='L2:S0'] article").count(),
      0,
    );
    assert.equal(await page.locator("button[data-step='L2:other']").count(), 0);
    await page.getByText("End of the walkthrough.").waitFor();

    // Republishing as a historical stack replaces this walkthrough and states its limitation.
    await tip.publish(layerInput(69));
    const historical = await publish(true);
    assert.equal(historical.ok, true, JSON.stringify(historical));
    assert.equal(historical.replaced, published.stack);
    await page.getByRole("link", { name: "Open the newer one" }).click();
    await page.locator("[data-historical]").waitFor();
    assert.match(
      (await page.locator("[data-historical]").textContent()) ?? "",
      /final retained head/,
    );
    // Unchanged steps keep their reads and the reviewer's position; the tip is current again at its pinned head.
    await at(page, "L2:S0");
    assert.equal(
      await page.locator("button[data-step='L0:S0']").getAttribute("data-read"),
      "read",
    );
    await page
      .locator("[data-stack-step='L2:S0'] article[data-path='src/retry.py']")
      .waitFor();
  },
);
