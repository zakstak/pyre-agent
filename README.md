# Pyre Agent

User-installed, reusable skills for Claude Code, Codex, and the agent providers inside T3 Code. Skills apply across your projects after you choose to install them at user scope. This repository does not install anything, change your agent settings, or grant a skill permission to expand a task.

Zak's plain global instruction file is provided separately at [`global/AGENTS.md`](global/AGENTS.md).

Each skill is proposed in its own draft pull request. Review the wording, companion dependencies, and checks before merging. No skill is approved merely because its PR exists. The initial main branch intentionally contains only this README.

## Shared internal visual reference

[BRAND.md](BRAND.md) points to the self-contained [internal-visual-style skill](skills/internal-visual-style/SKILL.md). Use it for all UI and theming work without a specific product design system, including plans, review pages, reports, and ad hoc visual artifacts. Product-specific branding takes precedence. Install the complete skill folder for its maintained reference, shared semantic tokens, plain HTML, Tailwind v4 build entry, theme control, and bundled reading font. Final palette, theme treatment, banner, and technical mono remain undecided. No global installation is performed by this proposal.

## Install only what you approve

When a skill is merged, its complete folder lives at `skills/<skill-name>/`, with `SKILL.md` and any required scripts/references/assets. The project MIT license is in root LICENSE; upstream copyright notices and source credits are in this README; individual skill folders contain no README or LICENSE files. Review existing names before copying; do not overwrite another skill blindly. Keep referenced companion folders as siblings. Copy the whole skill folder, not just SKILL.md, and keep root LICENSE and this README once alongside the installed skill folders. Preserve the copyright notices and shared permission text when copying or distributing the material.

| Agent | User-level destination | Invocation |
| --- | --- | --- |
| Claude Code | `skills/<skill-name>/` in the effective `CLAUDE_CONFIG_DIR` (defaults to `~/.claude/skills/<skill-name>/`) | `/skill-name` or matching requests |
| Codex | `~/.agents/skills/<skill-name>/` | `$skill-name` or matching requests |
| T3 Code | The user-level skill directory of its selected agent provider | Use that provider's supported skill invocation |

The portable skills use the common name/description frontmatter and do not require a Cursor SDK. Host-specific workflows are proposed separately under `host-skills/`. A Claude-only Codex review bridge is invoked explicitly and requires an already installed/authenticated Codex CLI with the exact supported model. Its paired profile stays inside its folder. It is not a portable core skill or a second review workflow.

## Claude-only review bridge installation

