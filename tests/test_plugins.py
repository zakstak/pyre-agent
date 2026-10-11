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

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ID = "pyre-agent@pyre-agent-local"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


class PackageTests(unittest.TestCase):
    def test_catalogs_select_the_same_plugin_and_version(self):
        codex = read_json(ROOT / ".agents/plugins/marketplace.json")
        claude = read_json(ROOT / ".claude-plugin/marketplace.json")
        self.assertEqual(codex["name"], claude["name"])
        self.assertEqual(codex["plugins"][0]["name"], claude["plugins"][0]["name"])
        self.assertEqual(ROOT / codex["plugins"][0]["source"]["path"],
                         ROOT / claude["plugins"][0]["source"])
        manifests = [read_json(ROOT / f".{host}-plugin/plugin.json")
                     for host in ("codex", "claude")]
        self.assertEqual(manifests[0]["name"], manifests[1]["name"])
        self.assertEqual(manifests[0]["version"], manifests[1]["version"])

    def test_hook_runs_only_on_startup_and_reads_the_relocated_package(self):
        hooks = read_json(ROOT / "hooks/hooks.json")["hooks"]
        self.assertEqual(set(hooks), {"SessionStart"})
        group, = hooks["SessionStart"]
        self.assertIsNotNone(re.search(group["matcher"], "startup"))
        for source in ("resume", "clear", "compact", "fork"):
            self.assertIsNone(re.search(group["matcher"], source), source)
        handler, = group["hooks"]
        with tempfile.TemporaryDirectory(prefix="pyre-plugin-context-") as temp:
            installed = Path(temp) / "installed plugin with spaces"
            (installed / "context").mkdir(parents=True)
            context = installed / "context/working-with-zak.md"
            shutil.copyfile(ROOT / "context/working-with-zak.md", context)
            unrelated = Path(temp) / "other project"
            (unrelated / "context").mkdir(parents=True)
            (unrelated / "context/working-with-zak.md").write_text("Wrong project")
            before = context.read_bytes()
            result = subprocess.run(
                handler["command"], shell=True, cwd=unrelated,
                env=dict(os.environ, CLAUDE_PLUGIN_ROOT=str(installed)),
                capture_output=True, timeout=handler["timeout"], check=True,
            )
            self.assertEqual(result.stdout, before)
            self.assertEqual(context.read_bytes(), before)
            self.assertLessEqual(len(result.stdout.decode("utf-8")), 10000)


@unittest.skipUnless(shutil.which("codex") and shutil.which("claude"),
                     "Native integration requires Codex and Claude Code CLIs")
class NativePluginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-plugin-native-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "marketplace with spaces"
        shutil.copytree(ROOT, self.repo,
                        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
        self.codex = self.base / "codex"
        self.claude = self.base / "claude"
        self.codex.mkdir()
        self.claude.mkdir()
        self.env = dict(os.environ, CODEX_HOME=str(self.codex),
                        CLAUDE_CONFIG_DIR=str(self.claude))

    def run_cli(self, *command):
        result = subprocess.run(command, cwd=self.base, env=self.env,
                                capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def inspect_codex_components(self):
        """Ask the installed harness for its skills and hooks, never start a turn."""
        process = subprocess.Popen(
            ["codex", "app-server", "--stdio"], cwd=self.base, env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        events = queue.Queue()

        def read_events():
            for line in process.stdout:
                events.put(json.loads(line))
            events.put(None)

        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()

        def request(number, method, params):
            process.stdin.write(json.dumps({"id": number, "method": method,
                                            "params": params}) + "\n")
            process.stdin.flush()
            while True:
                event = events.get(timeout=20)
                self.assertIsNotNone(event, "app-server exited before its response")
                if event.get("id") == number:
                    self.assertNotIn("error", event, event)
                    return event["result"]

        try:
            request(1, "initialize", {
                "clientInfo": {"name": "pyre-plugin-test", "version": "1"},
                "capabilities": {"experimentalApi": True},
            })
            process.stdin.write('{"method":"initialized"}\n')
            process.stdin.flush()
            skills = request(2, "skills/list", {"cwds": [str(self.base)],
                                               "forceReload": True})
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
        installed = json.loads(self.run_cli("codex", "plugin", "add", PLUGIN_ID, "--json"))
        installed_path = Path(installed["installedPath"])
        self.assertTrue(installed_path.is_relative_to(self.codex))
        self.assertNotEqual(installed_path, self.repo)
        inventory = json.loads(self.run_cli("codex", "plugin", "list", "--marketplace",
                                            "pyre-agent-local", "--json"))
        self.assertTrue(inventory["installed"][0]["enabled"])
        skills, hooks = self.inspect_codex_components()
        self.assertFalse(skills["data"][0]["errors"])
        actual = {skill["name"] for entry in skills["data"] for skill in entry["skills"]
                  if Path(skill["path"]).is_relative_to(installed_path)}
        shared = {f"pyre-agent:{path.parent.name}"
                  for path in self.repo.glob("skills/*/SKILL.md")}
        self.assertEqual(actual, shared)
        hook, = [hook for entry in hooks["data"] for hook in entry["hooks"]
                 if hook.get("pluginId") == PLUGIN_ID]
        self.assertEqual(hook["matcher"], "^startup$")
        self.assertEqual(hook["trustStatus"], "untrusted")
        self.assertEqual(hook["source"], "plugin")
        self.assertIn(str(installed_path / "context/working-with-zak.md"), hook["command"])

        self.run_cli("claude", "plugin", "marketplace", "add", str(self.repo))
        self.run_cli("claude", "plugin", "install", PLUGIN_ID, "--json")
        inventory = self.run_cli("claude", "plugin", "details", "pyre-agent")
        for path in self.repo.glob("skills/*/SKILL.md"):
            self.assertIn(path.parent.name, inventory)
        self.assertIn("codex-branch-review", inventory)
        self.assertIn("Hooks (1)", inventory)
        self.assertIn("SessionStart", inventory)

        context = self.repo / "context/working-with-zak.md"
        updated = context.read_text() + "\nUpdated local context.\n"
        context.write_text(updated)
        self.assertNotEqual((installed_path / "context/working-with-zak.md").read_text(), updated)
        self.run_cli("codex", "plugin", "add", PLUGIN_ID, "--json")
        self.assertEqual((installed_path / "context/working-with-zak.md").read_text(), updated)
        self.assertIn("nothing to update", self.run_cli("claude", "plugin", "update", PLUGIN_ID))

        for config, instructions in ((self.codex, "AGENTS.md"), (self.claude, "CLAUDE.md")):
            self.assertFalse((config / instructions).exists())
            for name in actual | {"pyre-agent:codex-branch-review"}:
                self.assertFalse((config / "skills" / name.split(":", 1)[1]).exists())
        self.run_cli("codex", "plugin", "remove", PLUGIN_ID, "--json")
        self.run_cli("claude", "plugin", "uninstall", PLUGIN_ID)
        inventory = json.loads(self.run_cli("codex", "plugin", "list", "--marketplace",
                                            "pyre-agent-local", "--json"))
        self.assertFalse(inventory["installed"])
        self.assertNotIn(PLUGIN_ID, read_json(self.claude / "plugins/installed_plugins.json")["plugins"])


if __name__ == "__main__":
    unittest.main()
