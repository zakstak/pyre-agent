# Pyre Agent

Zak's reusable engineering skills and optional startup context, packaged as a
plugin for Codex and Claude Code. Each host installs, loads, updates, and
removes its own plugin files. T3 Code uses the plugin support of its selected
provider.

| Path                               | Contents                                          |
| ---------------------------------- | ------------------------------------------------- |
| `skills/`                          | Shared skills for both hosts.                     |
| `host-skills/claude-code/`         | The Claude Code-only `codex-branch-review` skill. |
| `context/working-with-zak.md`      | Reference context loaded once at startup.         |
| `hooks/hooks.json`                 | The shared startup-only hook.                     |
| `.codex-plugin/plugin.json`        | Codex's plugin manifest.                          |
| `.claude-plugin/plugin.json`       | Claude Code's plugin manifest.                    |
| `.agents/plugins/marketplace.json` | Codex's local marketplace catalog.                |
| `.claude-plugin/marketplace.json`  | Claude Code's local marketplace catalog.          |

## Install from a local checkout

Run these commands from this repository. They register the checkout as the
`pyre-agent-local` marketplace and install the `pyre-agent` plugin for your
user. They do not copy skills into a global skill folder or write an instruction
file.

### Codex

```sh
codex plugin marketplace add "$PWD"
codex plugin add pyre-agent@pyre-agent-local
```

In Codex, open `/hooks` and review and trust the plugin's startup hook.
Installation alone does not trust hooks. Until you trust it, the skills load but
the helper context does not. Start a new session after the review, because this
hook matches only a new session's `startup` event.

### Claude Code

```sh
claude plugin marketplace add "$PWD"
claude plugin install pyre-agent@pyre-agent-local
```

Start a new session. Claude Code loads the shared skills, its extra review
skill, and the startup hook. To inspect registration, use `/hooks` and
`claude plugin details pyre-agent`.

## Use the skills and helper context

Plugin skills have the `pyre-agent:` namespace. Invoke `/pyre-agent:unslop` in
Claude Code or `$pyre-agent:unslop` in Codex. The host also selects skills whose
descriptions match the task. `correct`, `deliver-draft-pr`, and
`codex-branch-review` require an explicit invocation.

The plugin supplies `context/working-with-zak.md` through a `SessionStart` hook
with the matcher `^startup$`. The hook reads the installed file and emits its
contents as context. It performs no installation or configuration writes. It
does not run on resume, clear, compaction, subagent start, or tool calls. After
compaction, the host can summarize this context. The full text is not reloaded
automatically.

Keep this reference short. Claude Code passes at most 10,000 characters directly
from one hook output, and Codex has its own hook context limits.
Project-specific instructions still belong in the project's instruction files.

### Claude Code branch review

The Claude manifest adds `host-skills/claude-code/` to the shared skill
inventory. The Codex manifest scans only `skills/`, so it does not expose this
host-specific workflow. Invoke `/pyre-agent:codex-branch-review` in Claude Code.

The bridge needs Python 3.11 or later and an authenticated Codex CLI with access
to `gpt-6.1-sol`. Claude Code uses its normal Bash permission flow to run the
bundled Python wrapper. See the
[bridge contract](host-skills/claude-code/codex-branch-review/references/bridge-contract.md).

## Update a local install

Update the registered checkout with your normal Git workflow. The local
marketplace exposes that checkout's current files, including uncommitted edits.
Keep a separate checkout for experiments if you want sessions to use only
reviewed changes.

For Codex, refresh its installed copy through the host:

```sh
codex plugin add pyre-agent@pyre-agent-local
```

Then start a new session. If `/hooks` reports the hook needs review, trust its
current definition there before starting the next session.

Claude Code reads a relative-source plugin from a local marketplace in place.
Its edits load at the next session start or with `/reload-plugins`. Reloading
components does not turn a resume into a startup, so start a new session to load
the helper context again.

The manifests record the same plugin version. Raise both versions for a release.
Individual skill versions follow the checks below.

## Verify or remove an install

See [Verify a native plugin install](docs/verify-install.md) for read-only
checks, and for testing installation in temporary configuration directories
without running a model.

The hosts own removal:

```sh
codex plugin remove pyre-agent@pyre-agent-local
claude plugin uninstall pyre-agent@pyre-agent-local
```

