# Claude → Codex review contract

## Requirements

Requires Python 3.11+, Git supporting `--no-lazy-fetch`, and an already
installed/authenticated Codex CLI with access to the model pinned in the paired
TOML, `gpt-6.1-sol` when last checked. CLI flags were checked on 0.159.2;
bounded live inference also passed on 0.162.0 on 2026-10-09.
This integration never installs tools, logs in, changes `CODEX_HOME`, reads auth
files, or writes configuration. Account entitlement can only be established by a
successful call; model catalog membership alone is insufficient.

An explicit
`--profile-file /absolute/path/to/adversarial-branch-review.config.toml` can
select a paired profile from a trusted location. The bridge checks its exact
model and safety settings. Resolution order: explicit path, then the bundled
profile. A missing profile fails explicitly.

Cloning does not activate this skill. Explicit Claude invocation and disabled
nested delegation prevent recursive calls; the reviewer also forbids invoking
skills or loading agent memories.

The paired TOML is both the reviewer personality and a valid optional modern
Codex profile. The bridge reads it directly and passes invocation-local
overrides; it does not require installing that profile globally.

## Input

`python3 scripts/review_bridge.py --request /path/to/request.json`

`--request -` reads JSON from stdin. Input opening and reading share the total
`--timeout` deadline; a producer that keeps a pipe or FIFO open fails with a
structured timeout before review starts. Unknown fields and duplicate keys are
errors. Required strings: `repo` and `base`. Optional `head` defaults to `HEAD`;
`focus` is an array of up to 20 strings; `context` is a string; `subagents` is
an array of up to four objects with unique lowercase `name` slugs and a `task`
string. Refs are resolved with Git's end-of-options protection, then pinned to
commit hashes. The scope is `merge-base(base, head)..head`. Missing refs,
unavailable history, shallow repositories, unrelated histories, and ambiguous
merge bases fail without fetching. Legacy grafts are ignored through an
invocation-local `GIT_GRAFT_FILE` pointing at the platform's empty device, so
local graft metadata cannot rewrite the committed ancestry. Dirty or untracked
work in the target repository is excluded and flagged. Submodule worktrees are
not inspected; the review covers committed gitlink changes in the target
repository. Nothing switches the checkout.

Request example:

```json
{
  "repo": "/absolute/path/to/project",
  "base": "origin/main",
  "head": "HEAD",
  "focus": ["Authorization boundaries", "Backwards compatibility"],
  "context": "The route must remain compatible with existing API clients.",
  "subagents": [
    {
      "name": "security",
      "task": "Look for authorization bypasses introduced by this diff"
    },
    {
      "name": "compatibility",
      "task": "Check old clients and migration failure paths"
    }
  ]
}
```

Each specialist is an independent Codex subprocess, not a native Codex agent
role. Specialists run concurrently; the lead starts only after all return valid
results. Every subprocess uses the same model and read-only reviewer
personality. The lead gets their complete reports for verification and
deduplication. A failed specialist aborts the overall result; an incomplete
specialist forces the final verdict to `incomplete`. No additional nested agents
are enabled.

## Output

Success exits 0 with one JSON object and these fields:

- `schema_version`: `1`
- `status`: `review_completed` (or `preflight_passed` with `--check`)
- `model_requested`: the model pinned in the paired TOML; this is the exact CLI
  request, not a claim of independent verification of the service's internal
  routing
- `scope`: repository path, input refs, resolved `base_sha`, `head_sha`, unique
  `merge_base`, `local_changes_excluded`, and `empty_diff`
- `review`: `verdict`, `summary`, `coverage`, `limitations`, and `findings`
- `delegated_reviews`: each specialist's name, requested model, and full review

Each finding has severity `P0`–`P3`, title, repository-relative POSIX path,
positive line_start/line_end, evidence, impact, recommendation, and confidence
0–1. The [JSON schema](review.schema.json) is supplied to Codex and
independently validated by the bridge. Paths and line ranges are structurally
validated; Claude must still check that evidence and locations are correct. No
generated patch or external publication is part of the contract.

Failure exits 1, leaves stdout empty, and writes
`{"error":{"code":...,"message":...}}` to stderr. Cancellation (SIGINT or
SIGTERM) exits 130 with a structured cancelled error. Invalid CLI syntax exits 2
through argparse. Raw model event streams, CLI stderr, and authentication status
text are not forwarded to the caller. `--check` runs CLI/auth/model preflight
but does not request model inference.

