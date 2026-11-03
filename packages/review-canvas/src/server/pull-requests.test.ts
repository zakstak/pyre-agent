import assert from "node:assert/strict";
import { test } from "node:test";
import * as Result from "effect/Result";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type { CommitSha, RepoPath } from "../schema/primitives.ts";
import type { OpenPullRequest } from "../schema/pull-requests.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { Store } from "../store/store.ts";
import { pushedSince, repositoryPullRequests } from "./pull-requests.ts";

test("discovery of an unconfigured host stays local and explains the missing provider", async () => {
  const result = await repositoryPullRequests(
    "unknown.invalid/team/project",
    new AbortController().signal,
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable")
    assert.match(result.message, /REVIEW_CANVAS_FORGE_HOSTS/);
});
test("an already cancelled read starts no worker", async () => {
  const result = await repositoryPullRequests(
    "github.com/acme/project",
    AbortSignal.abort(),
  );
  assert.deepEqual(result, {
    kind: "unavailable",
    message: "PR discovery cancelled.",
  });
});

const pullRequestInput = () => {
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/pull-request.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  return decoded.success;
};

test("a review learns of a push from the open list only while the list shows a head its round and drift do not", () => {
  const store = Store.open(":memory:");
  const input = pullRequestInput();
  const { review, thread } = store.register({
    target: input.target,
    label: "Claude Code: test",
    host: { kind: "claude-code" },
  });
  const id = review.state.id;
  const listed = (head: string | undefined): OpenPullRequest => ({
    url: input.target.kind === "worktree" ? assert.fail() : input.target.url,
    title: "Retry",
    base_branch: "main",
    head_branch: "retry",
    same_repository: true,
    ...(head === undefined ? {} : { head_sha: head as CommitSha }),
  });
  const pushed = "3".repeat(40);
  // No round yet, and a host that names no head: nothing to compare.
  assert.equal(pushedSince(store, listed(pushed)), undefined);
  store.publish(id, thread.id, input);
  assert.equal(pushedSince(store, listed(undefined)), undefined);
  // The round's head, in any case: nothing was pushed.
  assert.equal(
    pushedSince(store, listed(input.target.head_sha.toUpperCase())),
    undefined,
  );
  const since = pushedSince(store, listed(pushed));
  assert.deepEqual(
    since === undefined ? undefined : [since.review, since.from, since.to],
    [id, input.target.head_sha, pushed],
  );
  // An agent's check that could not compare the head leaves the comparison to the server; one that did, does not.
  store.act(id, { kind: "drift", paths: [], head_sha: pushed as CommitSha });
  assert.notEqual(pushedSince(store, listed(pushed)), undefined);
  store.act(id, {
    kind: "drift",
    paths: ["src/retry.py" as RepoPath],
    head_sha: pushed as CommitSha,
    compared: { kind: "listed", commits: 1 },
  });
  assert.equal(pushedSince(store, listed(pushed)), undefined);
  // A later push is new again.
  assert.notEqual(pushedSince(store, listed("4".repeat(40))), undefined);
});
