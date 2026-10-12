import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "../schema/target.ts";
import {
  cleanBody,
  findPullRequest,
  type Gh,
  GhFailed,
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
  const asked: Array<[ReadonlyArray<string>, string | undefined]> = [];
  const open: Gh = (args, cwd) => {
    asked.push([args, cwd]);
    return JSON.stringify({ url: URL, state: "OPEN" });
  };
  assert.deepEqual(findPullRequest(worktree, open), {
    kind: "found",
    url: URL,
  });
  assert.deepEqual(asked, [[["pr", "view", "--json", "url,state"], "/repo"]]);
  const merged = findPullRequest(worktree, () =>
    JSON.stringify({ url: URL, state: "MERGED" }),
  );
  assert.deepEqual(merged, {
    kind: "none",
    reason: "the branch's pull request is merged",
  });
  const missing = findPullRequest(worktree, () => {
    throw new GhFailed("no pull requests found for branch");
  });
  assert.equal(missing.kind, "none");
});

const node = (n: number, kind: string, body: string) => ({
  id: `NODE_${n}`,
  author: n === 9 ? null : { login: "octocat" },
  body,
  createdAt: `2026-10-12T00:0${n}:00Z`,
  url: `${URL}#${kind}${n}`,
});

/** A fake gh that answers each connection's query, the review threads in two pages. */
const fakeGh: Gh = (args) => {
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
                  startLine: null,
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
                  startLine: 3,
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
  return JSON.stringify({ data: { repository: { pullRequest } } });
};

test("a pull request's comments read page by page into the import format", () => {
  const read = readComments(URL, fakeGh);
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
  assert.equal(first.start_line, undefined);
  assert.equal(second.start_line, 3);
  assert.equal(second.resolved, true);
  assert.equal(conversation?.author, null);
});

test("GitHub text is cleaned to what the schemas accept", () => {
  assert.equal(cleanBody("a\u0000b\tc\r\n"), "a�b\tc\r\n");
  assert.equal(cleanBody("\ud800x"), "�x");
});
