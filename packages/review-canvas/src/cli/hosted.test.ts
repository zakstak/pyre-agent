import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Result, Schema } from "effect";
import { Fixture, withEnv } from "../collector/testing.ts";
import { openWorktree } from "../collector/collect.ts";
import { Store, feedbackOf } from "../store/store.ts";
import { decodeValue, FeedbackDocument } from "../schema/document.ts";
import { PullRequestUrl, Timestamp } from "../schema/primitives.ts";
import { targetName } from "../client/names.ts";
import { collectPullRequest } from "./pull-request.ts";
import { ForgeFailed } from "./forge-api.ts";
import {
  findHostedPullRequest,
  hunkThrough,
  readHostedComments,
  readPullRequest,
  type ForgeClients,
} from "./hosted.ts";
import { readComments, type Gh } from "./github.ts";
import { Target } from "../schema/target.ts";
import * as Limits from "../schema/limits.ts";

const fixture = (t: TestContext) => {
  const git = new Fixture(t);
  git.commit({ "a.txt": "a\n" });
  const base = git.head();
  git.commit({ "a.txt": "a\nb\n" });
  return { git, base, head: git.head() };
};

const clientsFor = (
  provider: "gitlab" | "gitea",
  f: ReturnType<typeof fixture>,
) => {
  const url = Schema.decodeUnknownSync(PullRequestUrl)(
    `https://git.something.company.com/${provider === "gitlab" ? "division/team/project/-/merge_requests" : "team/project/pulls"}/42`,
  );
  const calls: Array<string> = [];
  const clients: ForgeClients = {
    gh: () => {
      throw new Error("gh must not receive another provider's requests");
    },
    api: (pull, path) => {
      assert.equal(pull.host, "git.something.company.com");
      calls.push(path);
      if (!path.includes("?"))
        return provider === "gitlab"
          ? {
              title: "Corporate change",
              web_url: url,
              target_branch: "main",
              diff_refs: { base_sha: f.base, head_sha: f.head },
              changes_count: "1",
            }
          : {
              title: "Corporate change",
              html_url: url,
              base: { sha: f.base, ref: "main" },
              head: { sha: f.head },
              changed_files: 1,
            };
      if (path.includes("page=2")) return [];
      if (path.includes("/diffs?"))
        return [
          {
            old_path: "a.txt",
            new_path: "a.txt",
            renamed_file: false,
            diff: "@@ -1 +1,2 @@\n a\n+b\n",
          },
        ];
      if (path.includes("/files?")) return [{ filename: "a.txt" }];
      if (path.includes("/discussions?"))
        return [
          {
            notes: [
              {
                id: 1,
                author: { username: "employee.name" },
                body: "Check this line",
                created_at: "2026-10-15T12:00:00Z",
                system: false,
                resolved: false,
                position: {
                  head_sha: f.head,
                  old_path: "a.txt",
                  new_path: "a.txt",
                  old_line: null,
                  new_line: 2,
                },
              },
              {
                id: 2,
                author: { username: "other_employee" },
                body: "Reply",
                created_at: "2026-10-15T12:01:00Z",
                system: false,
              },
            ],
          },
        ];
      if (path.includes("/reviews/7/comments?"))
        return [
          {
            id: 1,
            user: { login: "employee.name" },
            body: "Check this line",
            created_at: "2026-10-15T12:00:00Z",
            html_url: `${url}/files#issuecomment-1`,
            path: "a.txt",
            commit_id: f.head,
            diff_hunk: "@@ -1 +1,2 @@\n a\n+b\n",
            position: 2,
            original_position: 0,
            resolver: null,
          },
        ];
      if (path.includes("/reviews?"))
        return [
          {
            id: 7,
            user: { login: "employee.name" },
            body: "",
            submitted_at: "2026-10-15T12:00:00Z",
            html_url: `${url}#pullreview-7`,
            state: "COMMENT",
          },
        ];
      if (path.includes("/issues/42/comments?")) return [];
      throw new Error(`Unexpected endpoint ${path}`);
    },
  };
  return { url, clients, calls };
};

