import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureBytes } from "../schema/testing.ts";
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

/** Both listeners on one store: the agent API on a socket, the pages on a loopback port. */
const withServers = (
  check: (
    agent: { socketPath: string },
    pages: { port: number },
  ) => Promise<void>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "review-canvas-agent-"));
  const socketPath = join(dir, "agent.sock");
  const TestAssets = Layer.succeed(Assets, { styles: [], scripts: [] });
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

test("an agent registers, publishes, and answers; a page comments, submits, and exports", () =>
  withServers(async (agent, pages) => {
    const registered = await call(agent, "POST", "/agent/register", {
      body: JSON.stringify({
        target: input().target,
        label: "Claude Code: atomic save",
        host: { kind: "claude-code" },
      }),
    });
    assert.equal(registered.status, 200, registered.text);
    const { review, token } = registered.body as {
      review: string;
      token: string;
    };
    assert.equal(
      registered.body.url,
      `http://127.0.0.1:${pages.port}/reviews/${review}`,
    );

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
    const unauthorized = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(unauthorized.status, 401);

    // Before a round, the page waits.
    const waiting = await call(pages, "GET", `/reviews/${review}`);
    assert.equal(waiting.status, 200);
    assert.match(waiting.text, /Waiting for the first round/);

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

    const page = await call(pages, "GET", `/reviews/${review}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Write notes atomically/);
    assert.match(page.text, /data-revision="2"/);
    assert.match(page.text, /class="stop"/);

    // A page action needs this server's Origin.
    const action = (body: unknown, origin = `http://127.0.0.1:${pages.port}`) =>
      call(pages, "POST", `/reviews/${review}/actions`, {
        body: JSON.stringify(body),
        headers: { origin },
      });
    const foreign = await action(
      { action: { kind: "general_comment", body: "x" } },
      "http://evil.example",
    );
    assert.equal(foreign.status, 403);
    const commented = await action({
      action: {
        kind: "comment",
        selection: { path: "src/notes/store.py", start_row: 13, end_row: 15 },
        body: "Lock first.",
      },
      revision: 2,
    });
    assert.equal(commented.status, 200, commented.text);
    assert.equal(commented.body.revision, 3);
    const stale = await action({
      action: { kind: "general_comment", body: "late" },
      revision: 2,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.kind, "stale");
    assert.equal(stale.body.error.revision, 3);

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
    const submitted = await action({
      action: { kind: "submit", verdict: "approve", body: "Ship it." },
    });
    assert.equal(submitted.status, 200, submitted.text);
    const after = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(after.body.status.submission.verdict, "approve");

    // Export is the feedback document, and the list page shows the review.
    const exported = await call(
      pages,
      "GET",
      `/reviews/${review}/feedback.json`,
    );
    assert.equal(exported.status, 200);
    assert.equal(exported.body.format, "review-canvas.feedback/1");
    assert.equal(exported.body.comments.length, 1);
    assert.equal(exported.body.submissions.length, 1);
    const home = await call(pages, "GET", "/");
    assert.match(home.text, /Write notes atomically/);
    assert.match(home.text, /Finished/);

    // A page on the loopback port cannot reach the agent API.
    const crossed = await call(pages, "POST", "/agent/register", {
      body: "{}",
    });
    assert.equal(crossed.status, 404);
  }));

test("the event stream reports the revision, then each change", () =>
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
    await call(agent, "POST", `/agent/reviews/${review}/rounds`, {
      body: fixtureBytes("input/worktree.json"),
      headers: { authorization: `Bearer ${token}` },
    });
    const events = await new Promise<string>((resolve, reject) => {
      let done = false;
      let posted: Promise<unknown> = Promise.resolve();
      const req = request(
        {
          host: "127.0.0.1",
          port: pages.port,
          path: `/reviews/${review}/events`,
          headers: { host: `127.0.0.1:${pages.port}` },
        },
        (response) => {
          assert.match(
            String(response.headers["content-type"]),
            /text\/event-stream/,
          );
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
            if (
              text.includes('"revision":2') &&
              !text.includes('"revision":3')
            ) {
              posted = call(pages, "POST", `/reviews/${review}/actions`, {
                body: JSON.stringify({
                  action: { kind: "general_comment", body: "Hello" },
                }),
                headers: { origin: `http://127.0.0.1:${pages.port}` },
              });
            }
            if (text.includes('"revision":3')) {
              done = true;
              response.on("error", () => {});
              req.destroy();
              void posted.then(() => resolve(text));
            }
          });
        },
      );
      // Closing the stream from this side resets the socket; that is the expected end, not a failure.
      req.on("error", (error) => {
        if (!done) reject(error);
      });
      req.end();
    });
    assert.match(events, /event: change\ndata: \{"revision":2\}/);
    assert.match(events, /event: change\ndata: \{"revision":3\}/);
  }));
