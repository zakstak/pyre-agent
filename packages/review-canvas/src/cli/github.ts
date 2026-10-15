/**
 * Reads a pull request's comments with `gh`, the GitHub CLI the user already signed in to. Nothing here posts to
 * GitHub. The comments go to the server as data; their bodies are third-party text.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { openWorktree } from "../collector/collect.ts";
import {
  type GitHubImport,
  GitHubImport as GitHubImportSchema,
} from "../schema/github.ts";
import * as Limits from "../schema/limits.ts";
import type { Target } from "../schema/target.ts";
import { parsePullRequest } from "../schema/forge-url.ts";
import type { Forge } from "../schema/forge-url.ts";
import { remoteAddress } from "../server/repositories.ts";

/** Runs gh with arguments in a folder, and returns its standard output, or throws a GhFailed with its message. */
export type Gh = (args: ReadonlyArray<string>, cwd?: string) => string;

export class GhFailed extends Error {}

/**
 * Runs gh outside any repository. gh runs Git where it starts, and Git reads the repository's own configuration,
 * which can run commands; the reviewed repository is not trusted that far, so gh never starts in it.
 */
export const runGh: Gh = (args, cwd = tmpdir()) => {
  const result = spawnSync("gh", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    timeout: 30_000,
  });
  if (result.error !== undefined)
    throw new GhFailed(
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "gh is not installed"
        : result.error.message,
    );
  if (result.status !== 0)
    throw new GhFailed(
      (result.stderr || `gh exited with ${result.status}`).trim(),
    );
  return result.stdout;
};

export type PullRequestFound =
  | { readonly kind: "found"; readonly url: string }
  | { readonly kind: "none"; readonly reason: string };

/** Where a working tree's branch lives on GitHub, or why it has no such place. */
export type BranchHome =
  | { readonly kind: Forge; readonly repo: string; readonly branch: string }
  | { readonly kind: "none"; readonly reason: string };

/** A clone URL alone cannot distinguish self-hosted APIs. Bind each private host to its configured provider. */
export const forgeRemote = (url: string, configured = process.env.REVIEW_CANVAS_FORGE_HOSTS): { readonly kind: Forge; readonly repo: string } | undefined => {
  const address = remoteAddress(url);
  if (address === null) return undefined;
  const at = address.indexOf("/");
  const host = address.slice(0, at);
  const repository = address.slice(at + 1);
  const settings = configured === undefined ? {} : Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Literals(["github", "gitlab", "gitea"])))(JSON.parse(configured));
  const provider = settings[host] ?? (host === "github.com" || host === process.env.GH_HOST ? "github" : host === "gitlab.com" ? "gitlab" : host === "codeberg.org" ? "gitea" : undefined);
  if (provider === undefined) return undefined;
  // A custom SSH port does not establish where that host serves HTTPS.
  if (url.startsWith("ssh://") && new URL(url).port !== "" && new URL(url).port !== "22") return undefined;
  const route = provider === "github" ? "pull" : provider === "gitlab" ? "-/merge_requests" : "pulls";
  if (parsePullRequest(`https://${host}/${repository}/${route}/1`) === undefined) return undefined;
  return { kind: provider, repo: `https://${host}/${repository}` };
};

/**
 * The branch's upstream on GitHub, read with the collector's hardened Git, which ignores the configuration that
 * could run commands. Without an upstream, the branch of the same name on origin.
 */
