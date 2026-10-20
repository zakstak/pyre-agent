import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { Fixture } from "../collector/testing.ts";
import { PullRequestUrl, WorktreeRoot } from "../schema/primitives.ts";
import { identifyRepository } from "../server/repositories.ts";
import { pullRequestStacks, stackAncestors } from "../review/stacks.ts";
import { addressOf, type ForgeClients } from "./hosted.ts";
import { browsePullRequest } from "./browse-pull.ts";
import { readHistoricalPullRequests } from "./pull-history.ts";
import { hostStackPath } from "./stack-range.ts";

export const historicalRow = (
  n: number,
  head: string,
  base: string,
  branch: string,
  parent: string,
) => ({
  url: `https://github.com/example/notes/pull/${n}`,
  title: `Layer ${n}`,
  state: "MERGED",
  headRefName: branch,
  baseRefName: "main",
  headRefOid: head,
  baseRefOid: base,
  isCrossRepository: false,
  timelineItems: {
    pageInfo: { hasNextPage: false },
    nodes:
      parent === "main"
        ? []
        : [{ previousRefName: parent, currentRefName: "main" }],
  },
});
export const historyResponse = (nodes: ReturnType<typeof historicalRow>[]) =>
  JSON.stringify([
    {
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          pullRequests: { nodes },
        },
      },
    },
  ]);

const url = Schema.decodeSync(PullRequestUrl)(
  "https://github.com/example/notes/pull/3",
);

test("retargeted merged PRs compare only their layer or their ancestors, excluding siblings and dirty work", async (t) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "base\n" });
  const base = f.head();
  f.commit({ "foundation.txt": "foundation\n" });
  const parent = f.head();
  f.commit({ "feature.txt": "feature\n" });
  const child = f.head();
  f.commit({ "ui.txt": "ui\n" });
  const tip = f.head();
  f.git(f.root, "checkout", "-b", "sibling", parent);
  f.commit({ "sibling.txt": "sibling\n" });
  const sibling = f.head();
  f.git(
    f.root,
    "remote",
    "add",
    "origin",
    "https://github.com/example/notes.git",
  );
  f.write("ui.txt", "dirty\n");
  const rows = [
    historicalRow(1, parent, base, "foundation", "main"),
    historicalRow(2, child, base, "feature", "foundation"),
    historicalRow(3, tip, base, "ui", "feature"),
    historicalRow(4, sibling, base, "sibling", "foundation"),
  ];
  const clients: ForgeClients = {
    api: () => {
      throw new Error("Unexpected API");
    },
    gh: (args) => {
      if (args.includes("graphql")) return historyResponse(rows);
      const row = rows.find((item) => item.url === args[2]);
      if (row === undefined)
        throw new Error(`Unexpected command ${args.join(" ")}`);
      return JSON.stringify({ ...row, changedFiles: 1 });
    },
  };
  const repository = await identifyRepository(
    Schema.decodeSync(WorktreeRoot)(f.root),
  );
  const before = f.git(f.root, "status", "--porcelain");
  for (const mode of ["layer", "cumulative"] as const) {
    const result = await browsePullRequest(repository, url, clients, {
      mode,
      historical: true,
    });
    assert.equal(result.kind, "ready", JSON.stringify(result));
    if (result.kind !== "ready") continue;
    assert.deepEqual(
      result.input.files.map((file) => file.path),
      mode === "layer"
        ? ["ui.txt"]
        : ["feature.txt", "foundation.txt", "ui.txt"],
    );
    assert.equal(result.comparison?.base_sha, mode === "layer" ? child : base);
    assert.equal(result.input.target.head_sha, tip);
  }
  assert.equal(f.git(f.root, "status", "--porcelain"), before);
  rows[1] = historicalRow(2, sibling, base, "feature", "foundation");
  const rewritten = await browsePullRequest(repository, url, clients, {
    mode: "layer",
    historical: true,
  });
  assert.equal(rewritten.kind, "unavailable");
  if (rewritten.kind === "unavailable")
    assert.match(rewritten.message, /not an ancestor/);
});

test("historical discovery preserves branch ambiguity and incomplete timelines", () => {
  const base = "a".repeat(40),
    head = "b".repeat(40);
  const rows = [
    historicalRow(1, head, base, "foundation", "main"),
    historicalRow(2, head, base, "foundation", "main"),
    historicalRow(3, head, base, "ui", "foundation"),
  ];
  const clients: ForgeClients = {
    api: () => [],
    gh: () => historyResponse(rows),
  };
  let items = readHistoricalPullRequests(addressOf(url), clients);
  assert.equal(pullRequestStacks(items).length, 3);
  assert.equal(stackAncestors(items, url).length, 1);
  rows.pop();
  const first = rows[0];
  if (first !== undefined) first.timelineItems.pageInfo.hasNextPage = true;
  items = readHistoricalPullRequests(addressOf(url), clients);
  assert.equal(items[0]?.history?.timeline_complete, false);
});

const pull = (n: number) =>
  Schema.decodeSync(PullRequestUrl)(
    `https://github.com/example/notes/pull/${n}`,
  );
const sha = (n: number) => String(n).padStart(2, "0").repeat(20);

/** #67 -> #73 -> #74 -> #75 -> #76, all merged after retargeting to main, with #77 a sibling of #74. */
const walkthroughRows = () => [
  historicalRow(67, sha(67), sha(1), "one", "main"),
  historicalRow(73, sha(73), sha(1), "two", "one"),
  historicalRow(74, sha(74), sha(1), "three", "two"),
  historicalRow(75, sha(75), sha(1), "four", "three"),
  historicalRow(76, sha(76), sha(1), "five", "four"),
  historicalRow(77, sha(77), sha(1), "side", "two"),
];

const walkthroughClients = (
  nodes: ReturnType<typeof walkthroughRows>,
): ForgeClients => ({
  api: () => {
    throw new Error("Unexpected API");
  },
  gh: (args) => {
    if (args.includes("graphql")) return historyResponse(nodes);
    throw new Error(
      `A historical path reads heads from history, not ${args.join(" ")}`,
    );
  },
});

test("a historical walkthrough path pins each layer's final retained head and leaves the sibling out", () => {
  const found = hostStackPath(
    pull(76),
    true,
    walkthroughClients(walkthroughRows()),
  );
  assert.deepEqual(
    found.path.map((layer) => [layer.url, layer.head_sha]),
    [67, 73, 74, 75, 76].map((n) => [pull(n), sha(n)]),
  );
  assert.deepEqual(
    found.excluded.map((item) => item.url),
    [pull(77)],
  );
});

test("a historical walkthrough refuses missing or ambiguous root dependencies", () => {
  const rows = walkthroughRows();
  assert.throws(
    () => hostStackPath(pull(76), true, walkthroughClients(rows.slice(1))),
    /root dependency is missing or ambiguous/,
  );
  const root = rows[0];
  assert.ok(root !== undefined);
  assert.throws(
    () =>
      hostStackPath(
        pull(76),
        true,
        walkthroughClients([...rows, { ...root, url: pull(78) }]),
      ),
    /root dependency is missing or ambiguous/,
  );
});

test("a historical path with truncated base-change history is refused", () => {
  const truncated = walkthroughRows();
  const layer = truncated[2];
  assert.ok(layer !== undefined);
  layer.timelineItems.pageInfo.hasNextPage = true;
  assert.throws(
    () => hostStackPath(pull(76), true, walkthroughClients(truncated)),
    /truncated|absent|missing or ambiguous/,
  );
});
