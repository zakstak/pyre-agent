// The review page's keys: what each press does, where a step goes, and the orders files and threads go in.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../../schema/feedback.ts";
import type { ReviewFile, ReviewInput } from "../../schema/input.ts";
import type { ReviewSnapshot } from "../../schema/rpc.ts";
import type { ReviewState, Round } from "../../review/queries.ts";
import {
  fileOrder,
  type KeyPress,
  lineCommand,
  pageCommand,
  SHORTCUTS,
  stepFrom,
  threadOrder,
} from "./keys.ts";
import { pageModel } from "./view.ts";

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

test("page keys: J, K, and N as before, F and T forward and with Shift back, V, E, and ?", () => {
  assert.deepEqual(pageCommand(press("j")), { kind: "stop", step: 1 });
  assert.deepEqual(pageCommand(press("K", { shiftKey: true })), {
    kind: "stop",
    step: -1,
  });
  assert.deepEqual(pageCommand(press("N", { shiftKey: true })), {
    kind: "next",
  });
  assert.deepEqual(pageCommand(press("f")), { kind: "file", step: 1 });
  assert.deepEqual(pageCommand(press("F", { shiftKey: true })), {
    kind: "file",
    step: -1,
  });
  assert.deepEqual(pageCommand(press("t")), { kind: "thread", step: 1 });
  assert.deepEqual(pageCommand(press("T", { shiftKey: true })), {
    kind: "thread",
    step: -1,
  });
  assert.deepEqual(pageCommand(press("v")), { kind: "viewed" });
  assert.deepEqual(pageCommand(press("e")), { kind: "finish" });
  assert.deepEqual(pageCommand(press("?", { shiftKey: true })), {
    kind: "help",
  });
});

test("Caps Lock alone reverses nothing, and the browser's and screen readers' modifiers pass through", () => {
  assert.deepEqual(pageCommand(press("F")), { kind: "file", step: 1 });
  for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const) {
    assert.equal(pageCommand(press("f", { [modifier]: true })), undefined);
    assert.equal(pageCommand(press("?", { [modifier]: true })), undefined);
    assert.equal(
      lineCommand(press("ArrowDown", { [modifier]: true })),
      undefined,
    );
  }
  for (const key of ["a", "/", " ", "Enter", "ArrowDown", "Tab", "Escape"])
    assert.equal(pageCommand(press(key)), undefined, key);
});

test("line keys: arrows move, Shift with an arrow selects, C comments, Esc clears; Enter is the button's", () => {
  assert.deepEqual(lineCommand(press("ArrowDown")), {
    kind: "move",
    step: 1,
    extend: false,
  });
  assert.deepEqual(lineCommand(press("ArrowUp", { shiftKey: true })), {
    kind: "move",
    step: -1,
    extend: true,
  });
  assert.deepEqual(lineCommand(press("c")), { kind: "comment" });
  assert.deepEqual(lineCommand(press("C")), { kind: "comment" });
  assert.equal(lineCommand(press("C", { shiftKey: true })), undefined);
  assert.deepEqual(lineCommand(press("Escape")), { kind: "clear" });
  assert.equal(lineCommand(press("Enter")), undefined);
  assert.equal(lineCommand(press("j")), undefined);
});

test("a step from nothing goes to the first forward and nowhere back, and stops at either end", () => {
  const items = ["a", "b", "c"];
  assert.equal(stepFrom(items, undefined, 1), "a");
  assert.equal(stepFrom(items, undefined, -1), undefined);
  assert.equal(stepFrom(items, "a", 1), "b");
  assert.equal(stepFrom(items, "b", -1), "a");
  assert.equal(stepFrom(items, "c", 1), undefined);
  assert.equal(stepFrom(items, "a", -1), undefined);
  assert.equal(stepFrom(items, "gone", 1), "a");
  assert.equal(stepFrom([], undefined, 1), undefined);
});

test("the key help lists every page key and line key", () => {
  const listed = new Set(
    SHORTCUTS.flatMap((group) =>
      group.shortcuts.flatMap((item) =>
        item.keys.map((keys) => keys.join("+")),
      ),
    ),
  );
  for (const keys of [
    "J",
    "K",
    "N",
    "F",
    "Shift+F",
    "T",
    "Shift+T",
    "V",
    "E",
    "?",
    "↓",
    "↑",
    "Shift+↓",
    "Shift+↑",
    "Enter",
    "C",
    "Shift+Enter",
    "Esc",
    "Ctrl+Enter",
  ])
    assert.ok(listed.has(keys), keys);
});

// Stop 1 excerpts z.ts; a.ts and m.ts go to the closing stop. Guided, z.ts comes first; by path, it comes last.
const patch = "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const file = (path: string): ReviewFile =>
  ({
    path,
    status: "modified",
    group: "core",
    additions: 1,
    deletions: 1,
    patch,
    fingerprint: "1".repeat(64),
  }) as ReviewFile;
const input = {
  target: {
    kind: "worktree",
    title: "T",
    root: "/r",
    head_sha: "a".repeat(40),
  },
  files_complete: true,
  files: [file("a.ts"), file("m.ts"), file("z.ts")],
  stops: [
    {
      title: "First",
      summary: "",
      attention: null,
      excerpts: [{ path: "z.ts", side: "new", start: 1, end: 2, caption: "" }],
      files: [],
      notes: [],
      questions: [],
    },
  ],
} as unknown as ReviewInput;

const at = "2026-10-13T19:00:00.000Z";
const inline = (id: string, path: string, start: number): Comment =>
  ({
    kind: "inline",
    id,
    source: { kind: "reviewer", state: "sent" },
    body: "Why?",
    created_at: at,
    updated_at: at,
    anchor: { kind: "patch", path, start_line: 1, end_line: 1 },
    history: [],
    attachment: {
      state: "attached",
      reason: "Same patch.",
      start,
      end: start + 3,
    },
    replies: [],
  }) as unknown as Comment;
const general: Comment = {
  ...inline("c-general", "a.ts", 0),
  kind: "general",
} as unknown as Comment;

const round = {
  round: 1,
  input_sha256: "f".repeat(64),
  thread: "t1",
  published_at: at,
} as unknown as Round;
const state = {
  id: "review-x",
  target: input.target,
  created_at: at,
  closed_at: undefined,
  carry_from: undefined,
  rounds: [round],
  approvals: [],
  comments: [
    general,
    inline("c-a", "a.ts", 20),
    inline("c-z-late", "z.ts", 20),
    inline("c-z-early", "z.ts", 0),
    inline("c-m", "m.ts", 0),
  ],
  submissions: [],
} as unknown as ReviewState;
const snapshot = {
  state,
  revision: 1,
  threads: [],
  drafts: [],
  stops: [],
} as unknown as ReviewSnapshot;
const page = pageModel(
  snapshot,
  round,
  input,
  { digests: {}, texts: {} },
  undefined,
);

test("files and threads go in the order the view shows them: by stop guided, by path in the source view", () => {
  assert.deepEqual(fileOrder(page, "guided"), ["z.ts", "a.ts", "m.ts"]);
  assert.deepEqual(fileOrder(page, "source"), ["a.ts", "m.ts", "z.ts"]);
  // Within a file, by the row the thread sits under; the whole change comes last.
  assert.deepEqual(threadOrder(page, "guided"), [
    "c-z-early",
    "c-z-late",
    "c-a",
    "c-m",
    "c-general",
  ]);
  assert.deepEqual(threadOrder(page, "source"), [
    "c-a",
    "c-m",
    "c-z-early",
    "c-z-late",
    "c-general",
  ]);
});
