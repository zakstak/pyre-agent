# Pyre Agent

User-installed, reusable skills for Claude Code, Codex, and the agent providers inside T3 Code. Skills apply across your projects after you choose to install them at user scope. This repository does not install anything, change your agent settings, or grant a skill permission to expand a task.

Each skill is proposed in its own draft pull request. Review the wording, companion dependencies, and checks before merging. No skill is approved merely because its PR exists. The initial main branch intentionally contains only this README.

## Install only what you approve

When a skill is merged, its complete folder lives at `skills/<skill-name>/`, with `SKILL.md`, any required scripts/references/assets, and its own license notice. Review existing names before copying; do not overwrite another skill blindly. Keep referenced companion folders as siblings. Copy the whole folder, not just SKILL.md.

| Agent | User-level destination | Invocation |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/<skill-name>/` | `/skill-name` or matching requests |
| Codex | `~/.agents/skills/<skill-name>/` | `$skill-name` or matching requests |
| T3 Code | The user-level skill directory of its selected agent provider | Use that provider's supported skill invocation |

The portable skills use the common name/description frontmatter and do not require a Cursor SDK. Host-specific workflows are proposed separately under `host-skills/`. A Claude-only Codex review bridge is invoked explicitly and requires an already installed/authenticated Codex CLI with the exact supported model. Its paired profile stays inside its folder. It is not a portable core skill or a second review workflow.

Generalized user collaboration guidance is proposed separately under `guidance/`. It is optional, contains no project or operating-system assumptions, and must be reviewed alongside your existing global instructions. Installing skills does not require replacing those instructions.

## Scope and private reviews

Skills guide work within your current request and agent permissions. Review requests do not authorize source changes, commits, merges, publication, or credential changes. The offline PR review viewer keeps source and notes local; export notes before closing it. Do not publish private-code reviews to an unapproved audience.

## Official discovery references

- [Claude Code personal skills](https://code.claude.com/docs/en/skills)
- [Codex user skills](https://learn.chatgpt.com/docs/build-skills)
- [T3 Code agent-provider architecture](https://github.com/pingdotgg/t3code)

Discovery depends on your installed version and provider. These destinations are instructions for deliberate user installation, not actions performed by cloning this repository. Preserve each skill's supplied license notices when copying it.
