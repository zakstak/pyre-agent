import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryPullRequests } from "./pull-requests.ts";

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
