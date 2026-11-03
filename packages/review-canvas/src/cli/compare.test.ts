import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitSha, PullRequestUrl } from "../schema/primitives.ts";
import { ForgeFailed } from "./forge-api.ts";
import { compareHeads, comparePushed, type ForgeClients } from "./hosted.ts";

const FROM = "a".repeat(40) as CommitSha;
const TO = "b".repeat(40) as CommitSha;
const unused = (): never => {
  throw new Error("unexpected client");
};

test("GitHub lists the files of a fast-forward, and past its file limit says the list is partial", () => {
  const url = "https://github.com/acme/project/pull/3" as PullRequestUrl;
  const answer = (files: number): ForgeClients => ({
    gh: () =>
      JSON.stringify({
        ahead_by: 4,
        behind_by: 0,
        files: Array.from({ length: files }, (_, at) => ({
          filename: `f${String(at).padStart(3, "0")}`,
        })),
      }),
    api: unused,
  });
  assert.deepEqual(compareHeads(url, FROM, TO, answer(2)), {
    comparison: { kind: "listed", commits: 4 },
    paths: ["f000", "f001"],
  });
  const many = compareHeads(url, FROM, TO, answer(300));
  assert.equal(many.comparison.kind, "unlisted");
  assert.equal(many.paths.length, 300);
});

test("GitLab compares the two trees directly, so a rewritten head still lists its files", () => {
  const url =
    "https://git.example/team/project/-/merge_requests/3" as PullRequestUrl;
  const paths: Array<string> = [];
  const clients = (timeout: boolean): ForgeClients => ({
    gh: unused,
    api: (_, path) => {
      paths.push(path);
      return {
        commits: [{}, {}],
        diffs: [
          { old_path: "old.ts", new_path: "new.ts" },
          { old_path: "same.ts", new_path: "same.ts" },
        ],
        compare_timeout: timeout,
      };
    },
  });
  assert.deepEqual(compareHeads(url, FROM, TO, clients(false)), {
    comparison: { kind: "listed", commits: 2 },
    paths: ["new.ts", "old.ts", "same.ts"],
  });
  assert.deepEqual(paths, [
    `/api/v4/projects/team%2Fproject/repository/compare?from=${FROM}&to=${TO}&straight=true`,
  ]);
  assert.equal(
    compareHeads(url, FROM, TO, clients(true)).comparison.kind,
    "unlisted",
  );
});

test("Gitea lists the files the new commits touch, unless the old head has commits the new one lost", () => {
  const url = "https://git.example/team/project/pulls/3" as PullRequestUrl;
  const clients = (lost: number): ForgeClients => ({
    gh: unused,
    api: (_, path) =>
      path.endsWith(`${FROM}...${TO}`)
        ? {
            total_commits: 2,
            commits: [
              { files: [{ filename: "b.ts" }, { filename: "a.ts" }] },
              { files: [{ filename: "a.ts" }] },
            ],
          }
        : { total_commits: lost, commits: [] },
  });
  assert.deepEqual(compareHeads(url, FROM, TO, clients(0)), {
    comparison: { kind: "listed", commits: 2 },
    paths: ["a.ts", "b.ts"],
  });
  assert.deepEqual(compareHeads(url, FROM, TO, clients(1)).comparison, {
    kind: "unlisted",
    commits: 2,
    reason:
      "The head was rewritten, as by a force-push, so the host cannot list the files that differ from the round's head.",
  });
});

test("a host that cannot compare says why, and an unreadable answer is the host's failure", () => {
  const url = "https://github.com/acme/project/pull/3" as PullRequestUrl;
  const failing: ForgeClients = {
    gh: () => {
      throw new ForgeFailed("no API access");
    },
    api: unused,
  };
  assert.deepEqual(comparePushed(url, FROM, TO, failing), {
    comparison: {
      kind: "failed",
      reason: "The host could not compare the heads: no API access",
    },
    paths: [],
  });
  const garbled: ForgeClients = { gh: () => "not json", api: unused };
  assert.equal(comparePushed(url, FROM, TO, garbled).comparison.kind, "failed");
});
