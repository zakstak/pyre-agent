#!/usr/bin/env node
/**
 * The agent's command-line tool. Every command prints JSON on success, so an agent reads one shape, and an error
 * line on failure with a non-zero exit.
 */
import * as Result from "effect/Result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  checkOutput,
  errorLine,
  report,
  writeOutput,
} from "../collector/output.ts";
import { collect, openWorktree } from "../collector/collect.ts";
import { CollectError, GitError } from "../collector/errors.ts";
import {
  decodeBytes,
  encodeDocument,
  FeedbackDocument,
  InputDocument,
} from "../schema/document.ts";
import type { Answer } from "../schema/feedback.ts";
import { HOSTS } from "../schema/thread.ts";
import type { Status } from "../server/status.ts";
import { call, ensureServer, expectOk, ServerError } from "./socket.ts";

const USAGE = `review-canvas: a local server where a reviewer walks an agent's change and the agent answers.

Commands
  serve                                   Run the server in the foreground (agents start it on demand).
  collect  --repo DIR --output FILE       Snapshot a working tree's uncommitted changes as review input.
           [--title TEXT] [--include-secret PATH]...
  register --session DIR --input FILE     Join the open review of the input's target, or start one.
           --label TEXT [--host KIND] [--session-id ID] [--fresh]
  publish  --session DIR --input FILE     Publish the input as the review's next round.
  status   --session DIR                  The review: comments, whose turn each is, approvals, the verdict.
  wait     --session DIR [--since REV]    Block until the reviewer finishes the current round.
           [--timeout-minutes N]
  answer   --session DIR --comment ID     Answer a comment on the agent's turn.
           --disposition fixed|rejected|deferred|question --body TEXT
           [--fixed-in-commit SHA | --fixed-in-fingerprint SHA256] [--blocker TEXT]
  export   --session DIR --output FILE    Write the review's feedback document.

The session folder holds session.json: the review, the thread, and its token. Keep it private.`;

interface Session {
  readonly review: string;
  readonly thread: { readonly id: string; readonly label: string };
  readonly token: string;
  readonly url: string;
}

const fail = (message: string): never => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
};

/** A required value, or an error naming what is missing. */
const need = <T>(value: T | undefined, message: string): T =>
  value ?? fail(message);

const print = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const session = (folder: string | undefined): Session => {
  const dir = need(folder, "--session DIR is required");
  try {
    return JSON.parse(
      readFileSync(join(dir, "session.json"), "utf8"),
    ) as Session;
  } catch {
    return fail(`no session in ${dir}; run register first`);
  }
};