For global Claude discovery, copy this entire `host-skills/claude-code/codex-branch-review` folder to `skills/codex-branch-review` inside the effective `CLAUDE_CONFIG_DIR` (defaults to `~/.claude/skills/codex-branch-review`). [Claude config-directory override](https://code.claude.com/docs/en/claude-directory) Its paired profile is already bundled under `references/`; do not copy a profile separately or modify global Codex configuration. Review an existing skill before overwriting it. The installed skill is independent of this checkout and of the current working directory.

A symlink to the complete skill folder is another user-controlled option; it depends on retaining the source checkout.

The bridge uses its bundled profile directly; no global Codex profile installation is required. For manual profile use, Codex 0.134+ expects `$CODEX_HOME/adversarial-branch-review.config.toml`, selected by `codex --profile adversarial-branch-review`. Installing it is a separate action. Do not put it in the obsolete `[profiles.adversarial-branch-review]` table. The standalone profile does not provide the bridge's isolated launch, preflight or Git ancestry checks and process protections. 

## Permissions for executable skills

The Claude-only bridge needs normal Read/Write access for its private request and Bash approval for the exact Python wrapper command. It deliberately grants no `allowed-tools` permissions. An existing allow rule must match that wrapper command; a rule for `codex` alone does not match Python launching Codex. Deny and managed rules still apply. The renderer likewise needs permission to read the selected PR and write its private artifacts. A skill invocation does not remove host restrictions. [Claude permissions](https://code.claude.com/docs/en/permissions)

Claude's Bash sandbox also constrains child processes. Codex needs its existing authentication, account/model access, network route and ordinary writable runtime storage; the wrapper needs private temporary files. Nested policy can block these even when direct Codex works. Report the denial without changing sandbox rules, copying credentials or retrying outside the boundary. [Claude sandbox](https://code.claude.com/docs/en/sandboxing)

The bridge pins `gpt-6.1-sol`, uses read-only model-command sandboxing, disables execution rules and user config for that review call while retaining normal authentication, and validates completion and structured reports. `--ephemeral` suppresses session rollout persistence; it does not promise zero CLI cache/log writes. Existing managed policy still applies. [Codex CLI](https://learn.chatgpt.com/docs/cli/reference), [configuration](https://learn.chatgpt.com/docs/config-file/config-reference)

`deliver-draft-pr` requires explicit invocation. Its Claude `disable-model-invocation` field and Codex `agents/openai.yaml` policy provide the documented host controls. Codex 0.162.0 accepted that combined metadata in a temporary discovery check. These CLI frontmatter extensions are not a claim of compatibility with strict generic skill upload packagers. No workflow was invoked. [Claude skills](https://code.claude.com/docs/en/skills), [Codex skills](https://learn.chatgpt.com/docs/build-skills)

## Global AGENTS.md

[`global/AGENTS.md`](global/AGENTS.md) is Zak's plain global instruction file, with no skill metadata, triggers or wrapper. It retains the approved communication, architecture, planning, preservation-of-work and scope preferences. Saga, operating-system, machine-path and computer-operation specifics were removed; Forge's installed original remains unchanged.

Review and reconcile the file with your existing global instructions before manually copying its contents to the provider destination below. Preserve existing instructions rather than replacing them blindly. Cloning this repository does not install or replace your global file. Installing skills is separate from installing this file.

After approval, manually install the reconciled file at the selected provider's user-level destination:

| Provider | Deliberate activation destination |
| --- | --- |
| Codex | `AGENTS.md` in the effective `CODEX_HOME` (defaults to `~/.codex/AGENTS.md`). A non-empty `AGENTS.override.md` takes precedence, so reconcile with that file if present. [Global guidance discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| Claude Code | `CLAUDE.md` in the effective `CLAUDE_CONFIG_DIR` (defaults to `~/.claude/CLAUDE.md`). [User instructions](https://code.claude.com/docs/en/memory), [config-directory override](https://code.claude.com/docs/en/claude-directory) |
| T3 Code | Use its selected provider's destination above on the machine running that provider, accounting for the configured Codex home or Claude config directory. For another provider, consult its instruction documentation. [Codex provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md), [Claude provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md) |

## Scope and private reviews

Skills guide work within your current request and agent permissions. Review requests do not authorize source changes, commits, merges, publication, or credential changes. The offline PR review viewer keeps source and notes local; export notes before closing it. Do not publish private-code reviews to an unapproved audience.

## Official discovery references

- [Claude Code personal skills](https://code.claude.com/docs/en/skills)
- [Codex user skills](https://learn.chatgpt.com/docs/build-skills)
- [T3 Code agent-provider architecture](https://github.com/pingdotgg/t3code)

Discovery depends on your installed version and provider. These destinations are instructions for deliberate user installation, not actions performed by cloning this repository. Keep repository root LICENSE and README with the copied skill collection. No README, LICENSE or NOTICE file is needed inside an individual skill folder.

## Proposal dependencies

Merge this root-documentation proposal before merging the twelve upstream-derived skill imports (`correct`, `pr-review-canvas`, the seven `principle-*` proposals, `technical-writing`, `typescript-best-practices` and `unslop`). The common MIT permission text is in repository root LICENSE; upstream copyright notices and concise credits live only in this root README. The Claude-only bridge and global AGENTS.md proposals also depend on this README for their setup and adoption instructions. These are explicit dependencies; no proposal is automatically merged or installed.

## Renderer verification

The [PR review canvas proposal](https://github.com/zakstak/pyre-agent/pull/2) passed 22 Python tests and the production-JS DOM test. Existing Chromium and Playwright also passed the real browser interaction suite: desktop, mobile, dark mode, grouping, filters, folding, notes, flags, JSON download, reload privacy, injection probes, no external requests, CSP and no-JS fallback.

Its screenshots under `validation/pr-review-canvas/` show only the fictional bundled example, using the same renderer/assets tested in that proposal. No private PR source or credentials appear. At a 375-pixel viewport, the page had no horizontal overflow; individual code views retain their own scrolling. The evidence files are `desktop.png`, `mobile.png` and `dark-mobile.png`.

Once that proposal is merged, run `python3 -m unittest discover -s tests -p test_review_renderer.py` and `node tests/browser_review.unit.cjs`. Real-browser checks require already available Playwright and Chromium; `tests/browser_review.cjs` documents its environment overrides. No dependency installation or global activation is performed by these checks.

## Qualification checked 2026-10-09

Source review and direct helper tests do not qualify every provider session. PASS below applies only to the stated path.

| Path and installed version | Result | Evidence and boundary |
| --- | --- | --- |
| Direct renderer: Python 3.14.7, Node 26.10.0; prior Chromium 152 | PASS | 22 Python tests and production-JS DOM checks passed; unchanged renderer/assets retain prior desktop/mobile/dark browser QA. This is not an agent skill invocation. |
| Direct bridge: Python 3.14.7, Git 2.55.0, Codex 0.162.0, requested Sol 6.1 | PASS | Preflight passed. Two live specialists and the lead detected the synthetic empty-input regression and returned one deduplicated P2 finding. The fixture worktree and Git objects were unchanged. Exact CLI model request checked; service routing not independently verified. |
| Codex 0.162.0 skill discovery | PASS | Non-inference `skills/list` found renderer/workflow copies in a temporary repository, including the workflow's Claude control field. No thread or model turn was started. User-level installation and workflow execution remain untested. |
| Claude Code 2.1.295 | UNTESTED | Version/help inspection passed; current docs support discovery, substitution and explicit-invocation metadata. Full skill execution, actual permission matching and nested Codex runtime access were not tested. No paid Claude inference was attempted. |
| T3 Code 0.0.45 | UNTESTED | Installed bundle and CLI version/help confirmed. Current provider and permission-mode docs were checked. No server/provider session or skill invocation was started; selected-provider permissions/discovery remain untested. |
| `deliver-draft-pr` execution | UNTESTED | Source and metadata reviewed only. No implementation-to-PR workflow, CI/bot integration or readiness operation was activated. |
| Native Windows bridge runtime | UNTESTED | Python 3.11 lookup emulation passed; the native Windows test is skipped on Forge. No native `codex.cmd` launch was verified. |

The bridge's prior process suite ran 40 checks: 39 passed and one native Windows check was skipped. These include cancellation, deadlines and structured failures. A separate sandbox-helper probe under this host's execution environment failed to initialize its app-server socket-directory boundary; it provides no nested-sandbox qualification. The successful direct bridge call above used the normal authorized CLI runtime.

T3 uses its selected provider's capabilities and permission mode; a source review cannot establish its runtime behavior. [T3 providers](https://github.com/pingdotgg/t3code), [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)

## License and credits

MIT. The project [LICENSE](LICENSE) is Copyright (c) 2026 Zak. The common MIT permission text appears there once; the upstream notices below apply to the identified retained material.

- **Lauren Tan — Copyright (c) 2026 Lauren Tan; [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack):** retained instructions and patterns in `correct`, `principle-boundary-discipline`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-guard-the-context-window`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-type-system-discipline`, `technical-writing`, `typescript-best-practices` and `unslop`.
- **Cursor — Copyright (c) 2026 Cursor; [upstream PR review canvas](https://github.com/cursor/plugins/tree/main/pr-review-canvas):** retained PR review canvas instructions.

The source links help you trace upstream changes for manual review; this repository does not update them automatically. These credits identify retained material; they do not attribute newly authored bridge code, scripts, tests or workflow instructions to those authors. Keep root LICENSE and this README with copied or distributed skills; there are no per-skill README or LICENSE files.
