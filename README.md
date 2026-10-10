# Pyre Agent

Zak's global agent defaults: reusable skills for Claude Code, Codex, and T3 Code, plus a global instruction file.

| Path | Contents |
| --- | --- |
| `skills/` | Portable skills for any provider that reads `SKILL.md` folders. |
| `host-skills/claude-code/` | Claude Code-only skills. |
| `global/AGENTS.md` | Global instructions. |
| `install.py` | Installs the skills. |

## Install the skills

`install.py` copies every skill from one Git version of this repository into each host's skill folder. It needs Python 3.10 or later and Git.

```sh
python3 install.py
```

| Host | Skill folder | Skills |
| --- | --- | --- |
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills` | `skills/` and `host-skills/claude-code/` |
| Codex | `~/.agents/skills` | `skills/` |

The installer acts on each host whose configuration folder exists: `${CLAUDE_CONFIG_DIR:-~/.claude}` for Claude Code and `${CODEX_HOME:-~/.codex}` for Codex. To choose one, pass `--host claude-code` or `--host codex`. T3 Code uses the skill folder of its selected provider.

By default, the installer fetches `origin` and installs `main`. Your checkout's branch and uncommitted edits never reach the installed skills. Run it again after a change merges.

The installer records what it installed in `${XDG_STATE_HOME:-~/.local/state}/pyre-agent/install.json` and changes nothing else:

- If a skill folder with the same name already exists and the installer did not create it, the installer reports a conflict and leaves the folder alone.
- If you edited an installed copy, the installer keeps your copy. `--force` replaces it.
- If a skill leaves the repository, the installer removes its copy.
- If the earlier README steps left a symlink into this checkout, the installer replaces the symlink with a copy.

The installer exits with code 1 after it skips a conflict or an edited copy, and with code 2 when it cannot run.

### Try a change before it merges

Tag the commit `preview`, push the tag, and install it:

```sh
git tag -f preview <commit>
git push -f origin preview
python3 install.py --ref preview
```

`--ref` takes a tag, a branch on `origin`, or a commit. To return to `main`, run `python3 install.py`. To install a commit you have not pushed, run `python3 install.py --ref HEAD --offline`.

### Check or remove the installed skills

```sh
python3 install.py status      # installed versions, local edits, and versions on main
python3 install.py --dry-run   # print the plan without changing installed skills
python3 install.py uninstall   # remove the installed skills and nothing else
```

Invoke a skill by name with `/skill-name` in Claude Code or `$skill-name` in Codex. Agents also pick skills up from matching requests, except `correct`, `deliver-draft-pr`, and `codex-branch-review`, which run only when you invoke them by name.

### Codex branch review requirements

The installer adds `codex-branch-review` for Claude Code only. The skill needs Python 3.11 or later and an authenticated Codex CLI with access to `gpt-6.1-sol`. Claude Code asks for Bash approval to run its Python wrapper. See the [bridge contract](host-skills/claude-code/codex-branch-review/references/bridge-contract.md) for details.

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

## Skill versions

Each skill records its version as `metadata.version` in its `SKILL.md` frontmatter, nondeterministically following [semver](https://semver.org). Any change inside a skill folder must raise that skill's version. Whether a change is major, minor, or a patch is a judgment call.

A pull request check compares every changed skill with the base branch. To run it before you push:

```sh
python3 tests/check_skill_versions.py --base origin/main
```

The check counts uncommitted and untracked files. A new skill needs only a valid version in the form `"MAJOR.MINOR.PATCH"`.

## License and credits

MIT. The project [LICENSE](LICENSE) is Copyright (c) 2026 Zak. Its MIT permission text also covers the upstream material below. If you copy or redistribute the skills, include LICENSE and this section.

- **Lauren Tan, Copyright (c) 2026 Lauren Tan, [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack).** Retained instructions and patterns in `correct`, `principle-boundary-discipline`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-type-system-discipline`, `technical-writing`, `typescript-best-practices`, and `unslop`.
- **Cursor, Copyright (c) 2026 Cursor, [upstream PR review canvas](https://github.com/cursor/plugins/tree/main/pr-review-canvas).** Retained instructions in `pr-review-canvas`.

The bundled Atkinson Hyperlegible fonts keep their OFL notices in `skills/internal-visual-style/assets/fonts/`.
