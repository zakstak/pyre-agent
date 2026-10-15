// The feedback cases of the Python review canvas (tests/fixtures/feedback, checked by tests/test_feedback_contract.py),
// converted to review-canvas.feedback/1, and the rules that format adds: threads, answers, GitHub comments, and rounds.
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  decodeBytes,
  decodeValue,
  encodeDocument,
  FeedbackDocument,
} from "./document.ts";
import { documentText } from "./encoding.ts";
import { AgentReply, Answer, compareReplies, Feedback } from "./feedback.ts";
import * as Limits from "./limits.ts";
import { GitHubCommentUrl } from "./primitives.ts";
import { pullRequestKey, sameTarget, Target, targetKey } from "./target.ts";
import {
  accepted,
  copy,
  fixture,
  fixtureBytes,
  get,
  type Json,
  type JsonPath,
  refused,
  set,
} from "./testing.ts";

const VALID = ["minimal", "pull-request", "worktree", "conversation"];
const decode = (doc: Json) => decodeValue(FeedbackDocument, doc);
const decodeRaw = (raw: string | Uint8Array) =>
  decodeBytes(
    FeedbackDocument,
    typeof raw === "string" ? new TextEncoder().encode(raw) : raw,
  );

for (const name of VALID) {
  test(`the ${name} feedback fixture decodes to its own JSON and encodes back`, () => {
    const raw = fixture(`feedback/${name}.json`);
    const decoded = accepted(decodeRaw(fixtureBytes(`feedback/${name}.json`)));
    assert.deepEqual(decoded, raw);
    assert.deepEqual(Schema.encodeSync(Feedback)(decoded), raw);
  });
}

test("text limits count UTF-16 code units, and C1 controls are text", () => {
  // valid-unicode.json: a 4,096-unit path of 2,048 emoji, a one-character body of U+0085, and a 4-unit quote.
  const doc = fixture("feedback/pull-request.json");
  const path = "🙂".repeat(2048);
  set(doc, ["files", 0, "path"], path);
  set(doc, ["approvals", 0, "path"], path);
  set(doc, ["comments", 0, "body"], "\u0085");
  set(doc, ["comments", 0, "anchor", "path"], "src/🙂.js");
  set(doc, ["comments", 0, "anchor", "quote"], "🙂 x");
  accepted(decode(doc));
});

const comment: JsonPath = ["comments", 0];
const anchor: JsonPath = [...comment, "anchor"];
const reply = (comment: number, reply: number): JsonPath => [
  "comments",
  comment,
  "replies",
  reply,
];

interface Case {
  /** The Python fixture this case ports, without its .json suffix. */
  readonly python: string;
  /** The feedback fixture to edit; pull-request unless named. */
  readonly base?: string;
  readonly edit: (doc: Json) => Json;
  readonly message: RegExp;
  readonly reason?: "format" | "schema";
}

const change = (path: JsonPath, value: Json | undefined) => (doc: Json) =>
  set(doc, path, value);

/** Restores the Python version field, so the document reads as feedback of the Python review canvas. */
const python = (version: Json) => (doc: Json) =>
  set(set(doc, ["format"], undefined), ["feedback_schema_version"], version);