export const branchHome = (root: string): BranchHome => {
  let worktree;
  try {
    worktree = openWorktree({ repo: root });
  } catch (error) {
    return {
      kind: "none",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const git = (args: ReadonlyArray<string>) => {
    try {
      return worktree.git
        .run(worktree.top, [...worktree.config, ...args])
        .toString("utf8")
        .trim();
    } catch {
      return undefined;
    }
  };
  const local = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (local === undefined || local === "")
    return {
      kind: "none",
      reason: "the working tree has no branch checked out",
    };
  const upstream = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const remote = upstream?.split("/")[0] ?? "origin";
  const branch =
    upstream === undefined ? local : upstream.slice(remote.length + 1);
  const url = git(["config", "--get", `remote.${remote}.url`]);
  const home = url === undefined ? undefined : forgeRemote(url);
  return home === undefined
    ? { kind: "none", reason: `the remote ${remote} has no configured review provider; collect an explicit --pr URL or set REVIEW_CANVAS_FORGE_HOSTS` }
    : { ...home, branch };
};

/** The pull request whose comments a review imports: the target's, or the open one of the working tree's branch. */
export const findPullRequest = (
  target: Target,
  gh: Gh,
  home: (root: string) => BranchHome = branchHome,
): PullRequestFound => {
  if (target.kind !== "worktree") return { kind: "found", url: target.url };
  const found = home(target.root);
  if (found.kind === "none") return found;
  if (found.kind !== "github") return { kind: "none", reason: "This branch uses another review provider." };
  let answer: Array<{ url?: unknown }>;
  try {
    answer = JSON.parse(
      gh([
        "pr",
        "list",
        "--repo",
        found.repo,
        "--head",
        found.branch,
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
      ]),
    );
  } catch (error) {
    return {
      kind: "none",
      reason: `gh could not list pull requests (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const url = answer[0]?.url;
  return typeof url === "string"
    ? { kind: "found", url }
    : {
        kind: "none",
        reason: `no open pull request for ${found.branch} in ${found.repo}`,
      };
};


interface Page<T> {
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
  readonly nodes: ReadonlyArray<T>;
}

type Side = "LEFT" | "RIGHT";

interface Post {
  readonly id: string;
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
}

/**
 * A review thread. `originalStartLine` numbers the first line in the diff hunk, which is from the commit the comment
 * was written on; `line` is the last line at the head, null once outdated. GitHub's `startLine` is not used: it is
 * null once outdated, and is not always moved with the code while the thread is current.
 */
interface ThreadNode {
  readonly isResolved: boolean;
  readonly path: string;
  readonly diffSide: Side;
  readonly startDiffSide: Side | null;
  readonly originalStartLine: number | null;
  readonly line: number | null;
  readonly comments: {
    readonly nodes: ReadonlyArray<Post & { readonly diffHunk: string }>;
  };
}

const POST = "id author { login } body createdAt url";

const QUERIES = {
  reviewThreads: `isResolved path diffSide startDiffSide originalStartLine line comments(first: 100) { nodes { ${POST} diffHunk } }`,
  comments: POST,
  reviews: POST,
} as const;

type Connection = keyof typeof QUERIES;

/** Every node of one connection of the pull request, page by page, and each head the pages saw. */
const readAll = <T>(
  gh: Gh,
  pr: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly number: number;
  },
  connection: Connection,
): { readonly nodes: Array<T>; readonly heads: Set<string> } => {
  const nodes: Array<T> = [];
  const heads = new Set<string>();
  let after: string | null = null;
  do {
    const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid
    ${connection}(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${QUERIES[connection]} } }
  } }
}`;
    const args: ReadonlyArray<string> = [
      "api",
      "graphql",
      "--hostname",
      pr.host,
      "-f",
      `query=${query}`,
      "-F",
      `owner=${pr.owner}`,
      "-F",
      `name=${pr.name}`,
      "-F",
      `number=${pr.number}`,
      ...(after === null ? [] : ["-f", `after=${after}`]),
    ];
    const pullRequest = (
      JSON.parse(gh(args)) as {
        data: {
          repository: {
            pullRequest: Record<Connection, Page<T>> & { headRefOid: string };
          };
        };
      }
    ).data.repository.pullRequest;
    const page = pullRequest[connection];
    heads.add(pullRequest.headRefOid);
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null && nodes.length < Limits.MAX_COMMENTS);
  return { nodes, heads };
};

const REFUSED = new RegExp(Limits.REFUSED_CONTROL_CHARACTERS.source, "g");

/** GitHub text as the schemas take it: refused control characters and broken surrogates become replacement marks. */
export const cleanBody = (text: string): string =>
  text
    .toWellFormed()
    .replace(REFUSED, "�")
    .slice(0, Limits.MAX_GITHUB_BODY_UNITS);

const time = (at: string) => new Date(at).toISOString();

const post = (node: Post) => ({
  id: node.id,
  author: node.author?.login ?? null,
  url: node.url,
  body: cleanBody(node.body),
  created_at: time(node.createdAt),
});

/**
 * The pull request's comments as the server imports them: review threads with their replies, conversation comments,
 * and review summaries that say something. A review with an empty summary only carries inline comments. The head is
 * given only when every page of threads saw the same one, so the threads' lines are all on it.
 */
export const readComments = (url: string, gh: Gh): GitHubImport => {
  const pull = parsePullRequest(url);
  if (pull === undefined || pull.provider !== "github") throw new GhFailed(`${url} is not a GitHub pull request URL`);
  const [owner, name] = pull.repository.split("/");
  const pr = {
    host: pull.host,
    owner: owner ?? "",
    name: name ?? "",
    number: Number(pull.number),
  };
  // Plain values until the schema checks and brands them below.
  const items: Array<Record<string, unknown>> = [];
  const threads = readAll<ThreadNode>(gh, pr, "reviewThreads");
  for (const thread of threads.nodes) {
    const [first, ...replies] = thread.comments.nodes;
    if (first === undefined || first.diffHunk === "") continue;
    const start = thread.originalStartLine;
    items.push({
      kind: "thread",
      ...post(first),
      resolved: thread.isResolved,
      path: thread.path,
      side: thread.diffSide,
      ...(start === null ? {} : { start_line: start }),
      ...(start === null ||
      thread.startDiffSide === null ||
      thread.startDiffSide === thread.diffSide
        ? {}
        : { start_side: thread.startDiffSide }),
      ...(thread.line === null ? {} : { line: thread.line }),
      diff_hunk: cleanBody(first.diffHunk),
      replies: replies.map(post),
    });
  }
  for (const node of readAll<Post>(gh, pr, "comments").nodes)
    items.push({ kind: "conversation", ...post(node) });
  for (const node of readAll<Post>(gh, pr, "reviews").nodes)
    if (node.body.trim() !== "") items.push({ kind: "review", ...post(node) });
  const [head, ...others] = threads.heads;
  const decoded = Schema.decodeUnknownResult(GitHubImportSchema)({
    pull_request: url,
    ...(head === undefined || others.length > 0 ? {} : { head_sha: head }),
    items: items.slice(0, Limits.MAX_COMMENTS),
  });
  if (Result.isFailure(decoded))
    throw new GhFailed(
      `GitHub returned comments this version cannot read: ${decoded.failure.message}`,
    );
  return decoded.success;
};
