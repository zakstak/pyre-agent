/**
 * Which revision the page acts on. The server refuses an action whose revision is not the review's current one, so
 * the page must send the revision its markup reflects, never one it has only heard of: an event can announce a new
 * round before its markup arrives, and the old markup's row numbers and verdict would then pass as current.
 */
export interface Revisions {
  /** The revision the markup shows. */
  readonly rendered: number;
  /**
   * The revision actions carry: the rendered one, advanced by the page's own actions while nothing else changed in
   * between. Those actions only add what the reviewer did, so the markup still describes the review they act on.
   */
  readonly basis: number;
  /** The newest revision the page heard of. Above `rendered`, the page is behind and refreshes. */
  readonly latest: number;
}

export const initial = (rendered: number): Revisions => ({
  rendered,
  basis: rendered,
  latest: rendered,
});

/**
 * The page's own action committed. It moves the basis only when the action was sent on the basis and made exactly
 * the next revision; otherwise someone else changed the review too, and the next action must wait for a refresh.
 */
export const afterOwnAction = (
  revisions: Revisions,
  sentWith: number,
  made: number,
): Revisions => ({
  ...revisions,
  basis:
    sentWith === revisions.basis && made === revisions.basis + 1
      ? made
      : revisions.basis,
  latest: Math.max(revisions.latest, made),
});

/** The page heard of a change, from its event stream or a refusal. */
export const afterEvent = (
  revisions: Revisions,
  revision: number,
): Revisions => ({
  ...revisions,
  latest: Math.max(revisions.latest, revision),
});

/**
 * New markup arrived. The basis never falls back: markup older than the basis lacks only the page's own actions.
 */
export const afterRefresh = (
  revisions: Revisions,
  rendered: number,
): Revisions => ({
  rendered,
  basis: Math.max(revisions.basis, rendered),
  latest: Math.max(revisions.latest, rendered),
});

export const isBehind = (revisions: Revisions): boolean =>
  revisions.latest > revisions.rendered;

/** The wait before retrying a failed refresh: 1 second, doubling, at most 30. */
export const retryDelay = (failures: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