const ported: ReadonlyArray<Case> = [
  {
    python: "invalid-approval-duplicate",
    edit: (doc) => set(doc, ["approvals", 1], copy(get(doc, ["approvals", 0]))),
    message: /approvals\[1\]\.path: duplicate approval path/,
  },
  {
    python: "invalid-approval-uppercase",
    edit: change(["approvals", 0, "fingerprint"], "F".repeat(64)),
    message:
      /approvals\[0\]\.fingerprint: Expected 64 lowercase hexadecimal characters/,
  },
  {
    python: "invalid-attached-null-range",
    edit: change([...comment, "attachment"], {
      state: "attached",
      reason: "",
      start: null,
      end: null,
    }),
    message: /comments\[0\]\.attachment\.start: Expected number/,
  },
  {
    python: "invalid-body-bom-only",
    edit: change([...comment, "body"], "\ufeff"),
    message: /comments\[0\]\.body: must not be empty/,
  },
  {
    python: "invalid-body-control",
    edit: change([...comment, "body"], "a\u0001b"),
    message:
      /comments\[0\]\.body: contains a control character other than tab, LF, or CR/,
  },
  {
    python: "invalid-body-js-whitespace",
    edit: change([...comment, "body"], "\u3000\u00a0\u2028"),
    message: /comments\[0\]\.body: must not be empty/,
  },
  {
    python: "invalid-body-lone-surrogate",
    edit: change([...comment, "body"], "Check \ud800 this"),
    message: /comments\[0\]\.body: contains an unpaired Unicode surrogate/,
  },
  {
    python: "invalid-boolean-position",
    edit: change([...anchor, "start_row"], false),
    message: /comments\[0\]\.anchor\.start_row: Expected number/,
  },
  {
    python: "invalid-comment-duplicate-id",
    edit: (doc) => set(doc, ["comments", 1], copy(get(doc, comment))),
    message: /comments\[1\]\.id: duplicate comment ID/,
  },
  {
    python: "invalid-comment-id",
    edit: change([...comment, "id"], "bad id"),
    message:
      /comments\[0\]\.id: Expected 1 to 80 letters, digits, hyphens, or underscores/,
  },
  {
    // Anchors now name a round, not a target, and every pull request target is pinned to its head commit.
    python: "invalid-comment-unpinned",
    edit: change(["target", "head_sha"], undefined),
    message: /target\.head_sha: missing/,
  },
  {
    python: "invalid-exported-at-empty",
    edit: change(["exported_at"], " "),
    message: /exported_at: expected a UTC time with milliseconds/,
  },
  {
    python: "invalid-group-unknown",
    edit: change(["files", 0, "group"], "tests"),
    message: /files\[0\]\.group: Expected "core" \| "wiring" \| "mechanical"/,
  },
  {
    python: "invalid-history-limit",
    edit: (doc) =>
      set(
        doc,
        [...comment, "history"],
        Array.from({ length: 21 }, () => copy(get(doc, anchor))),
      ),
    message:
      /comments\[0\]\.history: Expected a value with a length of at most 20/,
  },
  {
    python: "invalid-line-range-reversed",
    edit: (doc) =>
      set(set(doc, [...anchor, "start_line"], 5), [...anchor, "end_line"], 4),
    message: /comments\[0\]\.anchor\.end_line: must not come before start_line/,
  },
  {
    python: "invalid-missing-approvals",
    edit: change(["approvals"], undefined),
    message: /approvals: missing/,
  },
  {
    python: "invalid-old-line-fields",
    edit: (doc) =>
      set(set(doc, [...anchor, "new_line"], 1), [...anchor, "old_line"], null),
    message: /comments\[0\]\.anchor\.(new|old)_line: unknown field/,
  },
  {
    // An orphan has no range at all now, rather than a null one.
    python: "invalid-orphan-range",
    edit: change([...comment, "attachment"], {
      state: "orphan",
      reason: "",
      start: 7,
      end: 11,
    }),
    message: /comments\[0\]\.attachment\.(start|end): unknown field/,
  },
  {
    python: "invalid-path-utf16-length",
    edit: change(["files", 0, "path"], "🙂".repeat(2049)),
    message: /files\[0\]\.path: exceeds 4096 UTF-16 code units/,
  },
  {
    python: "invalid-pr-url",
    edit: change(["target", "url"], "https://github.com/example/repo/pull/2\n"),
    message:
      /target\.url: Expected an HTTPS GitHub/,
  },
  {
    python: "invalid-prefix-too-long",
    edit: change([...anchor, "prefix"], "x".repeat(81)),
    message: /comments\[0\]\.anchor\.prefix: exceeds 80 UTF-16 code units/,
  },
  {
    python: "invalid-quote-utf16-length",
    edit: (doc) =>
      set(set(doc, [...anchor, "quote"], "🙂"), [...anchor, "end"], 8),
    message:
      /comments\[0\]\.anchor\.end: must exceed start by the quote's length in UTF-16 code units/,
  },
  {
    python: "invalid-reply-action",
    base: "conversation",
    edit: change([...reply(0, 1), "action"], "resolve"),
    message:
      /comments\[0\]\.replies\[1\]\.action: Expected "accept" \| "reopen" \| "reply"/,
  },
  {
    // Feedback holds agent answers now, but a reviewer's reply cannot pass as one: an answer needs its thread and
    // disposition.
    python: "invalid-reply-agent-actor",
    base: "conversation",
    edit: change([...reply(0, 1), "actor"], "agent"),
    message:
      /^Feedback is invalid: comments\[0\]\.replies\[1\]\.action: unknown field$/,
  },
  {
    python: "invalid-reply-disposition",
    base: "conversation",
    edit: change([...reply(0, 1), "disposition"], "fixed"),
    message: /comments\[0\]\.replies\[1\]\.disposition: unknown field/,
  },
  {
    python: "invalid-reply-duplicate-id",
    base: "conversation",
    edit: change([...reply(1, 1), "id"], "r1"),
    message: /comments\[1\]\.replies\[1\]\.id: duplicate reply ID/,
  },
  {
    python: "invalid-reply-empty-body",
    base: "conversation",
    edit: change([...reply(1, 1), "body"], " "),
    message:
      /comments\[1\]\.replies\[1\]\.body: must not be empty unless the reply accepts/,
  },
  ...[
    ["invalid-reply-hour-24", "2026-10-10T24:00:00.000Z"],
    ["invalid-reply-impossible-date", "2026-02-31T10:00:00.000Z"],
    ["invalid-reply-time-format", "2026-10-10 01:00:00"],
    ["invalid-reply-year-zero", "0000-01-01T00:00:00.000Z"],
  ].map(
    ([name = "", time = ""]): Case => ({
      python: name,
      base: "conversation",
      edit: change([...reply(0, 1), "created_at"], time),
      message:
        /comments\[0\]\.replies\[1\]\.created_at: expected a UTC time with milliseconds/,
    }),
  ),
  {
    python: "invalid-reply-no-created-at",
    base: "conversation",
    edit: change([...reply(0, 1), "created_at"], undefined),
    message: /comments\[0\]\.replies\[1\]\.created_at: missing/,
  },
  {
    python: "invalid-retained-duplicate",
    edit: (doc) =>
      set(doc, ["earlier_rounds", 1], copy(get(doc, ["earlier_rounds", 0]))),
    message: /earlier_rounds\[1\]\.round: duplicate round/,
  },
  {
    python: "invalid-retained-reviewed-flag",
    edit: change(["earlier_rounds", 0, "files", 0, "reviewed"], true),
    message: /earlier_rounds\[0\]\.files\[0\]\.reviewed: unknown field/,
  },
  {
    python: "invalid-reviewed-flag",
    edit: change(["files", 0, "reviewed"], true),
    message: /files\[0\]\.reviewed: unknown field/,
  },
  {
    python: "invalid-side-both",
    edit: change([...anchor, "side"], "both"),
    message: /comments\[0\]\.anchor\.side: Expected "old" \| "new"/,
  },
  {
    python: "invalid-start-line-zero",
    edit: change([...anchor, "start_line"], 0),
    message:
      /comments\[0\]\.anchor\.start_line: Expected a value between 1 and 1000000000000/,
  },
  {
    python: "invalid-start-negative",
    edit: change([...anchor, "start"], -1),
    message:
      /comments\[0\]\.anchor\.start: Expected a value between 0 and 4194304/,
  },
  {
    python: "invalid-status-list",
    edit: change(["files", 0, "status"], ["modified"]),
    message: /files\[0\]\.status: Expected "added" \| "modified"/,
  },
  {
    python: "invalid-target-kind",
    edit: change(["target", "kind"], "branch"),
    message: /target: Expected a target whose kind is github_pr, pull_request, or worktree/,
  },
  {
    python: "invalid-unknown-field",
    edit: change(["extra"], true),
    message: /extra: unknown field/,
  },
  {
    python: "invalid-version-1-pr-object",
    edit: (doc) =>
      set(
        set(python(1)(doc), ["pr"], copy(get(doc, ["target"]))),
        ["target"],
        undefined,
      ),
    message:
      /Python review canvas feedback, feedback_schema_version 1, which this version cannot read/,
    reason: "format",
  },
  {
    python: "invalid-version-2",
    edit: python(2),
    message:
      /Python review canvas feedback, feedback_schema_version 2, which this version cannot read/,
    reason: "format",
  },
  {
    python: "invalid-worktree-no-head",
    base: "worktree",
    edit: change(["target", "head_sha"], undefined),
    message: /target\.head_sha: missing/,
  },
  {
    python: "invalid-worktree-relative-root",
    base: "worktree",
    edit: change(["target", "root"], "home/dev/repo"),
    message: /target\.root: expected an absolute path/,
  },
  {
    python: "invalid-worktree-unc-without-share",
    base: "worktree",
    edit: change(["target", "root"], "\\\\server"),
    message: /target\.root: expected an absolute path/,
  },
  {
    python: "invalid-worktree-url",
    base: "worktree",
    edit: change(["target", "url"], "https://github.com/example/repo/pull/2"),
    message: /target\.url: unknown field/,
  },
  {
    // Working trees are on Linux or macOS now, so a root is a POSIX path.
    python: "valid-unc-root",
    base: "worktree",
    edit: change(["target", "root"], "\\\\server\\share\\repo"),
    message: /target\.root: expected an absolute path/,
  },
  {
    python: "valid-windows-root",
    base: "worktree",
    edit: change(["target", "root"], "C:\\work\\repo"),
    message: /target\.root: expected an absolute path/,
  },
  {
    python: "invalid-not-object",
    edit: () => [],
    message: /must be a JSON object/,
    reason: "format",
  },
];

