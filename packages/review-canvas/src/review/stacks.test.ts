import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { OpenPullRequest } from "../schema/pull-requests.ts";
import { pullRequestStacks } from "./stacks.ts";

const pull = (id: number, head: string, base = "main", same = true) =>
  Schema.decodeSync(OpenPullRequest)({
    url: `https://github.com/acme/project/pull/${id}`,
    title: `Layer ${id}`,
    head_branch: head,
    base_branch: base,
    same_repository: same,
  });
const numbers = (items: ReadonlyArray<OpenPullRequest>) =>
  pullRequestStacks(items).map((layers) =>
    layers.map((layer) => [layer.pull.title, layer.depth, layer.parent?.title]),
  );

test("out-of-order layers form a base-first stack, including unregistered PRs and branches", () => {
  const a = pull(1, "foundation"),
    b = pull(2, "feature", "foundation"),
    c = pull(3, "ui", "feature"),
    d = pull(4, "docs", "foundation");
  assert.deepEqual(numbers([c, b, d, a]), [
    [
      ["Layer 1", 0, undefined],
      ["Layer 2", 1, "Layer 1"],
      ["Layer 3", 2, "Layer 2"],
      ["Layer 4", 1, "Layer 1"],
    ],
  ]);
});
test("fork branch names and ambiguous heads never become inferred parents", () => {
  assert.equal(
    pullRequestStacks([
      pull(1, "feature", "main", false),
      pull(2, "ui", "feature"),
    ]).length,
    2,
  );
  assert.equal(
    pullRequestStacks([
      pull(1, "feature"),
      pull(2, "feature"),
      pull(3, "ui", "feature"),
    ]).length,
    3,
  );
});
test("cycles, self references, duplicates, and an empty list lose no PRs", () => {
  assert.deepEqual(pullRequestStacks([]), []);
  const a = pull(1, "a", "b"),
    b = pull(2, "b", "a");
  assert.equal(pullRequestStacks([a, b, a]).flat().length, 2);
  assert.equal(pullRequestStacks([pull(3, "self", "self")]).flat().length, 1);
});
test("after a parent merges and the child retargets, remaining layers still form a stack", () => {
  assert.deepEqual(numbers([pull(3, "ui", "feature"), pull(2, "feature")]), [
    [
      ["Layer 2", 0, undefined],
      ["Layer 3", 1, "Layer 2"],
    ],
  ]);
});
