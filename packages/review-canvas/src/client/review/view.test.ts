// The review page's pure parts: status words, sidebar names, the hash contract, the revision actions carry, the
// stops a move marks read, and what the page shows of each file since the reviewer's last review.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewFile, ReviewInput } from "../../schema/input.ts";
import type {
  RepoPath,
  Revision,
  RoundNumber,
} from "../../schema/primitives.ts";
import type { ReviewSnapshot } from "../../schema/rpc.ts";
import type { Round } from "../../review/queries.ts";
import { compareSince, type SinceFile } from "../../review/since.ts";
import { splitPath, underRoot } from "../names.ts";
import { afterOwnAction } from "./data.ts";
import { parseHash } from "./places.ts";
import {
  autoRead,
  fileStatus,
  finishState,
  pageModel,
  partSince,
  pathOrder,
  readingSummary,
  sinceNote,
  sinceSummary,
} from "./view.ts";

const file = (extra: Readonly<Record<string, unknown>> = {}) =>
  ({
    path: "src/a.ts",
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    ...extra,
  }) as ReviewFile;

test("a file header shows one status word: a lapsed approval, then a change since the round before, then what the file is", () => {
  const since = { round: 1, patch: "@@ -1 +1 @@\n-one\n+one!\n" };
  assert.deepEqual(fileStatus(file(), true, since), {
    kind: "since",
    text: "changed since you viewed it",
    warning: true,
    patch: since.patch,
  });
  assert.equal(
    fileStatus(file({ status: "added" }), false, since)?.text,
    "changed since round 1",
  );
  assert.equal(
    fileStatus(file({ status: "added" }), true, undefined)?.kind,
    "word",
  );
  assert.deepEqual(
    fileStatus(
      file({ status: "renamed", old_path: "src/b.ts" }),
      false,
      undefined,
    ),
    {
      kind: "word",
      text: "renamed from src/b.ts",
      warning: false,
    },
  );
  // Modified, and unchanged since the round before, say nothing.
  assert.equal(fileStatus(file(), false, undefined), undefined);
});

test("the contents name a file by its folder and its file name", () => {
  assert.deepEqual(splitPath("src/jobs/webhook-retry-queue.ts"), {
    dir: "src/jobs/",
    base: "webhook-retry-queue.ts",
  });
  assert.deepEqual(splitPath("pnpm-lock.yaml"), {
    dir: "",
    base: "pnpm-lock.yaml",
  });
});

