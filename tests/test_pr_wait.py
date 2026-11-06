"""Exercise the bundled watcher offline, with disposable event state."""

import contextlib
import importlib.machinery
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / "skills/babysit-pr/scripts/pr-wait"
LOADER = importlib.machinery.SourceFileLoader("pr_wait", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
PR_WAIT = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(PR_WAIT)


def check(name="test", bucket="pass"):
    return {
        "name": name,
        "bucket": bucket,
        "link": f"https://example.com/{name}",
        "description": "",
    }


def comment(identifier, login="reviewer", body="Please fix this"):
    return {
        "id": identifier,
        "url": f"https://example.com/comments/{identifier}",
        "body": body,
        "author": {"login": login, "__typename": "User"},
    }


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-pr-wait-test-")
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.enterContext(patch.object(PR_WAIT, "STATE_DIR", self.state))
        self.enterContext(
            patch.object(PR_WAIT, "required_checks", return_value={"test"})
        )
        self.enterContext(
            patch.object(
                PR_WAIT,
                "gh",
                side_effect=AssertionError(
                    "Live GitHub access is forbidden in this test"
                ),
            )
        )
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        self.pr = {
            "url": "https://github.com/example/project/pull/7",
            "state": "OPEN",
            "headRefOid": "a" * 40,
            "baseRefName": "main",
            "baseRef": {"target": {"oid": "b" * 40}},
            "mergeStateStatus": "CLEAN",
            "author": {"login": "author"},
            "viewer": "operator",
            "comments": {"nodes": []},
            "reviews": {"nodes": []},
            "reviewThreads": {"nodes": []},
        }
        self.checks = {"test": check()}

    def watcher(self, until="ready"):
        watcher = PR_WAIT.Watcher("example/project", 7, until, 20)
        watcher.fetch_pr = Mock(return_value=self.pr)
        watcher.fetch_checks = Mock(return_value=self.checks)
        watcher.behind = Mock(return_value="")
        return watcher

    def reviewed(self, head=None):
        review = comment("bot-review", "greptile[bot]", "Reviewed")
        review.update(state="COMMENTED", commit={"oid": head or self.pr["headRefOid"]})
        review["author"]["__typename"] = "Bot"
        self.pr["reviews"]["nodes"] = [review]

    def assert_exit(self, watcher, code, message):
        with self.assertRaises(SystemExit) as result:
            watcher.poll()
        self.assertEqual(result.exception.code, code)
        self.assertIn(message, self.output.getvalue())

    def test_green_waits_for_stable_checks_without_a_review_bot(self):
        watcher = self.watcher("green")
        watcher.poll()
        self.assert_exit(watcher, 0, "green on aaaaaaa")

    def test_required_check_failure_needs_attention_on_the_first_poll(self):
        self.checks["test"] = check(bucket="fail")
        self.assert_exit(self.watcher(), 1, "required check failed: test")

    def test_not_yet_registered_required_check_prevents_green(self):
        with patch.object(PR_WAIT, "required_checks", return_value={"test", "lint"}):
            watcher = self.watcher("green")
            watcher.poll()
            watcher.poll()
            self.checks["lint"] = check("lint")
            watcher.poll()
            self.assert_exit(watcher, 0, "required 2/2 green")

    def test_old_head_review_does_not_make_the_current_head_ready(self):
        self.reviewed(head="c" * 40)
        watcher = self.watcher()
        watcher.poll()
        watcher.poll()
        self.reviewed()
        self.assert_exit(watcher, 0, "ready on aaaaaaa")

    def test_existing_unresolved_thread_blocks_ready(self):
        self.reviewed()
        self.pr["reviewThreads"]["nodes"] = [
            {
                "isResolved": False,
                "path": "app.py",
                "line": 4,
                "comments": {"nodes": [comment("existing-finding")]},
            }
        ]
        watcher = self.watcher()
        watcher.poll()
        self.assert_exit(watcher, 1, "blocked by 1 unresolved threads")
        self.assertIn(
            "https://example.com/comments/existing-finding", self.output.getvalue()
        )

    def test_pending_optional_coderabbit_does_not_hold_ready(self):
        self.reviewed()
        self.checks["CodeRabbit"] = check("CodeRabbit", "pending")
        watcher = self.watcher()
        watcher.poll()
        self.assert_exit(watcher, 0, "ready on aaaaaaa")

    def test_behind_branch_needs_attention_before_ready(self):
        self.reviewed()
        self.pr["mergeStateStatus"] = "BEHIND"
        watcher = self.watcher()
        watcher.poll()
        self.assert_exit(watcher, 1, "merge state is BEHIND")

    def test_conflict_needs_attention_even_while_checks_are_pending(self):
        self.pr["mergeStateStatus"] = "DIRTY"
        self.checks["test"] = check(bucket="pending")
        self.assert_exit(self.watcher(), 1, "merge state is DIRTY")

    def test_merged_and_closed_have_distinct_terminal_results(self):
        for state, code, message in [
            ("MERGED", 0, "merged:"),
            ("CLOSED", 1, "closed without merging:"),
        ]:
            with self.subTest(state=state):
                self.pr["state"] = state
                self.assert_exit(self.watcher(), code, message)

    def test_restart_reports_comments_from_the_gap_only_once(self):
        self.checks["test"] = check(bucket="pending")
        self.pr["comments"]["nodes"] = [comment("old")]
        baseline = self.watcher("any-change")
        baseline.poll()
        baseline.save()
        self.pr["comments"]["nodes"].append(comment("during-gap", body="New finding"))
        self.assert_exit(self.watcher("any-change"), 0, "New finding")
        self.watcher("any-change").poll()
        self.assertEqual(self.output.getvalue().count("comment from reviewer:"), 1)

    def test_duplicate_watcher_is_rejected_until_the_lock_is_released(self):
        first = PR_WAIT.lock("example/project", 7)
        try:
            with self.assertRaises(SystemExit) as result:
                PR_WAIT.lock("example/project", 7)
            self.assertEqual(result.exception.code, 2)
            self.assertIn("already watches example/project#7", self.output.getvalue())
        finally:
            first.close()
        PR_WAIT.lock("example/project", 7).close()


class CliTests(unittest.TestCase):
    def test_help_and_invalid_input_do_not_need_github_or_credentials(self):
        with tempfile.TemporaryDirectory(prefix="pyre-pr-wait-cli-") as directory:
            env = dict(
                os.environ,
                HOME=directory,
                XDG_CONFIG_HOME=directory,
                GH_CONFIG_DIR=directory,
                PATH=directory,
            )
            for arguments, code, message in [
                (["--help"], 0, "Watch a GitHub PR"),
                ([], 2, "missing PR number"),
                (
                    ["bad-target", "--repo", "example/project"],
                    2,
                    "not a PR number or PR URL",
                ),
                (["0", "--repo", "example/project"], 2, "not a valid PR number"),
                (["7", "--until", "unknown"], 2, "invalid choice"),
            ]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(
                        [sys.executable, str(SCRIPT), *arguments],
                        check=False,
                        cwd=directory,
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    self.assertEqual(
                        result.returncode, code, result.stdout + result.stderr
                    )
                    self.assertIn(message, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
