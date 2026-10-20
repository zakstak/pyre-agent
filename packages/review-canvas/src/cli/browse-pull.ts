/** Hosted reads and object collection run in a worker, never in the server event loop. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingCommits, openWorktree } from "../collector/collect.ts";
import { gitEnvironment, trustedPath } from "../collector/git.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import type { Repository } from "../schema/repositories.ts";
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

const fetchObjects = (root: string, url: PullRequestUrl, base: string) => {
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
    base,
  ]);
};

export const browsePullRequest = async (
  repository: Repository,
  url: PullRequestUrl,
  clients: ForgeClients = forgeClients,
): Promise<PullRequestSnapshot> => {
  let scratch: string | undefined;
  try {
    if (
      repository.identity.kind !== "remote" ||
      !belongsToRepository(repository.identity.address, url)
    )
      throw new Error("This PR does not belong to the monitored repository.");
    const before = readPullRequest(url, clients);
    let worktree;
    for (const root of repository.checkouts) {
      try {
        if (
          repositoryId((await identifyRepository(root)).identity) !==
          repositoryId(repository.identity)
        )
          continue;
        const candidate = openWorktree({ repo: root });
        if (
          missingCommits(candidate, [before.baseRefOid, before.headRefOid])
            .length === 0
        ) {
          worktree = candidate;
          break;
        }
      } catch {
        /* A missing or replaced checkout is not a usable object source. */
      }
    }
    if (worktree === undefined) {
      scratch = mkdtempSync(join(tmpdir(), "review-canvas-pr-"));
      fetchObjects(scratch, url, before.baseRefOid);
      worktree = openWorktree({ repo: scratch });
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
