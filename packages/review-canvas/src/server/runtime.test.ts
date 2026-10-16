import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntry } from "./main.ts";
import {
  checkSocket,
  secureRuntimeDir,
  StartLock,
  UnsafeRuntime,
} from "./runtime.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "review-canvas-runtime-"));
const uid = process.getuid?.() ?? -1;

test("the runtime folder is created private, and a loose one this user owns is tightened", () => {
  const created = join(scratch(), "nested", "run");
  secureRuntimeDir(created);
  assert.equal(statSync(created).mode & 0o777, 0o700);

  const loose = join(scratch(), "run");
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755);
  secureRuntimeDir(loose);
  assert.equal(statSync(loose).mode & 0o777, 0o700);
});

test("a runtime folder another user owns, a link, or a file is refused", () => {
  const foreign = join(scratch(), "run");
  mkdirSync(foreign, { mode: 0o700 });
  // The folder is this user's; claiming another uid stands in for a folder another user created first.
  assert.throws(
    () => secureRuntimeDir(foreign, uid + 1),
    (error: unknown) =>
      error instanceof UnsafeRuntime &&
      /belongs to another user/.test(error.message),
  );

  const real = join(scratch(), "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(scratch(), "link");
  symlinkSync(real, link);
  assert.throws(() => secureRuntimeDir(link), /is not a folder/);

  const file = join(scratch(), "file");
  writeFileSync(file, "");
  assert.throws(() => secureRuntimeDir(file), /is not a folder/);
});

test("the socket path must be absent or this user's socket", () => {
  const dir = scratch();
  checkSocket(join(dir, "absent.sock"));
  writeFileSync(join(dir, "agent.sock"), "");
  assert.throws(() => checkSocket(join(dir, "agent.sock")), /is not a socket/);
});

test("the start lock admits one holder until it is released", () => {
  const dir = scratch();
  const first = StartLock.try(dir);
  assert.ok(first !== undefined);
  assert.equal(StartLock.try(dir), undefined);
  first.release();
  const second = StartLock.try(dir);
  assert.ok(second !== undefined);
  second.release();
});

test("the entry check survives a path with URL characters", () => {
  const path = "/tmp/a#b/c%20d?e/main.ts";
  assert.ok(isEntry(pathToFileURL(path).href, path));
  assert.equal(isEntry(pathToFileURL(path).href, "/tmp/other.ts"), false);
  assert.equal(isEntry(pathToFileURL(path).href, undefined), false);
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

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });

const built = existsSync(
  fileURLToPath(
    new URL("../../dist/client/.vite/manifest.json", import.meta.url),
  ),
);

test(
  "servers started together leave exactly one listening",
  {
    skip: !built && "run pnpm build first: the server serves the built assets",
    timeout: 30_000,
  },
  async () => {
    const dir = scratch();
    const runtime = join(dir, "run");
    // No REVIEW_CANVAS_PORT: each server takes a free page port.
    const { REVIEW_CANVAS_PORT: _port, ...inherited } = process.env;
    const env = {
      ...inherited,
      REVIEW_CANVAS_RUNTIME: runtime,
      REVIEW_CANVAS_DATA: join(dir, "data", "reviews.sqlite"),
    };
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, [main], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // The server logs to stdout and stderr; keep both.
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream
          ?.setEncoding("utf8")
          .on("data", (chunk: string) => (output += chunk));
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      return { child, output: () => output, closed };
    });
    try {
      // Every server but one exits once it finds the winner listening.
      const deadline = Date.now() + 20_000;
      while (
        children.filter(({ child }) => child.exitCode === null).length > 1 &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      const running = children.filter(({ child }) => child.exitCode === null);
      assert.equal(
        running.length,
        1,
        children.map(({ output }) => output()).join("\n"),
      );
      assert.ok(await answers(join(runtime, "agent.sock")));
      for (const { child, output, closed } of children) {
        if (child.exitCode === null) continue;
        await closed;
        assert.match(output(), /already listens/);
      }
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
        await exited(child);
      }
    }
  },
);
