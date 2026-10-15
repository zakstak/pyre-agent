import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "../schema/target.ts";
import { Fixture } from "../collector/testing.ts";
import {
  branchHome,
  cleanBody,
  findPullRequest,
  type Gh,
  GhFailed,
  forgeRemote,
  readComments,
} from "./github.ts";

const URL = "https://github.com/example/notes/pull/7";

const worktree = {
  kind: "worktree",
  title: "t",
  root: "/repo",
  head_sha: "d".repeat(40),
} as unknown as Target;

test("the pull request is the target's, or the open one of the working tree's branch", () => {
  assert.deepEqual(
    findPullRequest(
      { ...worktree, kind: "github_pr", url: URL } as unknown as Target,
      () => {
        throw new Error("gh is not asked");
      },
    ),
    { kind: "found", url: URL },
  );
  const asked: Array<ReadonlyArray<string>> = [];
  const open: Gh = (args) => {
    asked.push(args);
    return JSON.stringify([{ url: URL }]);
  };
  const home = () =>
    ({ kind: "github", repo: "example/notes", branch: "atomic-save" }) as const;
  assert.deepEqual(findPullRequest(worktree, open, home), {
    kind: "found",
    url: URL,
  });
  // gh is asked by repository and branch, never inside the working tree.
  assert.deepEqual(asked, [
    [
      "pr",
      "list",
      "--repo",
      "example/notes",
      "--head",
      "atomic-save",
      "--state",
      "open",
      "--json",
      "url",
      "--limit",
      "1",
    ],
  ]);
  assert.deepEqual(
    findPullRequest(worktree, () => "[]", home),
    {
      kind: "none",
      reason: "no open pull request for atomic-save in example/notes",
    },
  );
  assert.deepEqual(
    findPullRequest(worktree, open, () => ({
      kind: "none",
      reason: "the remote origin is not on github.com",
    })),
    { kind: "none", reason: "the remote origin is not on github.com" },
  );
});

test("a remote URL names its GitHub repository in any spelling", () => {
  for (const url of [
    "https://github.com/example/notes.git",
    "https://github.com/example/notes",
    "git@github.com:example/notes.git",
    "ssh://git@github.com/example/notes.git",
  ])
    assert.deepEqual(forgeRemote(url), { kind: "github", repo: "https://github.com/example/notes" }, url);
  assert.deepEqual(forgeRemote("https://gitlab.com/example/notes.git"), { kind: "gitlab", repo: "https://gitlab.com/example/notes" });
});

test("a branch's home is read with hardened Git from its upstream", (t) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "a\n" });
  f.git(f.root, "checkout", "-q", "-b", "feature");
  f.git(f.root, "remote", "add", "origin", "git@github.com:example/notes.git");
  assert.deepEqual(branchHome(f.root), {
    kind: "github",
    repo: "https://github.com/example/notes",
    branch: "feature",
  });
});

const node = (n: number, kind: string, body: string) => ({
  id: `NODE_${n}`,
  author: n === 9 ? null : { login: "octocat" },
  body,
  createdAt: `2026-10-12T00:0${n}:00Z`,
  url: `${URL}#${kind}${n}`,
});

/**
 * A fake gh that answers each connection's query, the review threads in two pages. `secondHead` is the head the
 * second page of threads sees, as when a push lands between the two requests.
 */
const fakeGh =
  (secondHead = "a".repeat(40)): Gh =>
  (args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    const after = args.find((arg) => arg.startsWith("after="));
    const page = (nodes: Array<unknown>, next: string | null) => ({
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes,
    });
    let pullRequest: Record<string, unknown>;
    if (query.includes("reviewThreads(")) {
      pullRequest = {
        reviewThreads:
          after === undefined
            ? page(
                [
                  {
                    isResolved: false,
                    path: "src/a.ts",
                    diffSide: "RIGHT",
                    startDiffSide: null,
                    originalStartLine: null,
                    line: 1,
                    // GitHub's startLine is not read: it can lag behind line.
                    startLine: 1,
                    comments: {
                      nodes: [
                        {
                          ...node(1, "discussion_r", "Why?\u0007"),
                          diffHunk: "@@ -1 +1 @@\n-a\n+b",
                        },
                        {
                          ...node(2, "discussion_r", "Because."),
                          diffHunk: "@@ -1 +1 @@\n-a\n+b",
                        },
                      ],
                    },
                  },
                ],
                "cursor-1",
              )
            : page(
                [
                  {
                    isResolved: true,
                    path: "src/b.ts",
                    diffSide: "LEFT",
                    startDiffSide: "RIGHT",
                    originalStartLine: 3,
                    line: null,
                    startLine: null,
                    comments: {
                      nodes: [
                        {
                          ...node(3, "discussion_r", "Old code"),
                          diffHunk: "@@ -3,2 +3 @@\n-x\n-y",
                        },
                      ],
                    },
                  },
                ],
                null,
              ),
      };
    } else if (query.includes("reviews(")) {
      pullRequest = {
        reviews: page(
          [
            node(4, "pullrequestreview-", "Ship it"),
            node(5, "pullrequestreview-", "  "),
          ],
          null,
        ),
      };
    } else {
      pullRequest = {
        comments: page(
          [node(9, "issuecomment-", "From a deleted account")],
          null,
        ),
      };
    }
    pullRequest = {
      ...pullRequest,
      headRefOid: after === undefined ? "a".repeat(40) : secondHead,
    };
    return JSON.stringify({ data: { repository: { pullRequest } } });
  };

test("a pull request's comments read page by page into the import format", () => {
  const read = readComments(URL, fakeGh());
  assert.equal(read.pull_request, URL);
  assert.deepEqual(
    read.items.map((item) => [item.kind, item.id]),
    [
      ["thread", "NODE_1"],
      ["thread", "NODE_3"],
      ["conversation", "NODE_9"],
      ["review", "NODE_4"],
    ],
  );
  const [first, second, conversation] = read.items;
  assert.ok(first?.kind === "thread" && second?.kind === "thread");
  assert.equal(first.body, "Why?�");
  assert.equal(first.created_at, "2026-10-12T00:01:00.000Z");
  assert.deepEqual(
    first.replies.map((reply) => reply.id),
    ["NODE_2"],
  );
  // The first line is the one the diff hunk numbers; the last is where GitHub shows the thread now, if anywhere.
  assert.equal(first.start_line, undefined);
  assert.equal(first.line, 1);
  assert.equal(second.start_line, 3);
  assert.equal(second.start_side, "RIGHT");
  assert.equal(second.line, undefined);
  assert.equal(second.resolved, true);
  assert.equal(conversation?.author, null);
  assert.equal(read.head_sha, "a".repeat(40));
});

test("threads read across a push carry no head, so their lines place nothing", () => {
  assert.equal(readComments(URL, fakeGh("b".repeat(40))).head_sha, undefined);
});

test("GitHub text is cleaned to what the schemas accept", () => {
  assert.equal(cleanBody("a\u0000b\tc\r\n"), "a�b\tc\r\n");
  assert.equal(cleanBody("\ud800x"), "�x");
});
