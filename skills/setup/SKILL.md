---
name: setup
description:
  "Use when the user asks to install, update, or migrate Pyre Agent and selected
  extras in Codex, Claude Code, or Antigravity. Perform native setup and
  verification, then hand hook acceptance to the user."
metadata:
  version: "1.1.0"
---

# Set up Pyre Agent

Carry out the requested installation. Run the host commands yourself and verify
the result; do not send the user a reading assignment or a list of installation
commands. The user handles interactive hook acceptance when needed. This file
also serves as the bootstrap instructions for an agent that has not installed
the plugin yet.

## Select the installation

Identify the current machine, host CLI, and active configuration profile. Use
the host the user selected, or the current agent's host when unspecified. Set up
multiple hosts when requested. Resolve plugin sources and refs from the request
or existing installation configuration. Core defaults to
`https://github.com/zakstak/pyre-agent.git`, catalog `pyre-agent-local`, plugin
`pyre-agent` in Codex and Claude Code, and installs directly from
`https://github.com/zakstak/pyre-agent` in Antigravity.

Inspect the selected host's marketplace and plugin inventories before making
changes:

```sh
codex plugin marketplace list --json
codex plugin list --json
```

```sh
claude plugin marketplace list --json
claude plugin list --json
```

```sh
agy plugin list --json
```

Run only the commands for selected hosts. Reuse a correct registration and
preserve unrelated plugins. Back up registration files outside the repository
before migration. If machine policy enforces the old installation, use the
environment's established owner operation; a user override may not replace it.
Report the exact blocked operation if authentication or elevation prevents it.

Install extras only when requested or already selected in installation
configuration. If requested extras lack a source or plugin identity, ask for
that missing information. Never infer a personal source from core's catalog.

## Install and verify

For a new direct GitHub core install, run the selected host's commands:

```sh
codex plugin marketplace add https://github.com/zakstak/pyre-agent.git
codex plugin add pyre-agent@pyre-agent-local
```

```sh
claude plugin marketplace add https://github.com/zakstak/pyre-agent.git
claude plugin install pyre-agent@pyre-agent-local
```

```sh
agy plugin install https://github.com/zakstak/pyre-agent
```

Use the requested source, ref, and catalog identity for managed or checkout
installs. For existing sources in Codex and Claude Code, use the host's native
refresh and update commands; check its help rather than removing a source to
force a refresh. In Antigravity, `agy plugin list --json` reports only
`"source": "antigravity"` without the source URL, path, or revision. Before
replacing an existing Antigravity install with `agy plugin install <source>`,
recover its original source and ref from reliable install metadata or deployment
configuration; if provenance is unknown, ask the user for the original source
instead of assuming the public default. Register and install selected extras
separately using their actual catalogs or, in Antigravity, their source URL or
local plugin directory. Keep each plugin installed from one catalog. Remove a
superseded copy only as part of the requested migration, preserving plugin data.

Inspect inventories again. Confirm the source, revision, version, enabled state,
and discoverable skills (in Antigravity, `agy plugin list --json` omits source
URL and revision, so verify version, enabled state, skills, and the installed
source). Core contains no startup hook or personal context; attribute optional
hooks to the extras plugin that owns them. Report what the host inventory proves
separately from hook execution and model behavior.

For packaging experiments, follow
[installation verification](../../docs/verify-install.md) with temporary
profiles and native binaries. Tests do not change live registrations, copy
credentials, run model inference, or accept hooks. A requested real installation
uses the selected real profile; temporary-profile success is separate evidence.

## Hand off hook acceptance

Skip this step for a core-only install. For Codex extras with untrusted or
modified hooks, identify the exact plugin, hook event, source, matcher, and
command from the installed package or host inventory. Show those details to the
user with these actions:

1. In a terminal using the installation's profile, run `codex`.
2. Inside Codex, enter `/hooks`, select the identified hook, review it, and
   trust its current definition.
3. Quit without sending a model prompt, then run `codex` again for a fresh
   startup. Preserve any profile arguments or environment used at installation.

Do not invent a shell acceptance command, run the interactive session on the
user's behalf, write trust records, or use a trust-bypass flag. Codex 0.163.0
persists acceptance through `/hooks`. Read the selected plugin's instructions
for any additional host-specific setup.

Complete all independent installation work before this handoff. Mark setup as
installed with hook acceptance pending, rather than fully verified. When the
user reports completion, inspect the hook's status through the host when
available; otherwise state that the user confirmed it. Do not infer successful
hook execution or model behavior from trusted status alone.
