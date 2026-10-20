import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { Repository } from "../schema/repositories.ts";
import { PullRequestUrl } from "../schema/primitives.ts";
import { ComparisonRequest } from "../schema/pull-requests.ts";
import { browsePullRequest } from "./browse-pull.ts";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    repository: Repository,
    url: PullRequestUrl,
    comparison: Schema.optional(ComparisonRequest),
  }),
)(workerData);
parentPort?.postMessage(
  await browsePullRequest(
    request.repository,
    request.url,
    undefined,
    request.comparison,
  ),
);
