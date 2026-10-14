/**
 * What the home page's filter menus offer and write. A menu reads its state from the query and writes back into it,
 * so the field, the chips, and the menus never disagree: each value is a `key:value` term, included when the query
 * holds it, excluded when it holds it negated.
 */
import { threadName } from "../client/names.ts";
import type { ReviewSummary } from "../schema/rpc.ts";
import { type Query, repositoryOf, type Term } from "./query.ts";

/** A term a menu row writes. An exclusive one replaces the key's other positive terms when included. */
export type Option = { readonly key: string; readonly value: string; readonly exclusive: boolean };

export type TermState = "included" | "excluded" | "none";

/** The keys whose values come from the reviews on the page. */
export type FacetKey = "repo" | "author";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const valuesOf = (review: ReviewSummary, key: FacetKey): ReadonlySet<string> => {
  switch (key) {
    case "repo":
      return new Set([repositoryOf(review)]);
    case "author":
      return new Set(review.threads.map((thread) => threadName(thread.label)));
  }
};

/** The distinct values of a key with how many reviews carry each, the most carried first, then by name. */
export const facetValues = (
  reviews: ReadonlyArray<ReviewSummary>,
  key: FacetKey,
): ReadonlyArray<{ readonly value: string; readonly count: number }> => {
  const counts = new Map<string, number>();
  for (const review of reviews) for (const value of valuesOf(review, key)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

const isTerm = (term: Term, key: string, value: string): boolean => term.key === key && same(term.value, value);

/** Whether the query holds `key:value`, matched without regard to case, or `-key:value`. A substring marks nothing. */
export const termState = (query: Query, key: string, value: string): TermState => {
  const held = query.terms.filter((term) => isTerm(term, key, value));
  if (held.some((term) => !term.negated)) return "included";
  return held.some((term) => term.negated) ? "excluded" : "none";
};

/** The query with a term appended. */
export const withTerm = (query: Query, term: Term): Query => ({ terms: [...query.terms, term] });

/** The query without `key:value` either way round. */
export const withoutTerm = (query: Query, key: string, value: string): Query => ({
  terms: query.terms.filter((term) => !isTerm(term, key, value)),
});

/** The query without any term of the key. */
export const withoutKey = (query: Query, key: string): Query => ({ terms: query.terms.filter((term) => term.key !== key) });

/** The query that counts a row: without the positive terms its include would replace, so it can be added. */
export const restFor = (query: Query, option: Option): Query => ({
  terms: query.terms.filter(
    (term) => term.negated || term.key !== option.key || (!option.exclusive && !same(term.value, option.value)),
  ),
});

/** A click on the row: an included value is cleared, any other is included. */
export const include = (query: Query, option: Option): Query => {
  const { key, value } = option;
  if (termState(query, key, value) === "included") return withoutTerm(query, key, value);
  return withTerm(restFor(withoutTerm(query, key, value), option), { key, value, negated: false });
};

/** A click on Exclude: an excluded value is cleared, any other is excluded. */
export const exclude = (query: Query, option: Option): Query => {
  const { key, value } = option;
  const rest = withoutTerm(query, key, value);
  return termState(query, key, value) === "excluded" ? rest : withTerm(rest, { key, value, negated: true });
};

/** The State menu's values, in its two groups. Its `is:` values toggle beside the chips' rather than replace them. */
export const STATE_OPTIONS: ReadonlyArray<ReadonlyArray<Option & { readonly label: string }>> = [
  [
    { key: "is", value: "pr", exclusive: false, label: "Pull request" },
    { key: "is", value: "worktree", exclusive: false, label: "Worktree" },
  ],
  [
    { key: "is", value: "finished", exclusive: false, label: "Finished" },
    { key: "verdict", value: "approve", exclusive: true, label: "Approved" },
    { key: "verdict", value: "request_changes", exclusive: true, label: "Changes requested" },
    { key: "verdict", value: "comment", exclusive: true, label: "Commented" },
  ],
];

const STATE_IS: ReadonlyArray<string> = STATE_OPTIONS.flat().flatMap((option) => (option.key === "is" ? [option.value] : []));

/** Whether a term is the State menu's: `is:pr`, `is:worktree`, `is:finished`, or any `verdict:`. */
export const isStateTerm = (term: Term): boolean =>
  term.key === "verdict" || (term.key === "is" && STATE_IS.some((value) => same(term.value, value)));

/** The query without the State menu's terms; the chips' `is:` terms stay. */
export const withoutState = (query: Query): Query => ({ terms: query.terms.filter((term) => !isStateTerm(term)) });
