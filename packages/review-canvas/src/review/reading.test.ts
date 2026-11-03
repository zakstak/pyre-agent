import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile, ReviewInput } from "../schema/input.ts";
import type { RepoPath, RoundNumber, Timestamp } from "../schema/primitives.ts";
import type { Reading, StopMark } from "../schema/reading.ts";
import { markStop, readingOf, refKey, stopRead, stopRefs } from "./reading.ts";
import { tourView } from "./tour.ts";

const PATCH = "@@ -1,2 +1,2 @@\n-a\n+b\n c\n";

const file = (path: string, fingerprint: string): ReviewFile =>
  ({
    path,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch: PATCH,
    fingerprint: fingerprint.repeat(64),
  }) as ReviewFile;

const stop = (title: string, paths: ReadonlyArray<string>) => ({
  title,
  summary: "",
  attention: null,
  excerpts: paths.map((path) => ({
    path,
    side: "new",
    start: 1,
    end: 1,
    caption: "",
  })),
  files: [],
  notes: [],
  questions: [],
});

const input = (
  fingerprints: Readonly<Record<string, string>>,
  stops = [
    stop("Core", ["a.ts"]),
    stop("Core", ["b.ts"]),
    stop("UI", ["c.ts"]),
  ],
): ReviewInput =>
  ({
    format: "review-canvas.input/1",
    files_complete: true,
    target: {
      kind: "worktree",
      title: "t",
      root: "/r",
      head_sha: "d".repeat(40),
    },
    files: Object.entries(fingerprints).map(([path, print]) =>
      file(path, print),
    ),
    stops,
  }) as unknown as ReviewInput;

const at = "2026-10-10T00:00:00.000Z" as Timestamp;
const one = 1 as RoundNumber;
const two = 2 as RoundNumber;

const mark = (
  reading: Reading,
  round: RoundNumber,
  shown: ReviewInput,
  stopIndex: number,
  kind: "read" | "unread" = "read",
): Reading => {
  const marked = markStop(
    reading,
    { round, input: shown },
    { kind, round, stop: stopIndex },
    at,
  );
  if (Result.isFailure(marked)) assert.fail(marked.failure.message);
  return marked.success;
};

test("a stop is the same across rounds while its title is: the nth of that title, and the closing stop", () => {
  const { stops } = tourView(
    input({ "a.ts": "1", "b.ts": "1", "c.ts": "1", "d.ts": "1" }),
  );
  assert.deepEqual(stopRefs(stops), [
    { kind: "stop", title: "Core", occurrence: 0 },
    { kind: "stop", title: "Core", occurrence: 1 },
    { kind: "stop", title: "UI", occurrence: 0 },
    { kind: "closing" },
  ]);
  assert.notEqual(
    refKey({ kind: "stop", title: "Core", occurrence: 0 }),
    refKey({ kind: "stop", title: "Core", occurrence: 1 }),
  );
});

test("a mark holds while every file the stop covers keeps its version, and names the files that changed", () => {
  const file = (path: string, version: string) => ({
    path: path as RepoPath,
    version,
  });
  const read: StopMark = {
    stop: { kind: "closing" },
    round: one,
    files: [file("a.ts", "1"), file("b.ts", "1")],
    read_at: at,
  };
  assert.deepEqual(stopRead(undefined, []), { state: "unread" });
  assert.deepEqual(stopRead(read, read.files), {
    state: "read",
    round: one,
    read_at: at,
  });
  assert.deepEqual(
    stopRead(read, [file("a.ts", "2"), file("b.ts", "1"), file("new.ts", "1")]),
    { state: "changed", round: one, read_at: at, files: ["a.ts", "new.ts"] },
  );
});

test("reading two stops, then a round that changes one stop's file: that stop is changed, the other stays read", () => {
  const first = input({ "a.ts": "1", "b.ts": "1", "c.ts": "1" });
  let reading = mark({ marks: [] }, one, first, 0);
  reading = mark(reading, one, first, 2);
  assert.deepEqual(
    readingOf(reading, first).map((item) => item.read.state),
    ["read", "unread", "read"],
  );
  const second = input({ "a.ts": "2", "b.ts": "1", "c.ts": "1" });
  const after = readingOf(reading, second);
  assert.deepEqual(after[0]?.read, {
    state: "changed",
    round: one,
    read_at: at,
    files: ["a.ts"],
  });
  assert.equal(after[1]?.read.state, "unread");
  assert.deepEqual(after[2]?.read, { state: "read", round: one, read_at: at });
  // Reading the changed stop again in the new round makes it read.
  reading = mark(reading, two, second, 0);
  assert.deepEqual(readingOf(reading, second)[0]?.read, {
    state: "read",
    round: two,
    read_at: at,
  });
});

test("unread takes a mark off, and a change keeps only marks of stops the round has", () => {
  const first = input({ "a.ts": "1", "b.ts": "1", "c.ts": "1" });
  let reading = mark({ marks: [] }, one, first, 0);
  reading = mark(reading, one, first, 2);
  reading = mark(reading, one, first, 2, "unread");
  assert.equal(reading.marks.length, 1);
  const renamed = input({ "a.ts": "1", "b.ts": "1", "c.ts": "1" }, [
    stop("Renamed", ["a.ts"]),
  ]);
  reading = mark(reading, two, renamed, 0);
  assert.deepEqual(
    reading.marks.map((item) => item.stop),
    [{ kind: "stop", title: "Renamed", occurrence: 0 }],
  );
});

test("a page can mark only a stop of the round it shows, and of the current round", () => {
  const first = input({ "a.ts": "1", "b.ts": "1", "c.ts": "1" });
  const stale = markStop(
    { marks: [] },
    { round: two, input: first },
    { kind: "read", round: one, stop: 0 },
    at,
  );
  assert.ok(Result.isFailure(stale) && stale.failure.kind === "changed");
  const missing = markStop(
    { marks: [] },
    { round: one, input: first },
    { kind: "read", round: one, stop: 9 },
    at,
  );
  assert.ok(Result.isFailure(missing) && missing.failure.kind === "not_found");
});
