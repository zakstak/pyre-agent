import { Worker } from "node:worker_threads";
import { Schema } from "effect";
import { RepositoryPullRequests } from "../schema/pull-requests.ts";
import { pullsEntry } from "./install.ts";

/** One repository per request keeps local reviews usable even when a host is slow or offline. */
export const repositoryPullRequests = (
  address: string,
  signal: AbortSignal,
): Promise<RepositoryPullRequests> =>
  new Promise((resolve) => {
    if (signal.aborted)
      return resolve({
        kind: "unavailable",
        message: "PR discovery cancelled.",
      });
    const worker = new Worker(pullsEntry(), { workerData: address });
    const finish = (result: RepositoryPullRequests) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };
    const abort = () =>
      finish({ kind: "unavailable", message: "PR discovery cancelled." });
    const timer = setTimeout(
      () =>
        finish({
          kind: "unavailable",
          message:
            "PR discovery timed out. Check the host connection and authentication, then retry.",
        }),
      60_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: unknown) => {
      const decoded = Schema.decodeUnknownOption(RepositoryPullRequests)(value);
      finish(
        decoded._tag === "Some"
          ? decoded.value
          : {
              kind: "unavailable",
              message: "Could not decode the repository PR list.",
            },
      );
    });
    worker.once("error", () =>
      finish({ kind: "unavailable", message: "Could not start PR discovery." }),
    );
    worker.once("exit", () =>
      finish({
        kind: "unavailable",
        message: "PR discovery stopped before returning its list.",
      }),
    );
  });
