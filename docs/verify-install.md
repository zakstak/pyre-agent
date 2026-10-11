# Verify a native plugin install

Run these checks after installing `pyre-agent@pyre-agent-local`. They inspect
plugin registration and component discovery without running a model.

## Codex

```sh
codex plugin marketplace list --json
codex plugin list --marketplace pyre-agent-local --json
```

Expect the marketplace to resolve to the intended checkout, and the plugin to
report `installed: true` and `enabled: true`.

In a Codex session, open `/hooks`. Expect one plugin hook for `SessionStart`,
matching `^startup$`, that reads `context/working-with-zak.md` beneath the
installed plugin directory. Before it can run, its trust status must be trusted.
New or changed definitions require another review. Do not change trust or global
instruction files during a read-only verification.

The plugin provides every skill under `skills/`, each with a `pyre-agent:`
prefix. It must not provide `codex-branch-review`.

## Claude Code

```sh
claude plugin list --json
claude plugin details pyre-agent
```

Expect `pyre-agent@pyre-agent-local` to be enabled. The inventory must contain
the shared skills and `codex-branch-review`, plus one `SessionStart` hook. Use
`/hooks` to inspect its startup-only matcher.

The local marketplace's relative source loads from the registered checkout. Do
not infer its current files from an old cache path in `installed_plugins.json`.

## Test the package in isolation

From the repository root, run:

```sh
python3 -m unittest tests/test_plugins.py
```

The tests check the catalogs, manifests, startup hook, and bundled reference.
When both CLIs are available, they also install a temporary copy through each
host, inspect the discovered components, refresh a Codex install after a source
edit, and remove the plugins through the hosts. They set temporary `CODEX_HOME`
and `CLAUDE_CONFIG_DIR` directories and do not copy credentials or run
inference. Native integration tests are skipped when either CLI is absent.

Validate Claude Code's manifests separately:

```sh
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

## Confirm context delivery in a new session

Registration and discovery do not prove that a model saw the helper text. After
Codex's hook has been trusted, start a new session in each host and ask it to
identify the `Pyre Agent helper context` header. This uses a model and is a
separate acceptance check. A resumed session does not reload the startup hook.

Report installation, discovery, hook trust, and model acceptance separately.
