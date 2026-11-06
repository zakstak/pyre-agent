---
name: babysit-pr
description:
  Use when the user asks to monitor, watch, or babysit a pull request through
  review and CI.
metadata:
  version: "1.0.2"
---

# Babysit PR

Monitor the requested PR, assess feedback, and fix valid in-scope issues within
the user's authority. Merge only when the user explicitly requested it. Keep the
PR at the size the user's goal needs.

## Waiting

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher per
PR: `watch_pull_request` in T3 Code, `pr-wait` everywhere else. Never run both
on the same PR. Every watcher on a GitHub account shares its rate limit.

### In T3 Code: `watch_pull_request`

Handle existing checks and comments first. Finish any needed branch update and
push. Then call `watch_pull_request` and end your turn. T3 Code wakes you when a
check fails, required checks pass, someone comments or reviews, or the branch
conflicts.

- Only the thread that owns the PR watches it. A delegated child must never call
  `watch_pull_request`; report its findings to the parent. Do not watch PRs
  outside your task.
- A wake is news, not a merge decision. Check the merge gate yourself.
- Unwatch before handing off as ready or blocked, or asking the user a question.
  Call `unwatch_pull_request` first. A watched thread stays in Working and out
  of the user's inbox. Merge or closure ends the watch itself.
- If the watcher says "Stopped watching, could not read it", inspect the actual
  error. For a rate-limit failure, run
  `gh api rate_limit --jq .resources.graphql`. If `remaining` is near zero, use
  a supported one-time background wait until `reset` before watching again. If
  that mechanism is unavailable, report the blocker and reset time. Never retry
  in a tight loop or create another polling watcher.

### Everywhere else: `pr-wait`

Wait with [scripts/pr-wait](scripts/pr-wait) from this skill's directory. Use
its absolute path, not a command assumed to be on `PATH`:

```bash
/absolute/path/to/babysit-pr/scripts/pr-wait <pr> [--repo [host/]owner/name] [--until ready|green|any-change]
```

The helper requires Python 3.10 or newer, POSIX file locking, and an
authenticated `gh` on `PATH`. It stores locks and event state in
`~/.local/state/pr-wait/`, keyed by host, repository, and PR number. Older state
without a hostname starts a fresh baseline. Its review query reads at most 100
items per connection; independently verify paginated review state at the final
gate.

GitHub Enterprise PR URLs work directly. For a PR number, `gh` resolves the host
from a host-qualified `--repo`, `GH_HOST`, or the current checkout. Authenticate
`gh` to that host first. Every later request uses the host from the resolved PR
URL, including REST and GraphQL queries.

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you, and 2 on bad input. Required check
failure, conflicts, unresolved threads, and PR closure need attention. Read the
terminal event; exit 0 after a merge does not mean an open PR is ready.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope. This mode does not establish review approval.
- `any-change`: exit on the first event.

In Claude Code, use the Monitor tool with `timeout_ms: 3600000` when available,
so each line wakes you. Without a monitor, run it as one long command that ends
on its own. Respect the host's execution and completion instructions.

Start it again after a push, after handling exit 1, and after a resume. It
remembers reported events so events that arrived between runs are retained. If
another process already watches the PR, do not start a second one. Stop the old
process only after verifying that it belongs to this task and its events no
longer reach you.

With either watcher, when an event needs no action, end your turn without a
message if the host supports that lifecycle. Never post or say "still waiting".

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. When GraphQL is
exhausted, REST has a separate limit and may still be available. Use
`gh api repos/<owner>/<repo>/pulls/<n>` to read a PR and
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for checks. Include
legacy commit statuses and all result pages when assessing CI. Unavailable
review or check evidence does not establish readiness.

## Reviews

Use check runs and review evidence associated with the latest head SHA.
Reconcile every unresolved finding, including comments from before the latest
push that still apply. Notification deduplication must not hide outstanding
work. Verify every bot finding against the current source before changing code.

Fix real findings and CI failures. Distinguish repository failures from
infrastructure flakes. If the repo has `.macroscope/check-run-agents/*.md`, read
the cited rules before replying to a Macroscope finding.

CodeRabbit is advisory. Assess its findings, but do not wait for an optional
CodeRabbit review or hold a merge for it. Required repository gates still apply.

For a false positive or feedback that does not warrant a change, reply with a
written reason and then resolve the thread. Use the
[leaving-pr-comments skill](../leaving-pr-comments/SKILL.md) for every comment
posted on the user's behalf. Confirm the reply succeeded before resolving.
Follow the owning workflow's rules for human feedback and disputed findings.

Review loops tend to grow a PR one small fix at a time. Fix real bugs in the
intended case. Decline unrelated tests, guards, integration, compatibility, or
performance work with reasons and list it as follow-up work. Prefer a fix that
deletes or narrows code. Use screenshots or videos when they help explain a
finding and an authorized upload path is available.

## Base branch and merging

Track the PR's actual base branch. `pr-wait` reports new base commits that touch
this PR's files and when the PR becomes BEHIND or DIRTY. `watch_pull_request`
reports conflicts only, so check for BEHIND yourself before calling the PR
ready. If an overlapping PR makes this one obsolete, unwatch, report it, and ask
before closing unless closure was authorized.

Stop when `pr-wait` exits 0 or the T3 merge gate passes on the latest head.
Before reporting ready, verify the PR is open, required CI and repository review
gates pass, applicable findings are handled, and no relevant base drift
invalidates that evidence. A watcher signal alone does not prove these facts.
Report ready unless merging was explicitly requested.

Immediately before an authorized merge, fetch and re-read the PR, its head,
base, checks, reviews, and mergeability. Never merge while BEHIND or DIRTY, or
when base commits after the last green run touch this PR's files. Account for
related interfaces and dependencies too; cleanly merging files alone does not
prove compatibility.

Rebase when needed and permitted by repository policy. Preserve collaborator
commits and dirty files. If a rewritten branch needs an authorized push, use
`--force-with-lease` tied to the inspected remote SHA. Push, wait for CI, and
reassess review coverage after the new head. Respect repository merge policy and
use an expected-head guard for the final merge. Verify the merged state.

## Source

The bundled helper is adapted from
[tstack at revision 1085050f3baed1ac724caa4a8166145fb2ac88af](https://github.com/t3dotgg/tstack/blob/1085050f3baed1ac724caa4a8166145fb2ac88af/skills/babysit-pr/scripts/pr-wait).
Local changes add GitHub Enterprise host resolution, pin requests to that host,
and separate watcher state and locks by host. Copyright (c) 2026 Theo Browne.
See the project's [MIT license](../../LICENSE) and
[credits](../../README.md#license-and-credits).
