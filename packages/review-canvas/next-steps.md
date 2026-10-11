# Review canvas server: next steps

This plan moves the review canvas from the Python skill to a TypeScript server in this package. It records what is
done, what is decided, and the order of the remaining work.

## Where things stand

- `main` holds the Python review canvas: PRs #27 to #30, merged on 2026-10-10 as `c1bbfc3`, `fc63bb7`, `fc1de64`, and
  `81c77d7`. It reviews GitHub PRs and local working trees, serves a loopback page, and threads agent answers with
  reviewer replies. It is the working version until the port reaches parity.
- The server skeleton is on branch `review-canvas/server-skeleton`, in the worktree
  `/home/zak/git/pyre-agent-worktrees/server-skeleton`. It is in draft PR #31, and the `Review canvas server` workflow
  passes in CI.
- The skeleton serves one page and the built assets from 127.0.0.1, refuses requests for any other Host, and sets the
  security headers. `pnpm typecheck`, `pnpm build`, and `pnpm test` pass.

## Decisions

| Area | Decision |
| --- | --- |
| Tenancy | One local user. One server serves every repository and agent thread on the machine. |
| Thread | An agent conversation (Claude Code, Codex, or T3). |
| Thread identity | Registration returns a thread ID and token that the agent keeps. A host session ID is stored as metadata when available. |
| Joining | A new thread joins the open review of the same working tree root or PR URL. It can start a fresh review instead. |
| Breakout | A view filter. The review stays one; the UI can show one thread's rounds, answers, and comments, or all of them. |
| Scope | Everything moves to TypeScript: server, page, collector, fingerprints, answers, and validation. |
| Location | This package, `packages/review-canvas`, inside pyre-agent. |
| Server | Effect v4. It renders pages as HTML and serves the API. |
| Browser | No UI framework. Server-rendered HTML with small TypeScript modules, built by Vite with Tailwind and the internal visual style. |
| Type check | `tsc-rs` with Effect's diagnostics. |
| Runtime | Node 26 with pnpm. Node runs the server's TypeScript directly from a checkout or a linked install. Node refuses to strip types from files under `node_modules`, so an installed package needs emitted JavaScript. |
| Platforms | Linux, and macOS on Apple Silicon. The target Macs are M3 or newer; Intel Macs are not supported. CI runs on Linux and an arm64 macOS runner from step 2. |
| State authority | The server owns state. Each action (approve, comment, reply, accept, reopen) is one request that carries the revision it saw. Open pages get short change events over server-sent events and fetch the server-rendered HTML for the changed item. A hidden page closes its stream and catches up by revision when shown, so open tabs stay under the browser's six connections per host. |
| Approvals | Shared by every thread of a review and tied to file fingerprints. Each approval records the round it was made in. |
| Answers from several threads | Today's turn rules stay: any thread may answer on the agent's turn, and each answer names its thread. |
| Start fresh | A new review for the same target. It is not empty: it carries each approval whose path and fingerprint match its first round, records where the approval came from, and imports the target's GitHub comments (next row). Local comments, replies, and rounds do not carry. It opens with no thread filter. The earlier review stays listed and read-only. |
| GitHub comments | Every new review, including a fresh start, imports the comments of the target's open PR: the PR itself, or the open PR of a working tree's checked-out branch, found with `gh pr view`. It imports everything: review threads with their replies, top-level conversation comments, and review summaries. Resolved threads arrive resolved; everything else arrives as an open comment the agent must answer, under the turn rules, with its GitHub author and link. Resolution state comes from `gh api graphql`. Inline comments reattach to the review's diff by quote and context; those that do not match are orphans. Each keeps its GitHub ID, so an explicit refresh command imports only new comments. The agent command fetches and hands the comments to the server; the server never goes online. Nothing is posted back to GitHub. Comment bodies are untrusted data. |
| Storage | SQLite through the built-in `node:sqlite`, in `${XDG_DATA_HOME:-~/.local/share}/review-canvas` on both platforms. The schema version lives in `PRAGMA user_version`. |
| Lifecycle | The first agent command starts the server. It listens on a Unix socket for agents and on 127.0.0.1 for pages. The socket is the single-instance lock: a command that cannot connect starts the server, and a server that cannot bind exits. The socket lives in `$XDG_RUNTIME_DIR/review-canvas` on Linux and `$TMPDIR/review-canvas` on macOS, in a 0700 folder, with a path under 104 bytes. The server stops after a set idle time. Agent requests and visible pages with an open stream count as activity. |
| Page access | No page token. Pages rely on the exact Host check and the Origin check on changes. Any local process or OS user that can reach 127.0.0.1 can read and change reviews while the server runs; this is accepted for one user on one machine. The thread token identifies a thread; the socket's folder permissions are the only agent authentication. |
| Privacy | Plain modes only: 0700 folders and 0600 files. No ACL, ancestor, or filesystem checks, because the server already serves the data to anything on loopback. |
| File fallback | Drop the standalone `file://` page. Keep feedback JSON export. Import replays comments and replies as actions through the normal checks and reports what it skipped. |
| Format versions | Greenfield. Each format starts at version 1 under a new key, such as `"format": "review-canvas.feedback/1"`, so no Python file can be read as a new one. Unknown formats and versions fail with a message that names them. No conversion of Python reviews: finish them in the Python version. |
| Installation | npm in the long term. Nothing is published for now. The package has a `bin`, and local testing installs it with `pnpm link --global`, which runs the source. A `pnpm pack` tarball does not work until the build emits JavaScript for the server and the command-line tool; that build, and a test that installs the packed tarball and starts its `bin` on Node 26, come before any npm release. |

