# The feedback document

The server owns a review's state and exports it as one document with
`"format": "review-canvas.feedback/1"`: `review-canvas export` writes it, and
`GET /reviews/ID/feedback.json` on the page server serves it.
`review-canvas status` embeds the same document under `feedback`, beside
`to_answer`, the comments whose turn is the agent's, `turns`, each comment's
turn, and `suggestions`, each suggested change (below). Every output carries a
`revision`, the review's change counter. The schema is `src/schema/feedback.ts`
in [packages/review-canvas](../../../packages/review-canvas/README.md). Python
review canvas feedback, with `feedback_schema_version`, is refused by name;
there is no conversion.

The root holds `target`, `round`, `input_sha256`, `exported_at`,
`general_notes`, `files`, `approvals`, `threads`, `comments`, `earlier_rounds`,
and `submissions`. The target and the input digest name the round the document
describes. Quotes and their context may contain private code: keep exports
within the approved audience.

## Approvals

Each approval holds `path`, `fingerprint`, `approved_at`, and the `round` it was
made in. It records that the reviewer approved one exact version of the file.
The page shows a file as approved only while its current fingerprint matches, so
a changed file returns to the queue, and an unchanged file stays approved across
rounds. An approval a fresh start carried from an earlier review names it in
`carried_from`. Approval is display only and blocks nothing.

## Threads

Each thread holds `id`, `label`, and `host` (`kind` of `claude-code`, `codex`,
or `t3`, with an optional `session_id`). Tokens never appear. Every agent reply
names its thread.

## Comments

