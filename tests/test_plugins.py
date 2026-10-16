"""Verify the native plugin boundary without credentials or model inference."""

import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from tests.check_skill_package import package_errors

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ID = "pyre-agent@pyre-agent-local"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def native_cli(name, variable):
    """Refuse launchers that redirect an isolated test into a real user home."""
    selected = os.environ.get(f"PYRE_TEST_{name.upper()}_BIN", name)
    executable = shutil.which(selected)
    if executable is None:
        raise RuntimeError(f"Cannot find {selected}")
    with open(executable, "rb") as source:
        header = source.read(8192)
    if header.startswith(b"#!") and re.search(
        rb"\b" + variable.encode() + rb"\s*=", header
    ):
        raise RuntimeError(
            f"{executable} overrides {variable}; set "
            f"PYRE_TEST_{name.upper()}_BIN to the native executable"
        )
    return executable


class PackageTests(unittest.TestCase):
    def test_skill_companions_and_redistribution_notices_are_packaged(self):
        self.assertEqual(package_errors(ROOT), [])

    def test_native_tests_refuse_a_wrapper_that_overrides_the_test_home(self):
        with tempfile.TemporaryDirectory(prefix="pyre-plugin-wrapper-") as temp:
            wrapper = Path(temp) / "codex"
            wrapper.write_text("#!/bin/sh\nexport CODEX_HOME=/real/home\n")
            wrapper.chmod(0o755)
            from unittest.mock import patch

            with (
                patch.dict(os.environ, PYRE_TEST_CODEX_BIN=str(wrapper)),
                self.assertRaisesRegex(RuntimeError, "overrides CODEX_HOME"),
            ):
                native_cli("codex", "CODEX_HOME")

    def test_catalogs_select_the_same_plugin_and_version(self):
        codex = read_json(ROOT / ".agents/plugins/marketplace.json")
        claude = read_json(ROOT / ".claude-plugin/marketplace.json")
        self.assertEqual(codex["name"], claude["name"])
        self.assertEqual(
            [p["name"] for p in codex["plugins"]],
            [p["name"] for p in claude["plugins"]],
        )
        self.assertEqual(codex["plugins"][0]["name"], claude["plugins"][0]["name"])
        self.assertEqual(
            ROOT / codex["plugins"][0]["source"]["path"],
            ROOT / claude["plugins"][0]["source"],
        )
        manifests = [
            read_json(ROOT / f".{host}-plugin/plugin.json")
            for host in ("codex", "claude")
        ]
        self.assertEqual(manifests[0]["name"], manifests[1]["name"])
        self.assertEqual(manifests[0]["version"], manifests[1]["version"])
        self.assertFalse((ROOT / "hooks").exists())
        self.assertFalse((ROOT / "context").exists())
        self.assertFalse((ROOT / "plugins").exists())
        self.assertEqual([p["name"] for p in codex["plugins"]], ["pyre-agent"])


