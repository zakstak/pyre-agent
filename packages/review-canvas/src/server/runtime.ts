/**
 * The runtime folder holds the agent socket, the start lock, and the server log. Agents send inputs and thread tokens
 * through the socket, so the folder must belong to this user and admit nobody else before anything trusts what is in
 * it. Another user could otherwise create the folder first and listen on the socket path.
 */
import { chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export class UnsafeRuntime extends Error {}

const currentUid = (): number => process.getuid?.() ?? -1;

const lstat = (path: string): Stats | undefined =>
  lstatSync(path, { throwIfNoEntry: false });

/**
 * Creates the runtime folder if needed and checks it: a real folder, not a symbolic link, owned by this user, with no
 * access for group or others. A folder this user owns with looser modes is tightened; any other is refused.
 */
export const secureRuntimeDir = (dir: string, uid = currentUid()): void => {
  if (lstat(dir) === undefined)
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstat(dir);
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory())
    throw new UnsafeRuntime(
      `${dir} is not a folder. Remove it, or set REVIEW_CANVAS_RUNTIME.`,
    );
  if (stats.uid !== uid)
    throw new UnsafeRuntime(
      `${dir} belongs to another user, who could impersonate the review server. Remove it, or set REVIEW_CANVAS_RUNTIME.`,
    );
  if ((stats.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    const after = lstat(dir);
    if (after === undefined || (after.mode & 0o077) !== 0 || after.uid !== uid)
      throw new UnsafeRuntime(`${dir} could not be made private.`);
  }
};

/** Refuses a socket path that holds anything but this user's socket. An absent path is fine. */
export const checkSocket = (path: string, uid = currentUid()): void => {
  const stats = lstat(path);
  if (stats === undefined) return;
  if (!stats.isSocket())
    throw new UnsafeRuntime(`${path} is not a socket. Remove it.`);
  if (stats.uid !== uid)
    throw new UnsafeRuntime(`${path} belongs to another user. Remove it.`);
};

/**
 * The start lock: an exclusive SQLite transaction on a file in the runtime folder, held for the server's life. The
 * operating system releases it when the process ends, however it ends, so a crashed server leaves no stale lock. A
 * server holds it while it removes a stale socket and binds a new one, so two starts cannot both bind.
 */
export class StartLock {
  readonly #db: DatabaseSync;
  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Takes the lock, or returns undefined when another server holds it. */
  static try(dir: string): StartLock | undefined {
    const db = new DatabaseSync(join(dir, "server.lock"), { timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return new StartLock(db);
    } catch (error) {
      db.close();
      if (error instanceof Error && /locked|busy/i.test(error.message))
        return undefined;
      throw error;
    }
  }

  release(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