const readInput = (file: string | undefined) => {
  const path = need(file, "--input FILE is required");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return fail(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const decoded = decodeBytes(InputDocument, bytes);
  if (Result.isFailure(decoded))
    return fail(`${path}: ${decoded.failure.message}`);
  return { bytes, input: decoded.success };
};

const status = async (current: Session) =>
  (
    await expectOk<{ ok: true; status: Status }>(
      await call("GET", `/agent/reviews/${current.review}`, {
        token: current.token,
      }),
    )
  ).status;

const commands: Record<string, (args: Array<string>) => Promise<void>> = {
  async serve() {
    const { run } = await import("../server/main.ts");
    run();
  },

  async collect(args) {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        output: { type: "string" },
        title: { type: "string" },
        "include-secret": { type: "string", multiple: true },
      },
    });
    const repo = need(values.repo, "collect needs --repo DIR");
    const outputPath = need(values.output, "collect needs --output FILE");
    try {
      const worktree = openWorktree({ repo });
      const output = checkOutput(worktree, outputPath);
      const collected = collect(worktree, {
        ...(values.title === undefined ? {} : { title: values.title }),
        includeSecret: values["include-secret"] ?? [],
      });
      writeOutput(output, collected.review);
      for (const line of report({ output: outputPath, collected }))
        process.stderr.write(`${line}\n`);
      print({
        ok: true,
        output: outputPath,
        files: collected.review.files.length,
        flagged: collected.flagged,
        staged: collected.staged,
        target: collected.review.target,
      });
    } catch (error) {
      if (error instanceof CollectError || error instanceof GitError) {
        process.stderr.write(`${errorLine(error)}\n`);
        process.exit(1);
      }
      throw error;
    }
  },

  async register(args) {
    const { values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        input: { type: "string" },
        label: { type: "string" },
        host: { type: "string", default: "claude-code" },
        "session-id": { type: "string" },
        fresh: { type: "boolean", default: false },
      },
    });
    const sessionDir = need(values.session, "register needs --session DIR");
    const label = need(values.label, "register needs --label TEXT");
    if (!(HOSTS as ReadonlyArray<string>).includes(values.host))
      fail(`--host must be one of ${HOSTS.join(", ")}`);
    const { input } = readInput(values.input);
    const reply = await expectOk<{
      ok: true;
      review: string;
      thread: Session["thread"];
      token: string;
      url: string;
      created: boolean;
      status: Status;
    }>(
      await call("POST", "/agent/register", {
        body: JSON.stringify({
          target: input.target,
          label,
          host: {
            kind: values.host,
            ...(values["session-id"] === undefined
              ? {}
              : { session_id: values["session-id"] }),
          },
          fresh: values.fresh,
        }),
      }),
    );
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const saved: Session = {
      review: reply.review,
      thread: reply.thread,
      token: reply.token,
      url: reply.url,
    };
    writeFileSync(
      join(sessionDir, "session.json"),
      `${JSON.stringify(saved, null, 2)}\n`,
      { mode: 0o600 },
    );
    print({
      ok: true,
      review: reply.review,
      thread: reply.thread,
      url: reply.url,
      created: reply.created,
      round: reply.status.round,
      to_answer: reply.status.to_answer,
    });
  },

  async publish(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" }, input: { type: "string" } },
    });
    const current = session(values.session);
    const { bytes } = readInput(values.input);
    const reply = await expectOk<{
      ok: true;
      round: { round: number };
      revision: number;
      warnings: Array<string>;
      url: string;
    }>(
      await call("POST", `/agent/reviews/${current.review}/rounds`, {
        body: bytes,
        token: current.token,
        timeoutMs: 120_000,
      }),
    );
    print({
      ok: true,
      round: reply.round.round,
      revision: reply.revision,
      url: reply.url,
      warnings: reply.warnings,
    });
  },

  async status(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" } },
    });
    print({ ok: true, status: await status(session(values.session)) });
  },

  async wait(args) {
    const { values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        since: { type: "string" },
        "timeout-minutes": { type: "string", default: "60" },
      },
    });
    const current = session(values.session);
    const deadline =
      Date.now() + (Number(values["timeout-minutes"]) || 60) * 60_000;
    let since =
      values.since === undefined
        ? (await status(current)).revision
        : Number(values.since);
    while (Date.now() < deadline) {
      const reply = await expectOk<{ ok: true; status: Status }>(
        await call(
          "GET",
          `/agent/reviews/${current.review}/wait?revision=${since}&timeout=25000`,
          { token: current.token, timeoutMs: 40_000 },
        ),
      );
      const { status: latest } = reply;
      if (latest.closed) {
        print({ ok: true, finished: false, closed: true, status: latest });
        return;
      }
      if (latest.revision > since && latest.submission !== undefined) {
        print({ ok: true, finished: true, status: latest });
        return;
      }
      if (latest.revision > since) since = latest.revision;
    }
    print({
      ok: true,
      finished: false,
      timed_out: true,
      status: await status(current),
    });
  },

  async answer(args) {
    const { values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        comment: { type: "string" },
        disposition: { type: "string" },
        body: { type: "string" },
        blocker: { type: "string" },
        "fixed-in-commit": { type: "string" },
        "fixed-in-fingerprint": { type: "string" },
      },
    });
    const current = session(values.session);
    const comment = need(values.comment, "answer needs --comment ID");
    const body = need(values.body, "answer needs --body TEXT");
    let answer: Answer;
    switch (values.disposition) {
      case "fixed":
        if (values["fixed-in-commit"] !== undefined)
          answer = {
            disposition: "fixed",
            body,
            fixed_in: { commit: values["fixed-in-commit"] as never },
          };
        else if (values["fixed-in-fingerprint"] !== undefined)
          answer = {
            disposition: "fixed",
            body,
            fixed_in: { fingerprint: values["fixed-in-fingerprint"] as never },
          };
        else
          return fail(
            "a fixed answer names --fixed-in-commit SHA or --fixed-in-fingerprint SHA256",
          );
        break;
      case "rejected":
        answer = { disposition: "rejected", body };
        break;
      case "deferred":
        answer = {
          disposition: "deferred",
          body,
          blocker: need(
            values.blocker,
            "a deferred answer needs --blocker TEXT",
          ),
        };
        break;
      case "question":
        answer = { disposition: "question", body };
        break;
      default:
        return fail(
          "--disposition must be fixed, rejected, deferred, or question",
        );
    }
    const reply = await expectOk<{ ok: true; revision: number }>(
      await call("POST", `/agent/reviews/${current.review}/answers`, {
        body: JSON.stringify({ comment, answer }),
        token: current.token,
      }),
    );
    print({ ok: true, revision: reply.revision });
  },

  async export(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" }, output: { type: "string" } },
    });
    const output = need(values.output, "export needs --output FILE");
    const latest = await status(session(values.session));
    const feedback = need(latest.feedback, "the review has no round yet");
    const encoded = encodeDocument(FeedbackDocument, feedback);
    if (Result.isFailure(encoded)) return fail(encoded.failure.message);
    writeFileSync(output, encoded.success, { mode: 0o600 });
    print({ ok: true, output, round: latest.round, revision: latest.revision });
  },
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const run = need(commands[command], `unknown command ${command}\n\n${USAGE}`);
  try {
    // Any command that talks to the server starts it when none answers: the socket is the single-instance lock.
    if (command !== "serve" && command !== "collect") await ensureServer();
    await run(rest);
  } catch (error) {
    if (error instanceof ServerError) fail(`${error.message} (${error.kind})`);
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      fail(
        "no server answers on the socket; run register first, which starts it",
      );
    throw error;
  }
};

void main();
