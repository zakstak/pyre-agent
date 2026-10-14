import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { ReviewSummary } from "../schema/rpc.ts";
import { formatQuery, hasStanding, matches, parseQuery, withStanding } from "./query.ts";

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

const claude = { id: "t1", label: "Claude Code: fix the retry loop", host: { kind: "claude-code" } };
const codex = { id: "t2", label: "Codex", host: { kind: "codex" } };
const second = { id: "t3", label: "Claude Code: split the dispatcher", host: { kind: "claude-code" } };

/** A pull request that needs the reviewer: Claude Code published round 2, nobody finished it. */
const webhook = summary({
  id: "webhook",
  target: { kind: "github_pr", title: "Retry webhook signature freshness", url: "https://github.com/acme/ledger/pull/412", head_sha: SHA },
  round: 2,
  threads: [claude],
});
/** A working tree the reviewer finished, waiting for Codex and a second Claude Code thread. */
const branch = summary({
  id: "branch",
  target: { kind: "worktree", title: "Split the dispatcher", root: "/home/zak/src/ledger-feat", head_sha: SHA, branch: "feat/dispatch" },
  round: 1,
  submitted: true,
  verdict: "request_changes",
  threads: [codex, second],
});
/** A closed pull request review that Codex took part in. */
const closed = summary({
  id: "closed",
  target: { kind: "github_pr", title: "Old webhook retry", url: "https://github.com/acme/billing/pull/7", head_sha: SHA },
  closed_at: AT,
  round: 1,
  submitted: true,
  verdict: "approve",
  threads: [codex],
});
const all = [webhook, branch, closed];

const shown = (text: string): ReadonlyArray<string> =>
  all.filter((review) => matches(parseQuery(text), review)).map((review) => review.id);

test("a query splits on spaces, keeps quoted values whole, and reads a leading minus as negation", () => {
  assert.deepEqual(parseQuery(' is:open  -author:codex repo:"acme/ledger" "signature freshness" IS:Closed').terms, [
    { key: "is", value: "open", negated: false },
    { key: "author", value: "codex", negated: true },
    { key: "repo", value: "acme/ledger", negated: false },
    { key: undefined, value: "signature freshness", negated: false },
    { key: "is", value: "Closed", negated: false },
  ]);
  // Terms with no value yet, as while typing, are dropped; a lone minus is a word.
  assert.deepEqual(parseQuery("is: -is:").terms, []);
  assert.deepEqual(parseQuery("-").terms, [{ key: undefined, value: "-", negated: false }]);
  assert.equal(formatQuery(parseQuery('-repo:"acme ledger"  webhook')), '-repo:"acme ledger" webhook');
});

test("the brief's examples", () => {
  assert.deepEqual(shown("is:open -author:codex"), ["webhook"]);
  assert.deepEqual(shown("repo:ledger is:yours"), ["webhook"]);
  assert.deepEqual(shown("-is:closed webhook"), ["webhook"]);
  assert.deepEqual(shown("host:codex"), ["branch", "closed"]);
  assert.deepEqual(shown("branch:feat/ -is:finished"), []);
  assert.deepEqual(shown("branch:feat/"), ["branch"]);
});

test("bare words match the title, repository, checkout, branch, PR number, and thread names, ignoring case", () => {
  assert.deepEqual(shown("WEBHOOK"), ["webhook", "closed"]);
  assert.deepEqual(shown("ledger"), ["webhook", "branch"]);
  assert.deepEqual(shown("dispatch"), ["branch"]);
  assert.deepEqual(shown("#412"), ["webhook"]);
  assert.deepEqual(shown("412"), ["webhook"]);
  assert.deepEqual(shown("claude"), ["webhook", "branch"]);
  assert.deepEqual(shown('"signature freshness"'), ["webhook"]);
  assert.deepEqual(shown(""), ["webhook", "branch", "closed"]);
});

test("each key matches its own field, enumerations exactly", () => {
  assert.deepEqual(shown("is:open"), ["webhook", "branch"]);
  assert.deepEqual(shown("is:closed"), ["closed"]);
  assert.deepEqual(shown("is:waiting"), ["branch"]);
  assert.deepEqual(shown("is:finished"), ["branch", "closed"]);
  assert.deepEqual(shown("is:pr"), ["webhook", "closed"]);
  assert.deepEqual(shown("is:worktree"), ["branch"]);
  assert.deepEqual(shown("is:op"), []);
  assert.deepEqual(shown("is:constructor"), []);
  assert.deepEqual(shown("repo:ledger-feat"), ["branch"]);
  assert.deepEqual(shown("repo:billing"), ["closed"]);
  assert.deepEqual(shown("author:codex"), ["branch", "closed"]);
  assert.deepEqual(shown("author:dispatcher"), ["branch"]);
  assert.deepEqual(shown("host:claude"), []);
  assert.deepEqual(shown("host:claude-code"), ["webhook", "branch"]);
  assert.deepEqual(shown("verdict:approve"), ["closed"]);
  assert.deepEqual(shown("verdict:request"), []);
  assert.deepEqual(shown("round:2"), ["webhook"]);
  assert.deepEqual(shown("round:two"), []);
});

test("label and unknown keys match nothing, so negating them hides nothing", () => {
  assert.deepEqual(shown("label:bug"), []);
  assert.deepEqual(shown("-label:bug"), ["webhook", "branch", "closed"]);
  assert.deepEqual(shown("colour:red"), []);
});

test("a standing chip replaces every is: term and is pressed only alone", () => {
  const query = parseQuery("is:open -is:closed webhook");
  assert.equal(hasStanding(query, "open"), false);
  const next = withStanding(query, "yours");
  assert.equal(formatQuery(next), "is:yours webhook");
  assert.equal(hasStanding(next, "yours"), true);
  assert.equal(hasStanding(parseQuery("-is:yours"), "yours"), false);
  // The State menu's is: terms sit beside a chip's: the chip stays pressed and keeps them.
  assert.equal(hasStanding(parseQuery("is:open is:pr"), "open"), true);
  assert.equal(formatQuery(withStanding(parseQuery("is:open is:pr"), "closed")), "is:closed is:pr");
});
