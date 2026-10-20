import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import {
  RpcClient,
  RpcClientError,
  type RpcGroup,
  RpcSerialization,
} from "effect/rpc";
import { Socket } from "effect/socket";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureBytes } from "../schema/testing.ts";
import {
  RepoPath,
  ReviewId,
  Revision,
  RoundNumber,
} from "../schema/primitives.ts";
import { PageAction, PageRpcs, Refused } from "../schema/rpc.ts";
import { StackId } from "../schema/primitives.ts";
import { StepKey } from "../schema/stack.ts";
import { patchDigest } from "../review/anchor.ts";
import { finishedSince, hasQuestions } from "./status.ts";
import { AgentApi } from "./agent.ts";
import { App } from "./app.ts";
import { Assets } from "./assets.ts";
import { activityLayer, PageAddress, storeLayer } from "./services.ts";

interface Reply {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}

/** A request to the agent socket or the page port, with JSON in and out. */
const call = (
  where: { socketPath: string } | { port: number },
  method: string,
  path: string,
  options: {
    body?: string | Uint8Array;
    headers?: Record<string, string>;
  } = {},
) =>
  new Promise<Reply>((resolve, reject) => {
    const headers: Record<string, string> = {
      host: "port" in where ? `127.0.0.1:${where.port}` : "agent",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    };
    const req = request(
      {
        ...("port" in where
          ? { host: "127.0.0.1", port: where.port }
          : { socketPath: where.socketPath }),
        method,
        path,
        headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body, text });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

type PageClient = RpcClient.RpcClient.Flat<
  RpcGroup.Rpcs<typeof PageRpcs>,
  RpcClientError.RpcClientError
>;

/**
 * Runs calls through the page RPCs over the socket, as a page on `origin` would. A call that never settles fails
 * after a while, so a regression fails the test instead of hanging it.
 */
const rpc = <A, E>(
  port: number,
  use: (client: PageClient) => Effect.Effect<A, E>,
  origin = `http://127.0.0.1:${port}`,
) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(RpcClient.make(PageRpcs, { flatten: true }), use),
    ).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`, {
              headers: { origin },
            }),
          ),
          // The browser's constructor sends no Origin; Node's can.
          Layer.provide(NodeSocket.layerWebSocketConstructor),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
      Effect.timeout("10 seconds"),
    ),
  );

/** What a page call returned; a failed call fails the test with its cause. */
const succeeded = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) assert.fail(String(exit.cause));
  return exit.value;
};

/** The refusal a page call failed with. */
const refused = <A, E>(exit: Exit.Exit<A, E>): Refused => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  assert.ok(error instanceof Refused, `expected a refusal: ${String(exit)}`);
  return error;
};

/** Whether a page call failed because the socket would not open, so no call reached the review. */
const unopened = <A, E>(exit: Exit.Exit<A, E>): boolean => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  return (
    error instanceof RpcClientError.RpcClientError &&
    error.reason._tag === "SocketOpenError"
  );
};

/** A page action, decoded by the RPC's own schema, on the revision the page saw when it names one. */
const act = (
  port: number,
  id: ReviewId,
  request: { action: typeof PageAction.Encoded; revision?: number },
  origin?: string,
) =>
  rpc(
    port,
    (client) =>
      client("review.act", {
        id,
        action: Schema.decodeSync(PageAction)(request.action),
        revision:
          request.revision === undefined
            ? undefined
            : Schema.decodeSync(Revision)(request.revision),
      }),
    origin,
  );

/** The review as a page that opens it now first receives it. */
const snapshotOf = async (port: number, id: ReviewId) =>
  Option.getOrThrow(
    succeeded(
      await rpc(port, (client) =>
        Stream.runHead(client("review.watch", { id })),
      ),
    ),
  );

/** A round's input and patch digests, as a page reads them. */
const roundOf = async (port: number, id: ReviewId, round: number) =>
  succeeded(
    await rpc(port, (client) =>
      client("review.round", {
        id,
        round: Schema.decodeSync(RoundNumber)(round),
      }),
    ),
  );

/** Both listeners on one store: the agent API on a socket, the pages on a loopback port. */
const withServers = (
  check: (
    agent: { socketPath: string },
    pages: { port: number },
  ) => Promise<void>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-agent-"));
  const socketPath = join(dir, "agent.sock");
  const TestAssets = Layer.succeed(Assets, { index: "<!doctype html>" });
  const PageServer = NodeHttpServer.layer(createServer, {
    host: "127.0.0.1",
    port: 0,
  });
  const Pages = HttpRouter.serve(App({ clientDir: dir }), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provideMerge(PageServer));
  const address = Layer.effect(
    PageAddress,
    Effect.map(HttpServer.HttpServer, ({ address }) => ({
      origin:
        address._tag === "UnixPathAddress"
          ? ""
          : `http://127.0.0.1:${address.port}`,
    })),
  );
  const Agents = HttpRouter.serve(AgentApi, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { path: socketPath })),
  );
  const Live = Layer.mergeAll(
    Pages,
    Agents.pipe(Layer.provide(address.pipe(Layer.provide(Pages)))),
  ).pipe(
    Layer.provide(TestAssets),
    Layer.provide(storeLayer(":memory:")),
    Layer.provide(activityLayer),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Live);
        const { address } = Context.get(context, HttpServer.HttpServer);
        assert.notEqual(address._tag, "UnixPathAddress");
        if (address._tag !== "UnixPathAddress")
          yield* Effect.promise(() =>
            check({ socketPath }, { port: address.port }),
          );
      }),
    ),
  );
};