for (const { python, base = "pull-request", edit, message, reason } of ported) {
  test(`feedback: ${python}`, () =>
    refused(decode(edit(fixture(`feedback/${base}.json`))), message, reason));
}

/** The pull-request fixture as compact JSON text, with one exact substring replaced. */
const rawWith = (from: string, to: string) => {
  const raw = JSON.stringify(fixture("feedback/pull-request.json"));
  assert.ok(raw.includes(from), from);
  return raw.replace(from, to);
};

const rawCases: ReadonlyArray<{
  readonly python: string;
  readonly raw: () => string | Uint8Array;
  readonly message: RegExp;
  readonly reason: "too_large" | "encoding" | "syntax" | "schema";
}> = [
  {
    python: "invalid-bom",
    raw: () => `\ufeff${JSON.stringify(fixture("feedback/pull-request.json"))}`,
    message: /^Not valid JSON: it starts with a byte order mark\.$/,
    reason: "syntax",
  },
  {
    python: "invalid-deep-nesting",
    raw: () => `${"[".repeat(40)}${"]".repeat(40)}`,
    message: /nested deeper than 32 levels/,
    reason: "syntax",
  },
  {
    python: "invalid-duplicate-escaped-key",
    raw: () =>
      rawWith(
        `"general_notes":"Overall"`,
        `"general_notes":"Overall","general_\\u006eotes":"Again"`,
      ),
    message: /duplicate key: "general_notes"/,
    reason: "syntax",
  },
  {
    python: "invalid-duplicate-key",
    raw: () =>
      rawWith(
        `"general_notes":"Overall"`,
        `"general_notes":"Overall","general_notes":"Again"`,
      ),
    message: /duplicate key: "general_notes"/,
    reason: "syntax",
  },
  {
    python: "invalid-nan",
    raw: () => rawWith(`"start":7,`, `"start":NaN,`),
    message: /^Not valid JSON/,
    reason: "syntax",
  },
  {
    python: "invalid-start-exponent",
    raw: () => rawWith(`"start":7,`, `"start":7e0,`),
    message: /numbers must be integers, without a fraction or exponent: "7e0"/,
    reason: "syntax",
  },
  {
    python: "invalid-start-float",
    raw: () => rawWith(`"start":7,`, `"start":7.0,`),
    message: /numbers must be integers, without a fraction or exponent: "7\.0"/,
    reason: "syntax",
  },
  {
    // JSON.parse reads it as Infinity, which no position allows.
    python: "invalid-start-huge-integer",
    raw: () => rawWith(`"start":7,`, `"start":${"9".repeat(6000)},`),
    message: /comments\[0\]\.anchor\.start: Expected an integer/,
    reason: "schema",
  },
  {
    // JSON.parse rounds it to 2^53, which is past the safe integers.
    python: "invalid-start-past-safe-integer",
    raw: () => rawWith(`"start":7,`, `"start":9007199254740993,`),
    message: /comments\[0\]\.anchor\.start: Expected an integer/,
    reason: "schema",
  },
  {
    python: "invalid-trailing-comma",
    raw: () =>
      JSON.stringify(fixture("feedback/pull-request.json")).replace(/}$/, ",}"),
    message: /^Not valid JSON/,
    reason: "syntax",
  },
  {
    python: "invalid-utf8-in-string",
    raw: () => {
      // The fixture is ASCII, so character offsets are byte offsets.
      const raw = rawWith(
        `"general_notes":"Overall"`,
        `"general_notes":"Over_ll"`,
      );
      const bytes = new TextEncoder().encode(raw);
      bytes[raw.indexOf("Over_ll") + 4] = 0xff;
      return bytes;
    },
    message: /^Feedback is not valid UTF-8\.$/,
    reason: "encoding",
  },
  {
    // The version check sees JSON values, and 3.0 is not an integer in either version.
    python: "invalid-version-float",
    raw: () =>
      rawWith(
        `"format":"review-canvas.feedback/1"`,
        `"feedback_schema_version":3.0`,
      ),
    message: /numbers must be integers/,
    reason: "syntax",
  },
];

for (const { python, raw, message, reason } of rawCases) {
  test(`feedback: ${python}`, () => refused(decodeRaw(raw()), message, reason));
}

// Version 1 keeps a comment's replies as an array, so an empty one is the only spelling of none.
const nowValid = ["invalid-replies-empty"];
test("feedback: invalid-replies-empty is valid now, and replies are required", () => {
  accepted(
    decode(
      set(fixture("feedback/pull-request.json"), [...comment, "replies"], []),
    ),
  );
  refused(
    decode(
      set(
        fixture("feedback/pull-request.json"),
        [...comment, "replies"],
        undefined,
      ),
    ),
    /comments\[0\]\.replies: missing/,
  );
});

const conversation = () => fixture("feedback/conversation.json");
const agent = {
  id: "a9",
  actor: "agent",
  thread: "thread-claude",
  created_at: "2026-10-10T00:20:00.000Z",
  body: "Done.",
};

