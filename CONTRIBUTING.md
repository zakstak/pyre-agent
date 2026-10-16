# Contribute to Pyre Agent

Read [repository instructions](AGENTS.md) before changing core or an optional
plugin. Reusable engineering behavior belongs in core; personal context and
installation defaults belong in separately maintained extras.

## Set up checks

The checks need Python 3.10 or newer. The review-canvas package needs Node 26
and the pnpm version pinned in its `package.json`.

Install [Pragma](https://github.com/zakstak/pragma) once per clone for
formatting, lint, secret scanning, skill versions, and skill shape checks.
Pre-push hooks run the Python suite and review-canvas typecheck, build, tests,
and TypeScript documentation examples.

If this clone uses `core.hooksPath=.githooks`, unset that local setting before
installing Pragma:

```sh
git config --local --unset core.hooksPath
```

Then install Pragma and the package dependencies:

```sh
git clone https://github.com/zakstak/pragma.git "$HOME/.pragma"
"$HOME/.pragma/install.sh" --agent "$PWD"
pnpm --dir packages/review-canvas install --frozen-lockfile
```

The standalone `.githooks/pre-commit` runs only the staged skill-version guard.
It replaces Pragma's hooks when selected through `core.hooksPath`; the two hook
setups do not run together.

Pragma uses `prek.toml` for the full hook set. Regeneration replaces that file;
retain the repository's skill-version, skill-shape, and nested review-canvas
hooks. Formatting excludes `tests/fixtures/`, whose malformed JSON and precise
byte encodings test protocol rejection, and `pnpm-lock.yaml`, which pnpm owns.
YAML lint follows Prettier's flow style and GitHub Actions' `on` key.

## Run checks

From the repository root, run:

```sh
python3 tests/check_skill_versions.py --base origin/main
python3 tests/check_skill_shape.py
python3 tests/check_skill_package.py
python3 -m unittest discover -s tests
```

The version check includes uncommitted and untracked files. Native installation
tests skip unless both `codex` and `claude` are on `PATH`. Check the skip count
before treating a passing suite as installation verification. Follow
[installation verification](docs/verify-install.md) for temporary profiles and
native binary selection. Those profiles isolate host configuration, but are not
an operating-system sandbox.

For review-canvas changes, also run the package's
[checks](packages/review-canvas/README.md#check). Pull requests run the skill
and package checks in GitHub Actions; review-canvas changes also run the server,
browser, and packed-distribution tests on Linux and macOS.

## Skill versions

Each skill records its version as `metadata.version` in its `SKILL.md`
frontmatter. Use [semantic versions](https://semver.org). Any change inside a
skill folder must raise that skill's version, including a deleted or renamed
file. Whether a change is major, minor, or a patch is a judgment call, with two
exceptions that must raise the major version: a skill whose folder name changes,
because `/old-name` stops working, and a skill that moves into `host-skills/`,
because the other hosts lose it.

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

`tests/check_skill_shape.py` keeps every skill within its budgets. A `SKILL.md`
description must open with "Use when" or "Use for" within 250 characters, or
with "Invoke only by name." within 120 characters when the skill sets
`disable-model-invocation`. A `SKILL.md` body may hold 5,000 bytes for a
principle and 14,000 bytes otherwise. In every Markdown file below a skill
folder, a prose line that could have been wrapped may not run past column 80,
and a sentence may not resume in lowercase after a fenced code block. The check
runs before commits and in CI.

## Plugin releases

Match each plugin's name and release version across its Codex and Claude
manifests. Raise the release version when its contents change. Skill changes
also need the version increase described above.

The bundled catalogs select core from the same source tree. Managed catalogs can
pin immutable source revisions; publish the source before updating those pins.
Keep machine registration, credentials, private source URLs, and deployment
defaults in installation configuration outside core.
