// The review page's pure parts: status words, sidebar names, the hash contract, and the revision actions carry.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile } from "../../schema/input.ts";
import type { Revision } from "../../schema/primitives.ts";
import { splitPath, underRoot } from "../names.ts";
import { afterOwnAction } from "./data.ts";
import { parseHash } from "./places.ts";
import { fileStatus } from "./view.ts";

const file = (extra: Readonly<Record<string, unknown>> = {}) =>
  ({ path: "src/a.ts", status: "modified", group: "core", additions: 1, deletions: 1, ...extra }) as ReviewFile;

test("a file header shows one status word: a lapsed approval, then a change since the round before, then what the file is", () => {
  const since = { round: 1, patch: "@@ -1 +1 @@\n-one\n+one!\n" };
  assert.deepEqual(fileStatus(file(), true, since), {
    kind: "since",
    text: "changed since you viewed it",
    warning: true,
    patch: since.patch,
  });
  assert.equal(fileStatus(file({ status: "added" }), false, since)?.text, "changed since round 1");
  assert.equal(fileStatus(file({ status: "added" }), true, undefined)?.kind, "word");
  assert.deepEqual(fileStatus(file({ status: "renamed", old_path: "src/b.ts" }), false, undefined), {
    kind: "word",
    text: "renamed from src/b.ts",
    warning: false,
  });
  // Modified, and unchanged since the round before, say nothing.
  assert.equal(fileStatus(file(), false, undefined), undefined);
});

test("the contents name a file by its folder and its file name", () => {
  assert.deepEqual(splitPath("src/jobs/webhook-retry-queue.ts"), { dir: "src/jobs/", base: "webhook-retry-queue.ts" });
  assert.deepEqual(splitPath("pnpm-lock.yaml"), { dir: "", base: "pnpm-lock.yaml" });
});

test("a checkout's path is shown under the longest scan directory that holds it", () => {
  const roots = ["~/git", "~/git/work/"];
  assert.equal(underRoot("~/git/work/ledger", roots), "ledger");
  assert.equal(underRoot("~/git/pyre", roots), "pyre");
  assert.equal(underRoot("~/gitlab/pyre", roots), "~/gitlab/pyre");
  assert.equal(underRoot("~/git", roots), "~/git");
});

test("a hash names the files view, a stop, an element, or the start", () => {
  assert.deepEqual(parseHash(""), { kind: "start" });
  assert.deepEqual(parseHash("#files"), { kind: "files" });
  assert.deepEqual(parseHash("#files/src/a%20b.ts"), { kind: "files", file: "src/a b.ts" });
  assert.deepEqual(parseHash("#tour/3"), { kind: "stop", index: 2 });
  // A note in a later stop keeps its own identity instead of resetting the tour.
  assert.deepEqual(parseHash("#s1e0-note-A"), { kind: "element", id: "s1e0-note-A" });
  assert.deepEqual(parseHash("#main"), { kind: "element", id: "main" });
  assert.deepEqual(parseHash("#tour/0"), { kind: "element", id: "tour/0" });
  assert.deepEqual(parseHash("#%E0%A4%A"), { kind: "start" });
});

test("the page's own consecutive actions advance the revision it acts on; an interleaved change does not", () => {
  const at = (n: number) => n as Revision;
  assert.equal(afterOwnAction(at(5), at(6)), 6);
  // Someone else committed 6, so this action made 7: the snapshot no longer describes the review.
  assert.equal(afterOwnAction(at(5), at(7)), 5);
});
