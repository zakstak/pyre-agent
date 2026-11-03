// Where the drafts the server kept go back when the page opens a review.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { SavedDraft } from "../../schema/draft.ts";
import { Comment } from "../../schema/feedback.ts";
import {
  ContentDigest,
  PatchDigest,
  RepoPath,
} from "../../schema/primitives.ts";
import { restoring } from "./restore.ts";

const at = "2026-11-03T12:00:00.000Z";
const path = "src/a.ts";
const digest = "a".repeat(64);
const text = "c".repeat(64);

const comment = Schema.decodeUnknownSync(Comment);
const saved = (draft: unknown) =>
  Schema.decodeUnknownSync(SavedDraft)({ draft, saved_at: at });

const general = (id: string, source: unknown) =>
  comment({
    kind: "general",
    id,
    source,
    body: "Why?",
    created_at: at,
    updated_at: at,
    replies: [],
  });

const comments = [
  general("sent", { kind: "reviewer", state: "sent" }),
  general("pending", { kind: "reviewer", state: "pending" }),
  general("hosted", {
    kind: "github",
    id: "IC_1",
    author: "octocat",
    url: "https://github.com/acme/notes/pull/1#issuecomment-1",
    resolved: false,
  }),
];

const files = new Map([
  [
    Schema.decodeSync(RepoPath)(path),
    {
      index: 3,
      digest: Schema.decodeSync(PatchDigest)(digest),
      text: Schema.decodeSync(ContentDigest)(text),
    },
  ],
]);

/** A line comment's draft on lines of a file's new text. */
const onLines = (body: string, content = text) =>
  saved({
    kind: "comment",
    selection: {
      kind: "text",
      path,
      content_sha256: content,
      start_line: 40,
      end_line: 41,
    },
    body,
  });

/** A line comment's draft on rows of a patch. */
const onRows = (body: string, patch = digest, file = path) =>
  saved({
    kind: "comment",
    selection: {
      kind: "rows",
      path: file,
      patch_sha256: patch,
      start_row: 2,
      end_row: 4,
    },
    body,
  });

test("each box's saved text goes back into its box, and an empty box restores nothing", () => {
  assert.deepEqual(
    restoring(
      [
        saved({ kind: "general", body: "A question" }),
        saved({ kind: "finish", verdict: "approve", body: "" }),
        saved({ kind: "reply", comment: "sent", body: "A reply" }),
        saved({ kind: "edit", comment: "pending", body: "An edit" }),
        onRows("A comment"),
        onLines("On expanded lines"),
      ],
      comments,
      files,
    ),
    [
      { kind: "general", body: "A question" },
      { kind: "finish", verdict: "approve", body: "" },
      { kind: "reply", comment: "sent", body: "A reply" },
      { kind: "edit", comment: "pending", body: "An edit" },
      {
        kind: "comment",
        selection: {
          kind: "rows",
          path,
          patch_sha256: digest,
          start_row: 2,
          end_row: 4,
        },
        body: "A comment",
        element: "f3-r4",
      },
      {
        kind: "comment",
        selection: {
          kind: "text",
          path,
          content_sha256: text,
          start_line: 40,
          end_line: 41,
        },
        body: "On expanded lines",
        element: "f3-l41",
      },
    ],
  );
  assert.deepEqual(
    restoring(
      [
        saved({ kind: "general", body: "" }),
        saved({ kind: "finish", verdict: "comment", body: "" }),
        saved({ kind: "reply", comment: "sent", body: "" }),
        // Whitespace alone is no comment to offer.
        onRows("  "),
      ],
      comments,
      files,
    ),
    [],
  );
});

test("a reply or an edit needs a comment that can take it", () => {
  assert.deepEqual(
    restoring(
      [
        // Gone, pending, and imported from the git host.
        saved({ kind: "reply", comment: "gone", body: "A reply" }),
        saved({ kind: "edit", comment: "gone", body: "An edit" }),
        saved({ kind: "reply", comment: "pending", body: "A reply" }),
        saved({ kind: "edit", comment: "hosted", body: "An edit" }),
      ],
      comments,
      files,
    ),
    [],
  );
});

test("a comment whose patch or text changed is offered for the next comment", () => {
  assert.deepEqual(
    restoring(
      [
        onRows("Changed patch", "b".repeat(64)),
        onRows("File gone", digest, "src/gone.ts"),
        onLines("Changed text", "d".repeat(64)),
      ],
      comments,
      files,
    ),
    [
      { kind: "stash", body: "Changed patch" },
      { kind: "stash", body: "File gone" },
      { kind: "stash", body: "Changed text" },
    ],
  );
});
