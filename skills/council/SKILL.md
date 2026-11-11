---
name: council
description:
  Use when the user says 'council' to request three delegates from different
  providers for help with their task.
metadata:
  version: "1.1.0"
---

# Council

Run council when the user requests it for a task. Quoting, editing, or
discussing this skill does not itself request a council. Keep the council within
the task's scope and existing authority.

## Prepare the work

Before an audit, address outstanding PR comments, fix known issues, and run
relevant checks. Give council the updated implementation; do not defer known
fixes until reviews return. If the user wants to discard the implementation and
explore new ideas, skip fixes to code being replaced.

## Select three providers

Bring in three delegates to help with the user's request, usually for review or
feedback. Use one strong model from each of three different providers, at high
reasoning effort. If the user's instructions name council members, use those.
Otherwise pick the latest flagship model from each provider, for example Claude
Opus, GPT Sol, and Gemini Pro.

In T3 Code, call `orchestrator_capabilities` once before the first delegation.
Resolve all three members and their supported high-effort options before
starting any delegate. Put settings in `target.options`, using the option IDs
and values returned by capabilities. Use `delegate_task` to start one delegate
per model in parallel. Elsewhere, use the harness's subagent tools.

If three providers, a named member, or a required effort setting is unavailable,
report the exact limitation. Do not silently substitute a provider, model, or
effort setting, or present a partial council as complete.

## Give each delegate the same task

Give each delegate a standalone brief with the request, scope, constraints,
relevant files, checks already run, and any known limitations. Do not assume
delegates inherit the conversation. For code review, identify the reviewed head,
base, and uncommitted changes so all three review the same implementation.
Include local changes in the review input; a checkout from a commit alone can
omit them.

For review or feedback, keep delegates read-only. Ask them for findings with
evidence, severity, and a recommended disposition. They must not edit files,
post PR comments, start PR watchers, or launch their own council. For a code
review, also ask each delegate for a score out of 10 and whether any in-scope
issue prevents them from being satisfied with the result.

Follow the host's completion instructions. In T3 Code, honor each delegated
task's `next`: if completion wakes the thread, end the turn after launching the
members. Do not poll or add another watcher. Cancel delegates whose work is
replaced or no longer needed through `task_cancel`.

## Assess findings and repeat within scope

Collect all three responses and summarize useful findings, disagreements, and
recommended next steps. Verify findings against the implementation and request.
Fix recommendations you agree are valid and in scope, then run affected checks.
Explain why you reject a finding; do not change code only to raise a score.

Count each full review pass as one round. A fresh review after fixes starts a
new round with three new delegate tasks. Give them the updated implementation
and relevant prior findings. Do not reuse an old-head approval as review of
changed code. A failed or missing delegate leaves the round incomplete; it is
not a clean review.

Continue until all delegates are satisfied with the outcome. Satisfaction does
not require a score of 10. Use the user's or owning workflow's review budget;
otherwise allow at most three full rounds. If that budget is exhausted, a
delegate is unavailable, or the same disagreement persists without new evidence,
stop and report the remaining findings and decision needed. Do not claim that
the council approved the result.

Do not let repeated reviews expand scope. Decline unrelated improvements with
reasons. Ask the user only when a material disagreement requires their decision.

## Record the results

If the work ends in a pull request, put the results in the PR description. Put
this section before an existing model and harness line at the end. If there is
no such line, append the section without inventing one:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 7/10 | 9/10 |
| GPT Sol | 8/10 | 10/10 |
| Gemini Pro | 8/10 | 9/10 |
```

Use the actual model names, rounds, and scores. The table above is an example.
If a completed review gives no score, write `no score`. Mark a failed or missing
review `incomplete` and explain it. Do not invent scores or approval. If the PR
is open, edit the description. Do not post a comment for this. If there is no
PR, put the same results in the final reply only. Include material
disagreements, their disposition, and remaining limitations beside the table.
Preserve the rest of the PR description. If the PR is closed or cannot be
edited, report the results in the final reply with that limitation.
