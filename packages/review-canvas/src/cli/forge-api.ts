/** Read-only HTTPS API requests, authenticated by Git's existing helper for that exact host and repository. */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gitEnvironment, trustedPath } from "../collector/git.ts";
import type { PullRequestAddress } from "../schema/forge-url.ts";

export class ForgeFailed extends Error {}
export type ForgeApi = (pull: PullRequestAddress, path: string) => unknown;

/** Refuse helpers that return another host's credentials, and values unsafe in an HTTP header. */
export const credentialPassword = (
  raw: string,
  pull: PullRequestAddress,
): string | undefined => {
  const fields = new Map(
    raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
  if (
    fields.get("protocol") !== "https" ||
    fields.get("host") !== pull.host ||
    (fields.has("path") &&
      fields.get("path") !== pull.repository &&
      fields.get("path") !== `${pull.repository}.git`)
  )
    throw new ForgeFailed(
      `The credential helper returned a different HTTPS host or repository for ${pull.host}.`,
    );
  const password = fields.get("password");
  if (password === undefined || password === "") return undefined;
  if (!/^[\x21-\x7e]+$/.test(password))
    throw new ForgeFailed(
      "The credential helper returned an invalid API token.",
    );
  return password;
};

const tokenFor = (pull: PullRequestAddress): string | undefined => {
  for (const path of [`${pull.repository}.git`, pull.repository]) {
    const result = spawnSync(
      "git",
      ["-c", "credential.interactive=false", "credential", "fill"],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        input: `protocol=https\nhost=${pull.host}\npath=${path}\n\n`,
        env: gitEnvironment({
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "false",
          SSH_ASKPASS: "false",
        }),
      },
    );
    if (result.error !== undefined || result.status !== 0) continue;
    const token = credentialPassword(result.stdout, pull);
    if (token !== undefined) return token;
  }
  return undefined;
};

/** curl reads its authorization header from stdin: tokens never enter argv, logs, or review documents. */
export const readForgeApi: ForgeApi = (pull, path) => {
  const prefix = pull.provider === "gitlab" ? "/api/v4/" : "/api/v1/";
  if (
    !path.startsWith(prefix) ||
    /[\r\n\\]/.test(path) ||
    new URL(path, pull.origin).origin !== pull.origin
  )
    throw new ForgeFailed(
      "An API request tried to leave the selected git host.",
    );
  const token = tokenFor(pull);
  const header =
    token === undefined
      ? ""
      : pull.provider === "gitlab"
        ? `PRIVATE-TOKEN: ${token}\n`
        : `Authorization: token ${token}\n`;
  const result = spawnSync(
    "curl",
    [
      "--disable",
      "--header",
      "@-",
      "--silent",
      "--show-error",
      "--fail",
      "--proto",
      "=https",
      "--max-time",
      "30",
      "--max-redirs",
      "0",
      "--write-out",
      "\n%{http_code}",
      "--url",
      `${pull.origin}${path}`,
    ],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 35_000,
      maxBuffer: 64 * 1024 * 1024,
      input: header,
      env: { ...process.env, PATH: trustedPath() },
    },
  );
  if (result.error !== undefined || result.status !== 0)
    throw new ForgeFailed(
      `Cannot read ${pull.host}${path.split("?")[0]}. Check HTTPS trust and the existing Git credential helper's API access; curl exited ${result.status ?? "before starting"}.`,
    );
  const split = result.stdout.lastIndexOf("\n");
  if (result.stdout.slice(split + 1) !== "200")
    throw new ForgeFailed(
      `${pull.host} refused the API request or redirected it. Select the final HTTPS host explicitly.`,
    );
  try {
    return JSON.parse(result.stdout.slice(0, split));
  } catch {
    throw new ForgeFailed(`${pull.host} did not return JSON.`);
  }
};