Removing the plugin does not undo preferences you wrote in your own instruction
files. The plugin does not own those files.

## Plugin references

- [Codex packaging, marketplaces, and bundled hooks](https://developers.openai.com/plugins/build/plugins)
- [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
- [Claude Code local marketplace behavior](https://code.claude.com/docs/en/plugin-marketplaces#test-an-edit-to-a-plugin)
- [Claude Code plugin manifests](https://code.claude.com/docs/en/plugins-reference)

## Skill versions

Each skill records its version as `metadata.version` in its `SKILL.md`
frontmatter, nondeterministically following [semver](https://semver.org). Any
change inside a skill folder must raise that skill's version, including a
deleted or renamed file. Whether a change is major, minor, or a patch is a
judgment call, with two exceptions that must raise the major version: a skill
whose folder name changes, because `/old-name` stops working, and a skill that
moves into `host-skills/`, because the other hosts lose it.

`tests/check_skill_versions.py` compares every skill with the merge base of your
branch and `origin/main`. It fails when:

- A changed skill does not raise its version, or any skill lacks a version in
  the form `"MAJOR.MINOR.PATCH"`. A new skill needs only a valid version.
- A skill's frontmatter `name` differs from its folder name.
- A moved or renamed skill does not raise its version as required above. The
  check pairs a removed skill with a new skill of the same name, or else with
  one whose `SKILL.md` body shares at least half of its non-blank lines. A
  rename that also rewrites most of `SKILL.md` counts as a new skill.
- A file in `skills/`, `host-skills/`, or `context/` still names a skill that
  was removed or renamed. A hyphenated name counts anywhere. A one-word name
  counts only as `/name`, `$name`, or `` `name` ``, including the `pyre-agent:`
  namespace.

Install [Pragma](https://github.com/zakstak/pragma) once per clone to run
formatting, lint, secret scanning, and the skill-version guard before commits.
Pre-push hooks run the Python suite and the nested review-canvas typecheck,
build, and tests. The bootstrap used for this configuration is
`67843c5075e46f2cf0a5722fc3f4e5ff52ff0fda` (from
[Pragma PR #16](https://github.com/zakstak/pragma/pull/16)); merge that
prerequisite first.

```sh
git clone https://github.com/zakstak/pragma.git "$HOME/.pragma"
"$HOME/.pragma/install.sh" --agent "$PWD"
pnpm --dir packages/review-canvas install --frozen-lockfile
```

The repository uses `prek.toml` to preserve the skill-version guard from
`.githooks`. If you previously enabled `.githooks`, run
`git config --unset core.hooksPath` before installation so the generated Pragma
hooks can run. Regeneration replaces `prek.toml`; retain its repository-specific
guard and nested-package hook. The formatter excludes `tests/fixtures/`, whose
malformed JSON and precise byte encodings test protocol rejection, and
`pnpm-lock.yaml`, which pnpm owns. YAML lint follows Prettier's flow style and
GitHub Actions' `on` key.

To run the check by hand, including uncommitted and untracked files:

```sh
python3 tests/check_skill_versions.py --base origin/main
```

Pull requests run the same check in GitHub Actions. The check is advisory,
because GitHub Free cannot require checks on a private repository.

## License and credits

MIT. The project [LICENSE](LICENSE) is Copyright (c) 2026 Zak. Its MIT
permission text also covers the upstream material below. If you copy or
redistribute the skills, include LICENSE and this section.

- **Lauren Tan, Copyright (c) 2026 Lauren Tan,
  [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack).**
  Retained instructions and patterns in `correct`,
  `principle-boundary-discipline`, `principle-encode-lessons-in-structure`,
  `principle-fix-root-causes`,
  `principle-migrate-callers-then-delete-legacy-apis`,
  `principle-minimize-reader-load`, `principle-type-system-discipline`,
  `technical-writing`, `typescript-best-practices`, and `unslop`.
- **Cursor, Copyright (c) 2026 Cursor,
  [upstream PR review canvas](https://github.com/cursor/plugins/tree/main/pr-review-canvas).**
  Retained instructions in `review-canvas`.

The bundled Atkinson Hyperlegible fonts keep their OFL notices in
`skills/internal-visual-style/assets/fonts/`.