test("the source view shows files in the contents' order: root files first, then each folder's files by name", () => {
  const paths = [
    "src/b/z.ts",
    "README.md",
    "src/a.ts",
    "src/b/a.ts",
    "LICENSE",
    "docs/x.md",
  ].map((path) => path as RepoPath);
  assert.deepEqual(pathOrder(paths), [
    "LICENSE",
    "README.md",
    "docs/x.md",
    "src/a.ts",
    "src/b/a.ts",
    "src/b/z.ts",
  ]);
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

test("the page's own consecutive actions advance the revision it acts on; an interleaved change does not", () => {
  const at = (n: number) => n as Revision;
  assert.equal(afterOwnAction(at(5), at(6)), 6);
  // Someone else committed 6, so this action made 7: the snapshot no longer describes the review.
  assert.equal(afterOwnAction(at(5), at(7)), 5);
});

test("the finish says what is left, omitting any zero, and what waits for the agents", () => {
  const counts = (
    viewable: number,
    viewed: number,
    forYou: number,
    waiting: number,
  ) => ({
    viewable,
    viewed: new Set(
      Array.from({ length: viewed }, (_, at) => `f${at}` as RepoPath),
    ),
    forYou,
    waiting,
    pending: 0,
  });
  assert.equal(
    finishState(counts(15, 4, 3, 2)),
    "11 files not yet viewed · 3 answers waiting for you · 2 comments waiting for agents. You can finish anyway.",
  );
  assert.equal(
    finishState(counts(15, 15, 0, 1)),
    "1 comment waiting for agents. You can finish anyway.",
  );
  assert.equal(
    finishState(counts(15, 14, 0, 0)),
    "1 file not yet viewed. You can finish anyway.",
  );
  assert.equal(
    finishState(counts(15, 15, 0, 0)),
    "Everything viewed, nothing waiting.",
  );
});

test("the guide counts read stops; a changed stop and one the snapshot does not name yet are not read", () => {
  const at = "2026-10-10T00:00:00.000Z" as never;
  const summary = readingSummary(
    [
      { stop: 0, read: { state: "read", round: 1 as never, read_at: at } },
      {
        stop: 1,
        read: {
          state: "changed",
          round: 1 as never,
          read_at: at,
          files: ["a.ts" as RepoPath],
        },
      },
      { stop: 2, read: { state: "unread" } },
    ],
    4,
  );
  assert.equal(summary.read, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.stops.get(1)?.state, "changed");
  assert.equal(summary.stops.get(3), undefined);
});

test("moving to or past a stop marks it read only when it is not read: a changed stop waits for Mark read", () => {
  const at = "2026-10-10T00:00:00.000Z" as never;
  const reading = readingSummary(
    [
      { stop: 0, read: { state: "read", round: 1 as never, read_at: at } },
      {
        stop: 1,
        read: {
          state: "changed",
          round: 1 as never,
          read_at: at,
          files: ["a.ts" as RepoPath],
        },
      },
      { stop: 2, read: { state: "unread" } },
    ],
    4,
  );
  assert.deepEqual(autoRead(reading, [0, 1, 2, 3]), [2, 3]);
  assert.deepEqual(autoRead(reading, []), []);
});

test("a file that cannot be compared with the last review says why, and that its whole change shows instead", () => {
  const notes = (
    [
      { kind: "unchanged" },
      { kind: "changed", patch: "@@ -1 +1 @@\n-a\n+b\n" },
      { kind: "added" },
      { kind: "cannot_compare", reason: "deleted" },
      { kind: "cannot_compare", reason: "no_text" },
      { kind: "cannot_compare", reason: "too_different" },
    ] satisfies ReadonlyArray<SinceFile>
  ).map((since) => sinceNote(since, 2));
  assert.deepEqual(notes, [
    "Unchanged since round 2.",
    "Changes since round 2",
    "New since round 2: its whole change is new.",
    "Can’t compare with round 2: the file is deleted now, so there is no text to compare. This is its whole change.",
    "Can’t compare with round 2: a round did not keep this file's whole text. This is its whole change.",
    "Can’t compare with round 2: the versions differ in too many lines to compare. This is its whole change.",
  ]);
});

const textFile = (
  path: string,
  content: string | undefined,
  extra: Readonly<Record<string, unknown>> = {},
) =>
  ({
    path,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch: `@@ -1 +1 @@\n-old\n+${content ?? "x"}\n`,
    fingerprint: (content ?? "x").padEnd(64, "0"),
    ...(content === undefined ? {} : { new_content: `${content}\n` }),
    ...extra,
  }) as ReviewFile;

const inputOf = (files: ReadonlyArray<ReviewFile>) =>
  ({
    target: {
      kind: "worktree",
      title: "T",
      root: "/r",
      head_sha: "a".repeat(40),
    },
    files_complete: true,
    files,
    stops: [],
  }) as unknown as ReviewInput;

test("the control's line counts the files changed and unchanged since then, and those that left", () => {
  const then = inputOf([
    textFile("a.ts", "one"),
    textFile("b.ts", "two"),
    textFile("gone.ts", "three"),
  ]);
  const now = inputOf([textFile("a.ts", "one"), textFile("b.ts", "TWO")]);
  assert.equal(
    sinceSummary(compareSince(1 as RoundNumber, then, now)),
    "1 file changed · 1 unchanged · 1 file left the review",
  );
  assert.equal(
    sinceSummary(compareSince(2 as RoundNumber, now, now)),
    "nothing changed since round 2",
  );
});

test("since the last review, unchanged files fold into the disclosure and each change is open until viewed", () => {
  const then = inputOf([
    textFile("same.ts", "same"),
    textFile("edited.ts", "before"),
    textFile("viewed.ts", "before"),
    textFile("lost.ts", "before"),
  ]);
  const files = [
    textFile("same.ts", "same"),
    textFile("edited.ts", "after"),
    textFile("viewed.ts", "after"),
    textFile("new.ts", "new"),
    textFile("lost.ts", undefined, { status: "deleted" }),
  ];
  const input = inputOf(files);
  const round: Round = {
    round: 2 as RoundNumber,
    input_sha256: "f".repeat(64),
    thread: "t1",
    published_at: "2026-10-13T19:01:00.000Z",
  } as unknown as Round;
  const viewed = files[2];
  const snapshot = {
    state: {
      id: "review-x",
      target: input.target,
      created_at: "2026-10-13T19:00:00.000Z",
      rounds: [{ ...round, round: 1 }, round],
      approvals: [
        {
          path: "viewed.ts",
          fingerprint: viewed?.fingerprint,
          approved_at: "2026-10-13T19:02:00.000Z",
          round: 2,
        },
      ],
      comments: [],
      submissions: [],
    },
    revision: 3,
    threads: [],
    drafts: [],
    stops: [],
  } as unknown as ReviewSnapshot;
  const digests = { digests: {}, texts: {} };
  const since = compareSince(1 as RoundNumber, then, input);
  const page = pageModel(snapshot, round, input, digests, then, since);
  const model = (path: string) => page.files.get(path as RepoPath);
  assert.equal(page.since?.round, 1);
  // The unchanged file folds as it would without the setting; it shows only once its disclosure opens.
  assert.deepEqual(
    [...page.files.values()].map((item) => [
      item.file.path,
      item.since?.kind,
      item.since?.kind === "unchanged" ? "-" : item.folded,
    ]),
    [
      ["same.ts", "unchanged", "-"],
      ["edited.ts", "changed", false],
      ["viewed.ts", "changed", true],
      ["new.ts", "added", false],
      ["lost.ts", "cannot_compare", false],
    ],
  );
  // The change since round 1 is the body: the header offers no second diff against the round before.
  assert.equal(model("edited.ts")?.status, undefined);
  const { shown, unchanged } = partSince([...page.files.values()]);
  assert.deepEqual(
    unchanged.map((item) => item.file.path),
    ["same.ts"],
  );
  assert.equal(shown.length, 4);
  // Without the setting, every file shows its whole change, and a change since the round before is a toggle.
  const whole = pageModel(snapshot, round, input, digests, then);
  assert.equal(whole.since, undefined);
  assert.equal(whole.files.get("edited.ts" as RepoPath)?.since, undefined);
  assert.equal(whole.files.get("edited.ts" as RepoPath)?.status?.kind, "since");
  assert.equal(partSince([...whole.files.values()]).unchanged.length, 0);
});