for (const provider of ["gitlab", "gitea"] as const) {
  test(`${provider}: collect, import line comments, export, and refresh a corporate review`, (t) => {
    const f = fixture(t);
    const { url, clients, calls } = clientsFor(provider, f);
    const collected = collectPullRequest(
      openWorktree({ repo: f.git.root }),
      url,
      clients,
    );
    assert.equal(collected.review.target.kind, "pull_request");
    assert.equal(collected.review.files_complete, true);
    assert.equal(collected.headMoved, false);
    assert.equal(collected.mismatch, undefined);
    const name = targetName(collected.review.target);
    assert.ok(name.kind === "pr");
    assert.match(name.url, /git\.something\.company\.com/);
    if (provider === "gitlab")
      assert.ok(
        calls.some((path) => path.includes("division%2Fteam%2Fproject")),
      );
    const database = join(f.git.base, "reviews.sqlite");
    let store = Store.open(database);
    t.after(() => store.close());
    const registered = store.register({
      target: collected.review.target,
      label: "Corporate review",
      host: { kind: "codex" },
    });
    store.publish(
      registered.review.state.id,
      registered.thread.id,
      collected.review,
    );
    const comments = readHostedComments(url, clients);
    const imported = store.importGitHub(
      registered.review.state.id,
      comments.pull_request,
      comments.items,
      comments.head_sha,
    );
    assert.equal(imported.report.comments, 1);
    assert.deepEqual(imported.report.skipped, []);
    const view = store.review(registered.review.state.id);
    const comment = view?.state.comments[0];
    assert.equal(comment?.kind, "inline");
    assert.ok(
      comment?.kind === "inline" && comment.attachment.state === "attached",
    );
    assert.equal(comment.anchor.quote, "+b");
    assert.equal(
      store.importGitHub(
        registered.review.state.id,
        comments.pull_request,
        comments.items,
        comments.head_sha,
      ).report.already,
      1,
    );
    assert.ok(view);
    const feedback = feedbackOf(
      view,
      Schema.decodeUnknownSync(Timestamp)("2026-10-15T12:02:00.000Z"),
    );
    assert.ok(Result.isSuccess(decodeValue(FeedbackDocument, feedback)));
    store.close();
    store = Store.open(database);
    assert.equal(
      store.review(registered.review.state.id)?.state.comments.length,
      1,
    );
    assert.throws(
      () =>
        store.importGitHub(
          registered.review.state.id,
          Schema.decodeUnknownSync(PullRequestUrl)(
            url.replace("git.something.company.com", "other.company.com"),
          ),
          comments.items,
          comments.head_sha,
        ),
      /another pull request/,
    );
  });
}

test("GitHub Enterprise pins every REST and GraphQL request to the URL's host", (t) => {
  const f = fixture(t);
  const url = Schema.decodeUnknownSync(PullRequestUrl)(
    "https://git.something.company.com/team/project/pull/42",
  );
  const calls: Array<ReadonlyArray<string>> = [];
  const gh: Gh = (args) => {
    calls.push(args);
    if (args[0] === "pr")
      return JSON.stringify({
        title: "Corporate change",
        url,
        baseRefOid: f.base,
        headRefOid: f.head,
        baseRefName: "main",
        changedFiles: 1,
      });
    assert.equal(
      args[args.indexOf("--hostname") + 1],
      "git.something.company.com",
    );
    if (!args.includes("graphql")) return JSON.stringify({ filename: "a.txt" });
    const connection = (
      args.find((arg) => arg.startsWith("query=")) ?? ""
    ).includes("reviewThreads(")
      ? "reviewThreads"
      : (args.find((arg) => arg.startsWith("query=")) ?? "").includes(
            "comments(",
          )
        ? "comments"
        : "reviews";
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: f.head,
            [connection]: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  };
  const clients: ForgeClients = {
    gh,
    api: () => {
      throw new Error("REST client not used for GitHub");
    },
  };
  assert.equal(
    collectPullRequest(openWorktree({ repo: f.git.root }), url, clients).review
      .files_complete,
    true,
  );
  assert.equal(readComments(url, gh).pull_request, url);
  assert.equal(calls.filter((args) => args.includes("graphql")).length, 3);
});

