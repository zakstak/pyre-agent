// The page's pure logic: which revision an action carries, retry delays, and what a hash points at.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHash } from "./places.ts";
import {
  afterEvent,
  afterOwnAction,
  afterRefresh,
  initial,
  isBehind,
  retryDelay,
} from "./revisions.ts";

test("an announced revision never becomes the one actions carry", () => {
  // The markup shows 5; an event announces round 2 at 6 before its markup arrives.
  const heard = afterEvent(initial(5), 6);
  assert.equal(heard.basis, 5);
  assert.ok(isBehind(heard));
  // Only the new markup moves the basis.
  const shown = afterRefresh(heard, 6);
  assert.equal(shown.basis, 6);
  assert.equal(isBehind(shown), false);
});

test("the page's own consecutive actions advance the basis; an interleaved change does not", () => {
  const own = afterOwnAction(initial(5), 5, 6);
  assert.equal(own.basis, 6);
  assert.equal(own.rendered, 5);
  // Someone else committed 6, so this action made 7: the markup no longer describes the review.
  const mixed = afterOwnAction(initial(5), 5, 7);
  assert.equal(mixed.basis, 5);
  assert.ok(isBehind(mixed));
  // Markup older than the basis lacks only the page's own actions, so the basis stays.
  assert.equal(afterRefresh(own, 5).basis, 6);
});

test("failed refreshes wait longer each time, up to 30 seconds", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(retryDelay),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
});

test("a hash names the files view, a stop, an element, or the start", () => {
  assert.deepEqual(parseHash(""), { kind: "start" });
  assert.deepEqual(parseHash("#files"), { kind: "files" });
  assert.deepEqual(parseHash("#files/src/a%20b.ts"), {
    kind: "files",
    file: "src/a b.ts",
  });
  assert.deepEqual(parseHash("#tour/3"), { kind: "stop", index: 2 });
  // A note in a later stop keeps its own identity instead of resetting the tour.
  assert.deepEqual(parseHash("#s1e0-note-A"), {
    kind: "element",
    id: "s1e0-note-A",
  });
  assert.deepEqual(parseHash("#main"), { kind: "element", id: "main" });
  assert.deepEqual(parseHash("#tour/0"), { kind: "element", id: "tour/0" });
  assert.deepEqual(parseHash("#%E0%A4%A"), { kind: "start" });
});
