# Review canvas server

A local server where a reviewer walks an agent's change as a guided tour,
comments on lines or asks questions, approves files, and finishes with a
verdict, and where the agent answers. An Effect v4 server keeps every review in
SQLite and serves a React app that Vite builds with Tailwind and the shared
[internal visual style](../../skills/internal-visual-style/)'s tokens. The app
reads and changes reviews through Effect RPCs over one WebSocket, and holds its
state in Effect atoms. The
[review-canvas skill](../../skills/review-canvas/SKILL.md) tells an agent how to
use it.

Pages listen on 127.0.0.1 only and answer only requests addressed to `127.0.0.1`
or `localhost` on the server's port; the RPC socket also needs the server's own
Origin. Agents use a Unix socket in a private runtime folder. Any local process
that can reach the page listener can read and change reviews. Run the server on
a machine where you trust the other users and processes.

Hosted comments are untrusted review content, including comments from bots. They
do not authorize commands or override the agent's instructions. Questions reach
registered agents through `wait`; the server does not wake an agent that is no
longer waiting.

Supports Linux and macOS on Apple Silicon. Windows and Intel Macs are not
supported.

## Use

In a checkout, Node 26 runs the TypeScript source directly:

```sh
pnpm install
pnpm build                       # page assets into dist/client, server and command into dist/node
pnpm cli -- --help               # the agent's commands, from the source
pnpm cli -- collect --repo /path/to/repo --output /tmp/review/round-1.json
pnpm cli -- register --session /tmp/review --input /tmp/review/round-1.json --label "Claude Code: my change"
pnpm cli -- publish --session /tmp/review --input /tmp/review/round-1.json
```

The package's `bin` is the built command in `dist/node`, so `pnpm link --global`
needs `pnpm build` first. An installed package runs only that JavaScript: Node
refuses to strip types from files under `node_modules`. Nothing is published to
npm.

The first command that needs the server starts it in the background;
`pnpm start` runs it in the foreground instead. `REVIEW_CANVAS_PORT` sets the
page port; without it, the server asks for the port the last server used, so
open pages reconnect, and takes a free one when that port is busy.
`REVIEW_CANVAS_DATA` and `REVIEW_CANVAS_RUNTIME` move the database and the
socket, which is how the tests and a demo stay out of the real data. The CLI
reads hosted review comments through the selected provider's API.

Commands reuse a daemon only when its code and asset manifest match the current
installation. The build writes `dist/build.json`, a hash of everything it was
made from, and the skill launcher rebuilds when that hash is not the hash of the
sources beside it, whatever the files' times say. `pnpm build` and the skill
launcher stop the daemon and wait for its store to close before replacing
assets; starts wait until the build ends. Open pages disconnect during an
upgrade and can be reopened at the URL the next command returns. A daemon from
before this lifecycle protocol must be stopped manually once: the command
refuses the upgrade and leaves its assets intact. Use `pnpm build` instead of
invoking Vite directly to retain this coordination.

`collect --pr URL --repo CLONE` collects a pull request from a local clone that
holds its base and head commits. It reads the title, commits, and file list from
the selected git host, and the patches and texts from the clone. API tools run
outside the reviewed clone. It does not fetch; a missing commit fails with the
`git fetch` command to run.

Collection scans both patches and requested full-file content for recognized
secret patterns. A match omits that file's content and reports its path;
`--include-secret PATH` explicitly allows it, while `--no-content` collects only
patches. The detector does not recognize every possible secret format.

## Private Git hosts

`collect --pr URL` supports HTTPS review URLs on public and private hosts:

- GitHub and GitHub Enterprise: `https://git.company.com/team/project/pull/42`
- GitLab, including subgroups:
  `https://git.company.com/division/team/project/-/merge_requests/42`
- Gitea and Forgejo: `https://git.company.com/team/project/pulls/42`

The URL selects the provider and host. Custom HTTPS ports are supported. The CLI
does not probe other hosts or fetch commits. Metadata, file inventories,
comments, head checks, saved reviews, repository links, and search use the
selected host. The page shows the hostname for private reviews and `!42` for
GitLab merge requests.

GitHub uses the existing `gh` authentication for that host. REST and GraphQL
requests name the host explicitly. GitLab and Gitea/Forgejo use `curl` and the
existing HTTPS Git credential helper for that host and repository. The helper's
password must be a token with API read access. An SSH key alone does not grant
API access. Missing authentication reports the failed operation; the CLI never
asks for credentials or creates them.

