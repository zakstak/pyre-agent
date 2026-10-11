# Review canvas server

A local server for review canvas pages. An Effect v4 server renders every page
as HTML and serves the browser assets that Vite builds with Tailwind and the
shared [internal visual style](../../skills/internal-visual-style/).

It listens on 127.0.0.1 only and answers only requests addressed to `127.0.0.1`
or `localhost` on its own port.

## Use

Node 26 runs the TypeScript source directly, with no build step for the server.

```sh
pnpm install
pnpm build       # browser assets into dist/client
pnpm start       # REVIEW_CANVAS_PORT sets the port; without it, the system picks a free one
```

## Check

```sh
pnpm typecheck   # tsc-rs, with Effect's diagnostics
pnpm test
```
