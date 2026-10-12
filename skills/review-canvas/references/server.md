# The review canvas server

One server serves every review on the machine. The first agent command starts
it, and it stops after four hours without an agent request, a page change, or
an open page. Its code is in
[packages/review-canvas](../../../packages/review-canvas/README.md).

## Where it lives

| What         | Where                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Database     | `${XDG_DATA_HOME:-~/.local/share}/review-canvas/reviews.sqlite`, 0600 in a 0700 folder            |
| Agent socket | `$XDG_RUNTIME_DIR/review-canvas/agent.sock` on Linux, `$TMPDIR/review-canvas/agent.sock` on macOS |
| Server log   | `server.log` beside the socket                                                                    |
| Pages        | `http://127.0.0.1:PORT`, printed by the server and returned by `register` and `publish`           |

`REVIEW_CANVAS_DATA`, `REVIEW_CANVAS_RUNTIME`, `REVIEW_CANVAS_PORT`, and
`REVIEW_CANVAS_IDLE_MINUTES` override the defaults. The socket is the
single-instance lock: a command that cannot connect starts a server, and a
server that finds one answering exits.

## Who talks to it

Agents use the Unix socket. A thread registers once and proves itself with the
token in `session.json` on every later request. Pages use the loopback port.
The server answers only requests whose `Host` is its own loopback name and port,
and accepts a change only from a page it served, by its `Origin`. There is no
page token: anything on this machine that can reach 127.0.0.1 can read and
change reviews while the server runs. This is accepted for one user on one
machine.

## What the server owns

The server is the one authority on a review. Each action is one transaction
that raises the review's revision: a comment, a reply, an accept, a reopen, an
approval, a submission, a published round, an agent's answer. A page sends the
revision it saw with each action; when the review moved on, the server refuses
the action and the page refreshes. No state is written that the feedback schema
would refuse, so every review exports as a valid feedback document.

Open pages hold a server-sent event stream and refresh the page's content when
the revision changes, keeping the reviewer's place, open drafts, and scroll. A
hidden tab closes its stream and catches up when shown.

## Whose turn

Each comment waits for one side:

- **The agent** when the comment has no answer, or the reviewer reopened it or
  replied after the last answer.
- **The reviewer** when the last entry is an agent's answer.
- **Nobody** once the reviewer accepted the last answer, or withdrew the
  comment. The reviewer can reopen it.

An agent may answer only on its turn. Any registered thread of the review may
answer, and each answer names its thread. The review as a whole changes hands
when the reviewer chooses **Finish review**: the submission records the round,
a verdict (comment, approve, or request changes), and a summary, and
`review-canvas wait` returns.

## Reviews and threads

A review is keyed by its target: the pull request URL, or the working tree
root. A thread that registers for a target joins its open review, so several
agent conversations can work one review, or starts one when there is none.
`--fresh` closes the open review and starts a new one; approvals whose path and
fingerprint match the new review's first round carry over, with a record of
where they came from. The closed review stays listed and read-only.

Rounds belong to the thread that published them. Comments, replies, approvals,
and submissions belong to the review.