test("feedback: agent answers follow the reply rules of the Python input", () => {
  // test_agent_replies in tests/test_review_renderer.py. Answers were part of the round input there; they are part
  // of the review now, so each case replaces the first answer of the conversation fixture.
  const answer = (changes: { readonly [key: string]: Json | undefined }) => {
    const value: { [key: string]: Json } = {
      ...agent,
      disposition: "fixed",
      fixed_in: { fingerprint: "c".repeat(64) },
    };
    for (const [key, item] of Object.entries(changes)) {
      if (item === undefined) delete value[key];
      else value[key] = item;
    }
    return value;
  };
  const withAnswer = (value: Json) =>
    decode(set(conversation(), reply(0, 0), value));
  for (const valid of [
    answer({}),
    answer({ disposition: "rejected", fixed_in: undefined }),
    answer({ fixed_in: { commit: "e".repeat(40) } }),
    answer({
      disposition: "deferred",
      fixed_in: undefined,
      blocker: "Waiting on the API owner.",
    }),
    answer({
      disposition: "question",
      fixed_in: undefined,
      created_at: "2026-10-10T00:20:00.250Z",
    }),
  ])
    accepted(withAnswer(valid));
  const cases: ReadonlyArray<readonly [Json, RegExp]> = [
    // A reviewer reply cannot carry an answer's fields.
    [
      answer({ actor: "reviewer" }),
      /replies\[0\]\.(thread|disposition|fixed_in): unknown field/,
    ],
    [
      answer({ disposition: "done" }),
      /replies\[0\]: Expected a disposition of fixed, rejected, deferred, question/,
    ],
    [answer({ fixed_in: undefined }), /replies\[0\]\.fixed_in: missing/],
    [
      answer({
        fixed_in: { fingerprint: "c".repeat(64), commit: "e".repeat(40) },
      }),
      /replies\[0\]\.fixed_in\.(commit|fingerprint): unknown field/,
    ],
    [
      answer({ fixed_in: { fingerprint: "C".repeat(64) } }),
      /replies\[0\]\.fixed_in\.fingerprint: Expected 64 lowercase hexadecimal characters/,
    ],
    [
      answer({ fixed_in: { commit: "abc" } }),
      /replies\[0\]\.fixed_in\.commit: Expected a full 40- or 64-character hexadecimal commit hash/,
    ],
    [
      answer({ disposition: "deferred", fixed_in: undefined }),
      /replies\[0\]\.blocker: missing/,
    ],
    [
      answer({ disposition: "rejected", fixed_in: undefined, blocker: "x" }),
      /replies\[0\]\.blocker: unknown field/,
    ],
    [
      answer({ disposition: "rejected" }),
      /replies\[0\]\.fixed_in: unknown field/,
    ],
    // Answers sit under their comment, so the reply's own ID takes the place of comment_id.
    [answer({ id: "bad id" }), /replies\[0\]\.id: Expected 1 to 80 letters/],
    [answer({ body: " " }), /replies\[0\]\.body: must not be empty/],
    [
      answer({ created_at: "2026-10-10 10:00" }),
      /replies\[0\]\.created_at: expected a UTC time/,
    ],
    [
      answer({ created_at: "2026-10-10T10:00:00+02:00" }),
      /replies\[0\]\.created_at: expected a UTC time/,
    ],
    [
      answer({ created_at: "2026-02-31T10:00:00.000Z" }),
      /replies\[0\]\.created_at: expected a UTC time/,
    ],
    [
      answer({ created_at: "2026-10-10T24:00:00.000Z" }),
      /replies\[0\]\.created_at: expected a UTC time/,
    ],
    [
      answer({ disposition: "question", fixed_in: undefined, blocker: "x" }),
      /replies\[0\]\.blocker: unknown field/,
    ],
  ];
  for (const [value, message] of cases) refused(withAnswer(value), message);
  refused(
    decode(
      set(
        conversation(),
        reply(0, 2),
        answer({ id: "a1", created_at: "2026-10-10T01:30:00.000Z" }),
      ),
    ),
    /comments\[0\]\.replies\[2\]\.id: duplicate reply ID/,
  );
});

