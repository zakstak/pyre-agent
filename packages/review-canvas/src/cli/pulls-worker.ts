/** Existing synchronous host clients run off the server's event loop and are terminated when the read is cancelled. */
import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { forgeClients, readOpenPullRequests } from "./hosted.ts";
import { forgeRemote } from "./github.ts";
import { parsePullRequest } from "../schema/forge-url.ts";
import { RepositoryPullRequests } from "../schema/pull-requests.ts";

const read = (): RepositoryPullRequests => {
  try {
    const address = Schema.decodeUnknownSync(Schema.String)(workerData);
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
    return { kind: "ready", items: readOpenPullRequests(pull, forgeClients) };
  } catch (error) {
    return {
      kind: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
parentPort?.postMessage(read());
