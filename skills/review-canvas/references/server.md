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
| Last port    | `port` beside the socket                                                                          |
| Pages        | `http://127.0.0.1:PORT`, printed by the server and returned by `register` and `publish`           |

`REVIEW_CANVAS_DATA`, `REVIEW_CANVAS_RUNTIME`, `REVIEW_CANVAS_PORT`, and
`REVIEW_CANVAS_IDLE_MINUTES` override the defaults. A command that cannot
connect starts a server. A starting server takes an exclusive lock on
`server.lock` in the runtime folder and holds it while it runs; the operating
system releases it when the process ends. Under the lock it removes a stale
socket and binds a new one, so two starts never both bind, and a server that
finds another one answering exits.

Without `REVIEW_CANVAS_PORT`, a server asks for the page port in `port`, the
one the last server listened on, and takes any free port when that one is busy.
A page left open across a restart, such as one after the idle stop, then
reconnects on its own. A page that cannot reach the server for two tries in a
row says so until it reconnects. `status`, `wait`, and `publish` write the
current URL into `session.json` when it changed.

Before any command connects, and before a server binds, the runtime folder must
be a real folder owned by the current user with no access for others; a looser
folder of the user's own is tightened. A folder or socket another user owns is
refused, because a listener there could collect inputs and thread tokens.

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

A page acts on the revision its markup shows. A comment names the patch its
rows belong to, and a finish names the round it covers, so neither can land on
a round the reviewer has not seen even while a refresh is on its way.

Open pages hold a server-sent event stream and refresh the page's content when
the revision changes, keeping the reviewer's place, open drafts, and scroll. A
draft whose code changed is not moved; its text fills the next comment. A
hidden tab holds no stream and catches up when shown. A failed refresh waits
longer each time. Whole files show unified or side by side; the choice is a
cookie the server reads when it renders.

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
`review-canvas wait` returns. A question the reviewer asks now returns `wait`
without a finish, so the agent can answer while the reviewer reads.

## What agents tell the server

Beside rounds and answers, an agent reports two things the page shows:

- **Drift.** `review-canvas check` compares the code with the current round: a
  working tree's files, or a pull request's head. The page shows what changed
  until the next round.
- **GitHub comments.** `publish` and `review-canvas github` read the pull
  request's comments with `gh` and hand them over, with the head GitHub read
  them at. The server stores them once by GitHub ID and never goes online
  itself. A thread is found by the lines it was written on; when the round
  shows that head and the lines changed, the server places it on the line
  GitHub shows it on, spanning as many lines as the comment did.

## Reviews and threads

A review is keyed by its target: the pull request URL, or the working tree
root. A thread that registers for a target joins its open review, so several
agent conversations can work one review, or starts one when there is none.
`--fresh` closes the open review and starts a new one; approvals whose path and
fingerprint match the new review's first round carry over, with a record of
where they came from. The closed review stays listed and read-only.

Rounds belong to the thread that published them. Comments, replies, approvals,
and submissions belong to the review.
