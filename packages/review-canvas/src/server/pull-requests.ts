import { Worker } from "node:worker_threads";
import {
  type Duration,
  Effect,
  RcMap,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import type {
  CommitSha,
  PullRequestUrl,
  ReviewId,
  Revision,
} from "../schema/primitives.ts";
import {
  ComparedHeads,
  type HostRead,
  PullHead,
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

/** The head a pull request's host shows now. */
const pullHead = (
  url: PullRequestUrl,
  signal: AbortSignal,
): Promise<PullHead> =>
  hostRead(
    { kind: "head", url },
    PullHead,
    {
      cancelled: "Reading the pull request's head was cancelled.",
      timedOut:
        "Reading the pull request's head timed out. Check the host connection and authentication.",
      undecoded: "Could not decode the pull request's head.",
      unstarted: "Could not start reading the pull request's head.",
      stopped: "Reading the pull request's head stopped before returning.",
    },
    (message): PullHead => ({ kind: "unavailable", message }),
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

/** The reads from a host that tell the server of pushes: a pull request's head now, and the comparison of two heads. */
export interface PushHost {
  readonly head: (
    url: PullRequestUrl,
    signal: AbortSignal,
  ) => Promise<PullHead>;
  readonly compare: (
    url: PullRequestUrl,
    from: CommitSha,
    to: CommitSha,
    signal: AbortSignal,
  ) => Promise<ComparedHeads>;
}

/** The pull requests' own hosts, read in workers. */
export const forgeHost: PushHost = { head: pullHead, compare: compareHeads };

/**
 * A head the host showed for a pull request, from a read that began at `read_from`, in milliseconds since the epoch.
 * Whatever a review learned after that moment, such as a new round, is newer than the head.
 */
export interface HeadSeen {
  readonly url: PullRequestUrl;
  readonly head_sha: CommitSha;
  readonly read_from: number;
}

/** How long the server waits before it asks the host again to compare heads it could not compare. */
export const COMPARE_AGAIN_MS = 5 * 60_000;

/**
 * What a review learns from a head the host showed: that its pull request's head moved, which the host should compare
 * with its round's head, or that the head it recorded as moved is back at the round's, which clears its drift. Either
 * applies at the review's revision.
 */
export type Noticed =
  | {
      readonly kind: "compare";
      readonly review: ReviewId;
      readonly revision: Revision;
      readonly url: PullRequestUrl;
      readonly from: CommitSha;
      readonly to: CommitSha;
    }
  | {
      readonly kind: "clear";
      readonly review: ReviewId;
      readonly revision: Revision;
      readonly head_sha: CommitSha;
    };

/**
 * What the open review of a pull request should learn from a head its host showed. Nothing from a read that began
 * before the review's round was published or its drift recorded: the host showed the pull request as it was then, and
 * the review knows newer. Nothing while the host shows the round's head and the drift records no moved head, or once
 * the drift records the head the host shows with a comparison, unless the host failed to compare them a while ago.
 */
export const pushedSince = (
  store: Store,
  seen: HeadSeen,
): Noticed | undefined => {
  const view = store.openPullRequestReview(seen.url);
  if (view?.round === undefined) return undefined;
  const { target } = view.state;
  if (target.kind === "worktree") return undefined;
  const drift =
    view.state.drift?.round === view.round.round ? view.state.drift : undefined;
  const known = Math.max(
    Date.parse(view.round.published_at),
    drift === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(drift.checked_at),
  );
  if (seen.read_from <= known) return undefined;
  const same = (sha: string) =>
    sha.toLowerCase() === seen.head_sha.toLowerCase();
  const review = view.state.id;
  const revision = view.revision;
  if (same(target.head_sha))
    return drift?.head_sha === undefined
      ? undefined
      : { kind: "clear", review, revision, head_sha: seen.head_sha };
  // The drift holds this head's comparison already, unless the host failed to compare it a while ago.
  if (
    drift?.head_sha !== undefined &&
    same(drift.head_sha) &&
    drift.compared !== undefined &&
    (drift.compared.kind !== "failed" ||
      seen.read_from < Date.parse(drift.checked_at) + COMPARE_AGAIN_MS)
  )
    return undefined;
  return {
    kind: "compare",
    review,
    revision,
    url: target.url,
    from: target.head_sha,
    to: seen.head_sha,
  };
};

/**
 * Notices commits pushed to pull requests since their reviews' rounds, from the heads their host showed: has the host
 * compare each new head with the round's, and records what it found as the review's drift, which every open page
 * shows; a head back at the round's clears it. A review that changed meanwhile, as by a new round, records nothing;
 * the next read tries again. `comparing` holds the comparisons under way, so pages that read the same pull requests at
 * once compare each head once.
 */
const noticePushes = (
  store: Store,
  host: PushHost,
  seen: ReadonlyArray<HeadSeen>,
  comparing: Set<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    seen,
    (item) => {
      const noticed = pushedSince(store, item);
      if (noticed === undefined) return Effect.void;
      if (noticed.kind === "clear")
        return Effect.try(() =>
          store.act(
            noticed.review,
            { kind: "drift", paths: [], head_sha: noticed.head_sha },
            noticed.revision,
          ),
        ).pipe(Effect.ignore);
      const key = `${noticed.review}:${noticed.to.toLowerCase()}`;
      if (comparing.has(key)) return Effect.void;
      comparing.add(key);
      return Effect.promise((signal) =>
        host.compare(noticed.url, noticed.from, noticed.to, signal),
      ).pipe(
        Effect.flatMap(({ comparison, paths }) =>
          Effect.try(() =>
            store.act(
              noticed.review,
              {
                kind: "drift",
                paths,
                head_sha: noticed.to,
                compared: comparison,
              },
              noticed.revision,
            ),
          ),
        ),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => comparing.delete(key))),
      );
    },
    { discard: true },
  );

/** How often the server reads the head of a pull request whose review a page shows. */
export const HEAD_EVERY: Duration.Input = "1 minute";

/** How the server learns of commits pushed to the pull requests of its reviews. */
export interface Pushes {
  /** Learns from heads the host showed, as in its list of a repository's open pull requests. */
  readonly notice: (seen: ReadonlyArray<HeadSeen>) => Effect.Effect<void>;
  /**
   * While the scope lasts, reads the head of the open review's pull request at once and then every {@link HEAD_EVERY},
   * and learns from it: one read however many pages show the review. A review of a working tree reads nothing.
   */
  readonly watch: (review: ReviewId) => Effect.Effect<void, never, Scope.Scope>;
}

/** The server's watch of its pull requests' heads, which stops with the scope. */
export const makePushes = (
  store: Store,
  host: PushHost = forgeHost,
  every: Duration.Input = HEAD_EVERY,
): Effect.Effect<Pushes, never, Scope.Scope> =>
  Effect.gen(function* () {
    const comparing = new Set<string>();
    const notice = (seen: ReadonlyArray<HeadSeen>) =>
      noticePushes(store, host, seen, comparing);
    const heads = yield* RcMap.make({
      lookup: (url: PullRequestUrl) =>
        Effect.forkScoped(
          Effect.gen(function* () {
            const read_from = Date.now();
            const head = yield* Effect.promise((signal) =>
              host.head(url, signal),
            );
            if (head.kind === "ready")
              yield* notice([{ url, head_sha: head.head_sha, read_from }]);
          }).pipe(Effect.repeat(Schedule.spaced(every))),
        ),
    });
    return {
      notice,
      watch: (review) =>
        Effect.suspend(() => {
          const state = store.review(review)?.state;
          return state === undefined ||
            state.closed_at !== undefined ||
            state.target.kind === "worktree"
            ? Effect.void
            : RcMap.get(heads, state.target.url).pipe(Effect.asVoid);
        }),
    };
  });