const input = () =>
  JSON.parse(fixtureBytes("input/worktree.json").toString("utf8"));

/** The digest of a fixture file's patch, which the round the page reads must carry. */
const patchOf = (path: string): string =>
  patchDigest(
    (input().files as Array<{ path: string; patch?: string }>).find(
      (file) => file.path === path,
    )?.patch ?? "",
  );

const STORE = Schema.decodeSync(RepoPath)("src/notes/store.py");

for (const kind of ["claude-code", "codex", "t3"] as const) {
  test(`${kind}: an agent registers, publishes, and answers; a page comments, submits, and exports`, () =>
    withServers(async (agent, pages) => {
      const registered = await call(agent, "POST", "/agent/register", {
        body: JSON.stringify({
          target: input().target,
          label: `${kind}: atomic save`,
          host: { kind, session_id: "test-session" },
        }),
      });
      assert.equal(registered.status, 200, registered.text);
      assert.deepEqual(registered.body.thread.host, {
        kind,
        session_id: "test-session",
      });
      const { review, token } = registered.body as {
        review: string;
        token: string;
      };
      assert.equal(
        registered.body.url,
        `http://127.0.0.1:${pages.port}/reviews/${review}`,
      );
      const id = Schema.decodeSync(ReviewId)(review);

      // Unknown fields and bad tokens are refused.
      const extra = await call(agent, "POST", "/agent/register", {
        body: JSON.stringify({
          target: input().target,
          label: "x",
          host: { kind: "codex" },
          extra: 1,
        }),
      });
      assert.equal(extra.status, 400);
      assert.match(extra.body.error.message, /extra/);
      const unauthorized = await call(
        agent,
        "GET",
        `/agent/reviews/${review}`,
        {
          headers: { authorization: "Bearer nope" },
        },
      );
      assert.equal(unauthorized.status, 401);

      // Before a round, the page has no round to show, so it waits.
      const waiting = await snapshotOf(pages.port, id);
      assert.equal(waiting.revision, 1);
      assert.deepEqual(waiting.state.rounds, []);

      const published = await call(
        agent,
        "POST",
        `/agent/reviews/${review}/rounds`,
        {
          body: fixtureBytes("input/worktree.json"),
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(published.status, 200, published.text);
      assert.equal(published.body.round.round, 1);

      const page = await snapshotOf(pages.port, id);
      assert.equal(page.revision, 2);
      assert.equal(page.state.target.title, "Write notes atomically");
      assert.deepEqual(
        page.state.rounds.map((item) => item.round),
        [1],
      );
      // The page selects rows by the digest it receives, which names the patch the agent published.
      const round = await roundOf(pages.port, id, 1);
      assert.equal(round.input.files.length, input().files.length);
      assert.equal(round.digests[STORE], patchOf(STORE));

      // A page action needs this server's Origin: the socket refuses another, so the review stays at revision 2.
      const foreign = await act(
        pages.port,
        id,
        { action: { kind: "general_comment", body: "x" } },
        "http://evil.example",
      );
      assert.ok(unopened(foreign), String(foreign));
      const commented = succeeded(
        await act(pages.port, id, {
          action: {
            kind: "comment",
            selection: {
              path: STORE,
              patch_sha256: round.digests[STORE] ?? "",
              start_row: 13,
              end_row: 15,
            },
            body: "Lock first.",
          },
          revision: 2,
        }),
      );
      assert.equal(commented.revision, 3);
      const stale = refused(
        await act(pages.port, id, {
          action: { kind: "general_comment", body: "late" },
          revision: 2,
        }),
      );
      assert.equal(stale.kind, "stale");
      assert.equal(stale.revision, 3);
      assert.match(stale.message, /changed since the page loaded/);

      // The agent sees the comment as its turn, and its answer hands the turn back.
      const status = await call(agent, "GET", `/agent/reviews/${review}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(status.body.status.to_answer.length, 1);
      const commentId = status.body.status.to_answer[0];
      const answered = await call(
        agent,
        "POST",
        `/agent/reviews/${review}/answers`,
        {
          body: JSON.stringify({
            comment: commentId,
            answer: {
              disposition: "rejected",
              body: "A lock is not needed: rename is atomic.",
            },
          }),
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(answered.status, 200, answered.text);
      const again = await call(
        agent,
        "POST",
        `/agent/reviews/${review}/answers`,
        {
          body: JSON.stringify({
            comment: commentId,
            answer: { disposition: "question", body: "?" },
          }),
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(again.status, 409);
      assert.equal(again.body.error.kind, "not_your_turn");

      // The wait returns at once when the revision moved, and the submission ends the reviewer's turn.
      const waited = await call(
        agent,
        "GET",
        `/agent/reviews/${review}/wait?revision=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(waited.body.status.revision, 4);
      const submitted = succeeded(
        await act(pages.port, id, {
          action: {
            kind: "submit",
            round: 1,
            verdict: "approve",
            body: "Ship it.",
          },
        }),
      );
      const after = await call(agent, "GET", `/agent/reviews/${review}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(after.body.status.submission.verdict, "approve");
      const finishedAt = after.body.status.submission.revision;
      assert.equal(finishedAt, submitted.revision);
      // A finish that happened before the agent started waiting still counts; one it already read does not.
      assert.ok(finishedSince(after.body.status, 0));
      assert.equal(finishedSince(after.body.status, finishedAt), false);
      // A later comment is not a new finish.
      succeeded(
        await act(pages.port, id, {
          action: { kind: "general_comment", body: "One more thing." },
        }),
      );
      const later = await call(agent, "GET", `/agent/reviews/${review}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(later.body.status.revision > finishedAt);
      assert.equal(finishedSince(later.body.status, finishedAt), false);
      assert.equal(
        later.body.status.feedback.submissions[0].revision,
        undefined,
      );

      // Export is the feedback document, and the home page lists the review with its finished round.
      const exported = await call(
        pages,
        "GET",
        `/reviews/${review}/feedback.json`,
      );
      assert.equal(exported.status, 200);
      assert.equal(exported.body.format, "review-canvas.feedback/1");
      assert.equal(exported.body.comments.length, 2);
      assert.equal(exported.body.submissions.length, 1);
      assert.deepEqual(exported.body.threads[0].host, {
        kind,
        session_id: "test-session",
      });
      const home = succeeded(
        await rpc(pages.port, (client) => client("home.load", {})),
      );
      const listed = home.reviews.find((item) => item.id === id);
      assert.equal(listed?.target.title, "Write notes atomically");
      assert.equal(listed.round, 1);
      assert.equal(listed.submitted, true);
      assert.equal(listed.verdict, "approve");
      assert.deepEqual(listed.threads[0]?.host, {
        kind,
        session_id: "test-session",
      });

      // A page on the loopback port cannot reach the agent API.
      const crossed = await call(pages, "POST", "/agent/register", {
        body: "{}",
      });
      assert.equal(crossed.status, 404);
    }));
}

test("the review watch reports the revision, then each change", () =>
  withServers(async (agent, pages) => {
    const registered = await call(agent, "POST", "/agent/register", {
      body: JSON.stringify({
        target: input().target,
        label: "Codex",
        host: { kind: "codex" },
      }),
    });
    const { review, token } = registered.body as {
      review: string;
      token: string;
    };
    const id = Schema.decodeSync(ReviewId)(review);
    await call(agent, "POST", `/agent/reviews/${review}/rounds`, {
      body: fixtureBytes("input/worktree.json"),
      headers: { authorization: `Bearer ${token}` },
    });
    const answer = (comment: string) =>
      call(agent, "POST", `/agent/reviews/${review}/answers`, {
        body: JSON.stringify({
          comment,
          answer: { disposition: "answered", body: "Hello to you." },
        }),
        headers: { authorization: `Bearer ${token}` },
      });
    const hello = Schema.decodeSync(PageAction)({
      kind: "general_comment",
      body: "Hello",
    });
    const snapshots = succeeded(
      await rpc(pages.port, (client) =>
        client("review.watch", { id }).pipe(
          Stream.take(3),
          // Each change waits for the snapshot before it: the watch keeps only the newest, so two changes made
          // together would arrive as one.
          Stream.tap((snapshot) =>
            Effect.gen(function* () {
              if (snapshot.revision === 2)
                yield* client("review.act", { id, action: hello });
              const comment = snapshot.state.comments[0];
              if (snapshot.revision === 3 && comment !== undefined)
                yield* Effect.promise(async () => {
                  const answered = await answer(comment.id);
                  assert.equal(answered.status, 200, answered.text);
                });
            }),
          ),
          Stream.runCollect,
        ),
      ),
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.revision),
      [2, 3, 4],
    );
    assert.deepEqual(
      snapshots.map((snapshot) =>
        snapshot.state.comments[0]?.replies.map((reply) => reply.actor),
      ),
      [undefined, [], ["agent"]],
    );
  }));

test("a comment on a file that leaves the round stays in the review, though the round no longer holds the file", () =>
  withServers(async (agent, pages) => {
    const registered = await call(agent, "POST", "/agent/register", {
      body: JSON.stringify({
        target: input().target,
        label: "Claude Code",
        host: { kind: "claude-code" },
      }),
    });
    const { review, token } = registered.body as {
      review: string;
      token: string;
    };
    const id = Schema.decodeSync(ReviewId)(review);
    const publish = (round: unknown) =>
      call(agent, "POST", `/agent/reviews/${review}/rounds`, {
        body: JSON.stringify(round),
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await publish(input())).status, 200);
    const first = await roundOf(pages.port, id, 1);
    succeeded(
      await act(pages.port, id, {
        action: {
          kind: "comment",
          selection: {
            path: STORE,
            patch_sha256: first.digests[STORE] ?? "",
            start_row: 13,
            end_row: 15,
          },
          body: "Lock before the rename.",
        },
      }),
    );

    // Round 2 reverts store.py, so no file block can show the comment; the page lists it with the files that left.
    const second = input();
    second.files = second.files.filter(
      (file: { path: string }) => file.path !== STORE,
    );
    second.target.changed_files = second.files.length;
    assert.equal((await publish(second)).status, 200);
    const page = await snapshotOf(pages.port, id);
    assert.deepEqual(
      page.state.rounds.map((item) => item.round),
      [1, 2],
    );
    const [comment] = page.state.comments;
    assert.equal(comment?.body, "Lock before the rename.");
    assert.equal(comment.kind === "inline" && comment.anchor.path, STORE);
    const current = await roundOf(pages.port, id, 2);
    assert.ok(current.input.files.length > 0);
    assert.equal(
      current.input.files.some((file) => file.path === STORE),
      false,
    );
    assert.equal(current.digests[STORE], undefined);
  }));

test("agents report drift and GitHub comments; pages import feedback", () =>
  withServers(async (agent, pages) => {
    const registered = await call(agent, "POST", "/agent/register", {
      body: JSON.stringify({
        target: input().target,
        label: "Claude Code",
        host: { kind: "claude-code" },
      }),
    });
    const { review, token } = registered.body as {
      review: string;
      token: string;
    };
    const id = Schema.decodeSync(ReviewId)(review);
    const auth = { authorization: `Bearer ${token}` };
    await call(agent, "POST", `/agent/reviews/${review}/rounds`, {
      body: fixtureBytes("input/worktree.json"),
      headers: auth,
    });

    const drift = await call(agent, "POST", `/agent/reviews/${review}/drift`, {
      body: JSON.stringify({ paths: [STORE] }),
      headers: auth,
    });
    assert.equal(drift.status, 200, drift.text);
    const status = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: auth,
    });
    assert.deepEqual(status.body.status.drift.paths, [STORE]);
    assert.ok(status.body.status.files.length > 0);
    // The page shows the drift of the round it describes.
    const drifted = (await snapshotOf(pages.port, id)).state.drift;
    assert.equal(drifted?.round, 1);
    assert.deepEqual(drifted.paths, [STORE]);

    const github = await call(
      agent,
      "POST",
      `/agent/reviews/${review}/github`,
      {
        body: JSON.stringify({
          pull_request: "https://github.com/example/notes/pull/7",
          items: [
            {
              kind: "conversation",
              id: "IC_1",
              author: "octocat",
              url: "https://github.com/example/notes/pull/7#issuecomment-1",
              body: "Please add a test.",
              created_at: "2026-10-12T00:00:00.000Z",
            },
          ],
        }),
        headers: auth,
      },
    );
    assert.equal(github.status, 200, github.text);
    assert.equal(github.body.report.comments, 1);

    // A question asked now shows as the agents' to answer at once.
    succeeded(
      await act(pages.port, id, {
        action: {
          kind: "general_comment",
          body: "Why a temp file?",
          question: true,
        },
      }),
    );
    const asked = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: auth,
    });
    assert.equal(asked.body.status.questions.length, 1);
    assert.ok(hasQuestions(asked.body.status));

    // Export, then import into the same review: everything is already here.
    const exported = await call(
      pages,
      "GET",
      `/reviews/${review}/feedback.json`,
    );
    const importing = (text: string, origin?: string) =>
      rpc(
        pages.port,
        (client) => client("review.import", { id, text }),
        origin,
      );
    const foreign = await importing(exported.text, "http://evil.example");
    assert.ok(unopened(foreign), String(foreign));
    const imported = succeeded(await importing(exported.text));
    assert.equal(imported.report.comments, 0);
    assert.equal(imported.report.already, 2);
    const garbage = refused(
      await importing('{"format":"review-canvas.feedback/1"}'),
    );
    assert.equal(garbage.kind, "schema");
  }));

