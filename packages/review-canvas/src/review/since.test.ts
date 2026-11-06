import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type { Fingerprint, RoundNumber } from "../schema/primitives.ts";
import type { ReviewState } from "./queries.ts";
import { compareFile, compareSince, sinceRound } from "./since.ts";

const file = (path: string, extra: Partial<ReviewFile> = {}): ReviewFile =>
  ({
    path,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    ...extra,
  }) as ReviewFile;

const round = (n: number) => ({
  round: n,
  input_sha256: String(n).repeat(64),
  thread: "t",
  published_at: `2026-10-1${n}T00:00:00.000Z`,
});

const state = (rounds: number, submitted: ReadonlyArray<number>) =>
  ({
    rounds: Array.from({ length: rounds }, (_, at) => round(at + 1)),
    submissions: submitted.map((n) => ({
      round: n,
      verdict: "comment",
      body: "",
      submitted_at: `2026-10-1${n}T01:00:00.000Z`,
      revision: n,
    })),
  }) as unknown as ReviewState;

test("since my last review is the last finished round, or else the round before the current one", () => {
  assert.equal(sinceRound(state(0, [])), undefined);
  assert.equal(sinceRound(state(1, [])), undefined);
  assert.equal(sinceRound(state(3, [])), 2);
  assert.equal(sinceRound(state(3, [1])), 1);
  // The last submission decides, even when it finished the current round: nothing is new since.
  assert.equal(sinceRound(state(3, [1, 3])), 3);
});

test("a file compares by fingerprint first, then by its whole text", () => {
  const then = file("a.ts", {
    fingerprint: "1".repeat(64) as Fingerprint,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
    new_content: "b\nc\n",
  });
  assert.deepEqual(compareFile(undefined, then), { kind: "added" });
  assert.deepEqual(compareFile(then, then), { kind: "unchanged" });
  const sameText = {
    ...then,
    fingerprint: "2".repeat(64) as Fingerprint,
  };
  assert.deepEqual(compareFile(then, sameText), { kind: "unchanged" });
  const changed = compareFile(then, { ...sameText, new_content: "b\nd\n" });
  assert.equal(changed.kind, "changed");
  assert.ok(changed.kind === "changed" && changed.patch.includes("-c\n+d"));
});

test("a deleted file and a file without both texts cannot be compared, unless nothing changed", () => {
  const then = file("a.ts", {
    fingerprint: "1".repeat(64) as Fingerprint,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
  });
  const other = "2".repeat(64) as Fingerprint;
  assert.deepEqual(
    compareFile(then, { ...then, fingerprint: other, status: "deleted" }),
    { kind: "cannot_compare", reason: "deleted" },
  );
  assert.deepEqual(
    compareFile(then, {
      ...then,
      fingerprint: other,
      patch: "@@ -1 +1 @@\n-a\n+c\n",
    }),
    { kind: "cannot_compare", reason: "no_text" },
  );
  // The same change without a fingerprint to compare is the same file.
  const bare = file("a.ts", { patch: "@@ -1 +1 @@\n-a\n+b\n" });
  assert.deepEqual(compareFile(bare, bare), { kind: "unchanged" });
  // One text alone is not enough to compare.
  assert.deepEqual(
    compareFile(bare, {
      ...bare,
      patch: "@@ -1 +1 @@\n-a\n+c\n",
      new_content: "c\n",
    }),
    { kind: "cannot_compare", reason: "no_text" },
  );
});

test("texts too different to diff say so instead of showing a wrong diff", () => {
  const lines = (prefix: string) =>
    Array.from({ length: 2500 }, (_, at) => `${prefix}${at}`).join("\n");
  assert.deepEqual(
    compareFile(
      file("a.ts", { new_content: lines("a") }),
      file("a.ts", { new_content: lines("b") }),
    ),
    { kind: "cannot_compare", reason: "too_different" },
  );
});

test("a comparison covers every current file, counts the unchanged ones, and names files that left", () => {
  const fingerprint = "1".repeat(64) as Fingerprint;
  const then = {
    files: [
      file("same.ts", { fingerprint }),
      file("gone.ts", { fingerprint }),
      file("edited.ts", { new_content: "a\n" }),
    ],
  } as unknown as ReviewInput;
  const now = {
    files: [
      file("same.ts", { fingerprint }),
      file("edited.ts", { new_content: "b\n" }),
      file("new.ts"),
    ],
  } as unknown as ReviewInput;
  const since = compareSince(1 as RoundNumber, then, now);
  assert.equal(since.round, 1);
  assert.deepEqual(
    [...since.files].map(([path, item]) => [path, item.kind]),
    [
      ["same.ts", "unchanged"],
      ["edited.ts", "changed"],
      ["new.ts", "added"],
    ],
  );
  assert.equal(since.unchanged, 1);
  assert.deepEqual(since.left, ["gone.ts"]);
});
