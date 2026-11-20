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
TEST_MARKETPLACE = "pyre-agent-test"
TEST_PLUGIN_ID = f"pyre-agent@{TEST_MARKETPLACE}"


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
            for host in ("codex", "claude", "antigravity")
        ]
        for field in ("name", "version", "license"):
            self.assertEqual(
                {manifest[field] for manifest in manifests},
                {manifests[0][field]},
                field,
            )
        antigravity = manifests[2]
        self.assertTrue(antigravity.get("displayName"))
        self.assertTrue(antigravity.get("description"))
        self.assertTrue(antigravity.get("author"))
        self.assertFalse(antigravity.get("disabled", False))
        for forbidden in (
            "hooks",
            "context",
            "plugins",
            "rules",
            "agents",
            "hooks.json",
            "mcp_config.json",
        ):
            self.assertFalse((ROOT / forbidden).exists(), forbidden)
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
        # Use an isolated catalog name in the disposable copy so machine-wide
        # Claude managed settings for pyre-agent-local do not reject self.repo.
        for relative in (
            ".agents/plugins/marketplace.json",
            ".claude-plugin/marketplace.json",
        ):
            catalog_path = self.repo / relative
            catalog = read_json(catalog_path)
            catalog["name"] = TEST_MARKETPLACE
            catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
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
            self.run_cli("codex", "plugin", "add", TEST_PLUGIN_ID, "--json")
        )
        installed_path = Path(installed["installedPath"])
        self.assertTrue(installed_path.is_relative_to(self.codex))
        self.assertNotEqual(installed_path, self.repo)
        self.assert_skill_package(installed_path)
        inventory = json.loads(
            self.run_cli(
                "codex", "plugin", "list", "--marketplace", TEST_MARKETPLACE, "--json"
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
                if hook.get("pluginId") == TEST_PLUGIN_ID
            ]
        )
        self.run_cli("claude", "plugin", "marketplace", "add", str(self.repo))
        self.run_cli("claude", "plugin", "install", TEST_PLUGIN_ID, "--json")
        (claude_install,) = read_json(self.claude / "plugins/installed_plugins.json")[
            "plugins"
        ][TEST_PLUGIN_ID]
        claude_installed_path = Path(claude_install["installPath"])
        self.assertTrue(claude_installed_path.is_relative_to(self.claude))
        self.assert_skill_package(claude_installed_path)
        inventory = self.run_cli("claude", "plugin", "details", TEST_PLUGIN_ID)
        for path in self.repo.glob("skills/*/SKILL.md"):
            self.assertIn(path.parent.name, inventory)
        self.assertIn("Hooks (0)", inventory)
        readme = self.repo / "README.md"
        updated = readme.read_text() + "\nUpdated local package.\n"
        readme.write_text(updated)
        self.assertNotEqual((installed_path / "README.md").read_text(), updated)
        self.run_cli("codex", "plugin", "add", TEST_PLUGIN_ID, "--json")
        self.assertEqual((installed_path / "README.md").read_text(), updated)
        self.assertIn(
            "nothing to update",
            self.run_cli("claude", "plugin", "update", TEST_PLUGIN_ID),
        )

        for config, instructions in (
            (self.codex, "AGENTS.md"),
            (self.claude, "CLAUDE.md"),
        ):
            self.assertFalse((config / instructions).exists())
            for name in actual:
                self.assertFalse((config / "skills" / name.split(":", 1)[1]).exists())
        self.run_cli("codex", "plugin", "remove", TEST_PLUGIN_ID, "--json")
        self.run_cli("claude", "plugin", "uninstall", TEST_PLUGIN_ID)
        inventory = json.loads(
            self.run_cli(
                "codex", "plugin", "list", "--marketplace", TEST_MARKETPLACE, "--json"
            )
        )
        self.assertFalse(inventory["installed"])
        self.assertNotIn(
            TEST_PLUGIN_ID,
            read_json(self.claude / "plugins/installed_plugins.json")["plugins"],
        )


