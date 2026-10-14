# Verify the base and optional context

Use `pyre-market` for production registration. The producer's local fixture
catalog is `pyre-agent-local`; native tests use only that disposable fixture.

## Native package checks

```sh
PYRE_TEST_CODEX_BIN=/path/to/native/codex \
PYRE_TEST_CLAUDE_BIN=/path/to/native/claude \
python3 -m unittest tests/test_plugins.py tests/test_skill_versions.py tests/test_skill_package.py
```

Tests refuse wrappers that overwrite temporary configuration directories. They
install the base in temporary homes and verify that it has skills and no startup
hook. They install `pyre-context`, verify its untrusted startup hook, refresh
the context, then remove the optional plugin while keeping the base. They
finally remove the base. No credentials or inference are used.

Both installed base copies must retain local instruction references, companion
skills, and the source LICENSE and README. Omission fixtures reject incomplete
companion groups and missing notices. To check an assembled subset without
running either host:

```sh
python3 tests/check_skill_package.py /path/to/package
```

This validates the files in that copy. It does not install it, resolve host
activation rules, or grant permission to publish it.

Validate all Claude manifests and the fixture catalog:

```sh
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate plugins/pyre-context/.claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

## User acceptance

Install `pyre-agent@pyre-market` and inspect its skill inventory. It must have
no startup hook. Select `pyre-context@pyre-market` if startup preferences are
wanted. Review and trust its hook in Codex `/hooks`, then start a new session.
Ask the model for the `Pyre Context release` value without files or tools. The
initial optional release reports `1.0.0`.

Report Git-backed acquisition, component discovery, hook trust and model
acceptance separately. A local fixture check does not prove the Gitea route or
T3 UI. Removing the optional plugin must leave base skills available.
