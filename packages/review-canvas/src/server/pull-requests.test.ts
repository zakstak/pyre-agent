import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import * as Result from "effect/Result";
import { decodeBytes, InputDocument } from "../schema/document.ts";
import type {
  CommitSha,
  PullRequestUrl,
  RepoPath,
} from "../schema/primitives.ts";
import type { ComparedHeads, PullHead } from "../schema/pull-requests.ts";
import { fixtureBytes } from "../schema/testing.ts";
import { Store } from "../store/store.ts";
import {
  COMPARE_AGAIN_MS,
  type HeadSeen,
  makePushes,
  type PushHost,
  pushedSince,
  repositoryPullRequests,
} from "./pull-requests.ts";

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

/** A review of the fixture's pull request, registered and not yet published. */
const pullRequestReview = () => {
  const store = Store.open(":memory:");
  const input = pullRequestInput();
  const { review, thread } = store.register({
    target: input.target,
    label: "Claude Code: test",
    host: { kind: "claude-code" },
  });
  const url: PullRequestUrl =
    input.target.kind === "worktree" ? assert.fail() : input.target.url;
  const publish = (head: string) =>
    store.publish(review.state.id, thread.id, {
      ...input,
      target: { ...input.target, head_sha: head as CommitSha },
    });
  /** A head the host showed, from a read that began `from` (by default now) or later than anything stored. */
  const seen = (head: string, from = Date.now() + 1): HeadSeen => ({
    url,
    head_sha: head as CommitSha,
    read_from: from,
  });
  return {
    store,
    id: review.state.id,
    url,
    roundHead: input.target.head_sha,
    publish,
    seen,
  };
};

const PUSHED = "3".repeat(40);

test("a review learns of a push only from a head its round and drift do not hold", () => {
  const { store, id, roundHead, publish, seen } = pullRequestReview();
  // No round yet: nothing to compare.
  assert.equal(pushedSince(store, seen(PUSHED)), undefined);
  publish(roundHead);
  // The round's head, in any case: nothing was pushed.
  assert.equal(pushedSince(store, seen(roundHead.toUpperCase())), undefined);
  assert.deepEqual(pushedSince(store, seen(PUSHED)), {
    kind: "compare",
    review: id,
    revision: store.review(id)?.revision,
    url: seen(PUSHED).url,
    from: roundHead,
    to: PUSHED,
  });
  // An agent's check that could not compare the head leaves the comparison to the server; one that did, does not.
  store.act(id, { kind: "drift", paths: [], head_sha: PUSHED as CommitSha });
  assert.equal(pushedSince(store, seen(PUSHED))?.kind, "compare");
  store.act(id, {
    kind: "drift",
    paths: ["src/retry.py" as RepoPath],
    head_sha: PUSHED as CommitSha,
    compared: { kind: "listed", commits: 1 },
  });
  assert.equal(pushedSince(store, seen(PUSHED)), undefined);
  // A later push is new again.
  assert.equal(pushedSince(store, seen("4".repeat(40)))?.kind, "compare");
});

test("a head read before the round was published, or before the drift was recorded, teaches the review nothing", () => {
  const { store, id, roundHead, publish, seen } = pullRequestReview();
  publish(roundHead);
  // A page's list read starts; meanwhile the agent pushes and publishes round 2, and the list shows round 1's head.
  const began = Date.now();
  publish(PUSHED);
  assert.equal(pushedSince(store, seen(roundHead, began)), undefined);
  // A read that began after the round compares as usual.
  assert.equal(pushedSince(store, seen(roundHead))?.kind, "compare");
  // An agent's check recorded a newer head after a read began: the read cannot clear it or replace it.
  const before = Date.now();
  store.act(id, {
    kind: "drift",
    paths: [],
    head_sha: "4".repeat(40) as CommitSha,
    compared: { kind: "listed", commits: 1 },
  });
  assert.equal(pushedSince(store, seen(PUSHED, before)), undefined);
  assert.equal(pushedSince(store, seen("5".repeat(40), before)), undefined);
});

test("a recorded moved head clears once the host shows the round's head again", async () => {
  const { store, id, roundHead, publish, seen } = pullRequestReview();
  publish(roundHead);
  // A lagging host showed an older head, and the server recorded it as rewritten.
  store.act(id, {
    kind: "drift",
    paths: [],
    head_sha: PUSHED as CommitSha,
    compared: { kind: "unlisted", commits: 0, reason: "rewritten" },
  });
  assert.deepEqual(pushedSince(store, seen(roundHead.toUpperCase())), {
    kind: "clear",
    review: id,
    revision: store.review(id)?.revision,
    head_sha: roundHead.toUpperCase(),
  });
  const host: PushHost = {
    head: () => assert.fail("no head is read"),
    compare: () => assert.fail("nothing is compared"),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pushes = yield* makePushes(store, host);
        yield* pushes.notice([seen(roundHead)]);
      }),
    ),
  );
  assert.equal(store.review(id)?.state.drift, undefined);
  // With nothing recorded, the round's head teaches nothing.
  assert.equal(pushedSince(store, seen(roundHead)), undefined);
});

