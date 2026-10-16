/** Where the server keeps its database and its socket, on Linux and macOS. */
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const env = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** The database: `${XDG_DATA_HOME:-~/.local/share}/review-canvas/reviews.sqlite`. */
export const databasePath = () =>
  env("REVIEW_CANVAS_DATA") ??
  join(
    env("XDG_DATA_HOME") ?? join(homedir(), ".local", "share"),
    "review-canvas",
    "reviews.sqlite",
  );

/**
 * The folder for the agent socket: `$XDG_RUNTIME_DIR/review-canvas` on Linux, `$TMPDIR/review-canvas` on macOS.
 * Unix socket paths are limited to about 104 bytes, so the folder stays short.
 */
export const runtimeDir = () => {
  const explicit = env("REVIEW_CANVAS_RUNTIME");
  if (explicit !== undefined) return explicit;
  if (platform() === "darwin")
    return join(env("TMPDIR") ?? "/tmp", "review-canvas");
  const runtime = env("XDG_RUNTIME_DIR");
  return runtime === undefined
    ? join("/tmp", `review-canvas-${userInfo().uid}`)
    : join(runtime, "review-canvas");
};

export const socketPath = () => join(runtimeDir(), "agent.sock");

/** The page port the last server listened on, which the next one asks for so open pages find it again. */
export const portPath = () => join(runtimeDir(), "port");

/** The idle time after which the server stops, in minutes. */
export const idleMinutes = () =>
  Number(env("REVIEW_CANVAS_IDLE_MINUTES") ?? "240") || 240;
