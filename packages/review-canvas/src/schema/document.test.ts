import * as Result from "effect/Result";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decodeBytes,
  decodeValue,
  FeedbackDocument,
  InputDocument,
  type InvalidDocument,
  parseStrictJson,
  WorktreeInputDocument,
} from "./document.ts";
import {
  accepted,
  fixture,
  fixtureBytes,
  type Json,
  refused,
  set,
} from "./testing.ts";

// Each decoder in its own closure, since the formats decode to different types.
const decoders: ReadonlyArray<{
  readonly key: string;
  readonly decode: (
    bytes: Uint8Array,
  ) => Result.Result<unknown, InvalidDocument>;
}> = [
  {
    key: "feedback",
    decode: (bytes: Uint8Array) => decodeBytes(FeedbackDocument, bytes),
  },
  {
    key: "input",
    decode: (bytes: Uint8Array) => decodeBytes(InputDocument, bytes),
  },
  {
    key: "worktree input",
    decode: (bytes: Uint8Array) => decodeBytes(WorktreeInputDocument, bytes),
  },
];

test("no Python review canvas file decodes as a new format, and the refusal names its version", () => {
  const files = [
    ["feedback-v3", "feedback_schema_version", 3],
    ["input-v2", "schema_version", 2],
  ] as const;
  for (const [name, field, version] of files) {
    for (const { decode } of decoders) {
      refused(
        decode(fixtureBytes(`python/${name}.json`)),
        new RegExp(
          `^This is Python review canvas .*, ${field} ${version}, which this version cannot read\\. ` +
            "The Python review canvas was removed in review-canvas 4\\.0\\.0, and there is no conversion: start a new review\\.$",
        ),
        "format",
      );
    }
  }
});

test("an unknown format or version is refused by name", () => {
  const doc = (format: Json | undefined) =>
    set(fixture("feedback/minimal.json"), ["format"], format);
  const cases: ReadonlyArray<readonly [Json | undefined, RegExp]> = [
    [
      "review-canvas.feedback/2",
      /^"review-canvas\.feedback\/2" is not supported; this version reads "review-canvas\.feedback\/1"\.$/,
    ],
    [
      "review-canvas.feedback/0",
      /^"review-canvas\.feedback\/0" is not supported/,
    ],
    [
      "review-canvas.input/1",
      /^Expected feedback \("review-canvas\.feedback\/1"\), but this is "review-canvas\.input\/1"\.$/,
    ],
    [
      "review-canvas.notes/1",
      /^Unknown format "review-canvas\.notes\/1"; expected "review-canvas\.feedback\/1"\.$/,
    ],
    [
      "feedback",
      /^Unknown format "feedback"; expected "review-canvas\.feedback\/1"\.$/,
    ],
    [3, /^Unknown format 3; expected "review-canvas\.feedback\/1"\.$/],
    [
      undefined,
      /^Feedback has no "format" field; expected "review-canvas\.feedback\/1"\.$/,
    ],
  ];
  for (const [format, message] of cases)
    refused(decodeValue(FeedbackDocument, doc(format)), message, "format");
  refused(
    decodeValue(FeedbackDocument, "review-canvas.feedback/1"),
    /^Feedback must be a JSON object/,
    "format",
  );
  refused(
    decodeValue(FeedbackDocument, null),
    /^Feedback must be a JSON object/,
    "format",
  );
});

test("the strict JSON parser refuses what JSON.parse lets through, and nothing else", () => {
  const parsed = (raw: string) => accepted(parseStrictJson(raw));
  // Keys and numbers inside strings, escapes, and the same key in sibling objects are all fine.
  assert.deepEqual(
    parsed(
      `{"a":"}\\"{[,1.5e3","b":[{"k":1},{"k":-2}],"c":-0,"d":[true,false,null]}`,
    ),
    {
      a: `}"{[,1.5e3`,
      b: [{ k: 1 }, { k: -2 }],
      c: -0,
      d: [true, false, null],
    },
  );
  assert.deepEqual(parsed(` \t\n{ "a" : [ 1 , 2 ] }\r\n`), { a: [1, 2] });
  assert.equal(parsed(`"\\ud83d\\ude42"`), "🙂");
  refused(
    parseStrictJson(`{"a":{"b":1,"b":2}}`),
    /duplicate key: "b"/,
    "syntax",
  );
  refused(
    parseStrictJson(`{"a":1,"\\u0061":2}`),
    /duplicate key: "a"/,
    "syntax",
  );
  refused(parseStrictJson(`[1E2]`), /numbers must be integers/, "syntax");
  refused(parseStrictJson(`{"a":-0.5}`), /numbers must be integers/, "syntax");
  // The root is depth 0, so 33 nested arrays put a value at depth 33.
  parsed(`${"[".repeat(33)}${"]".repeat(33)}`);
  refused(
    parseStrictJson(`${"[".repeat(33)}1${"]".repeat(33)}`),
    /nested deeper than 32 levels/,
    "syntax",
  );
  refused(
    parseStrictJson(`${"[".repeat(34)}${"]".repeat(34)}`),
    /nested deeper than 32 levels/,
    "syntax",
  );
  refused(
    parseStrictJson(`${'{"a":'.repeat(33)}1${"}".repeat(33)}`),
    /nested deeper than 32 levels/,
    "syntax",
  );
  parsed(`${'{"a":'.repeat(32)}1${"}".repeat(32)}`);
  refused(parseStrictJson(""), /^Not valid JSON/, "syntax");
});
