/**
 * An agent's presence on a review, as a pure function of what the server saw: each thread's open long polls, when
 * its last one ended, when it last made any request, and what the review keeps of it, its rounds and answers.
 */
import type { Presence } from "../schema/presence.ts";
import type { ThreadId, Timestamp } from "../schema/primitives.ts";
import type { ReviewState } from "./queries.ts";

/**
 * How long a thread counts as listening after its last long poll ended: `review-canvas wait` polls again at once, and
 * an agent that read what it waited for and answers is back within it.
 */
export const LISTENING_GRACE_MS = 60_000;

/** What the server saw of one thread since it started, in milliseconds since the epoch. */
export interface Live {
  /** Long polls open now. */
  readonly waits: number;
  /** When the thread's last long poll ended. */
  readonly waitEnded: number | undefined;
  /** When the thread last made any request. */
  readonly seen: number | undefined;
}

/** When the review last heard from each thread, by what it keeps: the rounds it published and the answers it gave. */
export const keptSightings = (
  state: Pick<ReviewState, "rounds" | "comments">,
): ReadonlyMap<ThreadId, number> => {
  const seen = new Map<ThreadId, number>();
  const see = (thread: ThreadId, at: Timestamp) => {
    const time = Date.parse(at);
    if (time > (seen.get(thread) ?? Number.NEGATIVE_INFINITY))
      seen.set(thread, time);
  };
  for (const round of state.rounds) see(round.thread, round.published_at);
  for (const comment of state.comments)
    for (const reply of comment.replies)
      if (reply.actor === "agent") see(reply.thread, reply.created_at);
  return seen;
};

const listens = (live: Live, now: number): boolean =>
  live.waits > 0 ||
  (live.waitEnded !== undefined && now - live.waitEnded < LISTENING_GRACE_MS);

/**
 * The review's agents as the page shows them: the threads listening, else the thread heard from last and when, else
 * none heard from.
 */
export const presenceOf = (
  live: ReadonlyMap<ThreadId, Live>,
  kept: ReadonlyMap<ThreadId, number>,
  now: number,
): Presence => {
  const [first, ...rest] = [...live]
    .filter(([, item]) => listens(item, now))
    .map(([thread]) => thread);
  if (first !== undefined)
    return { state: "listening", threads: [first, ...rest] };
  let last: { readonly thread: ThreadId; readonly at: number } | undefined;
  for (const [thread, at] of [
    ...[...live].flatMap(([thread, item]) =>
      item.seen === undefined ? [] : [[thread, item.seen] as const],
    ),
    ...kept,
  ])
    if (last === undefined || at > last.at) last = { thread, at };
  return last === undefined
    ? { state: "never" }
    : {
        state: "away",
        thread: last.thread,
        seen_at: new Date(last.at).toISOString() as Timestamp,
      };
};

/**
 * When the presence next changes with nothing else happening: when the first thread that listens only because it
 * polled a moment ago stops counting. Undefined when time alone changes nothing.
 */
export const presenceExpires = (
  live: ReadonlyMap<ThreadId, Live>,
  now: number,
): number | undefined => {
  const ends = [...live.values()].flatMap((item) =>
    item.waits === 0 &&
    item.waitEnded !== undefined &&
    now - item.waitEnded < LISTENING_GRACE_MS
      ? [item.waitEnded + LISTENING_GRACE_MS]
      : [],
  );
  return ends.length === 0 ? undefined : Math.min(...ends);
};

/**
 * Whether what the reviewer sent at `sent` has no agent to read it yet: none listens, and none was heard from since.
 * An agent whose wait returned with it was heard from then, so it has it, listening or not.
 */
export const unheard = (presence: Presence, sent: string): boolean => {
  switch (presence.state) {
    case "listening":
      return false;
    case "away":
      return Date.parse(presence.seen_at) < Date.parse(sent);
    case "never":
      return true;
  }
};
