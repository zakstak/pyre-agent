/** Provider adapters share validated review data; the collector remains offline. */
import { Result, Schema } from "effect";
import { OpenPullRequest } from "../schema/pull-requests.ts";
import {
  parsePullRequest,
  type PullRequestAddress,
} from "../schema/forge-url.ts";
import {
  CommitSha,
  Count,
  integer,
  PullRequestUrl,
} from "../schema/primitives.ts";
import { GitHubImport } from "../schema/github.ts";
import * as Limits from "../schema/limits.ts";
import { parseRows } from "../review/patch.ts";
import {
  branchHome,
  cleanBody,
  findPullRequest,
  readComments,
  runGh,
  type Gh,
  type PullRequestFound,
} from "./github.ts";
import type { Target } from "../schema/target.ts";
import { ForgeFailed, readForgeApi, type ForgeApi } from "./forge-api.ts";

export interface ForgeClients {
  readonly gh: Gh;
  readonly api: ForgeApi;
}
export const forgeClients: ForgeClients = { gh: runGh, api: readForgeApi };

export const PullRequestView = Schema.Struct({
  title: Schema.String,
  url: PullRequestUrl,
  baseRefOid: CommitSha,
  headRefOid: CommitSha,
  baseRefName: Schema.String,
  changedFiles: Schema.NullOr(Count),
});
export type PullRequestView = typeof PullRequestView.Type;
const ChangedFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
});

const decode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(result))
    throw new ForgeFailed(
      `The git host returned data this version cannot read: ${result.failure.message}`,
    );
  return result.success;
};

export const addressOf = (url: string): PullRequestAddress => {
  const pull = parsePullRequest(url);
  if (pull === undefined)
    throw new ForgeFailed(
      "Expected an HTTPS GitHub, GitLab, or Gitea/Forgejo pull request URL.",
    );
  return pull;
};

const endpoint = (pull: PullRequestAddress): string =>
  pull.provider === "gitlab"
    ? `/api/v4/projects/${encodeURIComponent(pull.repository)}/merge_requests/${pull.number}`
    : `/api/v1/repos/${pull.repository}/pulls/${pull.number}`;

const sameRepository = (
  a: PullRequestAddress,
  b: PullRequestAddress,
): boolean =>
  a.origin === b.origin &&
  a.provider === b.provider &&
  (a.provider === "github"
    ? a.repository.toLowerCase() === b.repository.toLowerCase()
    : a.repository === b.repository);