const added: ReadonlyArray<{
  readonly name: string;
  readonly edit: (doc: Json) => Json;
  readonly message: RegExp;
}> = [
  {
    name: "a time without milliseconds is refused, so every moment has one spelling",
    edit: change([...reply(0, 1), "created_at"], "2026-10-10T01:00:00Z"),
    message: /created_at: expected a UTC time with milliseconds/,
  },
  {
    name: "an answer must name a thread the feedback lists",
    edit: change([...reply(0, 0), "thread"], "thread-gone"),
    message: /comments\[0\]\.replies\[0\]\.thread: names no thread in threads/,
  },
  {
    name: "thread IDs are unique",
    edit: (doc) => set(doc, ["threads", 1, "id"], "thread-claude"),
    message: /threads\[1\]\.id: duplicate thread ID/,
  },
  {
    name: "a thread runs in a known host",
    edit: change(["threads", 1, "host", "kind"], "cursor"),
    message: /threads\[1\]\.host\.kind: Expected "claude-code" \| "codex"/,
  },
  {
    name: "a thread has a label",
    edit: change(["threads", 1, "label"], " "),
    message: /threads\[1\]\.label: must not be empty/,
  },
  {
    name: "a reply has a known actor",
    edit: change([...reply(0, 1), "actor"], "bot"),
    message:
      /replies\[1\]: Expected a reply whose actor is reviewer, agent, or github/,
  },
  {
    name: "a GitHub comment links to a pull request comment",
    edit: change(
      ["comments", 2, "source", "url"],
      "https://github.com/example/repo/issues/2#issuecomment-1",
    ),
    message: /comments\[2\]\.source\.url: Expected a pull request comment URL/,
  },
  {
    name: "a GitHub comment has a GitHub author",
    edit: change(["comments", 2, "source", "author"], "not a login"),
    message: /comments\[2\]\.source\.author: Expected a git host login/,
  },
  {
    name: "a GitHub comment records whether it was resolved",
    edit: change(["comments", 2, "source", "resolved"], undefined),
    message: /comments\[2\]\.source\.resolved: missing/,
  },
  {
    name: "a GitHub comment keeps its GitHub ID",
    edit: change(["comments", 2, "source", "id"], "has spaces"),
    message: /comments\[2\]\.source\.id: Expected a GitHub node ID/,
  },
  {
    name: "a GitHub reply keeps its GitHub author",
    edit: change([...reply(2, 0), "github", "author"], undefined),
    message: /comments\[2\]\.replies\[0\]\.github\.author: missing/,
  },
  {
    name: "the reviewer's comment body stays within the text limit",
    edit: change([...comment, "body"], "x".repeat(Limits.MAX_TEXT_UNITS + 1)),
    message: /comments\[0\]\.body: exceeds 20000 UTF-16 code units/,
  },
  {
    name: "a GitHub comment body stays within GitHub's limit",
    edit: change(
      ["comments", 3, "body"],
      "x".repeat(Limits.MAX_GITHUB_BODY_UNITS + 1),
    ),
    message: /comments\[3\]\.body: exceeds 131072 UTF-16 code units/,
  },
  {
    name: "a general comment has no anchor",
    edit: (doc) => set(doc, ["comments", 3, "anchor"], copy(get(doc, anchor))),
    message: /comments\[3\]\.anchor: unknown field/,
  },
  {
    name: "an inline comment has an anchor",
    edit: change([...comment, "anchor"], undefined),
    message: /comments\[0\]\.anchor: missing/,
  },
  {
    name: "a comment has a known source",
    edit: change([...comment, "source"], { kind: "agent" }),
    message:
      /comments\[0\]\.source: Expected a source whose kind is reviewer or github/,
  },
  {
    name: "an approval names a repository-relative path",
    edit: change(["approvals", 0, "path"], "/etc/passwd"),
    message: /approvals\[0\]\.path: expected a repository-relative path/,
  },
  {
    name: "an anchor names a repository-relative path",
    edit: change([...anchor, "path"], "src/../../outside.js"),
    message: /comments\[0\]\.anchor\.path: expected a repository-relative path/,
  },
  {
    name: "an approval cannot come from a later round",
    edit: change(["approvals", 0, "round"], 4),
    message: /approvals\[0\]\.round: is after the feedback's round/,
  },
  {
    name: "a carried approval names the review it came from",
    edit: change(["approvals", 1, "carried_from", "review"], "not an id"),
    message: /approvals\[1\]\.carried_from\.review: Expected 1 to 80 letters/,
  },
  {
    name: "an anchor cannot come from a later round",
    edit: change([...anchor, "snapshot", "round"], 4),
    message:
      /comments\[0\]\.anchor\.snapshot\.round: is after the feedback's round/,
  },
  {
    name: "a round has one input digest",
    edit: change([...anchor, "snapshot", "input_sha256"], "d".repeat(64)),
    message:
      /comments\[0\]\.anchor\.snapshot\.input_sha256: differs from another digest of this round/,
  },
  {
    name: "rounds start at 1",
    edit: change(["round"], 0),
    message: /^Feedback is invalid: round: Expected a value between 1 and/,
  },
];

for (const { name, edit, message } of added) {
  test(`feedback: ${name}`, () =>
    refused(decode(edit(conversation())), message));
}

test("feedback: earlier rounds come before the feedback's round, with one digest each", () => {
  refused(
    decode(
      set(
        fixture("feedback/pull-request.json"),
        ["earlier_rounds", 0, "round"],
        2,
      ),
    ),
    /earlier_rounds\[0\]\.round: is not before the feedback's round/,
  );
  const doc = fixture("feedback/worktree.json");
  set(
    doc,
    ["earlier_rounds"],
    [{ round: 1, input_sha256: "c".repeat(64), general_notes: "", files: [] }],
  );
  refused(
    decode(doc),
    /comments\[0\]\.history\[0\]\.snapshot\.input_sha256: differs from another digest of this round/,
  );
});

test("feedback: anchor rows are zero-based, and offsets stay within a patch", () => {
  const withAnchor = (changes: { readonly [key: string]: Json }) => {
    const doc = fixture("feedback/pull-request.json");
    for (const [key, value] of Object.entries(changes))
      set(doc, [...anchor, key], value);
    return decode(doc);
  };
  // A patch has at most 10,000 rows, numbered 0 through 9,999.
  accepted(
    withAnchor({
      start_row: Limits.MAX_PATCH_LINES - 1,
      end_row: Limits.MAX_PATCH_LINES - 1,
    }),
  );
  refused(
    withAnchor({ end_row: Limits.MAX_PATCH_LINES }),
    /comments\[0\]\.anchor\.end_row: Expected a value between 0 and 9999/,
  );
  // Offsets index the patch's rows joined with LF; the exclusive end can reach the patch's length, and no further.
  const end = Limits.MAX_PATCH_UNITS;
  accepted(withAnchor({ start: end - 4, end }));
  refused(
    withAnchor({ start: end - 3, end: end + 1 }),
    /comments\[0\]\.anchor\.end: Expected a value between 0 and 4194304/,
  );
  const attachment = (start: number, stop: number) => {
    const attached = { state: "attached", reason: "", start, end: stop };
    return decode(
      set(
        fixture("feedback/pull-request.json"),
        [...comment, "attachment"],
        attached,
      ),
    );
  };
  accepted(attachment(end - 4, end));
  refused(
    attachment(end, end + 1),
    /comments\[0\]\.attachment\.end: Expected a value between 0 and 4194304/,
  );
});

