# Repository instructions

For installation, updates, or migration requests, follow
[the setup skill](skills/setup/SKILL.md). Perform the requested host setup and
verification, then give the user only the interactive acceptance steps that
remain.

## Keep reusable behavior in core

Core is the `pyre-agent` base plugin. Put general engineering skills in
`skills/`, host-specific reusable skills in `host-skills/`, and shared tooling
in `packages/` or `tests/`.

Personal preferences and behavior bespoke to an installation belong in optional
plugins. Keep personal skills, startup context, machine paths, private service
addresses, and installation defaults out of core. Extract the reusable mechanism
into core when useful, and keep its personal configuration in the plugin.

Maintain personal plugins in a separate extras repository with native Codex and
Claude manifests and catalogs. Do not fork core or copy its engineering skills
into extras. Install core and the selected extras alongside each other.

Personal context is maintained outside this repository. The bundled catalogs
contain only core. Do not add personal packages or private extras repository
URLs to the core catalog. Configure the extras source on the machine that uses
it, and install each plugin from only one catalog. Keep managed source URLs and
revision pins in deployment configuration.

## Apply the same rules to extras

Optional plugins follow core's skill naming, semantic versioning, shape budgets,
package completeness, and license requirements. Reuse the checkers in `tests/`.
When distributing checkers to an extras repository, record their source revision
and provide a command to refresh them without editing a second set of rules.

Match each plugin's name and version across its Codex and Claude manifests.
Raise its release version when its contents change. Raise a changed skill's
`metadata.version` too, as described in the
[contribution guide](CONTRIBUTING.md#skill-versions). Keep referenced resources
inside the installed package. Use host-native plugins for installation and
hooks, rather than writing global instruction files or copying skills into a
user's home directory.

## Experiment in temporary host configurations

Preserve dirty files and existing branches. Use a separate worktree when needed.
For plugin experiments, use a disposable checkout and temporary `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `HOME`, and `XDG_CONFIG_HOME` directories. Use native CLI
binaries that respect those directories. Do not copy credentials into the test.
This isolates host configuration, but is not an operating-system sandbox.

Follow [installation verification](docs/verify-install.md). Check installation,
discovery, hooks, refresh, and removal without model inference. Report hook
trust and model behavior separately from package validation. Do not repoint a
live marketplace or change deployment pins as part of a local packaging test.