@unittest.skipUnless(
    shutil.which("agy"),
    "Native integration requires Antigravity CLI",
)
class NativeAntigravityPluginTests(unittest.TestCase):
    def setUp(self):
        self.agy = native_cli("agy", "HOME")
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-plugin-agy-")
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
        self.env = dict(
            os.environ,
            HOME=str(self.base),
            XDG_CONFIG_HOME=str(self.base / "xdg"),
        )

    def run_agy(self, *args):
        result = subprocess.run(
            (self.agy, *args),
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
        for forbidden in (
            "hooks",
            "context",
            "plugins",
            "rules",
            "agents",
            "hooks.json",
            "mcp_config.json",
        ):
            self.assertFalse((installed_path / forbidden).exists(), forbidden)
        for name in ("LICENSE", "README.md"):
            self.assertEqual(
                (installed_path / name).read_bytes(), (self.repo / name).read_bytes()
            )

    def test_antigravity_validates_installs_refreshes_and_removes_the_plugin(self):
        manifest = read_json(self.repo / ".antigravity-plugin/plugin.json")
        shared = {path.parent.name for path in self.repo.glob("skills/*/SKILL.md")}

        report = json.loads(
            self.run_agy("plugin", "validate", "--json", str(self.repo))
        )
        self.assertEqual(report["manifest"], ".antigravity-plugin/plugin.json")
        self.assertEqual(report["name"], manifest["name"])
        self.assertEqual(
            report["components"],
            {
                "agents": 0,
                "hooks": 0,
                "mcpServers": 0,
                "rules": 0,
                "sidecars": 0,
                "skills": len(shared),
            },
        )
        unexpected_findings = [
            finding
            for finding in report.get("findings", [])
            if finding.get("severity") == "error"
            or (
                finding.get("severity") == "warning"
                and finding.get("file") != "AGENTS.md"
            )
        ]
        self.assertEqual(unexpected_findings, [])

        self.run_agy("plugin", "install", str(self.repo))
        config_dir = self.base / ".gemini/config"
        installed_path = config_dir / "plugins" / manifest["name"]
        self.assertTrue(installed_path.is_dir())
        self.assertNotEqual(installed_path, self.repo)
        self.assert_skill_package(installed_path)

        (entry,) = json.loads(self.run_agy("plugin", "list", "--json"))
        self.assertEqual(entry["name"], manifest["name"])
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["version"], manifest["version"])
        self.assertEqual(Path(entry["path"]), installed_path)
        self.assertEqual(set(entry["skills"]), shared)
        for absent in ("hooks", "rules", "agents", "mcpServers"):
            self.assertFalse(entry.get(absent), absent)

        readme = self.repo / "README.md"
        updated = readme.read_text() + "\nUpdated local package.\n"
        readme.write_text(updated)
        self.assertNotEqual((installed_path / "README.md").read_text(), updated)
        self.run_agy("plugin", "install", str(self.repo))
        self.assertEqual((installed_path / "README.md").read_text(), updated)

        self.run_agy("plugin", "disable", manifest["name"])
        (disabled_entry,) = json.loads(self.run_agy("plugin", "list", "--json"))
        self.assertFalse(disabled_entry["enabled"])
        self.run_agy("plugin", "enable", manifest["name"])
        (enabled_entry,) = json.loads(self.run_agy("plugin", "list", "--json"))
        self.assertTrue(enabled_entry["enabled"])

        for instructions in ("AGENTS.md", "GEMINI.md"):
            self.assertFalse((config_dir / instructions).exists())
        for name in shared:
            self.assertFalse((config_dir / "skills" / name).exists())

        self.run_agy("plugin", "uninstall", manifest["name"])
        self.assertEqual(json.loads(self.run_agy("plugin", "list", "--json")), [])
        self.assertFalse(installed_path.exists())


if __name__ == "__main__":
    unittest.main()
