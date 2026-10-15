# Pyre Agent

Reusable engineering skills for Codex and Claude Code. The production catalog is
`pyre-market`; this repository owns the plugin source.

| Plugin               | Contents                                                          | Default  |
| -------------------- | ----------------------------------------------------------------- | -------- |
| `pyre-agent` 4.2.0   | Shared engineering skills and the Claude-only branch review skill | Base     |
| `pyre-context` 1.0.1 | Zak's startup reference context                                   | Optional |

The base contains no startup hook or personal context. The optional plugin lives
in `plugins/pyre-context/` and includes its context and hook resources. Each
host installs, loads, updates and removes the selected plugin files.

## Install from pyre-market

Register `https://gitea.home.zakstak.com/saga-agent/pyre-market.git` with the
host's native marketplace command. Install the base:

```sh
codex plugin add pyre-agent@pyre-market
claude plugin install pyre-agent@pyre-market
```

Select startup context separately:

```sh
codex plugin add pyre-context@pyre-market
claude plugin install pyre-context@pyre-market
```

Codex users must review and trust `pyre-context` in `/hooks` before starting a
new session. This identity differs from the former bundled hook, so migration
needs one trust review. Later context edits preserve trust if the hook
definition stays unchanged. The hook matches only a new session's `startup`
event.

## Develop and verify locally

The local catalogs remain development fixtures named `pyre-agent-local`. They
contain both plugins and refer to this checkout. Register the checkout through
each host and select plugins using that marketplace suffix:

```sh
codex plugin marketplace add "$PWD"
codex plugin add pyre-agent@pyre-agent-local
claude plugin marketplace add "$PWD"
claude plugin install pyre-agent@pyre-agent-local
```

The base skill namespace remains `pyre-agent:`. Invoke `/pyre-agent:unslop` in
Claude Code or `$pyre-agent:unslop` in Codex. `codex-branch-review` is available
only in Claude Code and requires Python 3.11 and an authenticated Codex CLI. See
its
[bridge contract](host-skills/claude-code/codex-branch-review/references/bridge-contract.md).

[Native verification](docs/verify-install.md) checks base installation without
hooks, optional context installation, and removal of context while preserving
the base. No test copies user credentials or performs model inference.

## Companion skills and redistribution

The native base ships the collection together. A skill's source PR can be
reviewed separately, but copying one directory does not always produce a usable
skill. Retain its referenced files and all companion skills they link to.
`typescript-best-practices` and `principle-type-system-discipline` reference
each other; that group also needs `principle-boundary-discipline` and
`principle-encode-lessons-in-structure`. `technical-writing` needs `unslop`.

Carry the root `LICENSE` and this README's credits with any copied subset. Keep
asset-specific notices with their assets. The collection uses root MIT notices
rather than a separate license in every skill directory.

Check a checkout or an assembled copy without installing it:

```sh
python3 tests/check_skill_package.py /path/to/package
```

The check follows inline local Markdown links in skill instructions and
references, accepts companion cycles, and rejects missing files or links that
leave the package. It checks the root MIT and upstream copyright notices. Native
fixture tests also require installed LICENSE and README bytes to match the
source. These checks do not prove skill activation or model behavior.

## Release and migration

Both host manifests for a plugin must share its name and release version.
Increase the version for every release of that plugin. Catalog entries pin an
immutable producer revision; publish producer source before updating the
catalog. Pyre owns machine registration, credentials and the base default.
Optional plugins remain individually selectable.

Release 3.0.0 replaces the review canvas's Python scripts with the review canvas
server in `packages/review-canvas`. The `review-canvas` skill runs it through
`skills/review-canvas/scripts/review-canvas`, which needs Node 26 and pnpm and
builds the package on first use. It supports private GitHub Enterprise, GitLab,
and Gitea/Forgejo hosts; see the
[private-host setup](packages/review-canvas/README.md#private-git-hosts). A
review started with the Python version cannot be converted; finish it before
upgrading.

Release 2.0.0 separates startup context from the earlier 1.x bundle. Install the
new base and select `pyre-context` before removing the old marketplace. Then
review the optional Codex hook and verify a new session. Explicitly remove
`pyre-agent@pyre-agent-local` with `codex plugin remove` before removing its
marketplace; Codex marketplace removal alone keeps cached plugins installed.
Claude marketplace removal uninstalls its own entries. Preserve other
marketplaces.

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
- A file in `skills/`, `host-skills/`, `context/`, or `plugins/` still names a
  skill that was removed or renamed. A hyphenated name counts anywhere. A
  one-word name counts only as `/name`, `$name`, or `` `name` ``, including the
  `pyre-agent:` namespace.

Install [Pragma](https://github.com/zakstak/pragma) once per clone to run
formatting, lint, secret scanning, and the skill-version guard before commits.
Pre-push hooks run the Python suite and the nested review-canvas typecheck,
build, and tests, and compile the TypeScript documentation examples. The Pragma
source used to validate this configuration is
`ef07e80e88edb426f1e5660f151d2a899eedc984`, including the reviewed core and tool
updates in [Pragma PR #16](https://github.com/zakstak/pragma/pull/16) and
[PR #17](https://github.com/zakstak/pragma/pull/17).

Ruff targets Python 3.10 for the repository's checks. The Claude Code bridge
targets Python 3.11, its documented minimum.

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
