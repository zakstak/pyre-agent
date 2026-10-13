/** Calls to the server over its Unix socket, and starting the server when none answers. */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { Result, Schema } from "effect";
import { installedRevision, ServerIdentity } from "../server/identity.ts";
import { runtimeDir, socketPath } from "../server/paths.ts";
import { withServerOperation } from "../server/operation.ts";
export { withServerOperation } from "../server/operation.ts";
import { serverEntry } from "../server/install.ts";
import { checkSocket, StartLock } from "../server/runtime.ts";

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

export class ServerError extends Error {
  readonly status: number;
  readonly kind: string;
  constructor(status: number, kind: string, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export const call = (
  method: "GET" | "POST",
  path: string,
  options: {
    readonly body?: Uint8Array | string;
    readonly token?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: "review-canvas" };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.token !== undefined)
      headers.authorization = `Bearer ${options.token}`;
    const req = request(
      {
        socketPath: socketPath(),
        method,
        path,
        headers,
        timeout: options.timeoutMs ?? 30_000,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("The server did not answer in time.")),
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

/** A call whose answer must say ok; otherwise the server's refusal becomes the error. */
export const expectOk = async <T extends { readonly ok: true }>(
  reply: Reply,
): Promise<T> => {
  const body = reply.body as
    | { ok?: boolean; error?: { kind?: string; message?: string } }
    | string;
  if (typeof body === "object" && body.ok === true) return body as T;
  const error = typeof body === "object" ? body.error : undefined;
  throw new ServerError(
    reply.status,
    error?.kind ?? "unknown",
    error?.message ??
      `The server answered ${reply.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
};

const answering = () =>
  new Promise<boolean>((resolve) => {
    const client = connect(socketPath());
    client.once("connect", () => {
      client.end();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const listeningIdentity = async () => {
  checkSocket(socketPath());
  if (!(await answering())) return undefined;
  const reply = await call("GET", "/agent/server", { timeoutMs: 2000 });
  const decoded = Schema.decodeUnknownResult(ServerIdentity)(reply.body);
  if (reply.status !== 200 || Result.isFailure(decoded))
    throw new Error(
      `The server at ${socketPath()} cannot safely coordinate this upgrade. Stop the older review-canvas server manually, then retry. Its assets have not been rebuilt.`,
    );
  return decoded.success;
};

/** Caller holds withServerOperation through the ensuing build or start. */
export const stopServer = async (): Promise<void> => {
  let identity = await listeningIdentity();
  for (let attempt = 0; identity === undefined && attempt < 100; attempt++) {
    const lock = StartLock.try(runtimeDir());
    if (lock !== undefined) {
      lock.release();
      const lifetime = StartLock.try(runtimeDir(), "lifetime.lock");
      if (lifetime !== undefined) {
        lifetime.release();
        return;
      }
    }
    await sleep(100);
    identity = await listeningIdentity();
  }
  if (identity === undefined)
    throw new Error(
      "A server is still starting; its assets have not been rebuilt. Retry the command.",
    );
  await expectOk(
    await call("POST", "/agent/server/stop", {
      body: JSON.stringify({ instance: identity.instance }),
      timeoutMs: 2000,
    }),
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await answering())) {
      // The agent listener can close before the pages and store. Wait for the outer lifetime scope too.
      const lock = StartLock.try(runtimeDir());
      if (lock !== undefined) {
        lock.release();
        const lifetime = StartLock.try(runtimeDir(), "lifetime.lock");
        if (lifetime !== undefined) {
          lifetime.release();
          return;
        }
      }
    }
    await sleep(100);
  }
  throw new Error(
    `The server did not stop. Its assets have not been rebuilt. See ${runtimeDir()}/server.log.`,
  );
};

/** Reuses only a daemon running this installed code and manifest; replaces older daemons before reconnecting. */
export const ensureServer = async (): Promise<void> =>
  withServerOperation(async () => {
    const dir = runtimeDir();
    const revision = installedRevision();
    const identity = await listeningIdentity();
    if (identity?.revision === revision) return;
    await stopServer();
    const log = openSync(`${dir}/server.log`, "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [serverEntry(), "--coordinated-start"],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: process.env,
        },
      );
      child.unref();
    } finally {
      closeSync(log);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      await sleep(100);
      const started = await listeningIdentity();
      if (started?.revision === revision) return;
      if (started !== undefined)
        throw new Error(
          "The installation changed while the server started; retry the command.",
        );
    }
    throw new Error(`The server did not start. See ${dir}/server.log.`);
  });
