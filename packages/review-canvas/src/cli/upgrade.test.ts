/** Real daemons and rebuilds, confined to disposable package, socket and database paths. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

const fixture = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-upgrade-"));
  const pkg = join(dir, "package");
  mkdirSync(pkg);
  for (const name of [
    "src",
    "package.json",
    "pnpm-lock.yaml",
    "vite.node.config.ts",
  ])
    cpSync(join(root, name), join(pkg, name), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
  writeFileSync(
    join(pkg, "src/client/main.ts"),
    'import "./test.css"; document.title = "new client";',
  );
  writeFileSync(join(pkg, "src/client/test.css"), "body { color: red; }");
  writeFileSync(
    join(pkg, "vite.config.ts"),
    `export default { publicDir: false, build: { outDir: "dist/client", emptyOutDir: true, manifest: true, rolldownOptions: { input: "src/client/main.ts" } } };`,
  );
  mkdirSync(join(pkg, "dist/client/.vite"), { recursive: true });
  mkdirSync(join(pkg, "dist/client/assets"));
  writeFileSync(join(pkg, "dist/client/assets/old.js"), "// old client");
  writeFileSync(
    join(pkg, "dist/client/.vite/manifest.json"),
    JSON.stringify({
      "src/client/main.ts": { file: "assets/old.js" },
    }),
  );
  const { REVIEW_CANVAS_PORT: _port, ...inherited } = process.env;
  const env = {
    ...inherited,
    REVIEW_CANVAS_RUNTIME: join(dir, "run"),
    REVIEW_CANVAS_DATA: join(dir, "reviews.sqlite"),
  };
  mkdirSync(env.REVIEW_CANVAS_RUNTIME, { mode: 0o700 });
  const node = (args: string[]) =>
    exec(process.execPath, args, { cwd: pkg, env, timeout: 30_000 });
  const helper = (code: string) => node(["--input-type=module", "-e", code]);
  const identity = async () =>
    JSON.parse(
      (
        await helper(
          'import { call } from "./src/cli/socket.ts"; console.log(JSON.stringify(await call("GET", "/agent/server")));',
        )
      ).stdout,
    ).body;
  let server: ChildProcess | undefined;
  let serverError = "";
  t.after(async () => {
    try {
      await helper(
        'import { stopServer, withServerOperation } from "./src/cli/socket.ts"; await withServerOperation(stopServer);',
      );
    } catch {
      /* A legacy fixture is closed below. */
    }
    server?.kill("SIGTERM");
    if (server && server.exitCode === null)
      await new Promise((resolve) => server?.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    pkg,
    env,
    node,
    helper,
    identity,
    start: async (port?: number) => {
      server = spawn(process.execPath, ["src/server/main.ts"], {
        cwd: pkg,
        env: port === undefined ? env : { ...env, REVIEW_CANVAS_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stderr?.on("data", (chunk) => {
        serverError += chunk;
      });
      server.stdout?.on("data", (chunk) => {
        serverError += chunk;
      });
      for (let at = 0; at < 100; at++) {
        try {
          return await identity();
        } catch {
          if (server.exitCode !== null) break;
          await pause();
        }
      }
      assert.fail(`fixture server did not start: ${serverError}`);
    },
  };
};

const get = async (url: string) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, url);
  return response.text();
};

test("a running daemon stops before rebuild, then new code and assets serve the persisted review", async (t) => {
  const f = fixture(t);
  const old = await f.start();
  const registered = JSON.parse(
    (
      await f.node([
        "src/cli/main.ts",
        "register",
        "--session",
        join(f.dir, "session"),
        "--input",
        join(root, "fixtures/input/worktree.json"),
        "--label",
        "Upgrade fixture",
      ])
    ).stdout,
  );
  const before = await get(registered.url);
  assert.match(before, /\/assets\/old.js/);
  assert.equal(
    await get(new URL("/assets/old.js", registered.url).href),
    "// old client",
  );
  // The page normally keeps an SSE connection open for its entire lifetime.
  const events = request(new URL(`${registered.url}/events`));
  const streaming = new Promise<void>((resolve) =>
    events.once("response", (response) => {
      response.on("data", () => resolve());
      response.on("error", () => {}); // Expected when upgrade closes the stream.
    }),
  );
  events.on("error", () => {});
  events.end();
  await streaming;
  t.after(() => events.destroy());
  // An API/page-source change at the same installation path must not reuse the loaded code.
  const home = join(f.pkg, "src/server/pages/home.ts");
  writeFileSync(
    home,
    readFileSync(home, "utf8").replace(
      ">Reviews</h2>",
      ">Upgraded reviews</h2>",
    ),
  );
  await f.node(["src/cli/build.ts"]);
  // Rebuild removed the old hash, after the old daemon relinquished its listeners and store.
  assert.throws(() => readFileSync(join(f.pkg, "dist/client/assets/old.js")), {
    code: "ENOENT",
  });
  await assert.rejects(f.identity());
  const result = await f.node([
    "src/cli/main.ts",
    "register",
    "--session",
    join(f.dir, "session2"),
    "--input",
    join(root, "fixtures/input/worktree.json"),
    "--label",
    "After upgrade",
  ]);
  const current = JSON.parse(result.stdout);
  assert.equal(current.review, registered.review);
  const fresh = await f.identity();
  assert.notEqual(fresh.instance, old.instance);
  assert.notEqual(fresh.revision, old.revision);
  const page = await get(current.url);
  assert.doesNotMatch(page, /\/assets\/old.js/);
  for (const asset of page.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    assert.ok(asset[1] !== undefined);
    await get(new URL(asset[1], current.url).href);
  }
  assert.match(await get(new URL("/", current.url).href), /Upgraded reviews/);
  await f.helper(
    'import { ensureServer } from "./src/cli/socket.ts"; await Promise.all([ensureServer(), ensureServer()]);',
  );
  assert.equal((await f.identity()).instance, fresh.instance);

  writeFileSync(
    home,
    readFileSync(home, "utf8").replace("Upgraded reviews", "Second upgrade"),
  );
  await f.helper(
    'import { ensureServer } from "./src/cli/socket.ts"; await ensureServer();',
  );
  assert.notEqual((await f.identity()).instance, fresh.instance);
});