test("feedback: replies are listed by time, then agent, GitHub, and reviewer, then ID", () => {
  // Python's thread() merged answers and reviewer replies in this order. An import replays replies as listed, and the
  // last decides whose turn it is, so an accept listed before the answer it judges would leave the wrong turn.
  const swapped = conversation();
  const answer = copy(get(swapped, reply(0, 2)));
  set(swapped, reply(0, 2), copy(get(swapped, reply(0, 1))));
  set(swapped, reply(0, 1), answer);
  refused(
    decode(swapped),
    new RegExp(
      "^Feedback is invalid: comments\\[0\\]\\.replies\\[2\\]: is out of order in comment one: " +
        "replies go by created_at, then agent, GitHub, and reviewer, then ID$",
    ),
  );
  // At one time, an answer comes before a GitHub reply, and both before the reviewer's reply. GitHub replies sit
  // only under the inline comment imported from GitHub, the third in the fixture.
  const at = "2026-10-10T01:00:00.000Z";
  const reviewer: Json = {
    id: "r9",
    actor: "reviewer",
    created_at: at,
    action: "accept",
    body: "",
  };
  const answered: Json = {
    ...agent,
    id: "a9",
    created_at: at,
    disposition: "question",
  };
  const github = set(
    set(copy(get(conversation(), reply(2, 0))), ["created_at"], at),
    ["id"],
    "gh-r9",
  );
  const withReplies = (replies: ReadonlyArray<Json>) =>
    decode(set(conversation(), ["comments", 2, "replies"], [...replies]));
  accepted(withReplies([answered, github, reviewer]));
  refused(
    withReplies([reviewer, answered]),
    /comments\[2\]\.replies\[1\]: is out of order in comment gh-inline/,
  );
  refused(
    withReplies([github, answered]),
    /comments\[2\]\.replies\[1\]: is out of order/,
  );
  refused(
    withReplies([reviewer, github]),
    /comments\[2\]\.replies\[1\]: is out of order/,
  );
  // The same actor at the same time goes by ID.
  accepted(withReplies([reviewer, set(copy(reviewer), ["id"], "r9a")]));
  refused(
    withReplies([set(copy(reviewer), ["id"], "r9a"), reviewer]),
    /comments\[2\]\.replies\[1\]: is out of order/,
  );
  // Sorting a shuffled conversation with compareReplies gives the order the fixture lists.
  const listed = accepted(decode(conversation())).comments[0]?.replies ?? [];
  assert.equal(listed.length, 4);
  assert.deepEqual([...listed].reverse().sort(compareReplies), listed);
});

test("feedback: an attachment spans the anchor's quote where it was found again", () => {
  // feedback.js attached a comment at the anchor's own offsets when they still held the quote, or where the quote and
  // its context matched once, so the attached range always has the quote's length.
  const attached = (start: number, end: number, quote = "code") => {
    const doc = set(
      fixture("feedback/pull-request.json"),
      [...comment, "attachment"],
      {
        state: "attached",
        reason: "",
        start,
        end,
      },
    );
    return decode(
      set(
        set(doc, [...anchor, "quote"], quote),
        [...anchor, "end"],
        7 + quote.length,
      ),
    );
  };
  const wrongLength =
    /^Feedback is invalid: comments\[0\]\.attachment\.end: must exceed start by the anchor quote's/;
  accepted(attached(7, 11));
  accepted(attached(100, 104));
  refused(attached(7, 12), wrongLength);
  refused(attached(7, 10), wrongLength);
  // The length counts UTF-16 code units, as the offsets do: the emoji counts as 2.
  accepted(attached(20, 24, "🙂 x"));
  refused(attached(20, 23, "🙂 x"), wrongLength);
});

test("feedback: GitHub comments may be empty, though the reviewer's may not", () => {
  // An approving review summary often has no body. The importer decides whether to import one; feedback can hold it.
  const doc = conversation();
  set(doc, ["comments", 3, "body"], "");
  set(doc, ["comments", 2, "body"], " ");
  set(doc, [...reply(2, 0), "body"], "");
  accepted(decode(doc));
  refused(
    decode(set(conversation(), [...comment, "body"], "")),
    /comments\[0\]\.body: must not be empty/,
  );
  refused(
    decode(set(conversation(), [...reply(1, 1), "body"], "")),
    /comments\[1\]\.replies\[1\]\.body: must not be empty unless the reply accepts/,
  );
});

test("feedback: a GitHub comment or reply may have no author, as for a deleted account", () => {
  const doc = conversation();
  set(doc, ["comments", 2, "source", "author"], null);
  set(doc, [...reply(2, 0), "github", "author"], null);
  const value = accepted(decode(doc));
  const source = value.comments[2]?.source;
  assert.equal(source?.kind === "github" ? source.author : "not GitHub", null);
  refused(
    decode(set(conversation(), ["comments", 2, "source", "author"], "")),
    /comments\[2\]\.source\.author: Expected a git host login/,
  );
  refused(
    decode(
      set(conversation(), [...reply(2, 0), "github", "author"], undefined),
    ),
    /github\.author: missing/,
  );
});

test("feedback: each GitHub comment and reply is imported once", () => {
  const sourceId = (doc: Json, index: number) =>
    get(doc, ["comments", index, "source", "id"]);
  const asReply = conversation();
  set(asReply, [...reply(2, 0), "github", "id"], sourceId(asReply, 2));
  refused(
    decode(asReply),
    /comments\[2\]\.replies\[0\]\.github\.id: duplicate GitHub comment ID/,
  );
  const twoComments = conversation();
  set(twoComments, ["comments", 3, "source", "id"], sourceId(twoComments, 2));
  refused(
    decode(twoComments),
    /comments\[3\]\.source\.id: duplicate GitHub comment ID/,
  );
  const twoReplies = conversation();
  const later = set(
    copy(get(twoReplies, reply(2, 0))),
    ["created_at"],
    "2026-10-10T04:00:00.000Z",
  );
  set(twoReplies, reply(2, 2), set(later, ["id"], "gh-r2"));
  refused(
    decode(twoReplies),
    /comments\[2\]\.replies\[2\]\.github\.id: duplicate GitHub comment ID/,
  );
});

test("feedback: GitHub comments come from one pull request, the target's when it has one", () => {
  const other = (doc: Json, path: JsonPath, value: string) =>
    decode(set(doc, path, value));
  // pull/20 shares pull/2's prefix, so the check needs the # that follows the target's URL.
  refused(
    other(
      conversation(),
      ["comments", 3, "source", "url"],
      "https://github.com/example/repo/pull/20#issuecomment-1",
    ),
    /comments\[3\]\.source\.url: is not a comment on the target's pull request/,
  );
  const thread = conversation();
  set(
    thread,
    ["comments", 2, "source", "url"],
    "https://github.com/example/fork/pull/2#discussion_r1",
  );
  set(
    thread,
    [...reply(2, 0), "github", "url"],
    "https://github.com/example/fork/pull/2#discussion_r2",
  );
  refused(
    decode(thread),
    /comments\[2\]\.source\.url: is not a comment on the target's pull request/,
  );
  // A working tree target names no pull request: the comments name the open one of its branch, and agree on it.
  const worktree = () =>
    set(conversation(), ["target"], {
      kind: "worktree",
      title: "Uncommitted changes on main",
      root: "/home/dev/repo",
      head_sha: "2".repeat(40),
    });
  accepted(decode(worktree()));
  // Pull requests compare by key, so another spelling of the target's owner and repository is the same one.
  accepted(
    decode(
      set(
        conversation(),
        ["target", "url"],
        "https://github.com/Example/Repo/pull/2",
      ),
    ),
  );
  const summary = "https://github.com/EXAMPLE/repo/pull/2#pullrequestreview-1";
  accepted(decode(set(worktree(), ["comments", 3, "source", "url"], summary)));
  const moved = worktree();
  set(
    moved,
    ["comments", 2, "source", "url"],
    "https://github.com/example/repo/pull/9#discussion_r1",
  );
  set(
    moved,
    [...reply(2, 0), "github", "url"],
    "https://github.com/example/repo/pull/9#discussion_r2",
  );
  set(
    moved,
    ["comments", 3, "source", "url"],
    "https://github.com/example/repo/pull/9#pullrequestreview-3",
  );
  accepted(decode(moved));
  refused(
    other(
      worktree(),
      ["comments", 3, "source", "url"],
      "https://github.com/example/repo/pull/9#pullrequestreview-1",
    ),
    /comments\[3\]\.source\.url: is on another pull request than the review's other GitHub comments/,
  );
});