test("a file the next round changes reaches the page in both rounds, for the page to compare", () =>
  withServers(async (agent, pages) => {
    const round = (text: string) => {
      const base = input();
      base.files_complete = false;
      base.files = [
        {
          path: "notes.txt",
          status: "added",
          group: "core",
          additions: text.split("\n").length - 1,
          deletions: 0,
          fingerprint: (text.includes("three") ? "3" : "2").repeat(64),
          patch: `@@ -0,0 +1,${text.split("\n").length - 1} @@\n${text
            .split("\n")
            .slice(0, -1)
            .map((line) => `+${line}`)
            .join("\n")}\n`,
          new_content: text,
        },
      ];
      return base;
    };
    const first = round("one\ntwo\n");
    const registered = await call(agent, "POST", "/agent/register", {
      body: JSON.stringify({
        target: first.target,
        label: "Claude Code",
        host: { kind: "claude-code" },
      }),
    });
    const { review, token } = registered.body as {
      review: string;
      token: string;
    };
    const id = Schema.decodeSync(ReviewId)(review);
    const publish = (body: unknown) =>
      call(agent, "POST", `/agent/reviews/${review}/rounds`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await publish(first)).status, 200);
    // With one round there is no round before to compare with.
    assert.deepEqual(
      (await snapshotOf(pages.port, id)).state.rounds.map((item) => item.round),
      [1],
    );
    assert.equal((await publish(round("one\ntwo\nthree\n"))).status, 200);
    assert.deepEqual(
      (await snapshotOf(pages.port, id)).state.rounds.map((item) => item.round),
      [1, 2],
    );
    // The page reads the round before beside the current one: a new fingerprint says the file changed, and the two
    // contents give the patch between the rounds.
    const [before] = (await roundOf(pages.port, id, 1)).input.files;
    const [now] = (await roundOf(pages.port, id, 2)).input.files;
    assert.equal(before?.path, "notes.txt");
    assert.equal(now?.path, "notes.txt");
    assert.notEqual(before.fingerprint, now.fingerprint);
    assert.equal(before.new_content, "one\ntwo\n");
    assert.equal(now.new_content, "one\ntwo\nthree\n");
  }));

