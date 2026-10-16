import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { ReviewSummary } from "../schema/rpc.ts";
import { exclude, facetValues, include, type Option, restFor, termState, withoutKey, withoutState } from "./facets.ts";
import { formatQuery, matches, parseQuery, withStanding } from "./query.ts";

const SHA = "a".repeat(40);
const AT = "2026-10-01T12:00:00.000Z";

const summary = (fields: Record<string, unknown>): ReviewSummary =>
  Schema.decodeUnknownSync(ReviewSummary)({
    created_at: AT,
    revision: 1,
    open_comments: 0,
    comments: 0,
    approvals: 0,
    submitted: false,
    threads: [],
    ...fields,
  });

const pr = (id: string, url: string, threads: ReadonlyArray<unknown>, fields: Record<string, unknown> = {}): ReviewSummary =>
  summary({ id, target: { kind: "github_pr", title: id, url, head_sha: SHA }, threads, ...fields });

const claude = { id: "t1", label: "Claude Code: fix the retry loop", host: { kind: "claude-code" } };
const claudeAgain = { id: "t4", label: "Claude Code: second look", host: { kind: "claude-code" } };
const codex = { id: "t2", label: "Codex", host: { kind: "codex" } };

const reviews = [
  pr("one", "https://github.com/acme/ledger/pull/1", [claude, claudeAgain]),
  pr("two", "https://github.com/acme/ledger/pull/2", [codex], { round: 1, submitted: true, verdict: "approve" }),
  pr("three", "https://github.com/acme/billing/pull/3", [codex, claude]),
  summary({
    id: "four",
    target: { kind: "worktree", title: "four", root: "/home/zak/src/ledger-feat", head_sha: SHA },
    threads: [codex],
  }),
];

const repo = (value: string): Option => ({ key: "repo", value, exclusive: true });
const author = (value: string): Option => ({ key: "author", value, exclusive: true });

test("a facet lists each value once with how many reviews carry it, the most carried first, then by name", () => {
  assert.deepEqual(facetValues(reviews, "repo"), [
    { value: "acme/ledger", count: 2 },
    { value: "acme/billing", count: 1 },
    { value: "ledger-feat", count: 1 },
  ]);
  // A review with two Claude Code threads counts once.
  assert.deepEqual(facetValues(reviews, "author"), [
    { value: "Codex", count: 3 },
    { value: "Claude Code", count: 2 },
  ]);
  assert.deepEqual(facetValues([], "repo"), []);
});

test("a value is included or excluded by a term equal to it, ignoring case; a substring marks nothing", () => {
  const query = parseQuery("is:open repo:ACME/Ledger -author:codex repo:led");
  assert.equal(termState(query, "repo", "acme/ledger"), "included");
  assert.equal(termState(query, "author", "Codex"), "excluded");
  assert.equal(termState(query, "repo", "ledger-feat"), "none");
  assert.equal(termState(query, "author", "Claude Code"), "none");
});

const BASE = "is:open repo:acme/ledger -author:codex";
const edit = (text: string, change: (query: ReturnType<typeof parseQuery>) => ReturnType<typeof parseQuery>): string =>
  formatQuery(change(parseQuery(text)));

test("clicking a row includes a value in place of the key's others, or clears it when included", () => {
  // Neither: include, replacing the other repo: term.
  assert.equal(edit(BASE, (q) => include(q, repo("acme/billing"))), "is:open -author:codex repo:acme/billing");
  // Included: clear.
  assert.equal(edit(BASE, (q) => include(q, repo("acme/ledger"))), "is:open -author:codex");
  // Excluded: include, its negated term removed.
  assert.equal(edit(BASE, (q) => include(q, author("Codex"))), "is:open repo:acme/ledger author:Codex");
  // Names with spaces come out quoted.
  assert.equal(edit(BASE, (q) => include(q, author("Claude Code"))), 'is:open repo:acme/ledger -author:codex author:"Claude Code"');
});

test("clicking Exclude excludes a value, or clears it when excluded", () => {
  // Neither: exclude, other terms kept.
  assert.equal(edit(BASE, (q) => exclude(q, repo("acme/billing"))), "is:open repo:acme/ledger -author:codex -repo:acme/billing");
  // Included: exclude.
  assert.equal(edit(BASE, (q) => exclude(q, repo("acme/ledger"))), "is:open -author:codex -repo:acme/ledger");
  // Excluded: clear.
  assert.equal(edit(BASE, (q) => exclude(q, author("codex"))), "is:open repo:acme/ledger");
});

test("the State menu's is: values sit beside the chips' term; the kinds and the verdicts replace their own", () => {
  const prOption: Option = { key: "is", value: "pr", exclusive: true, among: ["pr", "worktree"] };
  const worktree: Option = { key: "is", value: "worktree", exclusive: true, among: ["pr", "worktree"] };
  const approve: Option = { key: "verdict", value: "approve", exclusive: true };
  const comment: Option = { key: "verdict", value: "comment", exclusive: true };
  assert.equal(edit(BASE, (q) => include(q, prOption)), `${BASE} is:pr`);
  assert.equal(edit(`${BASE} is:pr`, (q) => include(q, worktree)), `${BASE} is:worktree`);
  assert.equal(edit(`${BASE} is:pr is:finished`, (q) => include(q, worktree)), `${BASE} is:finished is:worktree`);
  assert.equal(edit(`${BASE} is:pr`, (q) => include(q, prOption)), BASE);
  assert.equal(edit(`${BASE} verdict:approve`, (q) => include(q, comment)), `${BASE} verdict:comment`);
  assert.equal(edit(BASE, (q) => exclude(q, approve)), `${BASE} -verdict:approve`);
  // A chip keeps the State menu's is: term.
  assert.equal(formatQuery(withStanding(parseQuery("is:open is:pr"), "closed")), "is:closed is:pr");
});

test("a row counts the reviews the rest of the query leaves with its value", () => {
  const count = (text: string, option: Option): number => {
    const rest = restFor(parseQuery(text), option);
    const term = { key: option.key, value: option.value, negated: false };
    return reviews.filter((review) => matches({ terms: [...rest.terms, term] }, review)).length;
  };
  // The key's positive terms give way; its negated ones stay.
  assert.equal(count("repo:acme/billing", repo("acme/ledger")), 2);
  assert.equal(count("-author:codex", repo("acme/ledger")), 1);
  // The other kind gives way too: a row never counts a query no review can match.
  assert.equal(count("is:pr", { key: "is", value: "worktree", exclusive: true, among: ["pr", "worktree"] }), 1);
  assert.equal(count("is:pr", { key: "is", value: "pr", exclusive: true, among: ["pr", "worktree"] }), 3);
  // A value of another group keeps the kind: finished pull requests.
  assert.equal(count("is:pr", { key: "is", value: "finished", exclusive: false }), 1);
});

test("Clear removes every term of the key, and on the State menu only its own terms", () => {
  assert.equal(edit(`${BASE} repo:acme/billing`, (q) => withoutKey(q, "repo")), "is:open -author:codex");
  assert.equal(edit("is:open is:pr -is:finished verdict:approve webhook", withoutState), "is:open webhook");
});
