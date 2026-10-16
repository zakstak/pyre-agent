# Verify core and separate personal plugins

The bundled GitHub and checkout catalog is `pyre-agent-local`. It contains only
`pyre-agent`. Personal plugins belong in a separate extras repository. Configure
private source URLs on the machine or in its managed deployment configuration.

## Check the package in temporary profiles

```sh
PYRE_TEST_CODEX_BIN=/path/to/native/codex \
PYRE_TEST_CLAUDE_BIN=/path/to/native/claude \
python3 -m unittest tests/test_plugins.py tests/test_skill_versions.py tests/test_skill_package.py
```

Tests refuse wrappers that overwrite temporary configuration directories. They
install core in temporary homes, verify skills and the absence of startup
hooks, check refresh behavior, and remove the plugin. They do not copy
credentials or perform model inference. Temporary profiles isolate host
configuration, but are not an operating-system sandbox.

Both installed copies must retain local instruction references, companion
skills, and the source LICENSE and README. They must contain no personal
context, startup hooks, or nested personal plugins. Check an assembled package
without either host:

```sh
python3 tests/check_skill_package.py /path/to/package
```

Validate the Claude manifest and catalog:

```sh
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

## Verify acquisition from GitHub

Follow [Install from GitHub](../README.md#install-from-github) in temporary host
profiles. A local checkout test does not prove Git acquisition or private
repository access. Verify the installed source URL, revision, and version.
Inspect the installed package and host component inventory. Core must provide
engineering skills and no startup hook.

In the same temporary profiles, register the separately configured private
extras source and select its personal plugin. Confirm that the hook and context
come from the extras package, and that core contains neither resource. Remove
the personal plugin and verify that core's skills remain available.

Report acquisition, component discovery, hook trust, and model behavior
separately. Codex requires review in `/hooks` and a new session for a new plugin
identity. A package test must not grant that trust automatically.

## Migrate an existing local installation

Inspect registrations before adding a source:

```sh
codex plugin marketplace list --json
codex plugin list --json
claude plugin marketplace list --json
claude plugin list --json
```

Back up the relevant registration files and plugin caches outside the source
repository. Keep backup permissions private. Install the GitHub base and the
private extras in a temporary profile first, and verify both before changing
the real profile.

For a direct installation, register the GitHub core catalog and the private
extras catalog separately. Remove the superseded plugin IDs through the host's
native commands, preserving persistent data. Keep each plugin installed from
only one catalog to avoid duplicate skills and hooks. Preserve unrelated
marketplaces and the source checkout.

For a managed installation, update its catalog entries so core pins a revision
of this repository and personal plugins pin revisions of their extras source.
Changing a user registration does not necessarily override machine policy.
Use the environment's established owner operation when managed settings enforce
a plugin or source. Do not alter authentication or elevation policy to proceed.

List plugins again. Verify one enabled core copy, one selected personal plugin
copy, their expected source revisions, and no personal hook attributed to core.
Keep private source URLs, local registration receipts, and cache backups outside
this repository.
