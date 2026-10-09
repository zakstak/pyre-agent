# Pyre Agent

User-installed, reusable skills for Claude Code, Codex, and the agent providers inside T3 Code. Skills apply across your projects after you choose to install them at user scope. This repository does not install anything, change your agent settings, or grant a skill permission to expand a task.

Each skill is proposed in its own draft pull request. Review the wording, companion dependencies, and checks before merging. No skill is approved merely because its PR exists. The initial main branch intentionally contains only this README.

## Install only what you approve

When a skill is merged, its complete folder lives at `skills/<skill-name>/`, with `SKILL.md` and any required scripts/references/assets. Required notices are consolidated in this root README; individual skill folders contain no README or LICENSE files. Review existing names before copying; do not overwrite another skill blindly. Keep referenced companion folders as siblings. Copy the whole skill folder, not just SKILL.md, and keep this root README once alongside the installed skill folders. Preserve the applicable consolidated notice whenever copying or distributing retained material.

| Agent | User-level destination | Invocation |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/<skill-name>/` | `/skill-name` or matching requests |
| Codex | `~/.agents/skills/<skill-name>/` | `$skill-name` or matching requests |
| T3 Code | The user-level skill directory of its selected agent provider | Use that provider's supported skill invocation |

The portable skills use the common name/description frontmatter and do not require a Cursor SDK. Host-specific workflows are proposed separately under `host-skills/`. A Claude-only Codex review bridge is invoked explicitly and requires an already installed/authenticated Codex CLI with the exact supported model. Its paired profile stays inside its folder. It is not a portable core skill or a second review workflow.

## Claude-only review bridge installation

For global Claude discovery, copy this entire `host-skills/claude-code/codex-branch-review` folder to `~/.claude/skills/codex-branch-review`. Its paired profile is already bundled under `references/`; do not copy a profile separately or modify global Codex configuration. Review an existing skill before overwriting it. The installed skill is independent of this checkout and of the current working directory.

A symlink to the complete skill folder is another user-controlled option; it depends on retaining the source checkout.

The bridge uses its bundled profile directly; no global Codex profile installation is required. For manual profile use, Codex 0.134+ expects `$CODEX_HOME/adversarial-branch-review.config.toml`, selected by `codex --profile adversarial-branch-review`. Installing it is a separate action. Do not put it in the obsolete `[profiles.adversarial-branch-review]` table. The standalone profile does not provide the bridge's isolated launch, preflight or Git ancestry checks and process protections. 

## Optional collaboration guidance

The candidate at `guidance/AGENTS.md` retains Zak's reusable communication, architecture, planning, preservation-of-work and scope preferences. Project, operating-system, machine-path and computer-operation instructions were removed; the installed original remains unchanged.

Review and reconcile it with your existing global guidance before adopting it. Use the instruction mechanism documented by your selected agent. It is optional, is not a repository-wide instruction file here, grants no additional authority and does not install or replace any global file. Installing skills does not require adopting it.

## Scope and private reviews

Skills guide work within your current request and agent permissions. Review requests do not authorize source changes, commits, merges, publication, or credential changes. The offline PR review viewer keeps source and notes local; export notes before closing it. Do not publish private-code reviews to an unapproved audience.

## Official discovery references

- [Claude Code personal skills](https://code.claude.com/docs/en/skills)
- [Codex user skills](https://learn.chatgpt.com/docs/build-skills)
- [T3 Code agent-provider architecture](https://github.com/pingdotgg/t3code)

Discovery depends on your installed version and provider. These destinations are instructions for deliberate user installation, not actions performed by cloning this repository. Keep this root README with the copied skill collection and preserve the relevant notice below. No README, LICENSE or NOTICE file is needed inside an individual skill folder.

## Proposal dependencies

Merge this root-documentation proposal before merging the twelve upstream-derived skill imports (`correct`, `pr-review-canvas`, the seven `principle-*` proposals, `technical-writing`, `typescript-best-practices` and `unslop`). Their notices live only here. The Claude-only bridge and guidance proposals also depend on this README for their setup and adoption instructions. These are explicit dependencies; no proposal is automatically merged or installed.

## Renderer verification

The [PR review canvas proposal](https://github.com/zakstak/pyre-agent/pull/2) passed 22 Python tests and the production-JS DOM test. Existing Chromium and Playwright also passed the real browser interaction suite: desktop, mobile, dark mode, grouping, filters, folding, notes, flags, JSON download, reload privacy, injection probes, no external requests, CSP and no-JS fallback.

Its screenshots under `validation/pr-review-canvas/` show only the fictional bundled example, using the same renderer/assets tested in that proposal. No private PR source or credentials appear. At a 375-pixel viewport, the page had no horizontal overflow; individual code views retain their own scrolling. The evidence files are `desktop.png`, `mobile.png` and `dark-mobile.png`.

Once that proposal is merged, run `python3 -m unittest discover -s tests -p test_review_renderer.py` and `node tests/browser_review.unit.cjs`. Real-browser checks require already available Playwright and Chromium; `tests/browser_review.cjs` documents its environment overrides. No dependency installation or global activation is performed by these checks.

## Required notices

These notices apply only to retained upstream-derived material in the listed skills. They do not assign a license to newly authored skills, bridge code, scripts, tests or collaboration guidance. This root README is the single location for the notices; keep it with the skill collection.

### Curated instruction skills

The following notice covers retained instructions and patterns in `correct`, `principle-boundary-discipline`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-guard-the-context-window`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-type-system-discipline`, `technical-writing`, `typescript-best-practices` and `unslop`.

MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
### PR review canvas instructions

The following notice covers retained PR review canvas skill instructions.

MIT License

Copyright (c) 2026 Cursor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
