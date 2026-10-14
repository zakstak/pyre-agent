/**
 * The home page's review filter as a query, as on GitHub's pull request list: terms separated by spaces, each a bare
 * word or `key:value`, any of them negated with a leading `-`, and a value quoted to hold spaces. A review matches
 * when every positive term matches it and no negated term does.
 */
import type { ReviewSummary } from "../schema/rpc.ts";

export type Term = { readonly key: string | undefined; readonly value: string; readonly negated: boolean };
export type Query = { readonly terms: ReadonlyArray<Term> };

/** Whose move a review waits for: the reviewer's, the agents', or nobody's once it is closed. */
export type Standing = "yours" | "agents" | "closed";

export const standing = (review: ReviewSummary): Standing =>
  review.closed_at !== undefined ? "closed" : review.round !== undefined && !review.submitted ? "yours" : "agents";

/** The query's terms as written: the text split on spaces outside quotes. */
const tokens = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let token = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && /\s/.test(char)) {
      if (token !== "") found.push(token);
      token = "";
    } else token += char;
  }
  if (token !== "") found.push(token);
  return found;
};

/**
 * The terms of a query's text. A term with no value, such as `is:` or a lone `-` while the reviewer types, is
 * dropped rather than matching nothing.
 */
export const parseQuery = (text: string): Query => ({
  terms: tokens(text).flatMap((token) => {
    const negated = token.length > 1 && token.startsWith("-");
    const rest = negated ? token.slice(1) : token;
    const keyed = /^([A-Za-z]+):(.*)$/s.exec(rest);
    const key = keyed?.[1]?.toLowerCase();
    const value = (keyed?.[2] ?? rest).replaceAll('"', "");
    return value === "" ? [] : [{ key, value, negated }];
  }),
});

/** A query as text again, quoting values that hold spaces. */
export const formatQuery = (query: Query): string =>
  query.terms
    .map(({ key, value, negated }) => {
      const shown = /\s/.test(value) ? `"${value}"` : value;
      return `${negated ? "-" : ""}${key === undefined ? "" : `${key}:`}${shown}`;
    })
    .join(" ");

/** A pull request's `owner/name` and number from its URL. */
const pullRequest = (url: string): { readonly repository: string; readonly number: string } | undefined => {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { repository: match[1], number: match[2] };
};

/** What `repo:` reads: the pull request's `owner/name`, or the checkout's folder name. */
const repositoryOf = (review: ReviewSummary): string => {
  const { target } = review;
  if (target.kind === "github_pr") return pullRequest(target.url)?.repository ?? target.url;
  return target.root.split("/").filter((part) => part !== "").at(-1) ?? target.root;
};

const includes = (text: string, value: string): boolean => text.toLowerCase().includes(value.toLowerCase());

const IS: ReadonlyMap<string, (review: ReviewSummary) => boolean> = new Map([
  ["open", (review) => review.closed_at === undefined],
  ["closed", (review) => review.closed_at !== undefined],
  ["yours", (review) => standing(review) === "yours"],
  ["waiting", (review) => standing(review) === "agents"],
  ["finished", (review) => review.verdict !== undefined],
  ["pr", (review) => review.target.kind === "github_pr"],
  ["worktree", (review) => review.target.kind === "worktree"],
]);

const matchesTerm = (term: Term, review: ReviewSummary): boolean => {
  const { target, threads } = review;
  const value = term.value.toLowerCase();
  switch (term.key) {
    case undefined: {
      const number = target.kind === "github_pr" ? `#${pullRequest(target.url)?.number ?? ""}` : "";
      const branch = target.kind === "worktree" ? (target.branch ?? "") : "";
      const labels = threads.map((thread) => thread.label).join(" ");
      return includes(`${target.title} ${repositoryOf(review)} ${branch} ${number} ${labels}`, value);
    }
    case "is":
      return IS.get(value)?.(review) ?? false;
    case "repo":
      return includes(repositoryOf(review), value);
    case "branch":
      return target.kind === "worktree" && target.branch !== undefined && includes(target.branch, value);
    case "author":
      return threads.some((thread) => includes(thread.label, value));
    case "host":
      return threads.some((thread) => thread.host.kind === value);
    case "verdict":
      return review.verdict === value;
    case "round":
      return /^[0-9]+$/.test(value) && review.round === Number(value);
    // Reviews carry no GitHub labels or PR author yet: `label:` matches nothing until the server fetches them.
    case "label":
      return false;
    default:
      return false;
  }
};

/** Whether a review matches every positive term of the query and none of its negated terms. */
export const matches = (query: Query, review: ReviewSummary): boolean =>
  query.terms.every((term) => matchesTerm(term, review) !== term.negated);

/** The query without its `is:` terms, which the standing chips count across. */
export const withoutStanding = (query: Query): Query => ({ terms: query.terms.filter((term) => term.key !== "is") });

/** The query with its `is:` terms replaced by `is:value`, first. */
export const withStanding = (query: Query, value: string): Query => ({
  terms: [{ key: "is", value, negated: false }, ...withoutStanding(query).terms],
});

/** Whether the query holds `is:value` and no other `is:` term. */
export const hasStanding = (query: Query, value: string): boolean => {
  const [only, ...others] = query.terms.filter((term) => term.key === "is");
  return only !== undefined && others.length === 0 && !only.negated && only.value.toLowerCase() === value;
};
