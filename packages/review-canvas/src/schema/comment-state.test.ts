// The comment lifecycle, text anchors, and drafts: what feedback written before them still reads as, and what the
// schemas refuse.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeValue, FeedbackDocument } from "./document.ts";
import { draftIn, slotKey, slotOf, Draft, DraftSlot } from "./draft.ts";
import { Comment } from "./feedback.ts";
import type { CommentId } from "./primitives.ts";
import { Selection } from "./selection.ts";
import {
  accepted,
  fixture,
  get,
  type Json,
  type JsonPath,
  refused,
  set,
} from "./testing.ts";

const decode = (doc: Json) => decodeValue(FeedbackDocument, doc);
const first: JsonPath = ["comments", 0];

/** The conversation fixture as feedback/1 was written before comment states and anchor kinds. */
const earlier = (): Json => {
  const doc = fixture("feedback/conversation.json");
  for (const index of [0, 1, 2]) {
    set(doc, ["comments", index, "anchor", "kind"], undefined);
    if (get(doc, ["comments", index, "source", "kind"]) === "reviewer")
      set(doc, ["comments", index, "source", "state"], undefined);
  }
  return doc;
};

test("feedback written before comment states and anchor kinds reads as sent comments on patch anchors", () => {
  const value = accepted(decode(earlier()));
  const [one, two] = value.comments;
  assert.deepEqual(one?.source, { kind: "reviewer", state: "sent" });
  assert.ok(one?.kind === "inline" && two?.kind === "inline");
  assert.equal(one.anchor.kind, "patch");
  assert.equal(two.anchor.kind, "patch");
});

test("an edited comment says when it was last edited", () => {
  const doc = fixture("feedback/conversation.json");
  set(doc, [...first, "source"], {
    kind: "reviewer",
    state: "edited",
    edited_at: "2026-10-10T03:00:00.000Z",
  });
  const value = accepted(decode(doc));
  assert.deepEqual(value.comments[0]?.source, {
    kind: "reviewer",
    state: "edited",
    edited_at: "2026-10-10T03:00:00.000Z",
  });
  set(doc, [...first, "source", "edited_at"], undefined);
  refused(decode(doc), /comments\[0\]\.source/);
});

test("feedback never holds a pending comment: Finish review sends it first", () => {
  const doc = fixture("feedback/conversation.json");
  set(doc, ["comments", 1, "source"], { kind: "reviewer", state: "pending" });
  set(doc, ["comments", 1, "replies"], []);
  refused(decode(doc), /comments\[1\]\.source\.state: is pending/);
});

const pending = {
  kind: "general",
  id: "c-1",
  source: { kind: "reviewer", state: "pending" },
  body: "Later.",
  created_at: "2026-10-10T00:00:00.000Z",
  updated_at: "2026-10-10T00:00:00.000Z",
  replies: [],
};

test("a pending comment has no replies: nobody has seen it", () => {
  const decodeComment = Schema.decodeUnknownResult(Comment);
  assert.ok(Result.isSuccess(decodeComment(pending)));
  const replied = decodeComment({
    ...pending,
    replies: [
      {
        id: "r",
        created_at: "2026-10-10T01:00:00.000Z",
        actor: "reviewer",
        action: "reply",
        body: "More.",
      },
    ],
  });
  assert.ok(Result.isFailure(replied));
  assert.match(String(replied.failure), /pending comment/);
});

const textComment = (doc: Json, anchor: Json, attachment: Json) => {
  set(doc, [...first, "anchor"], anchor);
  set(doc, [...first, "history"], []);
  set(doc, [...first, "attachment"], attachment);
  return doc;
};

const TEXT_ANCHOR = {
  kind: "text",
  snapshot: { round: 3, input_sha256: "a".repeat(64) },
  path: "source.js",
  content_sha256: "c".repeat(64),
  quote: "one\ntwo",
  prefix: "zero\n",
  suffix: "\nthree",
  side: "new",
  start_line: 4,
  end_line: 5,
};

test("a text anchor names its lines and their text; it attaches at lines, as many as it quotes", () => {
  const attached = {
    state: "attached",
    reason: "Same text.",
    start_line: 9,
    end_line: 10,
  };
  const value = accepted(
    decode(
      textComment(fixture("feedback/conversation.json"), TEXT_ANCHOR, attached),
    ),
  );
  const comment = value.comments[0];
  assert.ok(comment?.kind === "inline" && comment.anchor.kind === "text");
  refused(
    decode(
      textComment(
        fixture("feedback/conversation.json"),
        { ...TEXT_ANCHOR, end_line: 6 },
        attached,
      ),
    ),
    /one line for each line/,
  );
  refused(
    decode(
      textComment(fixture("feedback/conversation.json"), TEXT_ANCHOR, {
        ...attached,
        end_line: 11,
      }),
    ),
    /as many lines as the anchor's quote/,
  );
  refused(
    decode(
      textComment(fixture("feedback/conversation.json"), TEXT_ANCHOR, {
        state: "attached",
        reason: "Same patch.",
        start: 0,
        end: 7,
      }),
    ),
    /a text anchor attaches at lines/,
  );
});

test("a patch anchor attaches at offsets, not at lines", () => {
  const doc = fixture("feedback/conversation.json");
  set(doc, [...first, "attachment"], {
    state: "attached",
    reason: "Same text.",
    start_line: 1,
    end_line: 1,
  });
  refused(decode(doc), /a patch anchor attaches at offsets/);
});

test("a selection without a kind is a selection of rows, as earlier pages send it", () => {
  const decoded = Schema.decodeUnknownSync(Selection)({
    path: "a.ts",
    patch_sha256: "b".repeat(64),
    start_row: 1,
    end_row: 2,
  });
  assert.equal(decoded.kind, "rows");
  const text = Schema.decodeUnknownSync(Selection)({
    kind: "text",
    path: "a.ts",
    content_sha256: "c".repeat(64),
    start_line: 3,
    end_line: 3,
  });
  assert.equal(text.kind, "text");
});

test("each draft fills one slot, which a key names, and a slot holds the latest draft", () => {
  const comment = "c-1" as CommentId;
  const drafts = Schema.decodeUnknownSync(Schema.Array(Draft))([
    { kind: "general", body: "Overall" },
    { kind: "reply", comment, body: "Reply" },
    { kind: "edit", comment, body: "Edit" },
    { kind: "finish", verdict: "approve", body: "Ship" },
    {
      kind: "comment",
      selection: {
        kind: "rows",
        path: "a.ts",
        patch_sha256: "b".repeat(64),
        start_row: 1,
        end_row: 1,
      },
      body: "Here",
    },
  ]);
  assert.deepEqual(
    drafts.map((draft) => slotKey(slotOf(draft))),
    ["general", "reply:c-1", "edit:c-1", "finish", "comment"],
  );
  const saved = drafts.map((draft) => ({
    draft,
    saved_at: "2026-10-10T00:00:00.000Z" as never,
  }));
  assert.equal(draftIn(saved, { kind: "reply", comment })?.body, "Reply");
  assert.equal(draftIn(saved, { kind: "edit", comment })?.body, "Edit");
  assert.equal(draftIn(saved, { kind: "finish" })?.verdict, "approve");
  assert.equal(
    draftIn(saved, { kind: "reply", comment: "c-2" as CommentId }),
    undefined,
  );
  assert.ok(
    Result.isFailure(Schema.decodeUnknownResult(DraftSlot)({ kind: "reply" })),
  );
});
