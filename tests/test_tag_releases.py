"""Release tagging against a throwaway Git repository."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "tag_releases.py"
ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}
MANIFESTS = (".claude-plugin", ".codex-plugin", ".antigravity-plugin")


class TagReleasesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "work"
        self.remote = Path(self.temp.name) / "remote.git"
        subprocess.run(
            ["git", "init", "-q", "--bare", "-b", "main", str(self.remote)],
            check=True,
            env=ENV,
        )
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("remote", "add", "origin", str(self.remote))

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.root,
            env=ENV,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def release(self, subject, version, manifests=MANIFESTS):
        for folder in manifests:
            path = self.root / folder / "plugin.json"
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps({"name": "pyre-agent", "version": version}))
        (self.root / "notes.txt").write_text(subject)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", subject)
        self.git("push", "-q", "origin", "main")
        self.git("fetch", "-q", "origin")
        return self.git("rev-parse", "HEAD").strip()

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--since", "1.0.0", *args],
            cwd=self.root,
            env=ENV,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_tags_the_first_commit_of_each_untagged_version(self):
        first = self.release("Add one", "1.0.0")
        self.release("Docs only", "1.0.0")
        second = self.release("Add two", "1.1.0")
        self.git("tag", "-a", "v1.0.0", "-m", "done", first)

        dry = self.run_script()
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn(f"v1.1.0  {second[:7]}  Add two", dry.stdout)
        self.assertNotIn("v1.0.0", dry.stdout)
        self.assertEqual(self.git("tag", "--list", "v1.1.0"), "")

        pushed = self.run_script("--push")
        self.assertEqual(pushed.returncode, 0, pushed.stderr)
        self.assertEqual(self.git("rev-list", "-n1", "v1.1.0").strip(), second)
        self.assertEqual(
            self.git("tag", "-l", "--format=%(contents:subject)", "v1.1.0").strip(),
            "Pyre Agent 1.1.0: Add two",
        )
        remote = subprocess.run(
            ["git", "ls-remote", "--tags", str(self.remote)],
            env=ENV,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertIn("refs/tags/v1.1.0", remote)
        self.assertIn("is tagged", self.run_script().stdout)

    def test_stops_when_the_manifests_disagree(self):
        self.release("Add one", "1.0.0")
        self.release("Half raise", "1.1.0", manifests=MANIFESTS[:1])
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("disagree", result.stderr)


if __name__ == "__main__":
    unittest.main()
