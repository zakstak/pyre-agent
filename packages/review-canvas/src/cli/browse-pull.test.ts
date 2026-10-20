import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { Fixture } from "../collector/testing.ts";
import { PullRequestUrl, WorktreeRoot } from "../schema/primitives.ts";
import { identifyRepository } from "../server/repositories.ts";
import { belongsToRepository, browsePullRequest } from "./browse-pull.ts";
import type { ForgeClients } from "./hosted.ts";

const url = Schema.decodeSync(PullRequestUrl)(
  "https://github.com/example/notes/pull/7",
);

test("opening a discovered PR collects committed objects without changing the checkout", async (t) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "before\n" });
  const base = f.head();
  f.commit({ "a.txt": "after\n" });
  const head = f.head();
  f.git(
    f.root,
    "remote",
    "add",
    "origin",
    "https://github.com/example/notes.git",
  );
  f.write("a.txt", "local work\n");
  const before = f.git(f.root, "status", "--porcelain");
  const clients: ForgeClients = {
    gh: (args) =>
      args[0] === "pr"
        ? JSON.stringify({
            title: "A change",
            url,
            baseRefOid: base,
            headRefOid: head,
            baseRefName: "main",
            changedFiles: 1,
          })
        : JSON.stringify({ filename: "a.txt" }),
    api: () => {
      throw new Error("Unexpected REST call");
    },
  };
  const result = await browsePullRequest(
    await identifyRepository(Schema.decodeSync(WorktreeRoot)(f.root)),
    url,
    clients,
  );
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.input.target.head_sha, head);
  assert.match(result.input.files[0]?.patch ?? "", /\+after/);
  assert.doesNotMatch(result.input.files[0]?.patch ?? "", /local work/);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(f.git(f.root, "status", "--porcelain"), before);
});

test("a URL outside the monitored identity is refused before host access", async (t) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "a\n" });
  f.git(
    f.root,
    "remote",
    "add",
    "origin",
    "https://github.com/other/project.git",
  );
  const unexpected = () => {
    throw new Error("Host access must not happen");
  };
  const result = await browsePullRequest(
    await identifyRepository(Schema.decodeSync(WorktreeRoot)(f.root)),
    url,
    { gh: unexpected, api: unexpected },
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable")
    assert.match(result.message, /does not belong/);
  assert.equal(belongsToRepository("github.com/EXAMPLE/notes", url), true);
  assert.equal(
    belongsToRepository("github.com/example/notes-elsewhere", url),
    false,
  );
});
