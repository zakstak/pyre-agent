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
page port; without it, the system picks a free one. `REVIEW_CANVAS_DATA` and
`REVIEW_CANVAS_RUNTIME` move the database and the socket, which is how the
tests and a demo stay out of the real data. GitHub comments are read with `gh`
when it is installed and signed in.

## Layout

| Folder          | What                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `src/schema`    | The input, tour, feedback, and GitHub import formats as Effect Schema, with their limits |
| `src/collector` | The working tree collector and fingerprints                                              |
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