## Later, not now

- Start fresh might default to a new thread inside the open review instead of a new review.

## Steps

Each step ends with its tests passing in CI. Keep the Python review canvas frozen during the port: bug fixes only, no
thread or multi-thread features.

### 0. Land the skeleton

Done in draft PR #31: the skeleton is committed, and the `Review canvas server` workflow passes in CI. Merge it before
step 1 starts.

### 1. Schemas

Define the review input, feedback, threads, and answers once, with Effect Schema. One definition replaces both
`feedback_contract.py` and the page's `feedback.js`.

- Port the shared feedback cases in `tests/fixtures/feedback` (checked by `tests/test_feedback_contract.py`) and the
  input validation cases in `tests/test_review_renderer.py` as schema tests.
- Keep the limits the Python version enforces: sizes, counts, UTF-16 lengths, and refused control characters.
- A comment has a source: the reviewer, or GitHub with its comment ID, author, URL, and resolved state. Replies
  imported from GitHub keep their GitHub author.

Done: the schemas, limits, and decoders live in `src/schema` under the format keys `review-canvas.input/1` and
`review-canvas.feedback/1`; the collector writes `WorktreeInput`, and documents decode through `decodeBytes`, because
Effect's own decoders drop unknown fields. Answers moved from the input into feedback replies that name their thread,
comments are inline or general, anchors name a round instead of a target, PR targets always carry their URL and head
commit, roots are normalized POSIX paths, times are UTC with milliseconds, and a GitHub inline comment that misses the
diff still needs an anchor shape in step 6.

### 2. Collector and fingerprints

Port `collect_worktree.py` and `fingerprint.py`. They are the riskiest part, and their tests in
`tests/test_collect_worktree.py` (about 110 cases) are the specification. Port the tests first.

The collector must keep every protection it gained in review:

- It runs Git only from a trusted path, never one inside the repository, a bare clone, a `core.worktree` checkout read
  with Git's config rules and includes, or a symlink in the repository.
- It neutralizes filters, external diffs, text conversion, grafts, the shallow file, inter-hunk context, and the
  inherited `GIT_*` variables, and uses literal pathspecs.
- It reads the inventory twice around one consistency check that includes the index and the staged versions.
- It handles assume-unchanged and skip-worktree entries, sparse checkouts, case-only renames under
  `core.ignoreCase`, submodules, symlinks, and undecodable names.
- It replaces hidden and reordering characters in patches, and escapes paths in everything it prints.

Done: `src/collector` collects a working tree into a `WorktreeInput` checked by `WorktreeInputDocument`, and every
Python case has a test of the same name. 104 run, in CI on Linux and macOS, and 5 that guarded the Python state
directory or Windows are skipped with their reason. For step 6, the collect command runs `openWorktree`, `checkOutput`
(which now refuses the whole Git directory), `collect`, `writeOutput`, and `report`, and `prFingerprints` replaces
`fingerprint.py`; step 7 deletes `parity.test.ts` with the Python tests it reads.

### 3. Store and thread registry

- Reviews are keyed by target identity. Threads register with an ID, a token, a label, and host metadata.
- Rounds belong to the thread that published them. Comments, replies, and approvals belong to the review.
- SQLite through `node:sqlite`, one database for every review, 0600 in a 0700 folder. Each action is one
  transaction that raises the review's revision.
