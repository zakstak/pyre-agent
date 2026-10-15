#!/usr/bin/env node
/**
 * The agent's command-line tool. Every command prints JSON on success, so an agent reads one shape, and an error
 * line on failure with a non-zero exit.
 */
import * as Result from "effect/Result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  checkOutput,
  errorLine,
  escaped,
  report,
  writeOutput,
} from "../collector/output.ts";
import { collect, openWorktree } from "../collector/collect.ts";
import { CollectError, GitError } from "../collector/errors.ts";
import { prFingerprints } from "../collector/fingerprint.ts";
import {
  decodeBytes,
  encodeDocument,
  FeedbackDocument,
  InputDocument,
} from "../schema/document.ts";
import * as Schema from "effect/Schema";
import { Analysis, applyAnalysis } from "../schema/analysis.ts";
import type { Answer } from "../schema/feedback.ts";
import type { ReviewInput } from "../schema/input.ts";
import { hunkRanges, parseRows } from "../review/patch.ts";
import { tourView } from "../review/tour.ts";
import type { Target } from "../schema/target.ts";
import { HOSTS } from "../schema/thread.ts";
import { finishedSince, hasQuestions, type Status } from "../server/status.ts";
import { GhFailed } from "./github.ts";
import { collectPullRequest } from "./pull-request.ts";
import { PullRequestUrl } from "../schema/primitives.ts";
import { findHostedPullRequest, forgeClients, readHostedComments, readPullRequest } from "./hosted.ts";
import { ForgeFailed } from "./forge-api.ts";
import {
  call,
  ensureServer,
  expectOk,
  ServerError,
  SocketFailed,
} from "./socket.ts";
import { runtimeDir, socketPath } from "../server/paths.ts";

const USAGE = `review-canvas: a local server where a reviewer walks an agent's change and the agent answers.

Commands
  serve                                   Run the server in the foreground (agents start it on demand).
  collect  --repo DIR --output FILE       Snapshot a working tree's uncommitted changes as review input.
           [--title TEXT] [--include-secret PATH]... [--no-content]
           [--pr URL]                     With --pr, snapshot that pull request instead, from the clone in --repo,
                                          which must hold its base and head commits. Supports private GitHub,
                                          GitLab and Gitea/Forgejo hosts over HTTPS.
  fingerprints --repo DIR --base SHA      Print each changed file's fingerprint between two commits, for the
           --head SHA                     files of a pull request's input.
  register --session DIR --input FILE     Join the open review of the input's target, or start one.
           --label TEXT [--host KIND] [--session-id ID] [--fresh]
                                          KIND is claude-code (the default) or codex.
  publish  --session DIR --input FILE     Publish the input as the review's next round, then import the comments
           [--analysis FILE] [--no-comments] of its pull request. --analysis merges a kept analysis file:
           [--dry-run]                    summary, stops, and files by path. --dry-run validates and prints
                                          the tour and its warnings without publishing.
  hunks    --input FILE [--path PATH]     Each file's hunks as old and new line ranges, for excerpts and notes.
           [--rows]                       --rows prints every patch row with its old and new line numbers.
  comments --session DIR                  Import new comments of the review's pull/merge request.
  status   --session DIR                  The review: comments, whose turn each is, approvals, the verdict.
  wait     --session DIR [--since REV]    Block until the reviewer finishes the current round, or asks a question.
           [--timeout-minutes N]          Gives up after N minutes (60) with "timed_out": true; run it again.
  answer   --session DIR --comment ID     Answer a comment on the agent's turn.
           --disposition fixed|rejected|deferred|question|answered --body TEXT
           [--fixed-in-commit SHA | --fixed-in-fingerprint SHA256] [--blocker TEXT]
  check    --session DIR [--head SHA]     Compare the code with the current round, and show the reviewer what
                                          changed since: a working tree's files, or a pull request's head.
  export   --session DIR --output FILE    Write the review's feedback document.

The session folder holds session.json: the review, the thread, and its token. Keep it private.`;