test("a legacy listener is refused before any asset is removed", async (t) => {
  const f = fixture(t);
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("legacy");
  });
  await new Promise<void>((resolve) =>
    server.listen(join(f.env.REVIEW_CANVAS_RUNTIME, "agent.sock"), resolve),
  );
  // Close before fixture cleanup tries a bounded shutdown.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await assert.rejects(
    f.node(["src/cli/build.ts"]),
    /Stop the older review-canvas server manually/,
  );
  assert.equal(
    readFileSync(join(f.pkg, "dist/client/assets/old.js"), "utf8"),
    "// old client",
  );
  await assert.rejects(
    f.helper(
      'import { ensureServer } from "./src/cli/socket.ts"; await ensureServer();',
    ),
    /cannot safely coordinate this upgrade/,
  );
});

test("a foreground server waits for a concurrent build before reading its manifest", async (t) => {
  const f = fixture(t);
  const gate = join(f.dir, "build-started");
  const release = join(f.dir, "build-release");
  const config = join(f.pkg, "vite.config.ts");
  writeFileSync(
    config,
    `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(gate)}, "ready");
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 50));
${readFileSync(config, "utf8")}`,
  );
  const building = f.node(["src/cli/build.ts"]);
  for (let at = 0; at < 100 && !readable(gate); at++) await pause();
  assert.ok(readable(gate), "build did not reach the gate");
  const starting = f.start();
  try {
    await pause();
    await assert.rejects(f.identity());
  } finally {
    writeFileSync(release, "go");
  }
  await building;
  const identity = await starting;
  assert.equal(identity.ok, true);
  const registered = JSON.parse(
    (
      await f.node([
        "src/cli/main.ts",
        "register",
        "--session",
        join(f.dir, "session"),
        "--input",
        join(root, "fixtures/input/worktree.json"),
        "--label",
        "Concurrent start",
      ])
    ).stdout,
  );
  const page = await get(registered.url);
  assert.doesNotMatch(page, /\/assets\/old.js/);
});

const readable = (path: string) => {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
};

test("a command waits for a daemon finishing teardown after its socket has closed", async (t) => {
  const f = fixture(t);
  const gate = join(f.dir, "teardown-started");
  const release = join(f.dir, "teardown-release");
  const stopping =
    f.helper(`import { StartLock } from "./src/server/runtime.ts";
import { existsSync, writeFileSync } from "node:fs";
const lock = StartLock.try(${JSON.stringify(f.env.REVIEW_CANVAS_RUNTIME)}, "lifetime.lock");
if (lock === undefined) throw new Error("fixture could not take lifetime lock");
writeFileSync(${JSON.stringify(gate)}, "ready");
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 50));
lock.release();`);
  for (let at = 0; at < 100 && !readable(gate); at++) await pause();
  assert.ok(readable(gate));
  const starting = f.helper(
    'import { ensureServer } from "./src/cli/socket.ts"; await ensureServer();',
  );
  try {
    await pause();
    await assert.rejects(f.identity());
  } finally {
    writeFileSync(release, "go");
  }
  await stopping;
  await starting;
  assert.equal((await f.identity()).ok, true);
});

test("a restarted server remembers an explicit port, or follows a new port when the old one is busy", async (t) => {
  const f = fixture(t);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await f.start(address.port);
  const sessionDir = join(f.dir, "session");
  const cli = async (...args: Array<string>) =>
    JSON.parse((await f.node(["src/cli/main.ts", ...args])).stdout);
  const saved = () =>
    JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")).url;
  const stop = () =>
    f.helper(
      'import { stopServer, withServerOperation } from "./src/cli/socket.ts"; await withServerOperation(stopServer);',
    );
  const registered = await cli(
    "register",
    "--session",
    sessionDir,
    "--input",
    join(root, "fixtures/input/worktree.json"),
    "--label",
    "Restart fixture",
  );
  const port = Number(new URL(registered.url).port);
  assert.equal(Number(readFileSync(join(f.env.REVIEW_CANVAS_RUNTIME, "port"), "utf8")), port);

  await stop();
  const same = await cli("status", "--session", sessionDir);
  assert.equal(same.status.url, registered.url);
  await get(same.status.url);

  // Another program took the port while the server was down.
  await stop();
  const squatter = createServer();
  await new Promise<void>((resolve) =>
    squatter.listen(port, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => squatter.close(() => resolve())),
  );
  const moved = await cli("status", "--session", sessionDir);
  assert.notEqual(Number(new URL(moved.status.url).port), port);
  assert.equal(saved(), moved.status.url);
  await get(moved.status.url);
});
