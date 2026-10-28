/** Hosted reads and object collection run in a worker, never in the server event loop. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRange,
  missingCommits,
  openWorktree,
} from "../collector/collect.ts";
import { gitEnvironment, trustedPath } from "../collector/git.ts";
import { CommitSha } from "../schema/primitives.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import type { Repository } from "../schema/repositories.ts";
import { Schema } from "effect";
import { ReviewInput, INPUT_FORMAT } from "../schema/input.ts";
import { stackRange } from "./stack-range.ts";
import type { ComparisonRequest } from "../schema/pull-requests.ts";
import type { PullRequestSnapshot } from "../schema/pull-requests.ts";
import { identifyRepository } from "../server/repositories.ts";
import { repositoryId } from "../schema/repositories.ts";
import {
  addressOf,
  forgeClients,
  readPullRequest,
  type ForgeClients,
} from "./hosted.ts";
import { collectPullRequest } from "./pull-request.ts";

/** An explicit monitored identity binds network reads even when a saved checkout was replaced. */
export const belongsToRepository = (address: string, url: string): boolean => {
  const pull = addressOf(url);
  const actual = `${pull.host}/${pull.repository}`;
  return pull.provider === "github"
    ? address.toLowerCase() === actual.toLowerCase()
    : address === actual;
};

const fetchObjects = (
  root: string,
  url: PullRequestUrl,
  commits: ReadonlyArray<string>,
) => {
  const pull = addressOf(url);
  const run = (args: ReadonlyArray<string>) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=never",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        env: gitEnvironment({
          PATH: trustedPath(),
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "false",
        }),
      },
    );
    if (result.error !== undefined || result.status !== 0)
      throw new Error(
        `Could not fetch PR commits from ${pull.host}. Check existing Git authentication and HTTPS trust. Your checkouts were not changed.`,
      );
  };
  run(["init", "--quiet", "--template=", "--initial-branch=main"]);
  const ref =
    pull.provider === "gitlab"
      ? `refs/merge-requests/${pull.number}/head`
      : `refs/pull/${pull.number}/head`;
  run([
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    `${pull.repositoryUrl}.git`,
    ref,
    ...commits,
  ]);
};

export const browsePullRequest = async (
  repository: Repository,
  url: PullRequestUrl,
  clients: ForgeClients = forgeClients,
  comparison: ComparisonRequest = { mode: "host", historical: false },
): Promise<PullRequestSnapshot> => {
  let scratch: string | undefined;
  try {
    if (
      repository.identity.kind !== "remote" ||
      !belongsToRepository(repository.identity.address, url)
    )
      throw new Error("This PR does not belong to the monitored repository.");
    const range =
      comparison.mode === "host"
        ? undefined
        : stackRange(url, comparison, clients);
    const before = range?.selected ?? readPullRequest(url, clients);
    const commits =
      range === undefined
        ? [before.baseRefOid, before.headRefOid]
        : [
            ...new Set([
              range.base,
              range.head,
              ...range.views.flatMap((item) => [
                item.view.baseRefOid,
                item.view.headRefOid,
              ]),
            ]),
          ];
    let worktree;
    for (const root of repository.checkouts) {
      try {
        if (
          repositoryId((await identifyRepository(root)).identity) !==
          repositoryId(repository.identity)
        )
          continue;
        const candidate = openWorktree({ repo: root });
        if (missingCommits(candidate, commits).length === 0) {
          worktree = candidate;
          break;
        }
      } catch {
        /* A missing or replaced checkout is not a usable object source. */
      }
    }
    if (worktree === undefined) {
      scratch = mkdtempSync(join(tmpdir(), "review-canvas-pr-"));
      fetchObjects(scratch, url, commits);
      worktree = openWorktree({ repo: scratch });
    }
    if (range !== undefined) {
      for (let index = 1; index < range.views.length; index++) {
        const parent = range.views[index - 1];
        const child = range.views[index];
        if (parent === undefined || child === undefined) continue;
        const ancestor = worktree.git
          .run(worktree.top, [
            "merge-base",
            parent.view.headRefOid,
            child.view.headRefOid,
          ])
          .toString("utf8")
          .trim();
        if (ancestor !== parent.view.headRefOid)
          throw new Error(
            "The parent's retained head is not an ancestor of this layer. The stack was rebased or rewritten; its final snapshots cannot be compared as a stack.",
          );
      }
      const collected = collectRange(
        worktree,
        { base: range.base, head: range.head },
        { withContent: true },
      );
      if (comparison.historical && collected.mergeBase !== range.base)
        throw new Error(
          "The recorded historical base is not an ancestor of the retained head. This comparison is unavailable.",
        );
      for (const item of range.views) {
        const after = readPullRequest(item.pull.url, clients);
        if (
          after.headRefOid !== item.view.headRefOid ||
          after.baseRefOid !== item.view.baseRefOid ||
          after.baseRefName !== item.view.baseRefName
        )
          throw new Error(
            "A stack head or base moved while collecting. Refresh before comparing.",
          );
      }
      const input = Schema.decodeUnknownSync(ReviewInput)({
        format: INPUT_FORMAT,
        target: {
          ...(addressOf(url).provider === "github"
            ? { kind: "github_pr" }
            : { kind: "pull_request", provider: addressOf(url).provider }),
          title: before.title,
          url,
          head_sha: range.head,
          base_sha: collected.mergeBase,
          changed_files: collected.files.length,
        },
        files_complete: true,
        files: collected.files,
      });
      return {
        kind: "ready",
        input,
        warnings:
          collected.flagged.length > 0
            ? [
                `Contents omitted for likely secret files: ${collected.flagged.join(", ")}.`,
              ]
            : [],
        collected_at: new Date().toISOString(),
        comparison: {
          mode: comparison.mode,
          base_sha: Schema.decodeSync(CommitSha)(collected.mergeBase),
          head_sha: range.head,
          historical: comparison.historical,
        },
      };
    }
    const collected = collectPullRequest(worktree, url, clients, {
      withContent: true,
    });
    const warnings: Array<string> = [];
    if (collected.headMoved)
      warnings.push(
        "The PR head changed while collecting. Refresh before relying on this snapshot.",
      );
    if (collected.mismatch !== undefined)
      warnings.push(
        "The local changed-file list differs from the host. Coverage is incomplete.",
      );
    if (collected.flagged.length > 0)
      warnings.push(
        `Contents omitted for likely secret files: ${collected.flagged.join(", ")}.`,
      );
    return {
      kind: "ready",
      input: collected.review,
      warnings,
      collected_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      message:
        error instanceof Error ? error.message : "Could not collect this PR.",
    };
  } finally {
    if (scratch !== undefined)
      rmSync(scratch, { recursive: true, force: true });
  }
};
