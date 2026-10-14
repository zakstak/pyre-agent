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
import { patchDigest } from "../review/patch.ts";
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

/** The digest of a fixture file's patch, as the page's table carries it. */
const patchOf = (path: string): string =>
  patchDigest(
    (input().files as Array<{ path: string; patch?: string }>).find(
      (file) => file.path === path,
    )?.patch ?? "",
  );

/** Every id attribute on a page, with how often it appears. */
const repeatedIds = (page: string) => {
  const counts = new Map<string, number>();
  for (const [, id] of page.matchAll(/\sid="([^"]+)"/g))
    counts.set(id ?? "", (counts.get(id ?? "") ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1);
};

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
    assert.match(page.text, /<section class="stop/);

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
        selection: {
          path: "src/notes/store.py",
          patch_sha256: patchOf("src/notes/store.py"),
          start_row: 13,
          end_row: 15,
        },
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
      action: {
        kind: "submit",
        round: 1,
        verdict: "approve",
        body: "Ship it.",
      },
    });
    assert.equal(submitted.status, 200, submitted.text);
    const after = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(after.body.status.submission.verdict, "approve");
    const finishedAt = after.body.status.submission.revision;
    assert.equal(finishedAt, submitted.body.revision);
    // A finish that happened before the agent started waiting still counts; one it already read does not.
    assert.ok(finishedSince(after.body.status, 0));
    assert.equal(finishedSince(after.body.status, finishedAt), false);
    // A later comment is not a new finish.
    await action({
      action: { kind: "general_comment", body: "One more thing." },
    });
    const later = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(later.body.status.revision > finishedAt);
    assert.equal(finishedSince(later.body.status, finishedAt), false);
    assert.equal(later.body.status.feedback.submissions[0].revision, undefined);

    // Export is the feedback document, and the list page shows the review.
    const exported = await call(
      pages,
      "GET",
      `/reviews/${review}/feedback.json`,
    );
    assert.equal(exported.status, 200);
    assert.equal(exported.body.format, "review-canvas.feedback/1");
    assert.equal(exported.body.comments.length, 2);
    assert.equal(exported.body.submissions.length, 1);
    const home = await call(pages, "GET", "/");
    assert.match(home.text, /Write notes atomically/);
    assert.match(home.text, /Round 1 finished/);

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

test("a comment on a file that leaves the round stays on the page, and no id repeats", () =>
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
    const publish = (round: unknown) =>
      call(agent, "POST", `/agent/reviews/${review}/rounds`, {
        body: JSON.stringify(round),
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await publish(input())).status, 200);
    const commented = await call(pages, "POST", `/reviews/${review}/actions`, {
      body: JSON.stringify({
        action: {
          kind: "comment",
          selection: {
            path: "src/notes/store.py",
            patch_sha256: patchOf("src/notes/store.py"),
            start_row: 13,
            end_row: 15,
          },
          body: "Lock before the rename.",
        },
      }),
      headers: { origin: `http://127.0.0.1:${pages.port}` },
    });
    assert.equal(commented.status, 200, commented.text);
    const first = await call(pages, "GET", `/reviews/${review}`);
    assert.deepEqual(repeatedIds(first.text), []);

    // Round 2 reverts store.py, so no file panel can show the comment.
    const second = input();
    second.files = second.files.filter(
      (file: { path: string }) => file.path !== "src/notes/store.py",
    );
    second.target.changed_files = second.files.length;
    assert.equal((await publish(second)).status, 200);
    const page = await call(pages, "GET", `/reviews/${review}`);
    assert.match(page.text, /Files that left the round/);
    assert.match(page.text, /Lock before the rename\./);
    assert.match(page.text, /The file is not in this round\./);
    assert.deepEqual(repeatedIds(page.text), []);
  }));

test("agents report drift and GitHub comments; pages import feedback and choose a layout", () =>
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
    const auth = { authorization: `Bearer ${token}` };
    await call(agent, "POST", `/agent/reviews/${review}/rounds`, {
      body: fixtureBytes("input/worktree.json"),
      headers: auth,
    });

    const drift = await call(agent, "POST", `/agent/reviews/${review}/drift`, {
      body: JSON.stringify({ paths: ["src/notes/store.py"] }),
      headers: auth,
    });
    assert.equal(drift.status, 200, drift.text);
    const status = await call(agent, "GET", `/agent/reviews/${review}`, {
      headers: auth,
    });
    assert.deepEqual(status.body.status.drift.paths, ["src/notes/store.py"]);
    assert.ok(status.body.status.files.length > 0);
    assert.match(
      (await call(pages, "GET", `/reviews/${review}`)).text,
      /Changed since this round:/,
    );

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
    const origin = { origin: `http://127.0.0.1:${pages.port}` };
    await call(pages, "POST", `/reviews/${review}/actions`, {
      body: JSON.stringify({
        action: {
          kind: "general_comment",
          body: "Why a temp file?",
          question: true,
        },
      }),
      headers: origin,
    });
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
    const foreign = await call(pages, "POST", `/reviews/${review}/import`, {
      body: exported.text,
      headers: { origin: "http://evil.example" },
    });
    assert.equal(foreign.status, 403);
    const imported = await call(pages, "POST", `/reviews/${review}/import`, {
      body: exported.text,
      headers: origin,
    });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.body.report.comments, 0);
    assert.equal(imported.body.report.already, 2);
    const garbage = await call(pages, "POST", `/reviews/${review}/import`, {
      body: '{"format":"review-canvas.feedback/1"}',
      headers: origin,
    });
    assert.equal(garbage.status, 400);

    // The layout cookie picks how whole files render.
    const split = await call(pages, "GET", `/reviews/${review}`, {
      headers: { cookie: "review-canvas-layout=split" },
    });
    assert.match(split.text, /<table class="diff split"/);
    assert.match(split.text, /data-layout="split" aria-pressed="true"/);
    assert.doesNotMatch(
      (await call(pages, "GET", `/reviews/${review}`)).text,
      /<table class="diff split"/,
    );
  }));

test("a file the next round changes shows what changed since the round before", () =>
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
    const publish = (body: unknown) =>
      call(agent, "POST", `/agent/reviews/${review}/rounds`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await publish(first)).status, 200);
    assert.doesNotMatch(
      (await call(pages, "GET", `/reviews/${review}`)).text,
      /Changes since round/,
    );
    assert.equal((await publish(round("one\ntwo\nthree\n"))).status, 200);
    const page = (await call(pages, "GET", `/reviews/${review}`)).text;
    assert.doesNotMatch(page, /unchanged since round 1/);
    // The header says so in a word that opens the patch between the rounds above the diff.
    assert.match(page, /aria-controls="since-f0">changed since round 1<\/button>/);
    // The patch between rounds holds only the new line, and offers no comment control.
    const since = page.slice(page.indexOf('id="since-f0"'));
    assert.match(since, /<td class="source"><code>three<\/code>/);
    assert.doesNotMatch(
      since.slice(0, since.indexOf('class="file-body"')),
      /add-comment/,
    );
  }));