@unittest.skipUnless(
    shutil.which("codex") and shutil.which("claude"),
    "Native integration requires Codex and Claude Code CLIs",
)
class NativePluginTests(unittest.TestCase):
    def setUp(self):
        self.executables = {
            "codex": native_cli("codex", "CODEX_HOME"),
            "claude": native_cli("claude", "CLAUDE_CONFIG_DIR"),
        }
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-plugin-native-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "marketplace with spaces"
        shutil.copytree(
            ROOT,
            self.repo,
            ignore=shutil.ignore_patterns(
                ".git", "__pycache__", "*.pyc", "node_modules", "dist"
            ),
        )
        self.codex = self.base / "codex"
        self.claude = self.base / "claude"
        self.codex.mkdir()
        self.claude.mkdir()
        self.env = dict(
            os.environ, CODEX_HOME=str(self.codex), CLAUDE_CONFIG_DIR=str(self.claude)
        )
        self.env["HOME"] = str(self.base)
        self.env["XDG_CONFIG_HOME"] = str(self.base / "xdg")

    def run_cli(self, *command):
        command = (self.executables[command[0]], *command[1:])
        result = subprocess.run(
            command,
            check=False,
            cwd=self.base,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=45,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def assert_skill_package(self, installed_path):
        self.assertEqual(package_errors(installed_path), [])
        for directory in ("hooks", "context", "plugins"):
            self.assertFalse((installed_path / directory).exists(), directory)
        for name in ("LICENSE", "README.md"):
            self.assertEqual(
                (installed_path / name).read_bytes(), (self.repo / name).read_bytes()
            )

    def inspect_codex_components(self):
        """Ask the installed harness for its skills and hooks, never start a turn."""
        process = subprocess.Popen(
            [self.executables["codex"], "app-server", "--stdio"],
            cwd=self.base,
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        events = queue.Queue()

        def read_events():
            for line in process.stdout:
                events.put(json.loads(line))
            events.put(None)

        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()

        def request(number, method, params):
            process.stdin.write(
                json.dumps({"id": number, "method": method, "params": params}) + "\n"
            )
            process.stdin.flush()
            while True:
                event = events.get(timeout=20)
                self.assertIsNotNone(event, "app-server exited before its response")
                if event.get("id") == number:
                    self.assertNotIn("error", event, event)
                    return event["result"]

        try:
            request(
                1,
                "initialize",
                {
                    "clientInfo": {"name": "pyre-plugin-test", "version": "1"},
                    "capabilities": {"experimentalApi": True},
                },
            )
            process.stdin.write('{"method":"initialized"}\n')
            process.stdin.flush()
            skills = request(
                2, "skills/list", {"cwds": [str(self.base)], "forceReload": True}
            )
            hooks = request(3, "hooks/list", {"cwds": [str(self.base)]})
            return skills, hooks
        finally:
            process.terminate()
            process.wait(timeout=10)
            reader.join(timeout=5)
            process.stdin.close()
            process.stdout.close()

    def test_hosts_install_discover_refresh_and_remove_the_plugin(self):
        self.run_cli("codex", "plugin", "marketplace", "add", str(self.repo), "--json")
        installed = json.loads(
            self.run_cli("codex", "plugin", "add", PLUGIN_ID, "--json")
        )
        installed_path = Path(installed["installedPath"])
        self.assertTrue(installed_path.is_relative_to(self.codex))
        self.assertNotEqual(installed_path, self.repo)
        self.assert_skill_package(installed_path)
        inventory = json.loads(
            self.run_cli(
                "codex", "plugin", "list", "--marketplace", "pyre-agent-local", "--json"
            )
        )
        self.assertTrue(inventory["installed"][0]["enabled"])
        skills, hooks = self.inspect_codex_components()
        self.assertFalse(skills["data"][0]["errors"])
        actual = {
            skill["name"]
            for entry in skills["data"]
            for skill in entry["skills"]
            if Path(skill["path"]).is_relative_to(installed_path)
        }
        shared = {
            f"pyre-agent:{path.parent.name}"
            for path in self.repo.glob("skills/*/SKILL.md")
        }
        self.assertEqual(actual, shared)
        self.assertFalse(
            [
                hook
                for entry in hooks["data"]
                for hook in entry["hooks"]
                if hook.get("pluginId") == PLUGIN_ID
            ]
        )
        self.run_cli("claude", "plugin", "marketplace", "add", str(self.repo))
        self.run_cli("claude", "plugin", "install", PLUGIN_ID, "--json")
        (claude_install,) = read_json(self.claude / "plugins/installed_plugins.json")[
            "plugins"
        ][PLUGIN_ID]
        claude_installed_path = Path(claude_install["installPath"])
        self.assertTrue(claude_installed_path.is_relative_to(self.claude))
        self.assert_skill_package(claude_installed_path)
        inventory = self.run_cli("claude", "plugin", "details", "pyre-agent")
        for path in self.repo.glob("skills/*/SKILL.md"):
            self.assertIn(path.parent.name, inventory)
        self.assertIn("Hooks (0)", inventory)
        readme = self.repo / "README.md"
        updated = readme.read_text() + "\nUpdated local package.\n"
        readme.write_text(updated)
        self.assertNotEqual((installed_path / "README.md").read_text(), updated)
        self.run_cli("codex", "plugin", "add", PLUGIN_ID, "--json")
        self.assertEqual((installed_path / "README.md").read_text(), updated)
        self.assertIn(
            "nothing to update", self.run_cli("claude", "plugin", "update", PLUGIN_ID)
        )

        for config, instructions in (
            (self.codex, "AGENTS.md"),
            (self.claude, "CLAUDE.md"),
        ):
            self.assertFalse((config / instructions).exists())
            for name in actual:
                self.assertFalse((config / "skills" / name.split(":", 1)[1]).exists())
        self.run_cli("codex", "plugin", "remove", PLUGIN_ID, "--json")
        self.run_cli("claude", "plugin", "uninstall", PLUGIN_ID)
        inventory = json.loads(
            self.run_cli(
                "codex", "plugin", "list", "--marketplace", "pyre-agent-local", "--json"
            )
        )
        self.assertFalse(inventory["installed"])
        self.assertNotIn(
            PLUGIN_ID,
            read_json(self.claude / "plugins/installed_plugins.json")["plugins"],
        )


if __name__ == "__main__":
    unittest.main()
