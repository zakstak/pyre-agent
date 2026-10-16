import { createHash } from "node:crypto";
import { GitError } from "./errors.ts";
import { DIFF_FLAGS, trustedGit } from "./git.ts";
import { decodePath, line, records } from "./paths.ts";
import { Fingerprint } from "../schema/primitives.ts";

/*
 * A fingerprint is the SHA-256 of canonical JSON naming one exact version of one changed file: its path, its old path
 * when renamed, and the Git blob ID and mode on each side. Copy detection is off here and in the collector, so a copy
 * is an added file whose own content and mode the fingerprint covers.
 */

/** A Git object ID: 40 or 64 lowercase hexadecimal digits, never the all-zero ID Git prints for a missing side. */
export type ObjectId = string & { readonly __brand: "ObjectId" };

/** The Git modes of a changed path: a regular or executable file, a symbolic link, or a submodule commit. */
export type FileMode = "100644" | "100755" | "120000" | "160000";

export type ObjectFormat = "sha1" | "sha256";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parses an object ID Git printed. The all-zero ID, which marks a missing side, is null. */
export const objectId = (text: string): ObjectId | null => {
  if (!OBJECT_ID.test(text))
    throw new GitError({
      message: `expected a Git object ID, got ${JSON.stringify(text)}`,
    });
  return /^0+$/.test(text) ? null : (text as ObjectId);
};

/** Parses a mode Git printed. 000000, which marks a missing side, is null. */
export const fileMode = (text: string): FileMode | null => {
  switch (text) {
    case "000000":
      return null;
    case "100644":
    case "100755":
    case "120000":
    case "160000":
      return text;
    default:
      throw new GitError({
        message: `unexpected Git mode ${JSON.stringify(text)}`,
      });
  }
};

export const objectFormat = (text: string): ObjectFormat => {
  if (text === "sha1" || text === "sha256") return text;
  throw new GitError({
    message: `unexpected Git object format ${JSON.stringify(text)}`,
  });
};

export const isRegular = (mode: FileMode | null) =>
  mode === "100644" || mode === "100755";

/** The blob ID Git would give data: a digest, which is never all zeros. */
export const blobId = (format: ObjectFormat, data: Uint8Array): ObjectId =>
  createHash(format)
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex") as ObjectId;

export interface RawChange {
  /** Git's status letter: A, C, D, M, R, T, U, or another Git may add. */
  readonly status: string;
  readonly path: string;
  /** The source of a rename or copy. */
  readonly oldPath: string | null;
  readonly oldMode: FileMode | null;
  readonly newMode: FileMode | null;
  readonly oldBlob: ObjectId | null;
  readonly newBlob: ObjectId | null;
}

/** Parses git diff --raw -z --no-abbrev output. Paths must be valid UTF-8. */
export const rawChanges = (data: Buffer): Array<RawChange> => {
  const fields = records(data);
  const changes: Array<RawChange> = [];
  for (
    let index = 0;
    index < fields.length && (fields[index]?.length ?? 0) > 0;
  ) {
    const [
      oldMode = "",
      newMode = "",
      oldBlob = "",
      newBlob = "",
      status = "",
    ] = (fields[index] ?? Buffer.alloc(0))
      .subarray(1)
      .toString("latin1")
      .split(" ");
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = fields.slice(index + 1, index + 1 + count);
    const [first, last] = [paths[0], paths[count - 1]];
    if (first === undefined || last === undefined)
      throw new GitError({
        message: "git diff --raw output ended inside an entry",
      });
    index += 1 + count;
    changes.push({
      status: status.slice(0, 1),
      path: decodePath(last),
      oldPath: count === 2 ? decodePath(first) : null,
      oldMode: fileMode(oldMode),
      newMode: fileMode(newMode),
      oldBlob: objectId(oldBlob),
      newBlob: objectId(newBlob),
    });
  }
  return changes;
};

/** One version of one changed file. A side or rename source that does not exist is null. */
export interface FileVersion {
  readonly path: string;
  readonly oldPath: string | null;
  readonly oldBlob: ObjectId | null;
  readonly newBlob: ObjectId | null;
  readonly oldMode: FileMode | null;
  readonly newMode: FileMode | null;
}

/** The SHA-256 hex digest of one file version. */
export const fileFingerprint = (version: FileVersion): Fingerprint => {
  // Keys in sorted order, so the JSON matches Python's json.dumps(sort_keys=True) byte for byte.
  const canonical = JSON.stringify({
    new_blob: version.newBlob,
    new_mode: version.newMode,
    old_blob: version.oldBlob,
    old_mode: version.oldMode,
    old_path: version.oldPath,
    path: version.path,
  });
  return Fingerprint.make(
    createHash("sha256").update(canonical, "utf8").digest("hex"),
  );
};

/**
 * The fingerprint of each path changed between the merge base of base and head, and head, as a GitHub PR's "Files
 * changed" shows them, read from a local clone at repo. Throws GitError, or CollectError for a path that is not valid
 * UTF-8.
 */
export const prFingerprints = ({
  repo,
  base,
  head,
}: {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
}): ReadonlyMap<string, Fingerprint> => {
  const git = trustedGit({ repo });
  git.run(repo, ["rev-parse", "--git-dir"]);
  const commit = (ref: string) => {
    try {
      return line(
        git.run(repo, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${ref}^{commit}`,
        ]),
      ).toString();
    } catch (error) {
      if (error instanceof GitError)
        throw new GitError({
          message: `${ref} does not name a commit in ${repo}`,
        });
      throw error;
    }
  };
  const commits = [commit(base), commit(head)] as const;
  let mergeBase: string;
  try {
    mergeBase = line(git.run(repo, ["merge-base", ...commits])).toString();
  } catch (error) {
    if (error instanceof GitError)
      throw new GitError({ message: `${base} and ${head} have no merge base` });
    throw error;
  }
  const changes = rawChanges(
    git.run(repo, [
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      ...DIFF_FLAGS,
      mergeBase,
      commits[1],
      "--",
    ]),
  );
  return new Map(
    changes.map((change) => [change.path, fileFingerprint(change)]),
  );
};