/** Continue to an empty page: server-side page-size caps must not truncate a review silently. */
const pages = <S extends Schema.Codec<unknown, unknown>>(
  pull: PullRequestAddress,
  path: string,
  schema: S,
  api: ForgeApi,
  limit: number,
): Array<S["Type"]> => {
  const items: Array<S["Type"]> = [];
  for (let page = 1; page <= limit + 1; page++) {
    const next = decode(
      Schema.Array(schema),
      api(
        pull,
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&${pull.provider === "gitlab" ? "per_page" : "limit"}=100`,
      ),
    );
    if (next.length === 0) return items;
    items.push(...next);
    if (items.length > limit)
      throw new ForgeFailed(
        `The git host returned more than ${limit} items; the review is incomplete.`,
      );
  }
  throw new ForgeFailed("The git host did not finish pagination.");
};

const GitLabView = Schema.Struct({
  title: Schema.String,
  web_url: PullRequestUrl,
  target_branch: Schema.String,
  diff_refs: Schema.Struct({ base_sha: CommitSha, head_sha: CommitSha }),
  changes_count: Schema.String,
});
const GiteaView = Schema.Struct({
  title: Schema.String,
  html_url: PullRequestUrl,
  base: Schema.Struct({ sha: CommitSha, ref: Schema.String }),
  head: Schema.Struct({ sha: CommitSha }),
  changed_files: Count,
});

/** Automatic branch lookup uses the selected upstream's configured API; ambiguous matches require an explicit URL. */
export const findHostedPullRequest = (
  target: Target,
  clients: ForgeClients,
): PullRequestFound => {
  if (target.kind !== "worktree") return { kind: "found", url: target.url };
  const home = branchHome(target.root);
  if (home.kind === "none") return home;
  if (home.kind === "github") {
    const found = findPullRequest(target, clients.gh, () => home);
    const repository = home.repo.startsWith("https://")
      ? home.repo
      : `https://github.com/${home.repo}`;
    if (
      found.kind === "found" &&
      !sameRepository(addressOf(`${repository}/pull/1`), addressOf(found.url))
    )
      return {
        kind: "none",
        reason: "The git host returned a pull request from another repository.",
      };
    return found;
  }
  const route = home.kind === "gitlab" ? "-/merge_requests" : "pulls";
  const pull = addressOf(`${home.repo}/${route}/1`);
  try {
    const matches =
      home.kind === "gitlab"
        ? pages(
            pull,
            `/api/v4/projects/${encodeURIComponent(pull.repository)}/merge_requests?scope=all&state=opened&source_branch=${encodeURIComponent(home.branch)}`,
            Schema.Struct({ web_url: PullRequestUrl }),
            clients.api,
            Limits.MAX_COMMENTS,
          ).map((item) => item.web_url)
        : pages(
            pull,
            `/api/v1/repos/${pull.repository}/pulls?state=open`,
            Schema.Struct({
              html_url: PullRequestUrl,
              head: Schema.Struct({ ref: Schema.String }),
            }),
            clients.api,
            Limits.MAX_COMMENTS,
          )
            .filter((item) => item.head.ref === home.branch)
            .map((item) => item.html_url);
    const [url] = matches;
    if (
      matches.some((candidate) => !sameRepository(pull, addressOf(candidate)))
    )
      throw new ForgeFailed(
        "The git host returned a pull request from another repository.",
      );
    return url === undefined || matches.length !== 1
      ? {
          kind: "none",
          reason: `Expected one open pull request for ${home.branch}; collect an explicit --pr URL.`,
        }
      : { kind: "found", url };
  } catch (error) {
    if (error instanceof ForgeFailed)
      return { kind: "none", reason: error.message };
    throw error;
  }
};

export const readPullRequest = (
  url: PullRequestUrl,
  clients: ForgeClients,
): PullRequestView => {
  const pull = addressOf(url);
  let view: PullRequestView;
  if (pull.provider === "github") {
    let raw: unknown;
    try {
      raw = JSON.parse(
        clients.gh([
          "pr",
          "view",
          url,
          "--json",
          "title,url,baseRefOid,headRefOid,baseRefName,changedFiles",
        ]),
      );
    } catch (error) {
      throw new ForgeFailed(
        `Cannot read the pull request from ${pull.host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    view = decode(PullRequestView, raw);
  } else if (pull.provider === "gitlab") {
    const raw = decode(GitLabView, clients.api(pull, endpoint(pull)));
    view = decode(PullRequestView, {
      title: raw.title,
      url: raw.web_url,
      baseRefOid: raw.diff_refs.base_sha,
      headRefOid: raw.diff_refs.head_sha,
      baseRefName: raw.target_branch,
      changedFiles: /^[0-9]+$/.test(raw.changes_count)
        ? Number(raw.changes_count)
        : null,
    });
  } else {
    const raw = decode(GiteaView, clients.api(pull, endpoint(pull)));
    view = decode(PullRequestView, {
      title: raw.title,
      url: raw.html_url,
      baseRefOid: raw.base.sha,
      headRefOid: raw.head.sha,
      baseRefName: raw.base.ref,
      changedFiles: raw.changed_files,
    });
  }
  const actual = addressOf(view.url);
  if (!sameRepository(actual, pull) || actual.number !== pull.number)
    throw new ForgeFailed(
      "The git host returned a different pull request. Select its URL explicitly.",
    );
  return view;
};

const GitLabFile = Schema.Struct({
  new_path: Schema.String,
  old_path: Schema.String,
  renamed_file: Schema.Boolean,
});
export const readPullRequestFiles = (
  url: PullRequestUrl,
  clients: ForgeClients,
): ReadonlyArray<typeof ChangedFile.Type> => {
  const pull = addressOf(url);
  if (pull.provider === "github") {
    const text = clients.gh([
      "api",
      "--hostname",
      pull.host,
      "--paginate",
      `repos/${pull.repository}/pulls/${pull.number}/files?per_page=100`,
      "--jq",
      ".[] | {filename, previous_filename}",
    ]);
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new ForgeFailed("gh api did not print one JSON file per line");
        }
        return decode(ChangedFile, raw);
      });
  }
  if (pull.provider === "gitlab")
    return pages(
      pull,
      `${endpoint(pull)}/diffs`,
      GitLabFile,
      clients.api,
      Limits.MAX_FILES,
    ).map((file) => ({
      filename: file.new_path,
      ...(file.renamed_file ? { previous_filename: file.old_path } : {}),
    }));
  return pages(
    pull,
    `${endpoint(pull)}/files`,
    ChangedFile,
    clients.api,
    Limits.MAX_FILES,
  );
};

const Id = integer(1, Number.MAX_SAFE_INTEGER);
const Line = integer(0, Limits.MAX_LINE);
const GitLabPosition = Schema.Struct({
  head_sha: CommitSha,
  old_path: Schema.String,
  new_path: Schema.String,
  old_line: Schema.optionalKey(Schema.NullOr(Line)),
  new_line: Schema.optionalKey(Schema.NullOr(Line)),
  line_range: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        start: Schema.Struct({
          type: Schema.Literals(["old", "new"]),
          old_line: Schema.optionalKey(Schema.NullOr(Line)),
          new_line: Schema.optionalKey(Schema.NullOr(Line)),
        }),
      }),
    ),
  ),
});
const GitLabDiff = Schema.Struct({
  old_path: Schema.String,
  new_path: Schema.String,
  diff: Schema.optionalKey(Schema.String),
});
const GitLabVersion = Schema.Struct({ id: Id, head_commit_sha: CommitSha });
const GitLabNote = Schema.Struct({
  id: Id,
  body: Schema.String,
  created_at: Schema.String,
  author: Schema.NullOr(Schema.Struct({ username: Schema.String })),
  system: Schema.Boolean,
  resolved: Schema.optionalKey(Schema.Boolean),
  position: Schema.optionalKey(Schema.NullOr(GitLabPosition)),
});
const GitLabDiscussion = Schema.Struct({ notes: Schema.Array(GitLabNote) });
const GiteaPost = Schema.Struct({
  id: Id,
  body: Schema.String,
  created_at: Schema.String,
  html_url: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const GiteaReview = Schema.Struct({
  id: Id,
  body: Schema.String,
  submitted_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  html_url: Schema.String,
  state: Schema.String,
});
const GiteaThread = Schema.Struct({
  ...GiteaPost.fields,
  path: Schema.String,
  commit_id: CommitSha,
  diff_hunk: Schema.String,
  position: Line,
  original_position: Line,
  resolver: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ login: Schema.String })),
  ),
});

/** The selected line ends the quote, as the importer expects; never anchor at the end of an unrelated hunk. */
export const hunkThrough = (
  patch: string,
  side: "old" | "new",
  line: number,
): string => {
  const rows = parseRows(patch);
  const end = rows.findIndex((row) => row[side] === line);
  if (end === -1) return "";
  const start = rows.findLastIndex(
    (row, at) => at <= end && row.kind === "hunk",
  );
  const first = rows[start];
  const last = rows[end];
  return first === undefined || last === undefined
    ? ""
    : patch.slice(first.offset, last.offset + last.text.length);
};

const time = (value: string): string => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new ForgeFailed("The git host returned an invalid comment date.");
  return new Date(parsed).toISOString();
};

export const readHostedComments = (
  url: PullRequestUrl,
  clients: ForgeClients,
): GitHubImport => {
  const pull = addressOf(url);
  if (pull.provider === "github") return readComments(url, clients.gh);
  const before = readPullRequest(url, clients);
  const items: Array<unknown> = [];
  const add = (item: unknown) => {
    if (items.length < Limits.MAX_COMMENTS) items.push(item);
  };
  if (pull.provider === "gitlab") {
    const diffs = new Map<string, ReadonlyArray<typeof GitLabDiff.Type>>();
    let versions: ReadonlyArray<typeof GitLabVersion.Type> | undefined;
    const patchAt = (position: typeof GitLabPosition.Type): string => {
      let files = diffs.get(position.head_sha);
      if (files === undefined) {
        if (position.head_sha === before.headRefOid)
          files = pages(
            pull,
            `${endpoint(pull)}/diffs`,
            GitLabDiff,
            clients.api,
            Limits.MAX_FILES,
          );
        else {
          versions ??= pages(
            pull,
            `${endpoint(pull)}/versions`,
            GitLabVersion,
            clients.api,
            Limits.MAX_COMMENTS,
          );
          const version = versions.find(
            (item) => item.head_commit_sha === position.head_sha,
          );
          files =
            version === undefined
              ? []
              : decode(
                  Schema.Struct({ diffs: Schema.Array(GitLabDiff) }),
                  clients.api(pull, `${endpoint(pull)}/versions/${version.id}`),
                ).diffs;
        }
        diffs.set(position.head_sha, files);
      }
      return (
        files.find(
          (file) =>
            file.old_path === position.old_path &&
            file.new_path === position.new_path,
        )?.diff ?? ""
      );
    };
    const post = (note: typeof GitLabNote.Type) => ({
      id: `gitlab_note_${note.id}`,
      author: note.author?.username ?? null,
      body: cleanBody(note.body),
      created_at: time(note.created_at),
      url: `${url}#note_${note.id}`,
    });
    for (const discussion of pages(
      pull,
      `${endpoint(pull)}/discussions`,
      GitLabDiscussion,
      clients.api,
      Limits.MAX_COMMENTS,
    )) {
      const [first, ...replies] = discussion.notes.filter(
        (note) => !note.system,
      );
      if (first === undefined) continue;
      const position = first.position;
      const line = position?.new_line ?? position?.old_line;
      if (
        position === undefined ||
        position === null ||
        line == null ||
        line === 0
      ) {
        for (const note of [first, ...replies])
          add({ kind: "conversation", ...post(note) });
      } else {
        const start = position.line_range?.start;
        const startSide = start?.type === "old" ? "LEFT" : "RIGHT";
        const startLine =
          start?.type === "old" ? start.old_line : start?.new_line;
        add({
          kind: "thread",
          ...post(first),
          resolved: first.resolved ?? false,
          path:
            position.new_line == null ? position.old_path : position.new_path,
          side: position.new_line == null ? "LEFT" : "RIGHT",
          diff_hunk: hunkThrough(
            patchAt(position),
            position.new_line == null ? "old" : "new",
            line,
          ),
          ...(startLine == null || startLine === 0
            ? {}
            : { start_line: startLine, start_side: startSide }),
          ...(position.head_sha === before.headRefOid ? { line } : {}),
          replies: replies.slice(0, Limits.MAX_GITHUB_REPLIES).map(post),
        });
      }
    }
  } else {
    const post = (note: typeof GiteaPost.Type) => ({
      id: `gitea_comment_${note.id}`,
      author: note.user?.login ?? null,
      body: cleanBody(note.body),
      created_at: time(note.created_at),
      url: note.html_url,
    });
    const issues = `/api/v1/repos/${pull.repository}/issues/${pull.number}/comments`;
    for (const note of pages(
      pull,
      issues,
      GiteaPost,
      clients.api,
      Limits.MAX_COMMENTS,
    ))
      add({ kind: "conversation", ...post(note) });
    const groups = new Map<string, Array<typeof GiteaThread.Type>>();
    for (const review of pages(
      pull,
      `${endpoint(pull)}/reviews`,
      GiteaReview,
      clients.api,
      Limits.MAX_COMMENTS,
    )) {
      if (review.state === "PENDING") continue;
      if (review.body.trim() !== "")
        add({
          kind: "review",
          id: `gitea_review_${review.id}`,
          author: review.user?.login ?? null,
          body: cleanBody(review.body),
          created_at: time(review.submitted_at),
          url: review.html_url,
        });
      for (const note of pages(
        pull,
        `${endpoint(pull)}/reviews/${review.id}/comments`,
        GiteaThread,
        clients.api,
        Limits.MAX_COMMENTS,
      )) {
        const key = JSON.stringify([
          review.id,
          note.path,
          note.commit_id,
          note.position,
          note.original_position,
        ]);
        if (!groups.has(key) && groups.size >= Limits.MAX_COMMENTS) continue;
        const group = groups.get(key) ?? [];
        if (!group.some((existing) => existing.id === note.id))
          group.push(note);
        groups.set(key, group);
      }
    }
    for (const notes of groups.values()) {
      notes.sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
      );
      const [first, ...replies] = notes;
      if (first === undefined) continue;
      // Gitea exposes file line numbers here, despite naming them positions.
      const side = first.position > 0 ? "new" : "old";
      const line = first.position || first.original_position;
      add({
        kind: "thread",
        ...post(first),
        path: first.path,
        side: side === "new" ? "RIGHT" : "LEFT",
        resolved: notes.some((note) => note.resolver != null),
        diff_hunk: hunkThrough(first.diff_hunk, side, line),
        ...(first.commit_id === before.headRefOid ? { line } : {}),
        replies: replies.slice(0, Limits.MAX_GITHUB_REPLIES).map(post),
      });
    }
  }
  const after = readPullRequest(url, clients);
  return decode(GitHubImport, {
    pull_request: url,
    ...(before.headRefOid === after.headRefOid
      ? { head_sha: before.headRefOid }
      : {}),
    items,
  });
};

/** Every open PR, across pages, without requiring a local review or checked-out source branch. */
export const readOpenPullRequests = (
  pull: PullRequestAddress,
  clients: ForgeClients,
): ReadonlyArray<OpenPullRequest> => {
  const branch = Schema.Struct({
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  });
  const github = Schema.Struct({
    html_url: PullRequestUrl,
    title: Schema.String,
    base: branch,
    head: branch,
  });
  let items: ReadonlyArray<OpenPullRequest>;
  if (pull.provider === "github") {
    const response = JSON.parse(
      clients.gh([
        "api",
        "--hostname",
        pull.host,
        "--paginate",
        "--slurp",
        `repos/${pull.repository}/pulls?state=open&per_page=100`,
      ]),
    );
    items = decode(Schema.Array(Schema.Array(github)), response)
      .flat()
      .map((item) => ({
        url: item.html_url,
        title: item.title,
        base_branch: item.base.ref,
        head_branch: item.head.ref,
        same_repository:
          item.head.repo !== null &&
          item.base.repo !== null &&
          item.head.repo.full_name.toLowerCase() ===
            item.base.repo.full_name.toLowerCase(),
      }));
  } else if (pull.provider === "gitlab") {
    items = pages(
      pull,
      `/api/v4/projects/${encodeURIComponent(pull.repository)}/merge_requests?scope=all&state=opened`,
      Schema.Struct({
        web_url: PullRequestUrl,
        title: Schema.String,
        target_branch: Schema.String,
        source_branch: Schema.String,
        source_project_id: Schema.NullOr(Count),
        target_project_id: Count,
      }),
      clients.api,
      2000,
    ).map((item) => ({
      url: item.web_url,
      title: item.title,
      base_branch: item.target_branch,
      head_branch: item.source_branch,
      same_repository: item.source_project_id === item.target_project_id,
    }));
  } else {
    items = pages(
      pull,
      `/api/v1/repos/${pull.repository}/pulls?state=open`,
      github,
      clients.api,
      2000,
    ).map((item) => ({
      url: item.html_url,
      title: item.title,
      base_branch: item.base.ref,
      head_branch: item.head.ref,
      same_repository:
        item.head.repo !== null &&
        item.base.repo !== null &&
        item.head.repo.full_name === item.base.repo.full_name,
    }));
  }
  if (items.length > 2000)
    throw new ForgeFailed(
      "More than 2000 open pull requests; the list is incomplete.",
    );
  for (const item of items) {
    if (!sameRepository(pull, addressOf(item.url)))
      throw new ForgeFailed(
        "The git host returned a pull request from another repository.",
      );
  }
  return decode(Schema.Array(OpenPullRequest), items);
};