test("a provider cannot redirect collection to another host or claim a capped file count is complete", (t) => {
  const f = fixture(t);
  const { url, clients } = clientsFor("gitlab", f);
  assert.throws(
    () =>
      readPullRequest(url, {
        ...clients,
        api: () => ({
          title: "Other",
          web_url: url.replace(
            "git.something.company.com",
            "other.company.com",
          ),
          target_branch: "main",
          diff_refs: { base_sha: f.base, head_sha: f.head },
          changes_count: "1",
        }),
      }),
    ForgeFailed,
  );
  const capped = {
    ...clients,
    api: ((pull, path) => {
      const value = clients.api(pull, path);
      return path.includes("?")
        ? value
        : {
            title: "Capped",
            web_url: url,
            target_branch: "main",
            diff_refs: { base_sha: f.base, head_sha: f.head },
            changes_count: "1000+",
          };
    }) satisfies ForgeClients["api"],
  };
  assert.equal(
    collectPullRequest(openWorktree({ repo: f.git.root }), url, capped).review
      .files_complete,
    false,
  );
});

test("a Gitea hunk is cut at the selected old or new line", () => {
  const patch = "@@ -1,2 +1,2 @@\n-old\n+new\n tail\n";
  assert.equal(hunkThrough(patch, "old", 1), "@@ -1,2 +1,2 @@\n-old");
  assert.equal(hunkThrough(patch, "new", 1), "@@ -1,2 +1,2 @@\n-old\n+new");
  assert.equal(hunkThrough(patch, "new", 10), "");
});

for (const provider of ["github", "gitlab", "gitea"] as const) {
  test(`${provider}: working-tree discovery uses the configured corporate host and rejects another host's result`, (t) => {
    const f = fixture(t);
    f.git.git(
      f.git.root,
      "remote",
      "add",
      "origin",
      "git@git.company.com:team/project.git",
    );
    const route =
      provider === "github"
        ? "pull"
        : provider === "gitlab"
          ? "-/merge_requests"
          : "pulls";
    const url = `https://git.company.com/team/project/${route}/42`;
    const target = Schema.decodeUnknownSync(Target)({
      kind: "worktree",
      root: f.git.root,
      head_sha: f.head,
      title: "Local review",
    });
    let reportedUrl = url;
    const clients: ForgeClients = {
      gh: (args) => {
        assert.equal(
          args[args.indexOf("--repo") + 1],
          "https://git.company.com/team/project",
        );
        return JSON.stringify([{ url: reportedUrl }]);
      },
      api: (pull, path) => {
        assert.equal(pull.origin, "https://git.company.com");
        if (provider === "gitlab") {
          const query = new URL(path, pull.origin).searchParams;
          assert.equal(query.get("scope"), "all");
          assert.equal(query.get("state"), "opened");
          assert.equal(query.get("source_branch"), "main");
        }
        return path.includes("page=2")
          ? []
          : provider === "gitlab"
            ? [{ web_url: reportedUrl }]
            : [{ html_url: reportedUrl, head: { ref: "main" } }];
      },
    };
    withEnv(
      {
        REVIEW_CANVAS_FORGE_HOSTS: JSON.stringify({
          "git.company.com": provider,
        }),
      },
      () => {
        assert.deepEqual(findHostedPullRequest(target, clients), {
          kind: "found",
          url,
        });
        reportedUrl = url.replace("git.company.com", "another.company.com");
        assert.equal(findHostedPullRequest(target, clients).kind, "none");
      },
    );
    withEnv(
      { REVIEW_CANVAS_FORGE_HOSTS: undefined, GH_HOST: undefined },
      () => {
        const found = findHostedPullRequest(target, clients);
        assert.ok(found.kind === "none");
        assert.match(found.reason, /explicit --pr URL/);
      },
    );
  });
}

