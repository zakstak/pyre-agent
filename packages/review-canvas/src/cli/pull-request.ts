/**
 * Collects a hosted pull request as review input from a local clone that already holds its base and head commits.
 * The host supplies only what the clone cannot: the title, the two commits, the base branch, and the file list to
 * reconcile with. Every patch, fingerprint, and text comes from the clone, read with the collector's hardened Git.
 * Nothing is fetched: a missing commit fails with the command that fetches it.
 */
import * as Result from "effect/Result";
import {
  type CollectOptions,
  collectRange,
  missingCommits,
  type Worktree,
} from "../collector/collect.ts";
import { CollectError } from "../collector/errors.ts";
import { byCodePoint } from "../collector/paths.ts";
import { decodeValue, InputDocument } from "../schema/document.ts";
import { INPUT_FORMAT, type ReviewInput } from "../schema/input.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import { addressOf, readPullRequest, readPullRequestFiles, type ForgeClients } from "./hosted.ts";
import { ForgeFailed } from "./forge-api.ts";

/** Paths that only one side lists, counting a rename's old path, so rename detection that differs still matches. */
export interface Mismatch {
  readonly only_on_github: ReadonlyArray<string>;
  readonly only_in_clone: ReadonlyArray<string>;
  /** GitHub's changed-file count, and the clone's. */
  readonly counts: { readonly github: number | null; readonly clone: number };
}

/**
 * Compares the clone's files with GitHub's list and count. undefined means they agree: the same paths, and as many
 * files as GitHub counts.
 */
export const reconcile = (
  files: ReadonlyArray<{ readonly path: string; readonly old_path?: string }>,
  github: ReadonlyArray<{
    readonly filename: string;
    readonly previous_filename?: string | null | undefined;
  }>,
  changedFiles: number | null,
): Mismatch | undefined => {
  const local = new Set(
    files.flatMap((file) =>
      file.old_path === undefined ? [file.path] : [file.path, file.old_path],
    ),
  );
  const remote = new Set(
    github.flatMap((file) =>
      file.previous_filename == null
        ? [file.filename]
        : [file.filename, file.previous_filename],
    ),
  );
  const only_on_github = [...remote]
    .filter((path) => !local.has(path))
    .sort(byCodePoint);
  const only_in_clone = [...local]
    .filter((path) => !remote.has(path))
    .sort(byCodePoint);
  if (
    only_on_github.length === 0 &&
    only_in_clone.length === 0 &&
    files.length === changedFiles &&
    github.length === changedFiles
  )
    return undefined;
  return {
    only_on_github,
    only_in_clone,
    counts: { github: changedFiles, clone: files.length },
  };
};

/** A word for a POSIX shell: as it is when it holds nothing the shell treats specially, otherwise single-quoted. */
const quoted = (word: string) =>
  /^[A-Za-z0-9_./:@%+=-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'"'"'`)}'`;

export interface CollectedPullRequest {
  readonly review: ReviewInput;
  /** Likely secret files whose contents were left out. */
  readonly flagged: ReadonlyArray<string>;
  readonly mergeBase: string;
  /** The branch the pull request merges into, to tell a stacked layer from one on the default branch. */
  readonly baseRef: string;
  /** The head GitHub showed at the end differs from the one collected. */
  readonly headMoved: boolean;
  readonly mismatch: Mismatch | undefined;
}

/**
 * Collects the pull request at url from the clone in worktree. files_complete is true only when the clone's files
 * match GitHub's list and count and the head did not move meanwhile. Throws CollectError or GitError, and writes
 * nothing.
 */
export const collectPullRequest = (
  worktree: Worktree,
  url: PullRequestUrl,
  clients: ForgeClients,
  options: CollectOptions = {},
): CollectedPullRequest => {
  let before;
  let github;
  try {
    before = readPullRequest(url, clients);
    github = readPullRequestFiles(before.url, clients);
  } catch (error) {
    if (error instanceof ForgeFailed) throw new CollectError({ message: error.message });
    throw error;
  }
  const missing = missingCommits(worktree, [
    before.baseRefOid,
    before.headRefOid,
  ]);
  if (missing.length > 0) {
    const pull = addressOf(before.url);
    const ref = pull.provider === "gitlab" ? `merge-requests/${pull.number}/head` : `pull/${pull.number}/head`;
    throw new CollectError({
      message: `${worktree.top} does not hold ${missing.join(" or ")}. Fetch the pull request's commits, then collect again: git -C ${quoted(worktree.top)} fetch ${quoted(pull.repositoryUrl + ".git")} ${ref} ${quoted(before.baseRefName)}`,
    });
  }
  const range = collectRange(
    worktree,
    { base: before.baseRefOid, head: before.headRefOid },
    options,
  );
  const mismatch = reconcile(range.files, github, before.changedFiles);
  const headMoved = readPullRequest(url, clients).headRefOid !== before.headRefOid;
  const provider = addressOf(before.url).provider;
  const review = decodeValue(InputDocument, {
    format: INPUT_FORMAT,
    target: {
      ...(provider === "github" ? { kind: "github_pr" as const } : { kind: "pull_request" as const, provider }),
      title: options.title ?? before.title,
      url: before.url,
      head_sha: before.headRefOid,
      base_sha: before.baseRefOid,
      ...(before.changedFiles === null ? {} : { changed_files: before.changedFiles }),
    },
    files_complete: mismatch === undefined && !headMoved,
    files: range.files,
  } satisfies typeof ReviewInput.Encoded);
  if (Result.isFailure(review))
    throw new CollectError({ message: review.failure.message });
  return {
    review: review.success,
    flagged: range.flagged,
    mergeBase: range.mergeBase,
    baseRef: before.baseRefName,
    headMoved,
    mismatch,
  };
};
