# Review canvas server

A local server where a reviewer walks an agent's change as a guided tour,
comments on lines, approves files, and finishes with a verdict, and where the
agent answers. An Effect v4 server renders every page as HTML, keeps every
review in SQLite, and serves the browser assets that Vite builds with Tailwind
and the shared [internal visual style](../../skills/internal-visual-style/).
The [review-canvas skill](../../skills/review-canvas/SKILL.md) tells an agent
how to use it.

Pages listen on 127.0.0.1 only and answer only requests addressed to
`127.0.0.1` or `localhost` on the server's port. Agents use a Unix socket.

## Use

Node 26 runs the TypeScript source directly, with no build step for the server
or the command-line tool.

```sh
pnpm install
pnpm build                       # browser assets into dist/client
pnpm cli -- --help               # the agent's commands
pnpm cli -- collect --repo /path/to/repo --output /tmp/review/round-1.json
pnpm cli -- register --session /tmp/review --input /tmp/review/round-1.json --label "Claude Code: my change"
pnpm cli -- publish --session /tmp/review --input /tmp/review/round-1.json
```

The first command that needs the server starts it in the background; `pnpm
start` runs it in the foreground instead. `REVIEW_CANVAS_PORT` sets the page
port; without it, the system picks a free one. `REVIEW_CANVAS_DATA` and
`REVIEW_CANVAS_RUNTIME` move the database and the socket, which is how the
tests and a demo stay out of the real data.

## Layout

| Folder          | What                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| `src/schema`    | The input, tour, and feedback formats as Effect Schema, with their limits           |
| `src/collector` | The working tree collector and fingerprints                                         |
| `src/review`    | Pure review logic: patch rows, anchors and attachments, the tour view, every action |
| `src/store`     | SQLite through `node:sqlite`: reviews, rounds, threads, revisions, change listeners |
| `src/server`    | The page routes, the agent API, server-sent events, page rendering, and lifecycle   |
| `src/client`    | The browser modules: tour navigation, line selection and composers, live refresh    |
| `src/cli`       | The `review-canvas` command                                                         |

## Check

```sh
pnpm typecheck   # tsc-rs, with Effect's diagnostics
pnpm test
```
