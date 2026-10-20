import { Worker } from "node:worker_threads";
import { Schema } from "effect";
import {
  PullRequestSnapshot,
  type ComparisonRequest,
} from "../schema/pull-requests.ts";
import type { PullRequestUrl } from "../schema/primitives.ts";
import type { Repository } from "../schema/repositories.ts";
import { browseEntry } from "./install.ts";

export const browsePull = (
  repository: Repository,
  url: PullRequestUrl,
  signal: AbortSignal,
  comparison?: ComparisonRequest,
): Promise<PullRequestSnapshot> =>
  new Promise((resolve) => {
    if (signal.aborted)
      return resolve({
        kind: "unavailable",
        message: "PR collection cancelled.",
      });
    const worker = new Worker(browseEntry(), {
      workerData: { repository, url, comparison },
    });
    const finish = (result: PullRequestSnapshot) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };
    const abort = () =>
      finish({ kind: "unavailable", message: "PR collection cancelled." });
    const timer = setTimeout(
      () =>
        finish({
          kind: "unavailable",
          message:
            "PR collection timed out. Check the host connection and retry.",
        }),
      120_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: unknown) => {
      const result = Schema.decodeUnknownOption(PullRequestSnapshot)(value);
      finish(
        result._tag === "Some"
          ? result.value
          : {
              kind: "unavailable",
              message: "Could not decode the PR snapshot.",
            },
      );
    });
    worker.once("error", () =>
      finish({
        kind: "unavailable",
        message: "Could not start PR collection.",
      }),
    );
    worker.once("exit", () =>
      finish({
        kind: "unavailable",
        message: "PR collection stopped before returning a snapshot.",
      }),
    );
  });
