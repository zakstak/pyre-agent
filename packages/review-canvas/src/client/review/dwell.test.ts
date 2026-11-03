// Reading a stop by keeping it on screen: the bands of its body in view, the dwell before they count, and an unread.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANDS,
  DWELL_MS,
  forget,
  inView,
  look,
  type Sights,
  unsee,
} from "./dwell.ts";

const WHOLE = { from: 0, to: 1 };

/** Looks at the same views at each time in turn, from no sights; the stops read at the last look. */
const watch = (
  views: ReadonlyMap<number, { readonly from: number; readonly to: number }>,
  times: ReadonlyArray<number>,
  sights: Sights = new Map(),
) => {
  let seen = { sights, read: [] as ReadonlyArray<number> };
  for (const at of times) seen = look(seen.sights, views, at);
  return seen;
};

test("the part of a box in view is a fraction of its height; a box out of view has none", () => {
  assert.deepEqual(
    inView({ top: 100, bottom: 300 }, { top: 0, bottom: 800 }),
    WHOLE,
  );
  assert.deepEqual(
    inView({ top: -100, bottom: 300 }, { top: 0, bottom: 800 }),
    {
      from: 0.25,
      to: 1,
    },
  );
  assert.deepEqual(
    inView({ top: 700, bottom: 1100 }, { top: 100, bottom: 800 }),
    {
      from: 0,
      to: 0.25,
    },
  );
  assert.equal(
    inView({ top: 900, bottom: 1000 }, { top: 0, bottom: 800 }),
    undefined,
  );
  assert.equal(
    inView({ top: 10, bottom: 10 }, { top: 0, bottom: 800 }),
    undefined,
  );
});

test("a stop in view is read once it stayed there for the dwell time, not before", () => {
  const views = new Map([[0, WHOLE]]);
  assert.deepEqual(watch(views, [0, DWELL_MS - 1]).read, []);
  assert.deepEqual(watch(views, [0, DWELL_MS]).read, [0]);
});

test("stops passed by faster than the dwell time are never read, however often", () => {
  // A jump or a fast scroll: each stop is in view for a moment, then the next one is.
  let sights: Sights = new Map();
  let read: ReadonlyArray<number> = [];
  for (let at = 0; at < 20; at++) {
    const seen = look(sights, new Map([[at % 3, WHOLE]]), at * 300);
    sights = seen.sights;
    read = [...read, ...seen.read];
  }
  assert.deepEqual(read, []);
});

test("a stop taller than the screen is read only once most of it was in view long enough", () => {
  // Its top half in view: half of its bands seen, which is not most.
  const top = watch(new Map([[0, { from: 0, to: 0.5 }]]), [0, DWELL_MS]);
  assert.deepEqual(top.read, []);
  // Reading on down through it: the bands seen before stay seen.
  const on = watch(
    new Map([[0, { from: 0.4, to: 0.9 }]]),
    [DWELL_MS, 2 * DWELL_MS],
    top.sights,
  );
  assert.deepEqual(on.read, [0]);
});

test("a band that leaves the view before the dwell time starts again when it comes back", () => {
  const views = new Map([[0, WHOLE]]);
  const first = look(new Map(), views, 0);
  const away = look(first.sights, new Map(), DWELL_MS / 2);
  const back = look(away.sights, views, DWELL_MS);
  assert.deepEqual(look(back.sights, views, DWELL_MS + DWELL_MS / 2).read, []);
  assert.deepEqual(look(back.sights, views, 2 * DWELL_MS).read, [0]);
});

test("after an unread, what was in view counts only once it left the view and came back", () => {
  const views = new Map([[0, WHOLE]]);
  const read = watch(views, [0, DWELL_MS]);
  assert.deepEqual(read.read, [0]);
  const unread = unsee(read.sights, 0);
  // Kept on screen, the stop the reviewer just marked unread stays unread.
  assert.deepEqual(
    watch(views, [3 * DWELL_MS, 10 * DWELL_MS], unread).read,
    [],
  );
  // Scrolled away and back, and kept there, it is read again.
  const away = look(unread, new Map(), 11 * DWELL_MS);
  assert.deepEqual(
    watch(views, [12 * DWELL_MS, 13 * DWELL_MS], away.sights).read,
    [0],
  );
  // A band out of view at the unread and seen before is unseen too.
  const half = watch(new Map([[0, { from: 0, to: 0.5 }]]), [0, DWELL_MS]);
  const lower = watch(
    new Map([[0, { from: 0.5, to: 1 }]]),
    [DWELL_MS, 2 * DWELL_MS],
    half.sights,
  );
  assert.deepEqual(lower.read, [0]);
  const unseen = unsee(lower.sights, 0);
  assert.equal(
    [...(unseen.get(0)?.values() ?? [])].filter((band) => band.kind === "seen")
      .length,
    0,
  );
  assert.ok((unseen.get(0)?.size ?? 0) <= BANDS);
});

test("after a refused mark, a stop is asked again only once it stayed in view again", () => {
  const views = new Map([[0, WHOLE]]);
  const read = watch(views, [0, DWELL_MS]);
  const forgotten = forget(read.sights, 0);
  assert.equal(forgotten.has(0), false);
  assert.deepEqual(look(forgotten, views, 2 * DWELL_MS).read, []);
  assert.deepEqual(
    watch(views, [2 * DWELL_MS, 3 * DWELL_MS], forgotten).read,
    [0],
  );
});