interface Session {
  readonly review: string;
  readonly thread: { readonly id: string; readonly label: string };
  readonly token: string;
  readonly url: string;
  /** The revision of the last submission `wait` reported, so the next `wait` reports only a newer one. */
  readonly seen_submission?: number;
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

const sessionFolder = (folder: string | undefined) =>
  need(folder, "--session DIR is required");

const session = (folder: string | undefined): Session => {
  const dir = sessionFolder(folder);
  try {
    return JSON.parse(
      readFileSync(join(dir, "session.json"), "utf8"),
    ) as Session;
  } catch {
    return fail(`no session in ${dir}; run register first`);
  }
};

/** Writes session.json privately: it holds the thread's token. */
const saveSession = (folder: string, saved: Session) => {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(folder, "session.json"),
    `${JSON.stringify(saved, null, 2)}\n`,
    { mode: 0o600 },
  );
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

/** Keeps session.json's URL the server's: a server that restarted can listen on another port. */
const keepUrl = (folder: string, current: Session, url: string): Session => {
  if (current.url === url) return current;
  const updated = { ...current, url };
  saveSession(folder, updated);
  return updated;
};

const status = async (folder: string, current: Session) => {
  const latest = (
    await expectOk<{ ok: true; status: Status }>(
      await call("GET", `/agent/reviews/${current.review}`, {
        token: current.token,
      }),
    )
  ).status;
  keepUrl(folder, current, latest.url);
  return latest;
};

/**
 * Imports the comments of the target's pull request, or of the open pull request of the working tree's branch. Without
 * gh, or without a pull request, the review goes on without them, and the result says why.
 */
const importGitHub = async (current: Session, target: Target) => {
  const found = findHostedPullRequest(target, forgeClients);
  if (found.kind === "none") return { skipped: found.reason };
  let items;
  try {
    const url = Schema.decodeUnknownSync(PullRequestUrl)(found.url);
    items = readHostedComments(url, forgeClients);
  } catch (error) {
    if (error instanceof GhFailed || error instanceof ForgeFailed) return { skipped: error.message };
    throw error;
  }
  const reply = await expectOk<{
    ok: true;
    revision: number;
    report: Record<string, unknown>;
  }>(
    await call("POST", `/agent/reviews/${current.review}/github`, {
      body: JSON.stringify(items),
      token: current.token,
    }),
  );
  return { pull_request: found.url, ...reply.report };
};

/** The snapshot with the analysis file merged in, and what of the analysis did not apply. */
const withAnalysis = (
  input: ReviewInput,
  file: string | undefined,
): {
  readonly input: ReviewInput;
  readonly warnings: ReadonlyArray<string>;
} => {
  if (file === undefined) return { input, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return fail(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const decoded = Schema.decodeUnknownResult(Analysis)(raw, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded))
    return fail(`${file} is not a valid analysis: ${decoded.failure.message}`);
  const applied = applyAnalysis(input, decoded.success);
  return {
    input: applied.input,
    warnings: applied.unknownPaths.map(
      (path) => `the analysis names ${path}, which is not in this round`,
    ),
  };
};

/** Text files the page cannot open unchanged lines for: their text did not fit, or was left out. */
const withoutContent = (review: ReviewInput) =>
  review.files
    .filter(
      (file) => file.patch !== undefined && file.new_content === undefined,
    )
    .map((file) => file.path);

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
        pr: { type: "string" },
        output: { type: "string" },
        title: { type: "string" },
        "include-secret": { type: "string", multiple: true },
        "no-content": { type: "boolean", default: false },
      },
    });
    const repo = need(values.repo, "collect needs --repo DIR");
    const outputPath = need(values.output, "collect needs --output FILE");
    const options = {
      ...(values.title === undefined ? {} : { title: values.title }),
      includeSecret: values["include-secret"] ?? [],
      withContent: !values["no-content"],
    };
    let pullRequest: PullRequestUrl | undefined;
    if (values.pr !== undefined) {
      const url = Schema.decodeUnknownResult(PullRequestUrl)(values.pr);
      if (Result.isFailure(url))
        return fail(
          `--pr takes an HTTPS GitHub /pull/N, GitLab /-/merge_requests/N, or Gitea/Forgejo /pulls/N URL`,
        );
      pullRequest = url.success;
    }
    try {
      const worktree = openWorktree({ repo });
      const output = checkOutput(worktree, outputPath);
      if (pullRequest !== undefined) {
        const collected = collectPullRequest(
          worktree,
          pullRequest,
          forgeClients,
          options,
        );
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        writeOutput(output, collected.review);
        for (const line of report({ output: outputPath, collected }))
          process.stderr.write(`${line}\n`);
        print({
          ok: true,
          output: outputPath,
          files: collected.review.files.length,
          files_complete: collected.review.files_complete,
          flagged: collected.flagged,
          without_content: withoutContent(collected.review),
          inventory_mismatch: collected.mismatch ?? null,
          head_moved: collected.headMoved,
          base_ref: collected.baseRef,
          merge_base: collected.mergeBase,
          target: collected.review.target,
        });
        return;
      }
      // The session folder holds the thread's token later, so it is private.
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      const collected = collect(worktree, options);
      writeOutput(output, collected.review);
      for (const line of report({ output: outputPath, collected }))
        process.stderr.write(`${line}\n`);
      print({
        ok: true,
        output: outputPath,
        files: collected.review.files.length,
        flagged: collected.flagged,
        staged: collected.staged,
        without_content: withoutContent(collected.review),
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

  /** Each file's hunks as line ranges on both sides, the numbers excerpts and notes name. */
  async hunks(args) {
    const { values } = parseArgs({
      args,
      options: {
        input: { type: "string" },
        path: { type: "string" },
        rows: { type: "boolean", default: false },
      },
    });
    const { input } = readInput(values.input);
    const files = input.files.filter(
      (file) =>
        file.patch !== undefined &&
        (values.path === undefined || file.path === values.path),
    );
    const range = (side: readonly [number, number] | []) =>
      side.length === 0 ? "none" : `${side[0]}-${side[1]}`;
    print({
      ok: true,
      files: Object.fromEntries(
        files.map((file) => [
          file.path,
          values.rows
            ? // Each row as "old new marker text", the numbers excerpts and notes name.
              parseRows(file.patch ?? "").map(
                (row) =>
                  `${String(row.old ?? "").padStart(5)} ${String(row.new ?? "").padStart(5)} ${row.text}`,
              )
            : hunkRanges(file.patch ?? "").map(
                (hunk) => `old ${range(hunk.old)}, new ${range(hunk.new)}`,
              ),
        ]),
      ),
    });
  },

  async fingerprints(args) {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
      },
    });
    try {
      const found = prFingerprints({
        repo: need(values.repo, "fingerprints needs --repo DIR"),
        base: need(values.base, "fingerprints needs --base SHA"),
        head: need(values.head, "fingerprints needs --head SHA"),
      });
      print({ ok: true, fingerprints: Object.fromEntries(found) });
    } catch (error) {
      if (error instanceof GitError) return fail(error.message);
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
    saveSession(sessionDir, {
      review: reply.review,
      thread: reply.thread,
      token: reply.token,
      url: reply.url,
    });
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
      options: {
        session: { type: "string" },
        input: { type: "string" },
        analysis: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "no-comments": { type: "boolean", default: false },
        "no-github": { type: "boolean", default: false },
      },
    });
    const { input, warnings: merged } = withAnalysis(
      readInput(values.input).input,
      values.analysis,
    );
    const encoded = encodeDocument(InputDocument, input);
    if (Result.isFailure(encoded))
      return fail(
        `the input with its analysis is invalid: ${encoded.failure.message}`,
      );
    if (values["dry-run"]) {
      // What publishing would show, without publishing: the reviewer sees nothing until the real run.
      const tour = tourView(input);
      print({
        ok: true,
        dry_run: true,
        files: input.files.length,
        stops: tour.stops.map((stop) => ({
          title: stop.title,
          attention: stop.attention?.kind ?? null,
          excerpts: stop.excerpts.map(
            (excerpt) =>
              `${excerpt.path} rows ${excerpt.start_row}-${excerpt.end_row}`,
          ),
          notes: stop.excerpts.flatMap((excerpt) =>
            excerpt.notes.map((note) => `${note.letter} ${note.title}`),
          ),
          questions: stop.questions.length,
          owns: stop.owns,
        })),
        warnings: [...merged, ...tour.warnings],
      });
      return;
    }
    const folder = sessionFolder(values.session);
    const current = session(folder);
    const bytes = encoded.success;
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
    keepUrl(folder, current, reply.url);
    print({
      ok: true,
      round: reply.round.round,
      revision: reply.revision,
      url: reply.url,
      warnings: [...merged, ...reply.warnings],
      github: values["no-comments"] || values["no-github"]
        ? { skipped: values["no-comments"] ? "--no-comments" : "--no-github" }
        : await importGitHub(current, input.target),
    });
  },

  async comments(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" } },
    });
    const folder = sessionFolder(values.session);
    const current = session(folder);
    const latest = await status(folder, current);
    const target = latest.feedback?.target;
    if (target === undefined)
      return fail("the review has no round yet; publish one first");
    print({ ok: true, github: await importGitHub(current, target) });
  },

  /**
   * Compares the code with the current round and reports what changed to the server, which shows it on the page:
   * for a working tree, the files whose fingerprint differs, appeared, or went; for a pull request, a moved head.
   */
  async check(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" }, head: { type: "string" } },
    });
    const folder = sessionFolder(values.session);
    const current = session(folder);
    const latest = await status(folder, current);
    const target = latest.feedback?.target;
    if (target === undefined)
      return fail("the review has no round yet; publish one first");
    let paths: Array<string> = [];
    let head: string | undefined;
    if (target.kind === "worktree") {
      try {
        const collected = collect(openWorktree({ repo: target.root }));
        const now = new Map<string, string | undefined>(
          collected.review.files.map((file) => [file.path, file.fingerprint]),
        );
        const then = new Map(
          latest.files.map((file) => [file.path, file.fingerprint]),
        );
        paths = [...new Set([...now.keys(), ...then.keys()])]
          .filter((path) => now.get(path) !== then.get(path))
          .sort();
      } catch (error) {
        if (error instanceof CollectError || error instanceof GitError)
          return fail(error.message);
        throw error;
      }
    } else {
      head = values.head;
      if (head === undefined) {
        try {
          head = readPullRequest(target.url, forgeClients).headRefOid;
        } catch (error) {
          return fail(
            `cannot read the pull request's head; pass --head SHA (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }
    const reply = await expectOk<{ ok: true; revision: number }>(
      await call("POST", `/agent/reviews/${current.review}/drift`, {
        body: JSON.stringify({
          paths,
          ...(head === undefined ? {} : { head_sha: head }),
        }),
        token: current.token,
      }),
    );
    print({
      ok: true,
      changed: paths,
      head_moved:
        head !== undefined && target.kind !== "worktree"
          ? head.toLowerCase() !== target.head_sha.toLowerCase()
          : false,
      revision: reply.revision,
    });
  },

  async status(args) {
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" } },
    });
    const folder = sessionFolder(values.session);
    print({ ok: true, status: await status(folder, session(folder)) });
  },

  /**
   * Waits for a submission newer than the last one this session reported, or than --since. A submission that already
   * happened counts, so an agent that starts waiting late does not miss it.
   */
  async wait(args) {
    const { values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        since: { type: "string" },
        "timeout-minutes": { type: "string", default: "60" },
      },
    });
    const folder = sessionFolder(values.session);
    let current = session(folder);
    const deadline =
      Date.now() + (Number(values["timeout-minutes"]) || 60) * 60_000;
    const since =
      values.since === undefined
        ? (current.seen_submission ?? 0)
        : Number(values.since);
    // -1 answers at once with the current status; later calls block until the review moves past the cursor.
    let cursor = -1;
    let latest: Status | undefined;
    while (Date.now() < deadline) {
      // Each long poll ends by the deadline, so a short --timeout-minutes is kept.
      const poll = Math.max(100, Math.min(25_000, deadline - Date.now()));
      latest = (
        await expectOk<{ ok: true; status: Status }>(
          await call(
            "GET",
            `/agent/reviews/${current.review}/wait?revision=${cursor}&timeout=${poll}`,
            { token: current.token, timeoutMs: poll + 15_000 },
          ),
        )
      ).status;
      current = keepUrl(folder, current, latest.url);
      if (latest.closed) {
        print({ ok: true, finished: false, closed: true, status: latest });
        return;
      }
      // A question asked now is answered now: return without waiting for the round to finish.
      if (hasQuestions(latest)) {
        // A finish can wait behind a question: report both, so the agent answers and knows the round is done.
        const finished = finishedSince(latest, since);
        if (finished)
          saveSession(folder, {
            ...current,
            seen_submission: latest.submission?.revision ?? since,
          });
        print({
          ok: true,
          finished,
          questions: latest.questions,
          status: latest,
        });
        return;
      }
      if (finishedSince(latest, since)) {
        saveSession(folder, {
          ...current,
          seen_submission: latest.submission?.revision ?? since,
        });
        print({ ok: true, finished: true, status: latest });
        return;
      }
      cursor = latest.revision;
    }
    print({
      ok: true,
      finished: false,
      timed_out: true,
      status: latest ?? (await status(folder, current)),
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
      case "answered":
        answer = { disposition: "answered", body };
        break;
      default:
        return fail(
          "--disposition must be fixed, rejected, deferred, question, or answered",
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
    const folder = sessionFolder(values.session);
    const latest = await status(folder, session(folder));
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
  // The original public command remains accepted for existing agent sessions.
  const run = need(commands[command === "github" ? "comments" : command], `unknown command ${command}\n\n${USAGE}`);
  // Any command that talks to the server starts it when none answers: the socket is the single-instance lock.
  const offline =
    ["serve", "collect", "fingerprints", "hunks"].includes(command) ||
    rest.includes("--dry-run");
  if (!offline) await ensureServer();
  await run(rest);
};

const SOCKET_GONE = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

/**
 * An error as one line's message and kind: the server's refusal and its kind, a system error and its code, or any
 * other error and its name. Agents read the kind; a stack trace would only bury it. Control characters are escaped,
 * so a message cannot forge a second line.
 */
const described = (
  error: unknown,
): { readonly message: string; readonly kind: string } => {
  const { message, kind } = classified(error);
  return { message: escaped(message), kind };
};

const classified = (
  error: unknown,
): { readonly message: string; readonly kind: string } => {
  if (error instanceof ServerError)
    return { message: error.message, kind: error.kind };
  if (!(error instanceof Error))
    return { message: String(error), kind: "unknown" };
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  // Only the socket's own failures mean the server is gone; a file this command reads or writes can fail alike.
  if (
    error instanceof SocketFailed &&
    code !== undefined &&
    SOCKET_GONE.has(code)
  )
    return {
      message: `no review server answers on ${socketPath()}; run the command again, which starts one. See ${runtimeDir()}/server.log.`,
      kind: code.toLowerCase(),
    };
  const name =
    "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : error.constructor.name;
  return {
    message: error.message,
    kind:
      code?.toLowerCase() ??
      name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase(),
  };
};

main().catch((error: unknown) => {
  const { message, kind } = described(error);
  fail(`${message} (${kind})`);
});
