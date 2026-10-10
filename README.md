# Pyre Agent

Zak's global agent defaults: reusable skills for Claude Code, Codex, and T3 Code, plus a global instruction file.

| Path | Contents |
| --- | --- |
| `skills/` | Portable skills for any provider that reads `SKILL.md` folders. |
| `host-skills/claude-code/` | Claude Code-only skills. |
| `global/AGENTS.md` | Global instructions. |

## Install the skills

Symlink every skill folder into your user skill directory. Symlinks keep the installed skills in sync with this checkout. Some skills link to sibling skills, so install them together. `ln` refuses to replace an existing skill with the same name.

Claude Code:

```sh
dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
mkdir -p "$dest"
for skill in "$PWD"/skills/*; do ln -sn "$skill" "$dest/"; done
```

Codex:

```sh
mkdir -p ~/.agents/skills
for skill in "$PWD"/skills/*; do ln -sn "$skill" ~/.agents/skills/; done
```

T3 Code uses the skill directory of its selected provider.

Invoke a skill by name with `/skill-name` in Claude Code or `$skill-name` in Codex. Agents also pick skills up from matching requests, except `correct`, `deliver-draft-pr`, and `codex-branch-review`, which run only when you invoke them by name.

### Codex branch review (Claude Code only)

```sh
ln -sn "$PWD/host-skills/claude-code/codex-branch-review" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/"
```

The skill needs Python 3.11 or later and an authenticated Codex CLI with access to `gpt-6.1-sol`. Claude Code asks for Bash approval to run its Python wrapper. See the [bridge contract](host-skills/claude-code/codex-branch-review/references/bridge-contract.md) for details.

## Install the global instructions

Claude Code: add this line to `~/.claude/CLAUDE.md`, using the absolute path of this checkout:

```text
@/path/to/pyre-agent/global/AGENTS.md
```

Codex: merge anything you want to keep from your existing `~/.codex/AGENTS.md` into `global/AGENTS.md`, remove the old file, and then link it:

```sh
ln -s "$PWD/global/AGENTS.md" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
```

A non-empty `AGENTS.override.md` in the same directory takes precedence over `AGENTS.md`.

## License and credits

MIT. The project [LICENSE](LICENSE) is Copyright (c) 2026 Zak. Its MIT permission text also covers the upstream material below. If you copy or redistribute the skills, include LICENSE and this section.

- **Lauren Tan, Copyright (c) 2026 Lauren Tan, [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack).** Retained instructions and patterns in `correct`, `principle-boundary-discipline`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-guard-the-context-window`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-type-system-discipline`, `technical-writing`, `typescript-best-practices`, and `unslop`.

The bundled Atkinson Hyperlegible fonts keep their OFL notices in `skills/internal-visual-style/assets/fonts/`.
