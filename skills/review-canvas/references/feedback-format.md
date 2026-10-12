# The feedback document

The server owns a review's state and exports it as one document with
`"format": "review-canvas.feedback/1"`: `review-canvas export` writes it, and
`GET /reviews/ID/feedback.json` on the page server serves it. `review-canvas
status` embeds the same document under `feedback`, beside `to_answer`, the
comments whose turn is the agent's, and `turns`, each comment's turn. The schema
is `src/schema/feedback.ts` in
[packages/review-canvas](../../../packages/review-canvas/README.md). Python
review canvas feedback, with `feedback_schema_version`, is refused by name;
there is no conversion.

The root holds `target`, `round`, `input_sha256`, `exported_at`,
`general_notes`, `files`, `approvals`, `threads`, `comments`, `earlier_rounds`,
and `submissions`. The target and the input digest name the round the document
describes. Quotes and their context may contain private code: keep exports
within the approved audience.

## Approvals

Each approval holds `path`, `fingerprint`, `approved_at`, and the `round` it
was made in. It records that the reviewer approved one exact version of the
file. The page shows a file as approved only while its current fingerprint
matches, so a changed file returns to the queue, and an unchanged file stays
approved across rounds. An approval a fresh start carried from an earlier
review names it in `carried_from`. Approval is display only and blocks nothing.

## Threads

Each thread holds `id`, `label`, and `host` (`kind` of `claude-code`, `codex`,
or `t3`, with an optional `session_id`). Tokens never appear. Every agent reply
names its thread.

## Comments

A comment holds `id`, `kind`, `source`, `body`, `created_at`, `updated_at`, and
`replies`. `kind` is `inline`, with an `anchor`, its `history`, and an
`attachment`, or `general`, on the whole change. `source` is `reviewer`, or
`github` with the comment's ID, author, URL, and resolved state, for comments
imported from a pull request.

An anchor holds the `snapshot` (round and input digest) the selection was made
in, `path`, `patch_sha256`, `start` and `end` (zero-based UTF-16 offsets into
the patch rows joined with LF, end exclusive), `quote`, `prefix` and `suffix`
(up to 80 units each), `start_row` and `end_row` (zero-based rows, counting
hunk headers), `side`, and `start_line` and `end_line` on that side. A
selection of deleted lines, alone or with context, is old-side; any other is
new-side. The anchor never changes when the diff moves.

The attachment is where the anchor lands in the current round, derived by the
server: `attached` with current offsets, or `orphan` with a reason. The same
patch attaches at the anchor's offsets. Another patch attaches where the quote
is found once, or where its context picks one of several places. A missing
file, a missing patch, a gone quote, or an ambiguous one makes an orphan. No
rename guessing or fuzzy matching. A manual reattachment keeps the earlier
anchor in `history`.

## Replies and turns

Replies are in order: by time, then agent before GitHub before reviewer, then
ID. Each has `id`, `created_at`, `actor`, and `body`.

- A `reviewer` reply has an `action`: `accept` resolves the comment and may
  have an empty body; `reopen` and `reply` return it to the agents.
- An `agent` reply names its `thread` and a `disposition`: `fixed` with
  `fixed_in` (`{ "fingerprint" }` or `{ "commit" }`), `rejected`, `deferred`
  with a `blocker`, or `question`.
- A `github` reply carries its GitHub ID, author, and URL.

The last reply decides the turn. No reply: the agent's. An agent reply: the
reviewer's. A reviewer `accept`: resolved. A reviewer `reopen` or `reply`, or a
GitHub reply: the agent's. The server refuses an agent answer off its turn and a
reviewer reply on a resolved comment, so one order is the only order.

## Submissions

Each submission holds `round`, `verdict` (`comment`, `approve`, or
`request_changes`), `body`, and `submitted_at`. The reviewer's **Finish
review** adds one, and `review-canvas wait` returns when the current round has
a submission newer than the revision the agent last saw.

## Limits

8 MiB as exported; 2,000 files and approvals with unique paths; 1,000 comments
with unique IDs; 200 reviewer replies and 200 GitHub replies per comment; 5,000
agent answers; 100 threads; 20 earlier anchors per comment; 50 earlier rounds;
1,000 submissions; 20,000 UTF-16 units per body or note, 131,072 for a GitHub
body; 2 MiB of all text together. The server refuses an action that would push
the review past a limit and says which.
