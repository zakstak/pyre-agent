# Review canvas server: next steps

This plan moves the review canvas from the Python skill to a TypeScript server in this package. It records what is
done, what is decided, what is still open, and the order of the remaining work.

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
| Runtime | Node 26 with pnpm. Node runs the server's TypeScript directly. |

## Open decisions

Each has a proposed default. Settle these before the step that needs them.

| Decision | Proposed default | Needed by |
| --- | --- | --- |
| State authority | The server owns state. Each action (approve, comment, reply, accept) is one request, and open pages get changes over server-sent events. This replaces whole-document autosave and most client merge and import logic. | Step 3 |
| Approvals | Shared by every thread of a review, tied to file fingerprints. | Step 2 |
| Answers from several threads | Today's turn rules stay: any thread may answer on the agent's turn, and each answer names its thread. | Step 2 |
| Start fresh | A new review for the same target with nothing carried over. The earlier review stays listed and readable. | Step 3 |
| Storage | `~/.local/share/review-canvas`: one folder of JSON files per review, plus an index. No database. | Step 3 |
| Lifecycle | The first agent command starts the server. A lock keeps one instance, a file in `$XDG_RUNTIME_DIR` records its port and token, and it stops after a set idle time. | Step 4 |
| Page access | The page needs a session token in its URL, as today. Agent API calls need the thread token. | Step 4 |
| File fallback | Drop the standalone `file://` page. Keep feedback JSON export and import. | Step 5 |
| Installation | How `install.py` installs or finds the server and its dependencies. `install.py` changes need approval first. | Step 6 |
| Format versions | The server-owned model changes the feedback format, so it gets a new version. Old versions fail with a message that names the version, with no migration code. | Step 1 |

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

### 3. Store and thread registry

- Reviews are keyed by target identity. Threads register with an ID, a token, a label, and host metadata.
- Rounds belong to the thread that published them. Comments, replies, and approvals belong to the review.
- Writes are atomic and private (mode 0600 in 0700 directories), with the ancestor and ACL checks from
  `review_state.py`. The server runs only where it can confirm privacy.
- Keep the round rules: a rendered round never changes, its input digest is recorded, and a round cannot drop or
  change an answer the published round showed.

### 4. Server API and lifecycle

- Endpoints to register a thread (join or fresh), publish a round, answer, approve, comment, reply, accept, and
  reopen, plus server-sent events for open pages.
- Keep today's request checks: exact Host, Origin on changes, token, content type, size, and revision.
- Single instance, runtime file, idle stop, and a bounded shutdown that finishes saves in progress.

### 5. Page

- A list of reviews, and a review page with files, diffs rendered when a file is expanded, approvals by fingerprint,
  comments anchored to a text selection, and threads.
- A thread list with labels, a filter for one thread or all, and a thread label on each answer and round.
- Tailwind with the internal visual style. Browser tests with Playwright owned by this package, not borrowed from
  another checkout.

### 6. Agent commands and the skill

- A TypeScript command-line tool: register, collect, publish, answer, and status.
- Rewrite `skills/review-canvas/SKILL.md` and its references for the server.
- Integrate with `install.py`, after approval.

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
- [ ] All request checks and privacy checks
- [ ] A working review loop driven by the skill

## Risks

- **Effect v4 HTTP is unstable.** Its modules can change in minor releases. Pin exact versions and keep the HTTP code
  thin.
- **Effect 4.0 patches are early.** `@effect/platform-node` 4.0.3 needs an unpublished `effect` 4.0.3, so the skeleton
  pins both to 4.0.2. The package index also loads a Redis module, so import module paths instead.
- **`tsc-rs` is an early release** whose author has not read its code. Pin it, use one `tsconfig`, and avoid `tsc -b`.
- **pnpm 11 holds back new releases** for a day; the skeleton lists `tsc-rs` 0.2.0 as an exception.
- **Privacy checks are Linux-only.** Server mode refuses macOS, Windows, and NFSv4 ACLs.

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