## Safety and limits

The bridge uses argument arrays and stdin, never a shell. Implicit Git and
default Codex lookup use trusted absolute PATH directories and pin the selected
executable before target-directory launches; relative or empty PATH entries are
also removed from child PATH values. On Windows, suffix candidates are expanded
explicitly for Python 3.11 compatibility without searching the current
directory. An explicit `--codex-bin` remains a separate trusted caller choice
and can select a caller-relative executable. Wrapper Git calls disable fsmonitor
and untracked-cache helpers per process without changing Git configuration. The
dirty check enumerates conversion filter keys and disables clean/process
commands and required-filter enforcement for that invocation; it does not
recurse into submodule worktrees. Git replacement objects, pagers and lazy
fetching are disabled. Unsupported no-lazy-fetch flags or missing local objects
fail without an unprotected retry. Inherited `GIT_*` repository/config routing
variables are removed before subprocess launch; `GIT_NO_LAZY_FETCH=1` is set
again for wrapper and reviewer object reads; normal Codex authentication
environment remains available. A private temporary launch directory keeps
repository Codex configuration out of automatic discovery. It refuses launch
directories inside the target repository or beneath an ancestor
`.codex/config.toml`. `--ignore-user-config` keeps existing authentication but
skips user config. `--ignore-rules` also skips user/project execution rules,
whose explicit allow entries can otherwise bypass the read-only sandbox.
Invocation overrides clear MCP server configuration and disable apps, plugins,
hooks, memories, native multi-agent tools, and web search. The selected
model/provider, read-only sandbox, and approval policy are explicit. No model
fallback is implemented. Catalog absence, execution failure, failed turns,
malformed results, and observable model mismatches fail closed.

The read-only sandbox governs model-generated commands. The personality forbids
source edits, publication, credential access, tests/scripts with side effects,
and escalation. This is not an independent OS/container security boundary for
the Codex binary or administrator-managed configuration. Existing managed policy
still applies. Use a trusted CLI and review approved system configuration; never
run this against a hostile local installation. Normal Codex inference contacts
OpenAI and can incur account usage. The model can read local files permitted by
the sandbox; read-only does not mean repo-only read access. This bridge does not
make a claim that all network traffic is blocked.

The read-only sandbox does not exempt the Python wrapper or the Codex process
from Claude's outer permissions and sandbox. Use the host's normal permission
flow for file access, writing the private request, and running the exact
bundled Python command through Bash. The skill grants no `allowed-tools`
permissions. If a tool, file, network or runtime-storage access is denied,
return the blocker; do not change permission settings or rerun through a
different tool to avoid the denial.

Captured stdout/stderr use temporary disk streams with an 8 MiB per-stream limit
checked every 100 ms; excess output aborts rather than returning a truncated
review. Final review JSON is capped at 1 MiB per session.

Temporary reports are cleaned on success or failure. On POSIX, timeout, SIGINT,
SIGTERM, or a specialist failure kills active Codex process groups and prevents
further calls; on Windows, it kills the direct process only. Hard process
termination or machine failure may leave private temporary files. Codex may
still write its own operational cache/log files through normal CLI behavior;
`--ephemeral` prevents persisted session files. Request and report retention in
Claude's own conversation follows that host's policies.

## Why `codex exec`, not the built-in review shortcut?

The bridge needs a dynamic review prompt, explicit immutable base/head scope,
structured output, and separate specialist reports. A general non-interactive
`codex exec` invocation supports these together. It is not pretending to install
an agent role by placing an arbitrary TOML file under an `agents` directory.

## Official references checked 2026-10-09

- [Git command reference](https://git-scm.com/docs/git): `--no-lazy-fetch` and
  `GIT_NO_LAZY_FETCH`
- [Claude Code skills](https://code.claude.com/docs/en/skills): discovery,
  explicit invocation, skill-directory substitution, and host-only frontmatter
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference): exec,
  stdin, model, sandbox, JSON events, output schema, ephemeral, and auth status
- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced):
  standalone profile files and command-line precedence
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference):
  additive developer instructions and integration configuration
- [Codex models](https://learn.chatgpt.com/docs/models): exact model selection

Runtime flag and catalog checks are required because installations and account
access differ. The integration test suite mocks Codex and does not need
credentials.