test("heads the host could not compare are compared again after a while, not on every read", () => {
  const { store, id, roundHead, publish, seen } = pullRequestReview();
  publish(roundHead);
  store.act(id, {
    kind: "drift",
    paths: [],
    head_sha: PUSHED as CommitSha,
    compared: {
      kind: "failed",
      reason: "The comparison of the heads timed out.",
    },
  });
  const failed = Date.parse(store.review(id)?.state.drift?.checked_at ?? "");
  assert.equal(pushedSince(store, seen(PUSHED, failed + 1)), undefined);
  assert.equal(
    pushedSince(store, seen(PUSHED, failed + COMPARE_AGAIN_MS - 1)),
    undefined,
  );
  assert.equal(
    pushedSince(store, seen(PUSHED, failed + COMPARE_AGAIN_MS))?.kind,
    "compare",
  );
});

const waitFor = (check: () => boolean, what: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 400 && !check(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check(), what);
  });

/** A host whose pull request's head is {@link PUSHED}, which records what it was asked. */
const pushedHost = () => {
  const reads: Array<PullRequestUrl> = [];
  const compared: Array<string> = [];
  const host: PushHost = {
    head: async (url): Promise<PullHead> => {
      reads.push(url);
      return { kind: "ready", head_sha: PUSHED as CommitSha };
    },
    compare: async (_url, from, to): Promise<ComparedHeads> => {
      compared.push(`${from}...${to}`);
      return {
        comparison: { kind: "listed", commits: 2 },
        paths: ["package.json" as RepoPath],
      };
    },
  };
  return { reads, compared, host };
};

test("a review a page shows reads its pull request's head on its own, once however many pages show it", async () => {
  const { store, id, url, roundHead, publish } = pullRequestReview();
  publish(roundHead);
  const { reads, compared, host } = pushedHost();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pushes = yield* makePushes(store, host, "1 hour");
        // Two pages show the review: the server reads its head once, at once, and records what was pushed.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pushes.watch(id);
            yield* pushes.watch(id);
            yield* waitFor(
              () => store.review(id)?.state.drift !== undefined,
              "the drift is recorded",
            );
            assert.deepEqual(reads, [url]);
          }),
        );
        // The last page left, which stopped the reads: the next page to show the review reads at once again.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pushes.watch(id);
            yield* waitFor(() => reads.length === 2, "the head is read again");
          }),
        );
      }),
    ),
  );
  // The second read found the head the drift records: nothing to compare again.
  assert.deepEqual(compared, [`${roundHead}...${PUSHED}`]);
  const drift = store.review(id)?.state.drift;
  assert.equal(drift?.head_sha, PUSHED);
  assert.deepEqual(drift?.paths, ["package.json"]);
  assert.deepEqual(drift?.compared, { kind: "listed", commits: 2 });
});

test("the server reads a shown review's head again and again, and stops when no page shows it", async () => {
  const { store, id, roundHead, publish } = pullRequestReview();
  publish(roundHead);
  const { reads, host } = pushedHost();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pushes = yield* makePushes(store, host, "10 millis");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pushes.watch(id);
            yield* waitFor(() => reads.length >= 3, "the head is read again");
          }),
        );
        const stopped = reads.length;
        yield* Effect.sleep("60 millis");
        assert.equal(reads.length, stopped);
      }),
    ),
  );
});

test("a review of a working tree reads no head", async () => {
  const store = Store.open(":memory:");
  const decoded = decodeBytes(
    InputDocument,
    fixtureBytes("input/worktree.json"),
  );
  if (Result.isFailure(decoded)) assert.fail(decoded.failure.message);
  const { review, thread } = store.register({
    target: decoded.success.target,
    label: "Claude Code: test",
    host: { kind: "claude-code" },
  });
  store.publish(review.state.id, thread.id, decoded.success);
  const host: PushHost = {
    head: () => assert.fail("no head is read"),
    compare: () => assert.fail("nothing is compared"),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pushes = yield* makePushes(store, host, "10 millis");
        yield* pushes.watch(review.state.id);
        yield* Effect.sleep("30 millis");
      }),
    ),
  );
});