- Start fresh carries matching approvals, as the decision above describes.
- Imported GitHub comments are unique per review by GitHub ID, so a refresh adds only new ones.
- Keep the round rules: a rendered round never changes, its input digest is recorded, and a round cannot drop or
  change an answer the published round showed.

### 4. Server API and lifecycle

- Endpoints to register a thread (join or fresh), publish a round, answer, approve, comment, reply, accept, and
  reopen, plus server-sent events for open pages.
- Keep today's request checks except the page token: exact Host, Origin on changes, content type, size, and
  revision.
- Agents use the Unix socket; pages use 127.0.0.1. The socket is the single-instance lock. Idle stop, and a bounded
  shutdown that finishes writes in progress and closes event streams.

### 5. Page

- A list of reviews, and a review page with files, diffs rendered when a file is expanded, approvals by fingerprint,
  comments anchored to a text selection, and threads.
- A thread list with labels, a filter for one thread or all, and a thread label on each answer and round.
- Tailwind with the internal visual style. Browser tests with Playwright owned by this package, not borrowed from
  another checkout.

### 6. Agent commands and the skill

- A TypeScript command-line tool: register, collect, publish, answer, status, and refresh GitHub comments.
- Starting a review looks up the open PR with `gh` and imports its comments. With no open PR, or when `gh` fails, the
  review starts without them and the command says why.
- Rewrite `skills/review-canvas/SKILL.md` and its references for the server.
- Give the package a `bin`. Install it locally with `pnpm link --global`. Do not publish.
- Before an npm release: emit JavaScript for the server and the command-line tool, and add a test that installs the
  `pnpm pack` tarball and starts its `bin` on Node 26.

### 7. Parity, then removal

When the server covers every row below, remove the Python review canvas in the same change:
`skills/review-canvas/scripts`, the old page assets (`review.js`, `feedback.js`, `review.css`), and their Python and
browser tests and fixtures. Raise `review-canvas` to 4.0.0.

Parity checklist:

- [ ] GitHub PR and working tree targets
- [ ] Every collector case from `tests/test_collect_worktree.py`
- [ ] Approvals by fingerprint, carried across rounds
- [ ] Side-aware comment anchors, orphans, and reattachment
- [ ] Agent answers with dispositions, reviewer accept, reopen, and reply
- [ ] Thread states, including missing history
- [ ] Feedback limits, export, and import
- [ ] All request checks, except the page token, which is dropped on purpose
- [ ] A working review loop driven by the skill

## Risks

- **Effect v4 HTTP is unstable.** Its modules can change in minor releases. Pin exact versions and keep the HTTP code
  thin.
- **Effect 4.0 patches are early.** `@effect/platform-node` 4.0.3 needs an unpublished `effect` 4.0.3, so the skeleton
  pins both to 4.0.2. The package index also loads a Redis module, so import module paths instead.
- **`tsc-rs` is an early release** whose author has not read its code. Pin it, use one `tsconfig`, and avoid `tsc -b`.
- **pnpm 11 holds back new releases** for a day; the skeleton lists `tsc-rs` 0.2.0 as an exception.
- **No page token.** Anything that can reach 127.0.0.1 can read and change reviews while the server runs, including
  other OS users and sandboxed tools that cannot read your files. Accepted for one user on one machine.
- **Browsers allow six HTTP/1.1 connections per host.** Loopback has no HTTP/2 without TLS, so every open event stream
  counts. Hidden pages must close their stream.
- **Imported comments are third-party text in the agent's queue.** Anyone who can comment on the PR, bots included,
  puts work in front of the agent. Treat bodies as untrusted data, never as instructions. Conversation comments have
  no resolved state on GitHub, so bot posts arrive open.
- **macOS is new.** The Python collector and server ran only on Linux in CI. Run the collector tests on macOS from
  step 2.

## Carried over from the Python version

- The `codex-branch-review` bridge splits its event stream with `str.splitlines()`, which also breaks on U+2028 and
  U+0085. The fixtures work around it with ASCII escapes; the bridge itself needs the fix.
- Notes in earlier rounds cannot be edited on the page, so a very large history can push carried feedback past
  8 MiB. The server-owned model should let a reviewer drop an earlier snapshot.
- The screenshots in PRs #28 to #30 predate the last review fixes. The `pr-28-screenshots`, `pr-29-screenshots`, and
  `pr-30-screenshots` branches stay, because the PR descriptions link to them.

## Housekeeping

- The `canvas/*` branches remain on GitHub.
- The main checkout at `/home/zak/git/pyre-agent` is still on `73e10fb`. Pull it when convenient.
