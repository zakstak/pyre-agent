---
name: deliver-yolo-pr
description:
  Use when the user requests unattended delivery of a supplied plan through
  implementation, a ready-for-review GitHub PR, local and Codex reviews, and
  automatic merge when every merge-risk axis is low.
metadata:
  version: "1.1.0"
---

# Deliver and merge a low-risk PR

Take the supplied plan to completion. Assume the sender will not monitor this
thread after initial clarification. Make routine decisions, fix verified
defects, and merge when the evidence meets the rules below. Do not ask for a
final merge confirmation already granted by the workflow invocation.

Apply the [technical-writing guide](../technical-writing/SKILL.md), including
its linked unslop guidance, to docs, commit messages, PR text, review replies,
and handoffs. Preserve repository-specific formats and templates.

The user's request to run this workflow authorizes scoped implementation,
checks, commits, task-branch pushes, a ready-for-review PR, Codex review
requests, review replies and resolutions, and a low-risk merge. A separate
top-level follow-up thread requires the user to request that delivery route.
Loading or discovering this skill alone grants none of those permissions. Follow
repository and environment restrictions. This workflow does not grant permission
for separate deployment actions, paid services, credential or policy changes,
unrelated work, or overwriting others' work. An authorized merge may run
existing repository automation. Assess those effects, including automatic
deployment, as part of merge risk. Any required target-specific deployment
approval still applies and must already be established before merging.

## Clarify once, before unattended work

Read the plan and inspect enough repository context to identify real questions.
Confirm the repository, target branch, acceptance criteria, scope exclusions,
and any plan-specific limits. Infer routine choices from the repository. Record
the chosen defaults, including the merge method and waiting budget. State that
current-head GitHub Codex review is required and may add external waiting time.
Ordinary requests to fix code do not select this unattended merge workflow.

Ask all material questions together now, while the sender may still be present.
Ask only about missing decisions that change scope, correctness, authority, or
the ability to finish unattended. Wait for essential answers before dependent
work. Silence never grants missing authority. If the plan is sufficient, state
the assumptions and proceed without a questionnaire.

After this phase, continue independent work when a new decision is needed.
Present the precise decision through the host's supported interaction route and
wait before dependent actions. Keep it in the current thread unless the user
requested a separate follow-up thread.

## Check open PRs and isolate the implementation

Identify the actual host, checkout, repository instructions, branch, dirty
files, remotes, and existing task PR. Use the current host's checkout and
installed guidance. Preserve existing files and collaborator commits. Use a
separate worktree when needed. A worktree isolates edits, not running processes
or access to live data. Use the project's sandbox for experiments, with
disposable data and separate ports. Do not run the application against
production resources.

List open PRs against the target branch, including drafts. Inspect likely
overlaps in files, interfaces, dependencies, migrations, and intended behavior.
Record relevant PRs and whether the work duplicates, depends on, or conflicts
with them. A clean Git merge does not prove semantic compatibility.

Reuse a PR only when it is clearly the same authorized task. Adapt independent
work to avoid collisions when practical. Do not modify, merge, close, or absorb
another PR just to unblock this task. If ownership or a prerequisite needs a
human decision, hand that decision off and continue only independent work.

## Implement and open for review

Implement the acceptance criteria and run checks appropriate to the change. Keep
one owning workflow. Review helpers may inspect bounded changes, but do not
invoke another task-to-PR orchestrator or recursively invoke this skill.
Delegation is optional and requires available tools and authorization.

Commit and push only task changes. Create a ready-for-review PR, not a draft,
unless repository policy requires a draft initially. In that case, mark it ready
when permitted so GitHub review can run. Include the concrete behavior,
validation, assumptions, and relevant PR interactions in the description.
Register the PR with the host thread when a linking tool is available.

Review the complete diff locally, including affected callers and failure paths.
Check the plan's acceptance criteria and look for regressions, security issues,
compatibility breaks, and unnecessary scope. Fix verified findings, rerun
affected checks, and push. Review advice must preserve explicit product
requirements. If a recommendation conflicts with one, preserve the requirement
and explain why that recommendation is not applied. Ask only if a material
choice remains unresolved. Local review does not replace GitHub Codex review.

For interface changes, inspect actual rendered states and exercise
representative complete interactions against the acceptance criteria. Source
inspection, test counts, and isolated component checks do not prove the
requested user flow. Report any acceptance state or interaction that could not
be verified.

## Complete GitHub Codex review and get the PR clean

Inspect the repository's Codex review setup and existing review state. Wait for
automatic review or request it through the supported repository mechanism. The
workflow permits a normal Codex review request, not installing or reconfiguring
the bot. If Codex review is unavailable, rate the missing evidence as unknown
and hand off. Do not substitute another bot or local self-review.