test("outdated GitLab discussions retain their original quote and remain orphaned when that code is gone", (t) => {
  const f = fixture(t);
  const { url, clients } = clientsFor("gitlab", f);
  const historical: ForgeClients = {
    ...clients,
    api: (pull, path) => {
      if (path.endsWith("/versions/7"))
        return {
          diffs: [
            {
              old_path: "a.txt",
              new_path: "a.txt",
              diff: "@@ -1 +1 @@\n-a\n+old\n",
            },
          ],
        };
      if (path.includes("/versions?"))
        return path.includes("page=2")
          ? []
          : [{ id: 7, head_commit_sha: f.base }];
      if (path.includes("/discussions?"))
        return path.includes("page=2")
          ? []
          : [
              {
                notes: [
                  {
                    id: 1,
                    body: "Outdated",
                    author: { username: "employee" },
                    created_at: "2026-10-15T12:00:00Z",
                    system: false,
                    resolved: false,
                    position: {
                      head_sha: f.base,
                      old_path: "a.txt",
                      new_path: "a.txt",
                      new_line: 1,
                    },
                  },
                ],
              },
            ];
      return clients.api(pull, path);
    },
  };
  const input = collectPullRequest(
    openWorktree({ repo: f.git.root }),
    url,
    clients,
  ).review;
  const comments = readHostedComments(url, historical);
  const store = Store.open(":memory:");
  t.after(() => store.close());
  const registered = store.register({
    target: input.target,
    label: "Review",
    host: { kind: "codex" },
  });
  store.publish(registered.review.state.id, registered.thread.id, input);
  assert.deepEqual(
    store.importGitHub(
      registered.review.state.id,
      comments.pull_request,
      comments.items,
      comments.head_sha,
    ).report.skipped,
    [],
  );
  const comment = store.review(registered.review.state.id)?.state.comments[0];
  assert.ok(comment?.kind === "inline");
  assert.equal(comment.anchor.quote, "+old");
  assert.equal(comment.attachment.state, "orphan");
});

for (const side of ["old", "new"] as const) {
  test(`Gitea ${side}-side positions are file lines beyond the first hunk`, (t) => {
    const f = fixture(t);
    const { url, clients } = clientsFor("gitea", f);
    const patch = "@@ -101,2 +201,2 @@\n-old\n+new\n tail\n";
    let commit = f.head;
    const comments: ForgeClients = {
      ...clients,
      api: (pull, path) =>
        path.includes("/reviews/7/comments?")
          ? path.includes("page=2")
            ? []
            : [
                {
                  id: 1,
                  body: "Check",
                  user: null,
                  created_at: "2026-10-15T12:00:00Z",
                  html_url: `${url}/files#issuecomment-1`,
                  path: "a.txt",
                  commit_id: commit,
                  diff_hunk: patch,
                  position: side === "new" ? 201 : 0,
                  original_position: side === "old" ? 101 : 0,
                },
              ]
          : clients.api(pull, path),
    };
    const [item] = readHostedComments(url, comments).items;
    assert.ok(item?.kind === "thread");
    assert.equal(item.side, side === "new" ? "RIGHT" : "LEFT");
    assert.equal(item.line, side === "new" ? 201 : 101);
    assert.equal(
      item.diff_hunk,
      side === "new"
        ? "@@ -101,2 +201,2 @@\n-old\n+new"
        : "@@ -101,2 +201,2 @@\n-old",
    );
    commit = f.base;
    const [outdated] = readHostedComments(url, comments).items;
    assert.ok(outdated?.kind === "thread");
    assert.equal(outdated.line, undefined);
    assert.equal(outdated.diff_hunk, item.diff_hunk);
  });
}

test("Gitea keeps reviews at the same location separate, with their own replies and resolution", (t) => {
  const f = fixture(t);
  const { url, clients } = clientsFor("gitea", f);
  const note = (id: number, resolved = false) => ({
    id,
    body: `Comment ${id}`,
    user: null,
    created_at: "2026-10-15T12:00:00Z",
    html_url: `${url}/files#issuecomment-${id}`,
    path: "a.txt",
    commit_id: f.head,
    diff_hunk: "@@ -1 +1,2 @@\n a\n+b\n",
    position: 2,
    original_position: 0,
    resolver: resolved ? { login: "resolver" } : null,
  });
  const comments: ForgeClients = {
    ...clients,
    api: (pull, path) => {
      if (path.includes("page=2")) return [];
      if (path.includes("/reviews?"))
        return [7, 8].map((id) => ({
          id,
          user: null,
          body: "",
          state: "COMMENT",
          submitted_at: "2026-10-15T12:00:00Z",
          html_url: `${url}#pullreview-${id}`,
        }));
      if (path.includes("/reviews/7/comments?")) return [note(1), note(2)];
      if (path.includes("/reviews/8/comments?")) return [note(3, true)];
      return clients.api(pull, path);
    },
  };
  const imported = readHostedComments(url, comments);
  assert.equal(imported.items.length, 2);
  const [first, second] = imported.items;
  assert.ok(first?.kind === "thread" && second?.kind === "thread");
  assert.equal(first.resolved, false);
  assert.deepEqual(
    first.replies.map((reply) => reply.id),
    ["gitea_comment_2"],
  );
  assert.equal(second.id, "gitea_comment_3");
  assert.equal(second.resolved, true);
  assert.deepEqual(second.replies, []);
});