test("feedback: only an inline comment from GitHub has GitHub replies and a resolved state", () => {
  // Conversation comments and review summaries have no threads on GitHub, and nothing is posted back to it.
  const githubReply = (doc: Json) => copy(get(doc, reply(2, 0)));
  const pr = "https://github.com/example/repo/pull";
  const withValue = (path: JsonPath, value: Json) =>
    decode(set(conversation(), path, value));
  const underReviewer = conversation();
  set(underReviewer, [...comment, "replies"], [githubReply(underReviewer)]);
  refused(
    decode(underReviewer),
    /comments\[0\]\.replies\[0\]: a GitHub reply belongs only under an inline comment from GitHub/,
  );
  const underGeneral = conversation();
  set(underGeneral, ["comments", 3, "replies"], [githubReply(underGeneral)]);
  refused(
    decode(underGeneral),
    /comments\[3\]\.replies\[0\]: a GitHub reply belongs only under an inline comment/,
  );
  // A GitHub reply is a review comment in the same thread, so it has a #discussion_r URL on the comment's pull request.
  refused(
    withValue([...reply(2, 0), "github", "url"], `${pr}/2#issuecomment-5`),
    /comments\[2\]\.replies\[0\]\.github\.url: expected a #discussion_r URL on the comment's pull request/,
  );
  refused(
    withValue([...reply(2, 0), "github", "url"], `${pr}/3#discussion_r5`),
    /comments\[2\]\.replies\[0\]\.github\.url: expected a #discussion_r URL on the comment's pull request/,
  );
  // Reviewer and agent replies under GitHub comments stay allowed: the fixture has an answer under each kind.
  const answeredSummary = conversation();
  const question = {
    ...agent,
    id: "a8",
    created_at: "2026-10-10T06:00:00.000Z",
    disposition: "question",
  };
  set(answeredSummary, ["comments", 3, "replies"], [question]);
  accepted(decode(answeredSummary));
  // GitHub's kinds of comment map to ours by URL.
  refused(
    withValue(["comments", 2, "source", "url"], `${pr}/2#pullrequestreview-1`),
    /comments\[2\]\.source\.url: an inline GitHub comment is a review comment, with a #discussion_r URL/,
  );
  refused(
    withValue(["comments", 3, "source", "url"], `${pr}/2#discussion_r9`),
    /comments\[3\]\.source\.url: a general GitHub comment is a conversation comment or review summary/,
  );
  refused(
    withValue(["comments", 3, "source", "resolved"], true),
    /comments\[3\]\.source\.resolved: only a review thread can be resolved on GitHub/,
  );
  accepted(withValue(["comments", 2, "source", "resolved"], true));
});

test("feedback: a GitHub comment may be longer than the reviewer's limit, up to GitHub's", () => {
  accepted(
    decode(
      set(
        conversation(),
        ["comments", 3, "body"],
        "x".repeat(Limits.MAX_TEXT_UNITS + 1),
      ),
    ),
  );
});

test("feedback: the size limit holds before parsing", () => {
  refused(
    decodeRaw(new Uint8Array(Limits.MAX_FEEDBACK_BYTES + 1).fill(0x20)),
    /^Feedback exceeds 8 MiB\.$/,
    "too_large",
  );
});

test("feedback that passes the schema always exports within 8 MiB, and imports again", () => {
  // Paths are outside the text budget, and 2 Mi units of text can take 6 MiB, so only the encoded size decides.
  const withPaths = (count: number) => {
    const doc = fixture("feedback/pull-request.json");
    const path = (index: number) => `${index}/${"p".repeat(4090)}`;
    const file = (index: number): Json => ({
      path: path(index),
      status: "added",
      group: "core",
      notes: "",
    });
    set(
      doc,
      ["files"],
      Array.from({ length: count }, (_, index) => file(index)),
    );
    set(
      doc,
      ["approvals"],
      Array.from({ length: count }, (_, index) => ({
        path: path(index),
        fingerprint: "f".repeat(64),
        approved_at: "2026-10-10T00:00:00.000Z",
        round: 2,
      })),
    );
    return doc;
  };
  const fits = withPaths(900);
  const value = accepted(decode(fits));
  const bytes = accepted(encodeDocument(FeedbackDocument, value));
  assert.ok(bytes.byteLength > 7 * 1024 * 1024, String(bytes.byteLength));
  assert.ok(
    bytes.byteLength <= Limits.MAX_FEEDBACK_BYTES,
    String(bytes.byteLength),
  );
  assert.deepEqual(accepted(decodeRaw(bytes)), value);
  refused(
    decode(withPaths(1100)),
    /^Feedback is invalid: takes \d+ bytes as exported JSON, more than 8 MiB$/,
  );
  // Three-byte characters within the 2 Mi unit text budget take 6 MiB; with paths that fit alone, they pass 8 MiB.
  const wide = (paths: number) => {
    const doc = withPaths(paths);
    const one = get(doc, comment);
    const body = "\u4e00".repeat(20_000);
    const big = (index: number) =>
      set(set(copy(one), ["id"], `c${index}`), ["body"], body);
    return set(
      doc,
      ["comments"],
      Array.from({ length: 104 }, (_, index) => big(index)),
    );
  };
  accepted(decode(wide(0)));
  accepted(decode(withPaths(400)));
  refused(
    decode(wide(400)),
    /takes \d+ bytes as exported JSON, more than 8 MiB/,
  );
});

