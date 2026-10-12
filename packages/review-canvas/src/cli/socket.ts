/** Calls to the server over its Unix socket, and starting the server when none answers. */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { runtimeDir, socketPath } from "../server/paths.ts";
import { serverEntry } from "../server/install.ts";
import { checkSocket, secureRuntimeDir } from "../server/runtime.ts";

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

/**
 * Starts the server in the background when none answers on the socket, and waits for it. Its output goes to
 * server.log in the runtime folder.
 */
export const ensureServer = async (): Promise<void> => {
  // Before any connection: a listener in a folder another user controls could be an impostor collecting tokens.
  const dir = runtimeDir();
  secureRuntimeDir(dir);
  checkSocket(socketPath());
  if (await answering()) return;
  const log = openSync(`${dir}/server.log`, "a", 0o600);
  const main = serverEntry();
  const child = spawn(process.execPath, [main], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    await sleep(100);
    if (await answering()) return;
  }
  throw new Error(`The server did not start. See ${dir}/server.log.`);
};