Require evidence that Codex completed review covering the current full head SHA.
Use the bot's actual completion signal and revision association, whether it
reports through a review, check, or documented comment mechanism. An empty list
of findings, a request acknowledgement, or an old-head review is insufficient.

Assess each finding against the code and plan. Fix valid in-scope defects,
verify, push, and reply with the fixing commit. Explain verified false positives
briefly. Resolve a bot thread only after the fix or explanation is posted. Do
not resolve uncertainty by dismissing the report. Reconcile all review comments
and conversations, not just the overall review status.

Apply clear, valid, in-scope human fixes autonomously. Leave disputed or
ambiguous human feedback unresolved and present the exact decision through the
host's supported interaction route. Do not manufacture an approval or dismiss a
blocking human review.

Repeat local review, affected checks, and Codex review after each new head.
Preserve review history when practical. Re-read remote state before pushes and
honor repository integration policy. Never overwrite collaborator changes.
Rebase only when appropriate and permitted. If an authorized rewritten branch
needs a push, tie force-with-lease to the inspected remote SHA.

Use the host's event-driven PR watcher when available. Save a checkpoint,
register the watch, and end the turn so the host can resume on events. Process
existing feedback before watching. A wake-up is a reason to reassess, not
evidence of readiness. Follow the host's waiting rules. Without a supported
watcher, check current state once and hand off the remaining wait. Do not create
polling loops or scheduled wake-ups, or promise monitoring after execution ends.

Default to two hours of cumulative waiting and at most three fix-and-review
rounds, unless the plan or repository specifies another limit. Record elapsed
waiting and rounds across resumes; a new head does not reset either budget.
Quota failures and missing review do not count as clean reviews. At the limit,
preserve the PR, checkpoint, and exact missing condition, then hand off. Do not
extend the budget automatically or skip required checks. If the host cannot wake
at the deadline, enforce it on the next resume and disclose that limitation.

## Rate risk and merge only when low

Use [the merge-risk rubric](references/merge-risk.md). Rate every axis as low,
medium, high, or unknown, with evidence and remaining uncertainty. Overall risk
is the highest axis. Unknown evidence blocks automatic merging. Never average
away a dangerous axis or infer low risk from a small diff or green CI alone.

Before merging, refresh the live PR, target branch, open-PR overlaps, check
results, review conversations, approvals, and mergeability. Assess base changes
since the last review. Integrate relevant drift or conflicts, rerun affected
checks, and obtain current-head Codex coverage after any resulting push.
Unrelated base movement still requires a recorded relevance assessment.

Merge only when all of these conditions hold:

- The final diff meets the plan and remains within the authorized scope.
- Local review is complete, applicable local checks pass, and required CI passes
  for the current head. Relevant optional failures are fixed or proven
  unrelated.
- GitHub Codex review completed for the current head, valid findings are fixed,
  and every conversation has a verified disposition. No unresolved human
  objection or required approval remains.
- Every risk axis is low, the PR is mergeable, and repository policy permits the
  merge. Unknown mergeability or unavailable required evidence blocks it.

Record the risk assessment and evidence in the PR before merging. Use the
repository's permitted merge method and an expected-head guard, such as
`gh pr merge --match-head-commit <full-sha>`. Do not use administrator bypass,
disable protections, or enqueue unconditional auto-merge for a future revision.
If the head changes, reassess it before another merge attempt. Honor a required
merge queue and verify its result rather than claiming queue admission is merge.

Confirm the PR's merged state and merge commit from the remote. Report the PR,
result, check and review evidence, risk ratings, and any remaining limitations.
Do not delete branches, worktrees, or recovery artifacts unless authorized.

## Preserve progress and move human follow-up

Keep a private checkpoint outside committed project files. Record the plan and
authority, host and checkout, branch and PR, head and assessed base SHAs,
relevant competing PRs, check results, Codex coverage, review dispositions, risk
ratings, retry budget, and next action. Reconcile it with live state on every
resume to avoid duplicate PRs, fixes, replies, or merge attempts.

If risk remains above low, evidence is missing, or a new human decision is
required, complete independent authorized work and leave the PR unmerged.
Present the blocker, decision needed, and resumption steps in the current thread
through the host's supported interaction route. Stop the PR watcher when handing
ownership back to the user.

Create a separate top-level follow-up only when the user requested that route
and the host supports it. Bind it to the existing task checkout and branch, with
the plan, PR, current evidence, exact blocker, and resumption steps. Retain the
returned ID and check for an existing follow-up before retrying a failed launch.
The follow-up must wait for the decision before dependent actions and must not
restart this workflow or create another handoff automatically. Link it from the
original thread using the host's returned link.

If the requested delivery route is unavailable, keep the handoff in the current
thread and private checkpoint, and report the exact limitation. Do not claim
another thread exists. Authentication blockers must name the failed operation
without asking for passwords or changing authentication policy.