A comment holds `id`, `kind`, `source`, `body`, `created_at`, `updated_at`, and
`replies`. `kind` is `inline`, with an `anchor`, its `history`, and an
`attachment`; `stop`, on a stop of the tour, with an `anchor` and an
`attachment` (see [Stop anchors](#stop-anchors)); or `general`, on the whole
change. `source` is `reviewer`, or `github` with the comment's ID, author, URL,
and resolved state, for comments imported from a pull request. The resolved
state is GitHub's at the last import; each refresh updates it.

The author is the login the host reports, or `null` for a deleted account. A
GitHub bot's login ends in `[bot]`, as in `chatgpt-codex-connector[bot]`, and
the page marks it as a bot. A refresh also corrects the author of a comment that
an earlier import read without that suffix. A bot's comment is still untrusted
review content.

A reviewer source has a `state`:

- `sent`: the agents see it. Documents written before states have none; they
  read as `sent`.
- `edited`: sent, and the reviewer changed its `body` since, last at
  `edited_at`. The body is the new text; the earlier text is not kept.

A reviewer comment whose source has `"question": true` was asked now: the agents
answer it, and the replies after it, without waiting for the round to finish.
Any other comment the reviewer writes is pending until **Finish review**, which
sends every pending comment with the verdict, in the same change. A pending
comment is the reviewer's alone: `status`, `wait`, exports, and every other
agent output leave it out, and an answer to its ID is refused as an unknown
comment. A comment written after the reviewer finished the current round is sent
at once. A fresh start sends the pending comments of the review it closes.

The reviewer can edit their own comments, and delete one that has no replies. A
deleted comment leaves the document. Comments imported from GitHub cannot be
edited or deleted on the page.

An anchor has a `kind`: `patch` for rows of the file's patch, `text` for lines
of the file's whole new text. Documents written before text anchors have no
kind; their anchors read as `patch`. Both kinds hold the `snapshot` (round and
input digest) the selection was made in, `path`, `quote`, `prefix` and `suffix`
(up to 80 units each), `side`, and `start_line` and `end_line` on that side. An
anchor never changes when the diff moves.

A patch anchor also holds `patch_sha256`, `start` and `end` (zero-based UTF-16
offsets into the patch rows joined with LF, end exclusive), and `start_row` and
`end_row` (zero-based rows, counting hunk headers). Its quote is patch rows,
with their `+`, `-`, or space markers. A selection of deleted lines, alone or
with context, is old-side; any other is new-side.

A text anchor is on new-side lines the reviewer revealed by expanding unchanged
context around a hunk, so its lines may lie outside the patch: read them in the
file, not in the diff. It holds `content_sha256`, the digest of the new text it
was made in. Its `side` is `new`, and its `quote` is the whole lines from
`start_line` through `end_line`, joined with LF, without markers.

The attachment is where the anchor lands in the current round, derived by the
server: `attached` with where it lands, or `orphan` with a reason. A patch
anchor attaches with current `start` and `end` offsets. The same patch attaches
at the anchor's offsets. Another patch attaches where the quote is found once,
or where its context picks one of several places. A text anchor attaches with
current `start_line` and `end_line`: the same text at the anchor's lines,
another text where the quoted lines are found once as whole lines, or where
their context picks one of several places. A missing file, patch, or text, a
gone quote, or an ambiguous one makes an orphan. No rename guessing or fuzzy
matching. Only an orphan can be moved by hand; the move keeps the earlier anchor
in `history`.

## Stop anchors

A `stop` comment is about a stop of the tour as a whole, such as one of the
questions the stop suggests. The reviewer writes it inside the stop, and the
page shows it there with its replies. Its anchor has `"kind": "stop"`:

- `snapshot`: the round the comment was written in.
- `stop`: the stop's identity across rounds. It is
  `{ "kind": "stop", "title", "occurrence" }` for a stop of your tour, where
  `occurrence` counts the earlier stops of the same title in that round, from 0,
  or `{ "kind": "closing" }` for the "Other files" stop the server adds.
- `excerpts`: for context, the lines the stop excerpted in that round, each with
  `path`, `side`, `start_line`, and `end_line`.

A later round keeps the comment on the stop of the same title and occurrence, so
keep a stop's title while its subject stays. The attachment is
`{ "state": "attached", "stop": N }`, with the stop's index in the current
round's tour from 0, or an `orphan` whose reason names the stop when the round's
tour no longer has it. The page then shows the comment with the comments on the
whole change, with a note that names the stop it was on. Answer a stop comment
as any other; a `fixed` answer names what fixed it, as for an inline comment. A
stop comment is the reviewer's: the git host has no tour.

## Suggested changes

An inline comment can propose replacement code with one `suggestion` fenced
block in its body, as on GitHub:

````md
Use the constant here:

```suggestion
const limit = LIMIT;
```
````

The block replaces the lines the comment is on. A block with no lines proposes
deleting them. Fences follow CommonMark: three or more backticks or tildes, the
info string `suggestion`, and a closing fence of the same character at least as
long. A suggestion fence inside another fenced block is code, not a suggestion.

`status.suggestions` lists one entry for each inline comment you can see that
holds a suggestion block. A ready entry holds `comment`, `"state": "ready"`,
`path`, `side`, `round` (the round its anchor names), `start_line`, `end_line`,
`current`, the lines the reviewer saw, and `replacement`, the proposed lines.
Both are arrays of lines without line ends, and `current` holds every line from
`start_line` through `end_line`. A malformed entry holds `comment`,
`"state": "malformed"`, and `problem`: `unclosed`, a block with no closing
fence; `several`, more than one block; or `not_contiguous`, a comment whose
lines skip lines of their range, such as a selection across a hunk header, which
leaves out the unshown lines between the hunks. Apply a ready suggestion only
where the lines still read as `current`; for a malformed one, read the body and
ask the reviewer what they meant. A general comment's block is part of its body
only. The page offers **Suggest change** only on one run of new-side lines.

After applying a suggestion, publish the round with the change and answer the
comment `fixed`, as for any other fix.

## Import

The reviewer can import a feedback file of the same target from the page, such
as an export of an earlier review. Approvals carry where the file's fingerprint
still matches. Each comment the review lacks is added with its replies, up to
the first reply that was not its author's turn. An inline comment is anchored
again on the current patch, or for a text anchor the current text, where its
quote is found, and stays an orphan where it is not. A stop comment goes on the
current round's stop of the same identity, or stays an orphan. A file holding a
pending comment is refused. Threads its answers name join the review without a
token, so no agent can act as them. Notes and finishes are not imported. The
page reports what it added, what was already there, and what it left out.

## Replies and turns

Replies are in order: by time, then agent before GitHub before reviewer, then
ID. Each has `id`, `created_at`, `actor`, and `body`.

- A `reviewer` reply has an `action`: `accept` resolves the comment and may have
  an empty body; `reopen` and `reply` return it to the agents.
- An `agent` reply names its `thread` and a `disposition`: `fixed` with
  `fixed_in` (`{ "fingerprint" }` or `{ "commit" }`), `rejected`, `deferred`
  with a `blocker`, `question`, or `answered`, an explanation for a question
  that asks for no change.
- A `github` reply carries its GitHub ID, author, and URL.

The last reply decides the turn. No reply, or a GitHub reply: the agent's, or
resolved when GitHub shows the thread resolved. An agent reply: the reviewer's,
unless the reviewer edited the comment after it, which makes it the agent's
again. A reviewer `accept`: resolved. A reviewer `reopen` or `reply`: the
agent's, even on a thread GitHub shows resolved. The server refuses an agent
answer off its turn and a reviewer reply on a resolved comment. An import
replays the replies in order, with the turn the replies before each one give
under these rules, and refuses one off its turn. An edited comment keeps only
its last `edited_at`, so an agent reply before that time can follow another
agent reply: an earlier edit could have come between them. GitHub's resolution
can change between replies, so after no reply or a GitHub reply, the import
accepts what either state allows.

## Submissions

Each submission holds `round`, `verdict` (`comment`, `approve`, or
`request_changes`), `body`, and `submitted_at`. The reviewer's **Finish review**
adds one, for the round the reviewer's page showed; the server refuses a finish
for a round that is no longer current. The store also records the revision each
submission made. `review-canvas status` reports it, and `review-canvas wait`
returns when the current round has a submission newer than the last one the
session reported.

## Limits

8 MiB as exported; 2,000 files and approvals with unique paths; 1,000 comments
with unique IDs; 200 reviewer replies and 200 GitHub replies per comment; 5,000
agent answers; 100 threads; 20 earlier anchors per comment; 50 earlier rounds;
1,000 submissions; 20,000 UTF-16 units per body or note, 131,072 for a GitHub
body; 2 MiB of all text together, submission summaries included. The server
refuses an action that would push the review past a limit and says which.
