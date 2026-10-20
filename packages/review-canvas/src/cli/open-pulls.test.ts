import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressOf,
  readOpenPullRequests,
  type ForgeClients,
} from "./hosted.ts";

const github = (
  n: number,
  repo = "acme/project",
  headRepo: string | null = repo,
) => ({
  html_url: `https://github.com/${repo}/pull/${n}`,
  title: `PR ${n}`,
  base: { ref: "main", repo: { full_name: repo } },
  head: {
    ref: `feature-${n}`,
    repo: headRepo === null ? null : { full_name: headRepo },
  },
});
const unused = (): never => {
  throw new Error("unexpected client");
};
test("GitHub requests every open PR page and retains fork/deleted-source identity", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const items = readOpenPullRequests(
    addressOf("https://github.com/acme/project/pull/1"),
    {
      gh: (args) => {
        calls.push(args);
        return JSON.stringify([
          [github(2)],
          [
            github(1, "acme/project", "fork/project"),
            github(3, "acme/project", null),
          ],
        ]);
      },
      api: unused,
    },
  );
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.same_repository),
    [true, false, false],
  );
  assert.deepEqual(calls[0], [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    "repos/acme/project/pulls?state=open&per_page=100",
  ]);
});
test("GitHub Enterprise reads the selected host and rejects other repositories or malformed responses", () => {
  const pull = addressOf("https://git.example/acme/project/pull/1");
  assert.throws(
    () =>
      readOpenPullRequests(pull, {
        gh: () => JSON.stringify([[github(1)]]),
        api: unused,
      }),
    /another repository/,
  );
  assert.throws(
    () => readOpenPullRequests(pull, { gh: () => "{}", api: unused }),
    /cannot read/,
  );
});
for (const provider of ["gitlab", "gitea"] as const) {
  test(`${provider} reads through short capped pages and an empty page without registration`, () => {
    const route = provider === "gitlab" ? "-/merge_requests" : "pulls";
    const pull = addressOf(`https://git.example/team/project/${route}/1`);
    const paths: Array<string> = [];
    const clients: ForgeClients = {
      gh: unused,
      api: (_, path) => {
        paths.push(path);
        if (paths.length === 3) return [];
        const n = paths.length;
        return provider === "gitlab"
          ? [
              {
                web_url: `https://git.example/team/project/${route}/${n}`,
                title: `PR ${n}`,
                target_branch: "main",
                source_branch: `branch-${n}`,
                target_project_id: 1,
                source_project_id: n,
              },
            ]
          : [
              {
                ...github(n),
                html_url: `https://git.example/team/project/${route}/${n}`,
              },
            ];
      },
    };
    assert.equal(readOpenPullRequests(pull, clients).length, 2);
    assert.equal(paths.length, 3);
    assert.match(
      paths[0] ?? "",
      provider === "gitlab" ? /scope=all&state=opened/ : /state=open/,
    );
    assert.match(paths[2] ?? "", /page=3/);
  });
}
test("host authentication failure is reported, not represented as an empty list", () => {
  assert.throws(
    () =>
      readOpenPullRequests(
        addressOf("https://github.com/acme/project/pull/1"),
        {
          gh: () => {
            throw new Error("gh: authentication required");
          },
          api: unused,
        },
      ),
    /authentication required/,
  );
});

test("needs-my-review uses the authenticated host search and intersects open PRs", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const items = readOpenPullRequests(
    addressOf("https://github.com/acme/project/pull/1"),
    {
      api: unused,
      gh: (args) => {
        calls.push(args);
        return args[0] === "api"
          ? JSON.stringify([[github(1), github(2)]])
          : JSON.stringify([
              { url: github(2).html_url },
              { url: github(3).html_url },
            ]);
      },
    },
    "requested",
  );
  assert.deepEqual(
    items.map((item) => item.url),
    [github(2).html_url],
  );
  assert.ok(calls[1]?.includes("review-requested:@me"));
  assert.ok(calls[1]?.includes("https://github.com/acme/project"));
});

test("personal inbox does not silently accept unsupported providers or cross-repository search results", () => {
  assert.throws(
    () =>
      readOpenPullRequests(
        addressOf("https://git.example/acme/project/pulls/1"),
        { gh: unused, api: unused },
        "requested",
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      readOpenPullRequests(
        addressOf("https://github.com/acme/project/pull/1"),
        {
          api: unused,
          gh: (args) =>
            args[0] === "api"
              ? JSON.stringify([[github(1)]])
              : JSON.stringify([{ url: github(2, "other/repo").html_url }]),
        },
        "requested",
      ),
    /another repository/,
  );
});

test("GitLab inbox filters by authenticated reviewer id", () => {
  const paths: string[] = [];
  readOpenPullRequests(
    addressOf("https://git.example/team/project/-/merge_requests/1"),
    {
      gh: unused,
      api: (_, path) => {
        paths.push(path);
        return path === "/api/v4/user" ? { id: 42 } : [];
      },
    },
    "requested",
  );
  assert.match(paths[1] ?? "", /reviewer_id=42/);
});
