# Write the tour

Review agents may already have read every line for bugs. The tour is not a bug
hunt and not a nitpick pass. The reviewer wants intent and judgment: what this
changes, how it is put together, and the few calls only they can make. Write it
as numbered stops the reviewer walks through the diff. The fields, their
required keys, and the server's hard limits are in
[the input reference](input-format.md); the numbers here are how a good tour
reads.

## The stops

- **Order.** One stop for a trivial change, usually 2 to 6, at most 8. Lead with
  the idea of the change, then its mechanics, then what it touches on the way. A
  reader who stops after the first stop should know what the change is for. For
  a change that is several features, let the first stop name them and give each
  later stop one; fold small features together to stay within 8.
- **Title.** A short, literal phrase in sentence case: what this stop shows.
- **Summary.** Two to four sentences on what the code here does and why it is
  shaped this way. Never narrate code line by line; the excerpt shows the code.
- **Attention.** Most stops have `null`. Set it only for a call that is the
  reviewer's to make: a `tradeoff`, a `contract` that other code depends on, a
  `product` decision, a `risk` to judge, or an `accessibility` call. Not a bug,
  not a missing test, not a style preference. Do not invent concerns. A stop
  holds one; when two calls belong to one stop, split it.
- **Excerpts.** 3 to 25 rows each as the page shows them, deleted lines
  included, usually 1 to 3 per stop, each with a short caption. Name lines on
  the `new` side, which for an added file are its own line numbers, or on the
  `old` side for deleted code. An excerpt shows the patch rows of the lines it
  names; across two hunks it shows both, with the second hunk's header between
  them. A file can be excerpted in any stop.
- **Files.** Files the stop covers without an excerpt, each with an optional
  note. Account for each file where it makes sense; the input reference says
  which stop owns a file and what `publish` warns about.
- **Notes.** At most 3 per stop, each on a line one of the stop's excerpts
  shows. A note explains; it is not a finding or a request.
- **Questions.** Zero to 2 short questions about intent that the reviewer might
  ask themselves at this stop, never whether something should change. A click
  puts one in the reviewer's question box, ready to ask.

## Groups and observations

Choose each file's `group` from its role in this change, not its path: `core`
for the behavior the change is about, `wiring` for what connects it, such as
routes, registration, and configuration that follows the change, and
`mechanical` for formatting, generated code, lock files, and routine renames.
Tests, styles, and build files take the group of what they serve: tests and
styles of the core behavior are `core`, and so is a test suite or build step the
change is about. Do not hide a risky change because its file also holds
mechanical edits.

For dense logic, add a file's `pseudocode`; for surprising behavior, a `trace`
of one input through the old and new paths. Put a real observation that is not
the reviewer's call in a file's `callouts`, with a short lowercase tag such as
`risk`, `breaking`, `race`, `untested`, or `follow-up`. Put what applies to the
whole review, such as tests you did not run, in the summary. A likely defect you
notice is such an observation, a callout tagged `bug`, not an attention:
attention is for the reviewer's judgment, not for a finding. Distinguish
evidence from inference. Do not manufacture findings, risk labels, or confidence
scores.

## One layer of a stack

When the pull request is one layer of a stack, say so in the first stop's
summary and name the pull requests below and above it by number. Tour only this
layer's files. Code from the layer below is context: name a seam with it in a
phrase, but do not excerpt, explain, or judge that layer's code as part of this
change. [The pull request reference](pull-request.md) says how to find the
layers.

## A walkthrough across a stack

When the reviewer asks for one walkthrough of a whole stack, review each layer
first: register, collect, and publish a round of every pull request from the
base to the tip you were given. Then write one stack file:

```json
{
  "format": "review-canvas.stack/1",
  "title": "Retry limits, base to tip",
  "summary": "Why the stack exists, and the order to read it in.",
  "tip": "https://github.com/acme/project/pull/69",
  "steps": [{ "layer": "https://github.com/acme/project/pull/68", "title": "…" }]
}
```

Each step is a stop of this reference with a `layer`: the URL of the pull
request whose round its excerpts and notes name. Order the steps from the base
layer to the tip. A layer's files that no step covers get a closing step.
Publish with every layer's session:

```sh
"$RC" stack-publish --input "$STACK" --session "$BASE" --session "$TIP"
```

The command reads the tip's ancestor path from the host. It refuses steps on a
sibling branch, steps out of order, and a layer whose round is not at the host's
current head and base. A layer above the root must diff from its parent's head:
after a parent is force-pushed, rebase the layer on it if needed, then collect
and publish a round again. The root must diff from its merge base with the
branch it merges into, which new commits on that branch do not change. Pass
`--history` for merged or closed GitHub stacks, which uses each pull request's
final retained head; say in the summary that earlier force-pushed revisions are
not shown. Publish the stack file again after a new round of any layer: the page
hides a moved layer's excerpts until you do, and keeps the reviewer's progress
on steps you left unchanged, even when steps or layers before them were added or
removed.

## Later rounds

Tour what changed since the last round. The page marks each file new or changed
in this round and shows its changes since the round before.

Before you write the tour, read `"$RC" status --session "$SESSION"`. Its `turns`
give each comment's state. A comment whose turn is `resolved` is settled: the
reviewer accepted your answer, or the git host shows its thread resolved. A
comment whose turn is `reviewer` waits for the reviewer to read your answer.
Raise no attention on a concern that either kind of comment already covers. A
stop can still show the code that fixed it.

An orphan, or an imported thread that arrived outdated, is not evidence of a
fix: its code changed or moved, which can mean anything. Read the current code
before you treat its concern as settled.
