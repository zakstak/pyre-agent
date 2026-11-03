// Where the drafts the server kept go back when the page opens a review.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { SavedDraft } from "../../schema/draft.ts";
import { Comment } from "../../schema/feedback.ts";
import { PatchDigest, RepoPath } from "../../schema/primitives.ts";
import { restoring } from "./restore.ts";

const at = "2026-11-03T12:00:00.000Z";
const path = "src/a.ts";
const digest = "a".repeat(64);

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
    { index: 3, digest: Schema.decodeSync(PatchDigest)(digest) },
  ],
]);

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
        path,
        digest,
        start: 2,
        end: 4,
        body: "A comment",
        index: 3,
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

test("a comment whose patch changed, or that is on lines of the text, is offered for the next comment", () => {
  assert.deepEqual(
    restoring(
      [
        onRows("Changed patch", "b".repeat(64)),
        onRows("File gone", digest, "src/gone.ts"),
        saved({
          kind: "comment",
          selection: {
            kind: "text",
            path,
            content_sha256: "c".repeat(64),
            start_line: 1,
            end_line: 1,
          },
          body: "On text",
        }),
      ],
      comments,
      files,
    ),
    [
      { kind: "stash", body: "Changed patch" },
      { kind: "stash", body: "File gone" },
      { kind: "stash", body: "On text" },
    ],
  );
});
