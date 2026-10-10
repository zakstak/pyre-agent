---
disable-model-invocation: true
name: correct
description: "Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, then types, then a lint whose error names the fix, then a test, and write docs last. Prove each check fails on a real past mistake. Repeat this each time the operator corrects you. Use when explicitly asked to correct recurring repository mistakes."
---

# Correct

The operator keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Use this workflow when asked to address recurring repository mistakes. Agree on the classes and scope to fix. A correction or review request alone does not authorize edits, commits, or changes to shared agent instructions.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

First, read recent commits, reverts, review comments, agent instruction files, and comments that explain workarounds. Group the mistakes into classes. A class counts once it has happened twice.

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state can't be written.** If bad code still compiles, add a lint or CI check whose error names the file, type, or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behavior.** Fix or delete any test that would still pass if every function it calls returned nothing.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Then fix the authorized classes in separately reviewable changes. Make one commit per class when committing is authorized. Prove each new check fails on a real past mistake. Run the same command locally and in CI when those checks are available and within scope. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.

## Keep the rule table

When updating agent instructions is authorized, keep a table there that pairs each rule with what enforces it. Treat each correction as evidence of a possible repeat; fix it and update the rule only within the agreed scope. If the rule was already there and nothing enforces it, propose the highest-level fix. Drop an obsolete rule when changing that instruction file is authorized.

**Reply:** each class with its evidence, the level you picked, and why a higher level didn't work.