test("GitLab bounds normalized discussion notes and thread replies", (t) => {
  const f = fixture(t);
  const { url, clients } = clientsFor("gitlab", f);
  const note = (id: number) => ({
    id,
    body: `Note ${id}`,
    author: null,
    system: false,
    created_at: "2026-10-15T12:00:00Z",
  });
  let inline = false;
  const comments: ForgeClients = {
    ...clients,
    api: (pull, path) =>
      path.includes("/discussions?")
        ? path.includes("page=2")
          ? []
          : [
              {
                notes: [
                  {
                    ...note(1),
                    ...(inline
                      ? {
                          position: {
                            head_sha: f.head,
                            old_path: "a.txt",
                            new_path: "a.txt",
                            new_line: 2,
                          },
                        }
                      : {}),
                  },
                  ...Array.from({ length: Limits.MAX_COMMENTS }, (_, at) =>
                    note(at + 2),
                  ),
                ],
              },
            ]
        : clients.api(pull, path),
  };
  const general = readHostedComments(url, comments);
  assert.equal(general.items.length, Limits.MAX_COMMENTS);
  assert.equal(general.items.at(-1)?.id, `gitlab_note_${Limits.MAX_COMMENTS}`);
  inline = true;
  const [thread] = readHostedComments(url, comments).items;
  assert.ok(thread?.kind === "thread");
  assert.equal(thread.replies.length, Limits.MAX_GITHUB_REPLIES);
  assert.equal(
    thread.replies.at(-1)?.id,
    `gitlab_note_${Limits.MAX_GITHUB_REPLIES + 1}`,
  );
});

test("Gitea bounds combined conversation, review, and thread imports and thread replies", (t) => {
  const f = fixture(t);
  const { url, clients } = clientsFor("gitea", f);
  const note = (id: number) => ({
    id,
    body: `Note ${id}`,
    user: null,
    created_at: "2026-10-15T12:00:00Z",
    html_url: `${url}/files#issuecomment-${id}`,
  });
  let conversationCount = Limits.MAX_COMMENTS - 2;
  const comments: ForgeClients = {
    ...clients,
    api: (pull, path) => {
      if (path.includes("page=2")) return [];
      if (path.includes("/issues/42/comments?"))
        return Array.from({ length: conversationCount }, (_, at) =>
          note(at + 1000),
        );
      if (path.includes("/reviews?"))
        return [
          {
            id: 7,
            body: "Summary",
            user: null,
            state: "COMMENT",
            submitted_at: "2026-10-15T12:00:00Z",
            html_url: `${url}#pullreview-7`,
          },
        ];
      if (path.includes("/reviews/7/comments?"))
        return Array.from(
          { length: Limits.MAX_GITHUB_REPLIES + 2 },
          (_, at) => ({
            ...note(at + 1),
            path: "a.txt",
            commit_id: f.head,
            diff_hunk: "@@ -1 +1,2 @@\n a\n+b\n",
            position: 2,
            original_position: 0,
          }),
        );
      return clients.api(pull, path);
    },
  };
  const imported = readHostedComments(url, comments);
  assert.equal(imported.items.length, Limits.MAX_COMMENTS);
  const thread = imported.items.at(-1);
  assert.ok(thread?.kind === "thread");
  assert.equal(thread.replies.length, Limits.MAX_GITHUB_REPLIES);
  conversationCount++;
  const capped = readHostedComments(url, comments);
  assert.equal(capped.items.length, Limits.MAX_COMMENTS);
  assert.equal(capped.items.at(-1)?.kind, "review");
});