test("a stack walkthrough publishes over the socket with every layer's thread, and pages move through it", () =>
  withServers(async (agent, pages) => {
    const pr = JSON.parse(
      fixtureBytes("input/pull-request.json").toString("utf8"),
    );
    const url = (n: number) =>
      `https://github.com/example/retry-demo/pull/${n}`;
    const sessions: Array<{ review: string; token: string }> = [];
    for (const n of [1, 2]) {
      const layer = {
        ...pr,
        target: { ...pr.target, url: url(n), head_sha: String(n).repeat(40) },
      };
      const registered = await call(agent, "POST", "/agent/register", {
        body: JSON.stringify({
          target: layer.target,
          label: `Layer ${n}`,
          host: { kind: "claude-code" },
        }),
      });
      assert.equal(registered.status, 200, registered.text);
      const published = await call(
        agent,
        "POST",
        `/agent/reviews/${registered.body.review}/rounds`,
        {
          body: JSON.stringify(layer),
          headers: { authorization: `Bearer ${registered.body.token}` },
        },
      );
      assert.equal(published.status, 200, published.text);
      sessions.push({
        review: registered.body.review,
        token: registered.body.token,
      });
    }
    const body = (tokens: typeof sessions) =>
      JSON.stringify({
        walkthrough: {
          format: "review-canvas.stack/1",
          title: "Retry stack",
          tip: url(2),
          steps: [1, 2].map((n) => ({
            layer: url(n),
            title: `Layer ${n}`,
            summary: "",
            attention: null,
            excerpts: [],
            files: [{ path: "src/retry.py" }],
            notes: [],
            questions: [],
          })),
        },
        historical: false,
        path: [1, 2].map((n) => ({
          url: url(n),
          title: `Layer ${n}`,
          head_sha: String(n).repeat(40),
        })),
        excluded: [],
        sessions: tokens,
      });
    const forged = await call(agent, "POST", "/agent/stacks", {
      body: body(
        sessions.map((item, index) =>
          index === 1 ? { ...item, token: sessions[0]?.token ?? "" } : item,
        ),
      ),
    });
    assert.equal(forged.status, 401, forged.text);
    const missing = await call(agent, "POST", "/agent/stacks", {
      body: body(sessions.slice(0, 1)),
    });
    assert.equal(missing.status, 400, missing.text);
    assert.match(missing.body.error.message, /No thread given for #2/);
    const published = await call(agent, "POST", "/agent/stacks", {
      body: body(sessions),
    });
    assert.equal(published.status, 200, published.text);
    assert.match(published.body.url, /\/stacks\/stack-/);
    assert.deepEqual(
      published.body.steps.map((step: { key: string }) => step.key),
      ["L0:S0", "L0:other", "L1:S0", "L1:other"],
    );
    const id = Schema.decodeSync(StackId)(published.body.stack);
    const step = Schema.decodeSync(StepKey);
    succeeded(
      await rpc(pages.port, (client) =>
        client("stack.act", {
          id,
          action: { kind: "go", step: step("L1:S0"), read: step("L0:other") },
        }),
      ),
    );
    const snapshot = succeeded(
      await rpc(pages.port, (client) =>
        client("stack.watch", { id }).pipe(Stream.runHead),
      ),
    );
    assert.equal(Option.getOrUndefined(snapshot)?.position, "L1:S0");
    assert.equal(
      refused(
        await rpc(pages.port, (client) =>
          client("stack.act", {
            id: Schema.decodeSync(StackId)("stack-none"),
            action: { kind: "unread", step: step("L0:S0") },
          }),
        ),
      ).kind,
      "not_found",
    );
    const home = succeeded(
      await rpc(pages.port, (client) => client("home.load", {})),
    );
    assert.deepEqual(
      home.stacks.map((item) => [item.id, item.read]),
      [[id, 1]],
    );
  }));
