/**
 * Existing synchronous host clients run off the server's event loop and are terminated when the read is cancelled:
 * a repository's pull requests, a pull request's head now, or the comparison of its round head with that head.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { readHistoricalPullRequests } from "./pull-history.ts";
import {
  comparePushed,
  forgeClients,
  readOpenPullRequests,
  readPullRequest,
} from "./hosted.ts";
import { forgeRemote } from "./github.ts";
import { parsePullRequest } from "../schema/forge-url.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import {
  type ComparedHeads,
  HostRead,
  type PullHead,
  type PullScope,
  type RepositoryPullRequests,
} from "../schema/pull-requests.ts";

const pulls = (address: string, scope: PullScope): RepositoryPullRequests => {
  try {
    const home = forgeRemote(`https://${address}`);
    if (home === undefined)
      return {
        kind: "unavailable",
        message:
          "Configure REVIEW_CANVAS_FORGE_HOSTS for this host's review provider.",
      };
    const route =
      home.kind === "github"
        ? "pull"
        : home.kind === "gitlab"
          ? "-/merge_requests"
          : "pulls";
    const pull = parsePullRequest(`${home.repo}/${route}/1`);
    if (pull === undefined)
      return {
        kind: "unavailable",
        message: "This repository has no supported HTTPS review URL.",
      };
    return {
      kind: "ready",
      items:
        scope === "history"
          ? readHistoricalPullRequests(pull, forgeClients)
          : readOpenPullRequests(pull, forgeClients, scope),
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const head = (url: PullRequestUrl): PullHead => {
  try {
    return {
      kind: "ready",
      head_sha: readPullRequest(url, forgeClients).headRefOid,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const read = (): RepositoryPullRequests | PullHead | ComparedHeads => {
  const request = Schema.decodeUnknownSync(HostRead)(workerData);
  switch (request.kind) {
    case "pulls":
      return pulls(request.address, request.scope);
    case "head":
      return head(request.url);
    case "compare":
      return comparePushed(request.url, request.from, request.to, forgeClients);
  }
};
parentPort?.postMessage(read());
