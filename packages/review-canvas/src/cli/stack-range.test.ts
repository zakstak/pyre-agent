import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { CommitSha, PullRequestUrl } from "../schema/primitives.ts";
import { addressOf, type ForgeClients, readMergeBase } from "./hosted.ts";
import { hostStackPath } from "./stack-range.ts";

const sha = (n: number) =>
  Schema.decodeSync(CommitSha)(String(n).padStart(2, "0").repeat(20));
const github = (n: number) =>
  Schema.decodeSync(PullRequestUrl)(
    `https://github.com/example/notes/pull/${n}`,
  );

/**
 * An open stack #68 -> #69 on GitHub. #68's base is main, whose tip `mainTip` moved on after #68 branched from
 * `mergeBase`; #69's base is #68's branch, whose tip is #68's head.
 */
const openStack = (options: {
  readonly mainTip: string;
  readonly mergeBase: string;
  readonly calls: Array<string>;
}): ForgeClients => {
  const view = (n: number, base: string, branch: string) =>
    JSON.stringify({
      title: `PR ${n}`,
      url: github(n),
      baseRefOid: base,
      headRefOid: sha(n),
      baseRefName: branch,
      changedFiles: 1,
    });
  const pull = (n: number, base: string, head: string) => ({
    html_url: github(n),
    title: `PR ${n}`,
    base: { ref: base, repo: { full_name: "example/notes" } },
    head: { ref: head, repo: { full_name: "example/notes" } },
  });
  return {
    api: () => {
      throw new Error("GitHub is read through gh");
    },
    gh: (args) => {
      if (args[0] === "pr" && args[2] === github(68))
        return view(68, options.mainTip, "main");
      if (args[0] === "pr" && args[2] === github(69))
        return view(69, sha(68), "core");
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/pulls?state=open"))
        return JSON.stringify([
          [pull(68, "main", "core"), pull(69, "core", "ui")],
        ]);
      if (path.includes("/compare/")) {
        options.calls.push(path);
        return `${options.mergeBase}\n`;
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
};

test("an open path bases its root on the host's merge base, not main's moved tip, and each layer on its parent's head", () => {
  const calls: Array<string> = [];
  const found = hostStackPath(
    github(69),
    false,
    openStack({ mainTip: sha(10), mergeBase: sha(11), calls }),
  );
  assert.deepEqual(
    found.path.map((layer) => [layer.url, layer.head_sha, layer.base_sha]),
    [
      [github(68), sha(68), sha(11)],
      [github(69), sha(69), sha(68)],
    ],
  );
  // Only the root asks the host; a layer above it needs no merge base but its parent's head.
  assert.deepEqual(calls, [
    `repos/example/notes/compare/${sha(10)}...${sha(68)}?per_page=1`,
  ]);
  // main gaining unrelated commits changes its tip, not the merge base, so the pinned path is the same.
  const later = hostStackPath(
    github(69),
    false,
    openStack({ mainTip: sha(12), mergeBase: sha(11), calls: [] }),
  );
  assert.deepEqual(later.path, found.path);
});

test("GitLab and Gitea report the merge base a pull request's diff starts from", () => {
  const gitlab = Schema.decodeSync(PullRequestUrl)(
    "https://gitlab.example.com/group/notes/-/merge_requests/4",
  );
  const paths: Array<string> = [];
  assert.equal(
    readMergeBase(
      gitlab,
      { baseRefOid: sha(10), headRefOid: sha(4) },
      {
        gh: () => {
          throw new Error("GitLab is read through its API");
        },
        api: (pull, path) => {
          assert.equal(pull.host, addressOf(gitlab).host);
          paths.push(path);
          return { id: sha(11) };
        },
      },
    ),
    sha(11),
  );
  assert.deepEqual(paths, [
    `/api/v4/projects/group%2Fnotes/repository/merge_base?refs%5B%5D=${sha(10)}&refs%5B%5D=${sha(4)}`,
  ]);

  const gitea = Schema.decodeSync(PullRequestUrl)(
    "https://git.example.com/team/notes/pulls/5",
  );
  const giteaClients = (base: string): ForgeClients => ({
    gh: () => {
      throw new Error("Gitea is read through its API");
    },
    api: () => ({
      merge_base: sha(11),
      base: { sha: base },
      head: { sha: sha(5) },
    }),
  });
  assert.equal(
    readMergeBase(
      gitea,
      { baseRefOid: sha(10), headRefOid: sha(5) },
      giteaClients(sha(10)),
    ),
    sha(11),
  );
  // Gitea reports the merge base only for the current base; one that moved since it was read is refused.
  assert.throws(
    () =>
      readMergeBase(
        gitea,
        { baseRefOid: sha(10), headRefOid: sha(5) },
        giteaClients(sha(12)),
      ),
    /changed while reading its merge base/,
  );
});
