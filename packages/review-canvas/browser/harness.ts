/**
 * A real server for browser tests: the TypeScript entry with the built page assets, its data and socket in a
 * temporary folder, and helpers that act as an agent over the socket.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const built = existsSync(join(root, "dist/client/.vite/manifest.json"));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
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

export interface Agent {
  readonly review: string;
  readonly url: string;
  readonly token: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<any>;
  readonly publish: (input: unknown) => Promise<any>;
  readonly status: () => Promise<any>;
  readonly answer: (comment: string, answer: unknown) => Promise<any>;
}

export interface Server {
  readonly origin: string;
  readonly register: (input: unknown, label?: string, options?: { readonly fresh?: boolean }) => Promise<Agent>;
  readonly stop: () => Promise<void>;
  /** Starts the server again after stop, on the same port, socket, and database. */
  readonly start: () => Promise<void>;
}

/** Starts a server and waits until it answers on its socket. */
export const startServer = async (options: { readonly repositoryRoots?: ReadonlyArray<string> } = {}): Promise<Server> => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-browser-"));
  const runtime = join(dir, "run");
  const socketPath = join(runtime, "agent.sock");
  const port = await freePort();
  let child: ChildProcess;
  const spawnServer = async () => {
    child = spawn(process.execPath, [join(root, "src/server/main.ts")], {
      env: {
        ...process.env,
        REVIEW_CANVAS_DATA: join(dir, "data/reviews.sqlite"),
        REVIEW_CANVAS_RUNTIME: runtime,
        REVIEW_CANVAS_PORT: String(port),
        REVIEW_CANVAS_REPO_ROOTS: (options.repositoryRoots ?? [dir]).join(delimiter),
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (
      let attempt = 0;
      attempt < 100 && !(await answers(socketPath));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const stop = async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
  };
  await spawnServer();

  const send = (method: string, path: string, body?: unknown, token?: string) =>
    new Promise<any>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: {
            host: "agent",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(token === undefined
              ? {}
              : { authorization: `Bearer ${token}` }),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () => resolve(JSON.parse(text)));
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  return {
    origin: `http://127.0.0.1:${port}`,
    register: async (input: any, label = "Claude Code: browser test", options = {}) => {
      const registered = await send("POST", "/agent/register", {
        target: input.target,
        label,
        host: { kind: "claude-code" },
        ...options,
      });
      if (registered.ok !== true) throw new Error(JSON.stringify(registered));
      const { review, token, url } = registered as {
        review: string;
        token: string;
        url: string;
      };
      const call = (method: string, path: string, body?: unknown) =>
        send(method, `/agent/reviews/${review}${path}`, body, token);
      return {
        review,
        url,
        token,
        call,
        publish: (round: unknown) => call("POST", "/rounds", round),
        status: async () => (await call("GET", "")).status,
        answer: (comment: string, answer: unknown) =>
          call("POST", "/answers", { comment, answer }),
      };
    },
    stop,
    start: spawnServer,
  };
};

let roots = 0;

/** The fixture working tree input, under a root no other test uses, so each test has its own review. */
export const fixtureInput = (): any => {
  const input = JSON.parse(
    readFileSync(join(root, "fixtures/input/worktree.json"), "utf8"),
  );
  input.target.root = `/browser/${process.pid}/${roots++}`;
  input.stops = [
    {
      title: "save() becomes atomic",
      summary: "A temporary file and a rename.",
      attention: { kind: "risk", note: "Same filesystem only." },
      excerpts: [
        {
          path: "src/notes/store.py",
          side: "new",
          start: 11,
          end: 17,
          caption: "The new save",
        },
      ],
      files: [],
      notes: [
        {
          path: "src/notes/store.py",
          line: 13,
          title: "Same directory",
          body: "",
        },
      ],
      questions: ["Should a failed write clean up?"],
    },
    {
      title: "The rename",
      summary: "format.py replaces render.py.",
      attention: null,
      excerpts: [
        {
          path: "src/notes/format.py",
          side: "new",
          start: 5,
          end: 6,
          caption: "",
        },
      ],
      files: [{ path: "src/notes/cli.py" }],
      notes: [
        { path: "src/notes/format.py", line: 6, title: "Dated line", body: "" },
      ],
      questions: [],
    },
  ];
  return input;
};

/** The same input with store.py's patch changed, as a next round after a fix would have it. */
export const changedStore = (input: any): any => ({
  ...input,
  files: input.files.map((file: any) =>
    file.path === "src/notes/store.py"
      ? {
          ...file,
          fingerprint: "1".repeat(64),
          additions: file.additions + 1,
          patch: file.patch.replace(
            "@@ -1,13 +1,19 @@\n import json\n",
            "@@ -1,13 +1,20 @@\n import json\n+import fcntl\n",
          ),
        }
      : file,
  ),
});
