# Review canvas server

A local server where a reviewer walks an agent's change as a guided tour,
comments on lines or asks questions, approves files, and finishes with a
verdict, and where the agent answers. An Effect v4 server renders every page as
HTML, keeps every review in SQLite, and serves the browser assets that Vite
builds with Tailwind and the shared
[internal visual style](../../skills/internal-visual-style/). The
[review-canvas skill](../../skills/review-canvas/SKILL.md) tells an agent how to
use it.

Pages listen on 127.0.0.1 only and answer only requests addressed to
`127.0.0.1` or `localhost` on the server's port. Agents use a Unix socket in a
private runtime folder.

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

The package's `bin` is the built command in `dist/node`, so
`pnpm link --global` needs `pnpm build` first. An installed package runs only
that JavaScript: Node refuses to strip types from files under `node_modules`.
Nothing is published to npm.

The first command that needs the server starts it in the background;
`pnpm start` runs it in the foreground instead. `REVIEW_CANVAS_PORT` sets the
page port; without it, the server asks for the port the last server used, so
open pages reconnect, and takes a free one when that port is busy. `REVIEW_CANVAS_DATA` and
`REVIEW_CANVAS_RUNTIME` move the database and the socket, which is how the
tests and a demo stay out of the real data. GitHub comments are read with `gh`
when it is installed and signed in.

Commands reuse a daemon only when its code and asset manifest match the current
installation. `pnpm build` and the skill launcher stop the daemon and wait for
its store to close before replacing assets; starts wait until the build ends.
Open pages disconnect during an upgrade and can be reopened at the URL the next
command returns. A daemon from before this lifecycle protocol must be stopped
manually once: the command refuses the upgrade and leaves its assets intact.
Use `pnpm build` instead of invoking Vite directly to retain this coordination.

`collect --pr URL --repo CLONE` collects a pull request from a local clone
that holds its base and head commits. It reads the title, commits, and file list
with `gh`, run outside the clone, and the patches and texts from the clone. It
does not fetch; a missing commit fails with the `git fetch` command to run.

Collection scans both patches and requested full-file content for recognized
secret patterns. A match omits that file's content and reports its path;
`--include-secret PATH` explicitly allows it, while `--no-content` collects only
patches. The detector does not recognize every possible secret format.

## Repository monitoring

The home page groups discovered local Git working trees into repositories.
**Add to monitoring** accepts a repository across its discovered copies. Discovery and review registration do not add
repositories to monitoring. Accepted repository identities persist in the review
database. **Remove** stops monitoring a repository without deleting its reviews.

Each repository has one entry, with its local clones and worktrees under
**Checkouts**. SSH and HTTPS remotes for the same host and project identify the
same repository. Credentials are omitted. GitHub project names are compared
without case; other hosts keep their path case. Nonstandard ports and different
fork owners remain separate. The `origin` remote is preferred, or the sole remote
when there is no `origin`. Local clone sources are followed without adding their
directories to the scan. Repositories without a usable remote use their common
Git directory, so unrelated projects with the same folder name stay separate.

Acceptance applies to all discovered copies of that repository, including copies
found by later scans. Counts and acceptance actions refer to repositories;
paths, branches, and working-tree status belong to individual checkouts.
PR reviews link from the repository entry identified by their GitHub URL;
working-tree reviews link from their checkout. Removing monitoring keeps those reviews.

Filter by name, path, or branch, and select **Monitored**, **Discovered**,
**With changes**, or **Unavailable**. Filters stay in the page URL across
refreshes. Accepted repositories show their current branch and count of changed
items for each checkout when you open or refresh the page. Untracked directories count as one
item; submodule changes are excluded. This does not start background Git watchers.

The default scan covers the launch repository or directory and existing `~/git` and `~/dev`
directories. Use **Scan directories** to choose another absolute directory.
`REVIEW_CANVAS_REPO_ROOTS` overrides the defaults with a platform-separated list
of absolute directories (`:` on Linux and macOS). Scans descend up to four
levels, stop at working tree roots, and skip hidden directories, symlinks, and
build and dependency folders. Size and time limits appear in the scan details.
Each Git status read has a timeout and output limit; failures show **Unavailable**.
Scans and status reads do not fetch from remotes or write to repository indexes.

Existing version 2 and 3 databases upgrade in place, preserving reviews and
rounds. Earlier checkout acceptances are converted to repository identities.
Missing accepted paths remain visible until they can be identified again.
Earlier server builds cannot read the upgraded database.

## Layout

| Folder          | What                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `src/schema`    | The input, tour, feedback, and GitHub import formats as Effect Schema, with their limits |
| `src/collector` | The working tree and commit range collectors, and fingerprints                           |
| `src/review`    | Pure review logic: patch rows, anchors, the tour view, every action, and imports         |
| `src/store`     | SQLite through `node:sqlite`: reviews, rounds, threads, revisions, change listeners      |
| `src/server`    | The page routes, the agent API, server-sent events, page rendering, and lifecycle        |
| `src/client`    | The browser modules: tour navigation, selection and composers, live refresh              |
| `src/cli`       | The `review-canvas` command, and reading pull request comments with `gh`                 |
| `browser`       | Browser tests in Chromium against a real server                                          |
| `scripts`       | The packed tarball test, and the live GitHub import test                                 |

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
