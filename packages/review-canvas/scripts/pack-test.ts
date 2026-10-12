/**
 * Installs the packed tarball as a user would, then runs its command: the help text, a server, a registered review,
 * and the page with its assets. It proves the package works without the TypeScript source. Run after `pnpm build`;
 * npm needs the registry, or a cache that holds the dependencies.
 *
 * Run: pnpm test:pack
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(
  existsSync(join(root, "dist/node/cli.js")) &&
    existsSync(join(root, "dist/client/.vite/manifest.json")),
  "run pnpm build first",
);

const work = mkdtempSync(join(tmpdir(), "review-canvas-pack-"));
execFileSync("pnpm", ["pack", "--pack-destination", work], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
assert.ok(tarball !== undefined, "pnpm pack wrote no tarball");

const app = join(work, "app");
execFileSync("mkdir", [app]);
writeFileSync(
  join(app, "package.json"),
  JSON.stringify({ name: "pack-test", private: true, type: "module" }),
);
execFileSync(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    join(work, tarball),
  ],
  { cwd: app, stdio: ["ignore", "ignore", "inherit"] },
);

const bin = join(app, "node_modules/.bin/review-canvas");
// Only the built JavaScript ships: an installed package cannot run TypeScript from node_modules.
const installed = join(app, "node_modules/@pyre-agent/review-canvas");
assert.ok(!existsSync(join(installed, "src")), "the tarball ships src");
assert.match(
  execFileSync(bin, ["--help"], { encoding: "utf8" }),
  /^review-canvas:/,
);

const { REVIEW_CANVAS_PORT: _port, ...inherited } = process.env;
const env = {
  ...inherited,
  REVIEW_CANVAS_DATA: join(work, "data/reviews.sqlite"),
  REVIEW_CANVAS_RUNTIME: join(work, "run"),
};

const get = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    request(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    })
      .on("error", reject)
      .end();
  });

const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const client = connect(path);
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });

let server: ChildProcess | undefined;
try {
  server = spawn(bin, ["serve"], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Until serve listens, a command would start a server of its own, detached, which would outlive this test.
  const socket = join(work, "run/agent.sock");
  for (let attempt = 0; attempt < 100 && !(await answers(socket)); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await answers(socket), "serve did not start listening");
  const registered = JSON.parse(
    execFileSync(
      bin,
      [
        "register",
        "--session",
        join(work, "session"),
        "--input",
        join(root, "fixtures/input/worktree.json"),
        "--label",
        "Pack test",
      ],
      { env, encoding: "utf8" },
    ),
  ) as { url: string };
  execFileSync(
    bin,
    [
      "publish",
      "--session",
      join(work, "session"),
      "--input",
      join(root, "fixtures/input/worktree.json"),
      "--no-github",
    ],
    { env, encoding: "utf8" },
  );
  const page = await get(registered.url);
  assert.equal(page.status, 200);
  assert.match(page.body, /Write notes atomically/);
  const stylesheet = /<link rel="stylesheet" href="([^"]+)">/.exec(
    page.body,
  )?.[1];
  assert.ok(stylesheet !== undefined, "the page links no stylesheet");
  assert.equal(
    (await get(new URL(stylesheet, registered.url).href)).status,
    200,
  );
  console.log(`The packed tarball installs and serves a review: ${tarball}`);
} finally {
  server?.kill("SIGTERM");
}
