# Merge-risk rubric

Assess the final diff against the current target branch and the effects of
merging. For each axis, record a rating, concrete evidence, and any remaining
uncertainty. Use low, medium, high, or unknown. Unknown is blocking.

Low means the change's effects are understood, bounded, and adequately verified
for that axis. Medium means a material concern remains despite some mitigation.
High means a plausible failure has severe consequences or poor containment.
Missing decisive evidence means unknown, even when the likely outcome seems
safe. Rate an unaffected axis low only after checking that it is unaffected.

Evaluate these axes separately:

| Axis                           | Evidence needed for low risk                                                                                               | Reasons to raise the rating                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Correctness and regressions    | Acceptance criteria verified, affected behavior and failure paths reviewed, relevant tests pass                            | Unverified behavior, fragile ordering, missed edge cases, flaky relevant checks                    |
| Security and privacy           | Trust boundaries, permissions, secrets, and exposed data remain appropriate                                                | Authentication or authorization changes, sensitive data exposure, widened privileges               |
| Data integrity                 | Writes and migration behavior are understood, existing data is preserved, recovery is practical                            | Destructive migration, irreversible writes, untested upgrade or recovery                           |
| Compatibility and dependencies | Affected callers, public contracts, save formats, and dependency changes are checked                                       | Breaking API or format, unsupported consumers, unexplained dependency or lockfile churn            |
| Operations and performance     | Resource use, startup, concurrency, and merge-triggered automation are understood and verified where affected              | Broad rollout, live infrastructure effects, unbounded cost or resource use, deployment uncertainty |
| Scope and integration          | Final diff fits the plan, current base is assessed, competing PR interactions are resolved                                 | Scope drift, prerequisite PR, semantic conflict, unexplained remote changes                        |
| Verification and review        | Applicable checks pass, current-head local and GitHub Codex reviews are complete, conversations have verified dispositions | Missing or stale review, unavailable required checks, unresolved findings or human objection       |
| Recovery and blast radius      | A failure is contained and the actual effects can be reverted without losing data or disrupting unrelated users            | Shared critical path, difficult rollback, merge-triggered actions with no verified recovery        |

Overall risk is the highest individual rating. Automatic merging requires every
axis to be low. Medium, high, and unknown require a separate follow-up thread.
Reduce risk through scoped fixes and evidence. Do not lower a rating merely to
finish unattended.

Record the assessment in this form, with one line per axis:

```text
Assessed head: <full SHA>
Assessed base: <full SHA>
<Axis>: <rating>. Evidence: <result or link>. Remaining uncertainty: <detail or none>.
Overall: <rating>. Decision: <merge or leave open>. Reason: <decisive evidence or blocker>.
```

An ordinary revert is not sufficient recovery evidence when merging triggers
data changes or deployment. Inspect those effects and their recovery before
rating operations, data integrity, or recovery as low.