test("an export is the document's one spelling, and decodes to the same value", () => {
  const value = accepted(decodeRaw(fixtureBytes("feedback/conversation.json")));
  const bytes = accepted(encodeDocument(FeedbackDocument, value));
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.endsWith("}\n") && text.startsWith('{\n  "'));
  const spelled = new TextEncoder().encode(
    documentText(fixture("feedback/conversation.json")),
  );
  assert.equal(bytes.byteLength, spelled.byteLength);
  assert.deepEqual(accepted(decodeRaw(bytes)), value);
});

test("feedback: notes, comments, and replies share a text budget", () => {
  // Python's LimitTests: 110 comments of 20,000 units pass 2 MiB.
  const doc = fixture("feedback/pull-request.json");
  const one = get(doc, comment);
  const big = (index: number) =>
    set(set(copy(one), ["id"], `c${index}`), ["body"], "x".repeat(20_000));
  set(
    doc,
    ["comments"],
    Array.from({ length: 110 }, (_, index) => big(index)),
  );
  refused(
    decode(doc),
    /notes, comments, and replies exceed 2097152 UTF-16 code units together/,
  );
});

test("feedback: reply, answer, and thread counts are limited", () => {
  const replies = (count: number, make: (index: number) => Json, under = 0) => {
    const doc = conversation();
    set(
      doc,
      ["comments", under, "replies"],
      Array.from({ length: count }, (_, index) => make(index)),
    );
    return doc;
  };
  const reviewer = (index: number): Json => ({
    id: `x${String(index).padStart(4, "0")}`,
    actor: "reviewer",
    created_at: "2026-10-10T01:00:00.000Z",
    action: "reply",
    body: "Why?",
  });
  accepted(decode(replies(Limits.MAX_REVIEWER_REPLIES, reviewer)));
  refused(
    decode(replies(Limits.MAX_REVIEWER_REPLIES + 1, reviewer)),
    /comments\[0\]\.replies: holds more than 200 reviewer replies/,
  );
  const github = (index: number): Json =>
    set(
      copy(get(conversation(), reply(2, 0))),
      ["id"],
      `g${String(index).padStart(4, "0")}`,
    );
  refused(
    decode(replies(Limits.MAX_GITHUB_REPLIES + 1, github, 2)),
    /comments\[2\]\.replies: holds more than 200 GitHub replies/,
  );
  const answers = (index: number): Json => ({
    ...agent,
    id: `y${String(index).padStart(4, "0")}`,
    disposition: "question",
  });
  refused(
    decode(replies(Limits.MAX_AGENT_ANSWERS + 1, answers)),
    /comments: hold more than 5000 agent answers/,
  );
  const threads = conversation();
  const thread = (index: number): Json => ({
    id: `t${index}`,
    label: "T",
    host: { kind: "codex" },
  });
  set(
    threads,
    ["threads"],
    Array.from({ length: Limits.MAX_THREADS + 1 }, (_, index) => thread(index)),
  );
  refused(
    decode(threads),
    /threads: Expected a value with a length of at most 100/,
  );
});

test("two targets are one review when they name the same pull request or working tree root", () => {
  // Python's test_identity, for the targets that key reviews now.
  const decodeTarget = Schema.decodeUnknownSync(Target);
  const pr = decodeTarget(
    get(fixture("feedback/pull-request.json"), ["target"]),
  );
  const worktree = decodeTarget(
    get(fixture("feedback/worktree.json"), ["target"]),
  );
  assert.ok(
    sameTarget(
      pr,
      decodeTarget({ ...pr, title: "Renamed", head_sha: "2".repeat(40) }),
    ),
  );
  assert.ok(
    !sameTarget(
      pr,
      decodeTarget({ ...pr, url: "https://github.com/other/repo/pull/2" }),
    ),
  );
  assert.ok(!sameTarget(worktree, pr));
  assert.ok(
    !sameTarget(worktree, decodeTarget({ ...worktree, root: "/elsewhere" })),
  );
  assert.ok(
    sameTarget(
      worktree,
      decodeTarget({ ...worktree, head_sha: "3".repeat(40), branch: "other" }),
    ),
  );
  // GitHub ignores the case of owner and repository names, so both spellings name one pull request.
  assert.ok(
    sameTarget(
      pr,
      decodeTarget({ ...pr, url: "https://github.com/Example/REPO/pull/2" }),
    ),
  );
  assert.ok(
    !sameTarget(
      pr,
      decodeTarget({ ...pr, url: "https://github.com/example/repo/pull/20" }),
    ),
  );
  const spelled = decodeTarget({
    ...pr,
    url: "https://github.com/Example/Repo/pull/2",
  });
  assert.equal(
    targetKey(spelled),
    "github_pr:https://github.com/example/repo/pull/2",
  );
  assert.equal(targetKey(worktree), "worktree:/home/dev/repo");
  const url = Schema.decodeSync(GitHubCommentUrl)(
    "https://github.com/Example/Repo/pull/2#discussion_r9",
  );
  assert.equal(pullRequestKey(url), "https://github.com/example/repo/pull/2");
  // Roots keep their case: Linux file systems tell names apart by it.
  assert.ok(
    !sameTarget(
      worktree,
      decodeTarget({ ...worktree, root: "/home/dev/Repo" }),
    ),
  );
});

test("an answer is what an agent submits; the review adds its ID, thread, and time", () => {
  const decodeAnswer = Schema.decodeUnknownSync(Answer);
  const submitted = {
    disposition: "deferred",
    body: "Needs the scheduler.",
    blocker: "The scheduler PR.",
  };
  const answer = decodeAnswer(submitted, { onExcessProperty: "error" });
  const held: AgentReply = Schema.decodeUnknownSync(AgentReply)({
    ...agent,
    ...answer,
  });
  assert.equal(held.thread, "thread-claude");
  assert.throws(
    () =>
      decodeAnswer(
        { ...submitted, thread: "thread-claude" },
        { onExcessProperty: "error" },
      ),
    /thread/,
  );
  assert.throws(
    () => decodeAnswer({ disposition: "fixed", body: "Done." }),
    /fixed_in/,
  );
});
