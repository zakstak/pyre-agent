// Which stops a drift changed: the files each stop owns or excerpts among those found changed since the round.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewInput } from "../../schema/input.ts";
import type {
  CommitSha,
  RepoPath,
  RoundNumber,
  Timestamp,
} from "../../schema/primitives.ts";
import type { Drift } from "../../schema/state.ts";
import type { Round } from "../../review/queries.ts";
import { tourView } from "../../review/tour.ts";
import { driftModel } from "./view.ts";

const patch = "@@ -0,0 +1,2 @@\n+one\n+two\n";
const file = (path: string) => ({
  path,
  status: "added",
  group: "core",
  additions: 2,
  deletions: 0,
  patch,
  fingerprint: "1".repeat(64),
});

// Stop 1 owns b.ts, which it excerpts, and c.ts; stop 2 owns d.ts; a.ts goes to the closing stop.
const { stops } = tourView({
  target: {
    kind: "worktree",
    title: "T",
    root: "/r",
    head_sha: "a".repeat(40),
  },
  files_complete: true,
  files: ["a.ts", "b.ts", "c.ts", "d.ts"].map(file),
  stops: [
    {
      title: "First",
      summary: "",
      attention: null,
      excerpts: [{ path: "b.ts", side: "new", start: 1, end: 2, caption: "" }],
      files: [{ path: "c.ts" }],
      notes: [],
      questions: [],
    },
    {
      title: "Second",
      summary: "",
      attention: null,
      excerpts: [],
      files: [{ path: "d.ts" }],
      notes: [],
      questions: [],
    },
  ],
} as unknown as ReviewInput);

const round = (n: number) =>
  ({
    round: n as RoundNumber,
    input_sha256: "f".repeat(64),
    thread: "t1",
    published_at: "2026-11-03T10:00:00.000Z",
  }) as unknown as Round;

const drift = (paths: ReadonlyArray<string>): Drift => ({
  round: 2 as RoundNumber,
  checked_at: "2026-11-03T10:05:00.000Z" as Timestamp,
  paths: paths as ReadonlyArray<RepoPath>,
});

test("each stop names the changed files it owns or excerpts, in its order; files no stop covers mark none", () => {
  const model = driftModel(
    drift(["package.json", "c.ts", "b.ts", "a.ts"]),
    round(2),
    stops,
  );
  assert.deepEqual(model === undefined ? undefined : [...model.stops], [
    [0, ["b.ts", "c.ts"]],
    [2, ["a.ts"]],
  ]);
});

test("a drift of another round, or none, changes no stop", () => {
  assert.equal(driftModel(drift(["b.ts"]), round(3), stops), undefined);
  assert.equal(driftModel(undefined, round(2), stops), undefined);
  // A moved head whose files the host could not list still says so, with no stop marked.
  const pushed = driftModel(
    {
      ...drift([]),
      head_sha: "b".repeat(40) as CommitSha,
      compared: { kind: "failed", reason: "No API access." },
    },
    round(2),
    stops,
  );
  assert.equal(pushed?.stops.size, 0);
});