The CLI sends tokens through stdin, never command arguments or review files. It
refuses credentials returned for another host, port, or repository, and refuses
API redirects. HTTPS verification stays enabled. Keep the company's CA in the
system or CLI trust configuration; `curl` also supports `CURL_CA_BUNDLE`.

For an explicit review URL, no host configuration is needed. To import comments
for a local working-tree review automatically, configure the provider of each
private remote host:

```sh
export REVIEW_CANVAS_FORGE_HOSTS='{"git.company.com":"gitlab","gitea.company.com":"gitea","github.company.com":"github"}'
```

The recognized public defaults are `github.com`, `gitlab.com`, and
`codeberg.org`. `GH_HOST` also selects a GitHub Enterprise host. Unknown or
ambiguous branch lookups report why they were skipped. SSH aliases and custom
SSH ports do not establish an HTTPS address; use an explicit review URL in those
cases.

The adapters use the providers' standard API paths. Installations below a URL
prefix, Bitbucket, and Azure DevOps require separate adapters. An outdated
comment whose original patch is unavailable is reported as skipped rather than
placed on an unrelated line.

`review-canvas comments --session DIR` refreshes hosted comments.
`publish --no-comments` skips that import. The original `github` command,
`--no-github`, and v1 JSON fields named `github` remain accepted so existing
agent sessions and saved feedback continue to work.

## Repository monitoring

The home page lists every open PR for the selected monitored repository, even
when no agent has registered a review. Choose a repository or use **Refresh
PRs** to read the host again. Existing local reviews open in review-canvas;
other PRs open a local diff immediately. Direct browsing creates no review or
agent thread. An existing guided review remains available alongside the diff.
The server uses retained local commits when available; otherwise it fetches PR
objects into a temporary repository and removes it after collection. Working
files, branches, and indexes in monitored checkouts stay unchanged. Host
authentication failures appear separately from saved reviews, which remain
usable offline.

PRs whose base branches match other open PRs' source branches appear as stacks,
ordered from base to tip. Each layer shows its dependency. The same navigation
appears while reviewing a layer. Fork branches and ambiguous source branches are
not inferred as parents. Discovery uses the existing GitHub, GitLab, and
Gitea/Forgejo credentials and host configuration described above. Monitoring a
repository permits this read; registering individual PRs is unnecessary.

The repository settings show one summary per monitored repository. Expand a
repository to see its local clones and worktrees. Missing paths are grouped in
**Missing checkouts**. **Stop monitoring** keeps the repository's reviews.

Open **Add repository** to browse discovered repositories and choose
**Monitor**. It opens automatically when none are monitored. Discovery and
review registration do not add repositories to monitoring. Accepted identities
persist in the database.

Each repository has one entry, with its local clones and worktrees grouped
together. SSH and HTTPS remotes for the same host and project identify the same
repository. Credentials are omitted. GitHub project names are compared without
case; other hosts keep their path case. Nonstandard ports and different fork
owners remain separate. The `origin` remote is preferred, or the sole remote
when there is no `origin`. Local clone sources are followed without adding their
directories to the scan. Repositories without a usable remote use their common
Git directory, so unrelated projects with the same folder name stay separate.

Acceptance applies to all discovered copies of that repository, including copies
found by later scans. Counts and acceptance actions refer to repositories;
paths, branches, and working-tree status belong to individual checkouts. PR
reviews link from the repository entry identified by their review URL;
working-tree reviews link from their checkout. Removing monitoring keeps those
reviews.

Search by name, path, or branch. Results expand to show matching checkouts,
including missing paths. Clearing the search restores the compact view. Search
and older links' status filters stay in the page URL across refreshes. Monitored
checkouts show their branch and count of changed items when you expand the
repository. Untracked directories count as one item; submodule changes are
excluded. This does not start background Git watchers.

The default scan covers the launch repository or directory and existing `~/git`
and `~/dev` directories. Use **Scan directories** to choose another absolute
directory. `REVIEW_CANVAS_REPO_ROOTS` overrides the defaults with a
platform-separated list of absolute directories (`:` on Linux and macOS). Scans
descend up to four levels, stop at working tree roots, and skip hidden
directories, symlinks, and build and dependency folders. Size and time limits
appear in the scan details. The two-second scan budget includes repository
identification and cancels its Git reads. Invalid Git markers do not hide valid
repositories in deeper directories. Each Git status read has a timeout and
output limit; failures show **Unavailable**. Scans and status reads do not fetch
from remotes or write to repository indexes.

