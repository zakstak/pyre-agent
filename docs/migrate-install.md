# Migrate from the custom installer

The native plugin replaces the copies and instruction blocks that `install.py`
managed. This cleanup runs once. Future installations and updates use the hosts'
plugin commands.

## Remove the recorded copies

Before updating an existing checkout to the plugin version, run the old installer
from that checkout:

```sh
python3 install.py status --offline
python3 install.py uninstall --dry-run --offline
```

Review the output. The uninstall removes only recorded, unchanged skills and
owned instruction blocks. It preserves text outside those blocks and leaves
backups in place. If it reports an edited copy or a broken block, resolve that
finding before continuing. Do not use `--force` to discard edits.

After reviewing the dry run, remove that installation:

```sh
python3 install.py uninstall --offline
```

If your checkout already has the plugin version and no `install.py`, use the last
installer version in an isolated checkout:

```sh
git worktree add --detach ../pyre-agent-legacy-install 81c77d7bcaee646c659923bb03f715cbd0e1169f
python3 ../pyre-agent-legacy-install/install.py status --offline
python3 ../pyre-agent-legacy-install/install.py uninstall --dry-run --offline
```

Review the output, then run its `uninstall --offline` command. The old program
uses the existing install record in `${XDG_STATE_HOME:-~/.local/state}/pyre-agent/install.json`.
It does not install a compatibility layer or change the native plugin.

Unrecorded skill copies or old symlinks can remain. Inspect any matching names in
`~/.agents/skills`, `${CLAUDE_CONFIG_DIR:-~/.claude}/skills`, and older
`${CODEX_HOME:-~/.codex}/skills` installations. Preserve anything owned by another
tool or edited locally. Remove only confirmed copies from the old Pyre Agent
installation.

## Install through the hosts

Follow the [native install commands](../README.md#install-from-a-local-checkout)
for each host. Review and trust Codex's startup hook through `/hooks`, then start
new sessions in both hosts. Existing conversations retain the instructions and
skill inventory they loaded earlier.

Verify the result with [the native install checks](verify-install.md).
