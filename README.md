# Pyre Agent

Zak's global agent defaults: reusable skills for Claude Code, Codex, and T3 Code, plus a global instruction file.

| Path | Contents |
| --- | --- |
| `skills/` | Portable skills for any provider that reads `SKILL.md` folders. |
| `host-skills/claude-code/` | Claude Code-only skills. |
| `global/AGENTS.md` | Global instructions. |
| `install.py` | Installs the skills and global instructions. |

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
- An update replaces the whole skill folder, so a file deleted from a skill also leaves the installed copy.
- If a skill leaves the repository or changes its name, the installer removes the old copy.
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

To have an agent check an install end to end, give it the [install verification runbook](docs/verify-install.md). It changes nothing and reports each finding with a proposed fix.

Invoke a skill by name with `/skill-name` in Claude Code or `$skill-name` in Codex. Agents also pick skills up from matching requests, except `correct`, `deliver-draft-pr`, and `codex-branch-review`, which run only when you invoke them by name.

### Codex branch review requirements

The installer adds `codex-branch-review` for Claude Code only. The skill needs Python 3.11 or later and an authenticated Codex CLI with access to `gpt-6.1-sol`. Claude Code asks for Bash approval to run its Python wrapper. See the [bridge contract](host-skills/claude-code/codex-branch-review/references/bridge-contract.md) for details.

## Install the global instructions

`install.py` also writes `global/AGENTS.md`, from the same commit as the skills, into each host's instruction file:

| Host | File |
| --- | --- |
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md` |
| Codex | `${CODEX_HOME:-~/.codex}/AGENTS.md` |

The installer owns one block that starts with a `<!-- pyre-agent:begin ... -->` line and ends with `<!-- pyre-agent:end -->`. Later installs replace only that block. Text outside the block is yours, and the installer never changes it. If you edit inside the block, the installer keeps your edit and reports it until you pass `--force`.

The first install into an existing file merges it. The installer backs up the file to `<name>.pyre-backup-<timestamp>`, then compares its `##` sections with `global/AGENTS.md`. Curly quotes and whitespace do not count as differences.

- If a section has the same heading and the same text, the installer drops it, because the block repeats it.
- If a section has a heading that `global/AGENTS.md` lacks, the installer keeps it after the block. It also keeps text above the first heading when that text differs from the repository's.
- If a section has the same heading but different text, the installer shows a diff and writes nothing. Edit or rename your section, then run the installer again.

The installer cannot recognize a section whose heading changed, so it lists every section it keeps. Delete any that repeat the block. It removes an `@.../global/AGENTS.md` import line or an `AGENTS.md` symlink into this checkout, which the earlier README steps created.

Codex reads a non-empty `AGENTS.override.md` instead of `AGENTS.md`, and the installer warns when one exists. `uninstall` removes the block and deletes any instruction file the installer created. A backup stays where the merge left it.

## Skill versions

Each skill records its version as `metadata.version` in its `SKILL.md` frontmatter, nondeterministically following [semver](https://semver.org). Any change inside a skill folder must raise that skill's version, including a deleted or renamed file. Whether a change is major, minor, or a patch is a judgment call, with one exception: a skill whose folder name changes must raise its major version, because `/old-name` stops working.

`tests/check_skill_versions.py` compares every skill with the merge base of your branch and `origin/main`. It fails when:

- A changed skill does not raise its version, or any skill lacks a version in the form `"MAJOR.MINOR.PATCH"`. A new skill needs only a valid version.
- A renamed skill does not raise its major version. The check pairs a removed skill with a new skill when at least half of their `SKILL.md` lines match. A rename that also rewrites most of `SKILL.md` counts as a new skill.
- A file in `skills/`, `host-skills/`, or `global/` still names a skill that was removed or renamed. A hyphenated name counts anywhere. A one-word name counts only as `/name`, `$name`, or `` `name` ``.

Turn on the pre-commit hook once per clone. It checks the files you staged:

```sh
git config core.hooksPath .githooks
```

To run the check by hand, including uncommitted and untracked files:

```sh
python3 tests/check_skill_versions.py --base origin/main
```

Pull requests run the same check in GitHub Actions. The check is advisory, because GitHub Free cannot require checks on a private repository.

## License and credits

MIT. The project [LICENSE](LICENSE) is Copyright (c) 2026 Zak. Its MIT permission text also covers the upstream material below. If you copy or redistribute the skills, include LICENSE and this section.

- **Lauren Tan, Copyright (c) 2026 Lauren Tan, [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack).** Retained instructions and patterns in `correct`, `principle-boundary-discipline`, `principle-encode-lessons-in-structure`, `principle-fix-root-causes`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-type-system-discipline`, `technical-writing`, `typescript-best-practices`, and `unslop`.
- **Cursor, Copyright (c) 2026 Cursor, [upstream PR review canvas](https://github.com/cursor/plugins/tree/main/pr-review-canvas).** Retained instructions in `review-canvas`.

The bundled Atkinson Hyperlegible fonts keep their OFL notices in `skills/internal-visual-style/assets/fonts/`.