Existing version 2 and 3 databases upgrade in place, preserving reviews and
rounds. Earlier checkout acceptances are converted to repository identities.
Missing accepted paths remain visible until they can be identified again.
Earlier server builds cannot read the upgraded database.

## Layout

| Folder          | What                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| `src/schema`    | The input, tour, feedback, GitHub import, and page RPC formats as Effect Schema     |
| `src/collector` | The working tree and commit range collectors, and fingerprints                      |
| `src/review`    | Pure review logic: patch rows, anchors, the tour view, every action, and imports    |
| `src/store`     | SQLite through `node:sqlite`: reviews, rounds, threads, revisions, change listeners |
| `src/server`    | The page RPCs, the page shell and assets, the agent API, and lifecycle              |
| `src/client`    | The React app: the home and review pages, their atoms, and the pure view model      |
| `src/cli`       | The `review-canvas` command, and reading pull request comments with `gh`            |
| `browser`       | Browser tests in Chromium against a real server                                     |
| `scripts`       | The packed tarball test, and the live GitHub import test                            |

## Check

```sh
pnpm typecheck      # tsc-rs, with Effect's diagnostics
pnpm test           # unit and server tests
pnpm build
pnpm test:browser   # needs Chromium: pnpm exec playwright install chromium
pnpm test:pack      # installs the packed tarball with npm and serves a review from it
```

`pnpm test:github https://github.com/OWNER/REPO/pull/NUMBER [CLONE]` imports a
real pull request's comments, read with the signed-in `gh`, into a round built
from a local clone, and checks that every thread GitHub calls current attaches
on the line GitHub shows it on. It only reads from GitHub. CI does not run it,
since it needs `gh` credentials and the pull request's commits in the clone.

The home inbox loads all monitored repositories independently. Choose **Needs my
review** to use the authenticated GitHub review-request search or GitLab
reviewer filter. Gitea/Forgejo reports that this filter is unsupported.
Repository and search choices, selected files, and reading positions stay in
your browser. PR lists and direct diffs refresh every minute while visible and
when the window regains focus. A failed list refresh keeps the previous result
with an explicit stale notice.

Choose **All states and stack history** to discover open, merged, and closed
GitHub PRs. Base-change events recover dependency links after branches were
deleted or retargeted. Links are candidates until a comparison verifies retained
commit ancestry. Reused branch names, incomplete timelines, or missing
dependencies can make a comparison unavailable. Historical discovery is limited
to 2000 PRs.

The direct diff offers **This layer** and **Stack through this PR**. A layer
starts at its immediate parent's retained head; a cumulative diff starts at the
root PR's recorded base and includes only the selected PR's ancestors, excluding
sibling branches. Historical comparisons reconstruct final retained heads, not
every earlier force-pushed revision. Merge-sync and conflict-resolution changes
can remain. GitLab and Gitea/Forgejo retain open-stack navigation and
comparison; historical discovery currently requires GitHub.

## Stack walkthroughs

An agent can publish one walkthrough across a stack with
`review-canvas stack-publish --input STACK.json --session DIR...`, after it
publishes a round of every layer. The command reads the tip's ancestor path from
the host and passes it to the server with a thread token of each layer's review.
Each step is a tour stop of one layer. The server resolves it against that
layer's current round, so excerpts, notes, inline threads, Viewed marks,
answers, and feedback stay in the per-PR review. Each layer ends with a closing
step for files no step covers. For a branching stack, only the tip's ancestors
are steps; siblings and PRs built on the tip are listed as left out.

`/stacks/ID` shows one step at a time. **Next** marks the step read and moves
across PR boundaries; the step list and **Previous** move without marking. The
server stores the position and read marks, so a reload or another tab resumes at
the same step. A mark records the layer's head and the version of each file the
step covers. When the head or one of those files changes, the step shows
**changed since you read it**. Each layer is pinned to its head and to the
commit its diff starts from: its parent layer's head, or for the root layer, its
merge base with the branch it merges into, which unrelated commits there do not
move. When a layer's review moves to a head or base the walkthrough was not
written for, as after a parent's force-push or a retarget, the layer is stale.
Its steps keep the agent's prose without excerpts until the agent publishes the
walkthrough again. A layer without an open review is missing and appears as a
placeholder step. Republishing a tip's walkthrough replaces the earlier one and
keeps progress on steps the agent left unchanged, following them when steps or
layers before them were added or removed. A stop written twice in one PR keeps
no progress, since which copy the reviewer read is unknown. `--history` builds
the path from merged and closed GitHub PRs' final retained heads, with the
limitations described above. Walkthroughs live in their own table of the same
database; older builds ignore it.
