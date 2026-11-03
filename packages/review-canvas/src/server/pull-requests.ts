import { Worker } from "node:worker_threads";
import { Effect, Schema } from "effect";
import type {
  CommitSha,
  PullRequestUrl,
  ReviewId,
  Revision,
} from "../schema/primitives.ts";
import {
  ComparedHeads,
  type HostRead,
  type OpenPullRequest,
  RepositoryPullRequests,
  type PullScope,
} from "../schema/pull-requests.ts";
import type { Store } from "../store/store.ts";
import { pullsEntry } from "./install.ts";

/** What a host read says when it gives no result. */
interface Unread {
  readonly cancelled: string;
  readonly timedOut: string;
  readonly undecoded: string;
  readonly unstarted: string;
  readonly stopped: string;
}

/**
 * Reads from a host in a worker, so its synchronous clients never block the server, and stops the worker when the
 * read is cancelled or takes a minute. Whatever goes wrong becomes `unavailable` with what `unread` says about it.
 */
const hostRead = <S extends Schema.Codec<unknown, unknown>>(
  request: HostRead,
  schema: S,
  unread: Unread,
  unavailable: (message: string) => S["Type"],
  signal: AbortSignal,
): Promise<S["Type"]> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(unavailable(unread.cancelled));
    const worker = new Worker(pullsEntry(), { workerData: request });
    const finish = (result: S["Type"]) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };
    const abort = () => finish(unavailable(unread.cancelled));
    const timer = setTimeout(
      () => finish(unavailable(unread.timedOut)),
      60_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: unknown) => {
      const decoded = Schema.decodeUnknownOption(schema)(value);
      finish(
        decoded._tag === "Some" ? decoded.value : unavailable(unread.undecoded),
      );
    });
    worker.once("error", () => finish(unavailable(unread.unstarted)));
    worker.once("exit", () => finish(unavailable(unread.stopped)));
  });

/** One repository per request keeps local reviews usable even when a host is slow or offline. */
export const repositoryPullRequests = (
  address: string,
  signal: AbortSignal,
  scope: PullScope = "all",
): Promise<RepositoryPullRequests> =>
  hostRead(
    { kind: "pulls", address, scope },
    RepositoryPullRequests,
    {
      cancelled: "PR discovery cancelled.",
      timedOut:
        "PR discovery timed out. Check the host connection and authentication, then retry.",
      undecoded: "Could not decode the repository PR list.",
      unstarted: "Could not start PR discovery.",
      stopped: "PR discovery stopped before returning its list.",
    },
    (message): RepositoryPullRequests => ({ kind: "unavailable", message }),
    signal,
  );

/** The host's comparison of a pull request's round head `from` with its head now, `to`. */
const compareHeads = (
  url: PullRequestUrl,
  from: CommitSha,
  to: CommitSha,
  signal: AbortSignal,
): Promise<ComparedHeads> =>
  hostRead(
    { kind: "compare", url, from, to },
    ComparedHeads,
    {
      cancelled: "The comparison of the heads was cancelled.",
      timedOut:
        "The comparison of the heads timed out. Check the host connection and authentication.",
      undecoded: "Could not decode the host's comparison of the heads.",
      unstarted: "Could not start comparing the heads.",
      stopped: "The comparison of the heads stopped before returning.",
    },
    (reason): ComparedHeads => ({
      comparison: { kind: "failed", reason },
      paths: [],
    }),
    signal,
  );

/**
 * What a review of an open pull request should learn from the host's list of open pull requests: nothing while the
 * host shows its round's head, or once its drift records the head the host shows; otherwise the two heads to compare,
 * at the review's revision.
 */
export const pushedSince = (
  store: Store,
  pull: OpenPullRequest,
):
  | {
      readonly review: ReviewId;
      readonly revision: Revision;
      readonly url: PullRequestUrl;
      readonly from: CommitSha;
      readonly to: CommitSha;
    }
  | undefined => {
  const head = pull.head_sha;
  if (head === undefined) return undefined;
  const view = store.openPullRequestReview(pull.url);
  if (view?.round === undefined) return undefined;
  const { target, drift } = view.state;
  if (target.kind === "worktree") return undefined;
  const same = (sha: string | undefined) =>
    sha?.toLowerCase() === head.toLowerCase();
  if (same(target.head_sha)) return undefined;
  if (
    drift?.round === view.round.round &&
    same(drift.head_sha) &&
    drift.compared !== undefined
  )
    return undefined;
  return {
    review: view.state.id,
    revision: view.revision,
    url: target.url,
    from: target.head_sha,
    to: head,
  };
};

/**
 * Notices commits pushed to the open pull requests of a host's list since their reviews' rounds: has the host compare
 * each new head with the round's, and records what it found as the review's drift, which every open page shows. A
 * review that changed meanwhile, as by a new round, records nothing; the next list tries again. `comparing` holds the
 * comparisons under way, so pages that list the same pull requests at once compare each head once.
 */
export const noticePushes = (
  store: Store,
  pulls: ReadonlyArray<OpenPullRequest>,
  comparing: Set<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    pulls,
    (pull) => {
      const pushed = pushedSince(store, pull);
      if (pushed === undefined) return Effect.void;
      const key = `${pushed.review}:${pushed.to.toLowerCase()}`;
      if (comparing.has(key)) return Effect.void;
      comparing.add(key);
      return Effect.promise((signal) =>
        compareHeads(pushed.url, pushed.from, pushed.to, signal),
      ).pipe(
        Effect.flatMap(({ comparison, paths }) =>
          Effect.try(() =>
            store.act(
              pushed.review,
              {
                kind: "drift",
                paths,
                head_sha: pushed.to,
                compared: comparison,
              },
              pushed.revision,
            ),
          ),
        ),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => comparing.delete(key))),
      );
    },
    { discard: true },
  );
