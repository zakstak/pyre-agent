import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import { parseForgeComment, parsePullRequest } from "./forge-url.ts";
import { GitHubCommentUrl, PullRequestUrl } from "./primitives.ts";
import { Target, pullRequestKey, targetKey } from "./target.ts";

test("private hosts and ports identify their provider without a public-host allowlist", () => {
  for (const [url, provider, repository] of [
    [
      "https://git.something.company.com/team/project/pull/42",
      "github",
      "team/project",
    ],
    [
      "https://git.something.company.com:8443/division/team/project/-/merge_requests/42",
      "gitlab",
      "division/team/project",
    ],
    [
      "https://git.something.company.com/team/project/pulls/42",
      "gitea",
      "team/project",
    ],
  ]) {
    assert.ok(url);
    const parsed = parsePullRequest(url);
    assert.equal(parsed?.provider, provider);
    assert.equal(parsed?.repository, repository);
    assert.equal(parsed?.number, "42");
    assert.ok(
      Result.isSuccess(Schema.decodeUnknownResult(PullRequestUrl)(url)),
    );
  }
  assert.equal(
    parsePullRequest("https://GIT.COMPANY.COM:443/team/project/pull/1")?.host,
    "git.company.com",
  );
});

test("review URLs refuse credentials, redirects encoded as paths, queries, and unsupported routes", () => {
  for (const url of [
    "http://git.company.com/team/project/pull/1",
    "https://user:secret@git.company.com/team/project/pull/1",
    "https://@git.company.com/team/project/pull/1",
    "https://git.company.com/team/project/pull/1?token=secret",
    "https://git.company.com/team/project/pull/1#issuecomment-1",
    "https://git.company.com/team/project/pull/0",
    "https://git.company.com/team/project/pull/9007199254740992",
    "https://git.company.com/team/../team/project/pull/1",
    "https://git.company.com/team/%70roject/pull/1",
    "https://git.company.com/team/project/issues/1",
    "https://git.company.com/team/project/pull/1\n",
    "https://git.company.com/team/project/pull/1/",
  ])
    assert.equal(parsePullRequest(url), undefined, url);
});

test("comment permalinks keep their host and request identity, including Gitea's files page", () => {
  for (const url of [
    "https://git.company.com/team/project/pull/1#discussion_r2",
    "https://git.company.com/team/project/-/merge_requests/1#note_2",
    "https://git.company.com/team/project/pulls/1/files#issuecomment-2",
  ]) {
    assert.ok(parseForgeComment(url), url);
    const comment = Schema.decodeUnknownSync(GitHubCommentUrl)(url);
    const page = Schema.decodeUnknownSync(PullRequestUrl)(
      parseForgeComment(url)?.url,
    );
    assert.equal(pullRequestKey(comment), pullRequestKey(page));
  }
  assert.equal(
    parseForgeComment("https://git.company.com/team/project/pull/1#note_2"),
    undefined,
  );
});

test("new targets preserve GitHub keys while separating private hosts and case-sensitive project paths", () => {
  const target = (
    kind: "github_pr" | "pull_request",
    url: string,
    provider?: "github" | "gitlab" | "gitea",
  ) =>
    Schema.decodeUnknownSync(Target)({
      kind,
      url,
      ...(provider === undefined ? {} : { provider }),
      title: "Review",
      head_sha: "a".repeat(40),
    });
  const url = "https://git.company.com/Team/Project/pull/1";
  assert.equal(
    targetKey(target("github_pr", url)),
    targetKey(target("pull_request", url.toLowerCase(), "github")),
  );
  assert.notEqual(
    targetKey(target("github_pr", url)),
    targetKey(
      target("github_pr", url.replace("git.company.com", "other.company.com")),
    ),
  );
  const gitlab = "https://git.company.com/Team/Project/-/merge_requests/1";
  assert.notEqual(
    targetKey(target("pull_request", gitlab, "gitlab")),
    targetKey(target("pull_request", gitlab.toLowerCase(), "gitlab")),
  );
  assert.ok(
    Result.isFailure(
      Schema.decodeUnknownResult(Target)({
        kind: "pull_request",
        provider: "gitea",
        url: gitlab,
        title: "Review",
        head_sha: "a".repeat(40),
      }),
    ),
  );
});
