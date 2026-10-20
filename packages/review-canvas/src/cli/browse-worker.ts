import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { Repository } from "../schema/repositories.ts";
import { PullRequestUrl } from "../schema/primitives.ts";
import { browsePullRequest } from "./browse-pull.ts";

const request = Schema.decodeUnknownSync(
  Schema.Struct({ repository: Repository, url: PullRequestUrl }),
)(workerData);
parentPort?.postMessage(
  await browsePullRequest(request.repository, request.url),
);
