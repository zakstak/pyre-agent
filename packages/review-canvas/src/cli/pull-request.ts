/**
 * Collects a GitHub pull request as review input from a local clone that already holds its base and head commits.
 * GitHub supplies only what the clone cannot: the title, the two commits, the base branch, and the file list to
 * reconcile with. Every patch, fingerprint, and text comes from the clone, read with the collector's hardened Git.
 * Nothing is fetched: a missing commit fails with the command that fetches it.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
import { CommitSha, PullRequestUrl } from "../schema/primitives.ts";
import { GhFailed, type Gh } from "./github.ts";

const PullRequestView = Schema.Struct({
  title: Schema.String,
  url: PullRequestUrl,
  baseRefOid: CommitSha,
  headRefOid: CommitSha,
  baseRefName: Schema.String,
  changedFiles: Schema.Number,
});
type PullRequestView = typeof PullRequestView.Type;

const ChangedFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
});

const decoded = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  value: unknown,
  what: string,
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(result))
    throw new CollectError({
      message: `gh returned ${what} this command cannot read: ${result.failure.message}`,
    });
  return result.success;
};

/** Runs gh, turning its failure into a CollectError that says what was being read. */
const ask = (gh: Gh, args: ReadonlyArray<string>, what: string) => {
  try {
    return gh(args);
  } catch (error) {
    if (error instanceof GhFailed)
      throw new CollectError({
        message: `cannot read ${what} with gh: ${error.message}`,
      });
    throw error;
  }
};

const view = (gh: Gh, url: PullRequestUrl): PullRequestView => {
  const text = ask(
    gh,
    [
      "pr",
      "view",
      url,
      "--json",
      "title,url,baseRefOid,headRefOid,baseRefName,changedFiles",
    ],
    url,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CollectError({ message: `gh pr view did not print JSON` });
  }
  return decoded(PullRequestView, raw, "a pull request");
};

/** GitHub's file list, which its API caps at 3,000 files: each path, and a renamed file's old path. */
const gitHubFiles = (gh: Gh, url: PullRequestUrl) => {
  const [, owner, repo, number] =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)$/.exec(url) ?? [];
  const text = ask(
    gh,
    [
      "api",
      "--paginate",
      `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      "--jq",
      ".[] | {filename, previous_filename}",
    ],
    `the files of ${url}`,
  );
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new CollectError({
          message: `gh api did not print one JSON file per line`,
        });
      }
      return decoded(ChangedFile, raw, "a changed file");
    });
};

/** Paths that only one side lists, counting a rename's old path, so rename detection that differs still matches. */
export interface Mismatch {
  readonly only_on_github: ReadonlyArray<string>;
  readonly only_in_clone: ReadonlyArray<string>;
  /** GitHub's changed-file count, and the clone's. */
  readonly counts: { readonly github: number; readonly clone: number };
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
  changedFiles: number,
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
  gh: Gh,
  options: CollectOptions = {},
): CollectedPullRequest => {
  const before = view(gh, url);
  const github = gitHubFiles(gh, before.url);
  const missing = missingCommits(worktree, [
    before.baseRefOid,
    before.headRefOid,
  ]);
  if (missing.length > 0) {
    const [, repo, number] =
      /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/([0-9]+)$/.exec(
        before.url,
      ) ?? [];
    throw new CollectError({
      message: `${worktree.top} does not hold ${missing.join(" or ")}. Fetch the pull request's commits, then collect again: git -C ${quoted(worktree.top)} fetch ${repo}.git pull/${number}/head ${quoted(before.baseRefName)}`,
    });
  }
  const range = collectRange(
    worktree,
    { base: before.baseRefOid, head: before.headRefOid },
    options,
  );
  const mismatch = reconcile(range.files, github, before.changedFiles);
  const headMoved = view(gh, url).headRefOid !== before.headRefOid;
  const review = decodeValue(InputDocument, {
    format: INPUT_FORMAT,
    target: {
      kind: "github_pr",
      title: options.title ?? before.title,
      url: before.url,
      head_sha: before.headRefOid,
      base_sha: before.baseRefOid,
      changed_files: before.changedFiles,
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
