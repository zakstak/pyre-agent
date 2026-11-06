"""Exercise the bundled watcher offline, with disposable event state."""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
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

    def watcher(self, until="ready", host="github.com"):
        watcher = PR_WAIT.Watcher(host, "example/project", 7, until, 20)
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
        first = PR_WAIT.lock("github.com", "example/project", 7)
        try:
            with self.assertRaises(SystemExit) as result:
                PR_WAIT.lock("github.com", "example/project", 7)
            self.assertEqual(result.exception.code, 2)
            self.assertIn(
                "already watches github.com/example/project#7", self.output.getvalue()
            )
        finally:
            first.close()
        PR_WAIT.lock("github.com", "example/project", 7).close()

    def test_same_pr_on_different_hosts_has_independent_state_and_locks(self):
        public = self.watcher()
        public.reported.add("public-event")
        public.save()
        enterprise = self.watcher(host="ghe.example.com:8443")
        self.assertTrue(enterprise.baseline)
        self.assertNotIn("public-event", enterprise.reported)
        enterprise.reported.add("enterprise-event")
        enterprise.save()
        self.assertEqual(self.watcher().reported, {"public-event"})
        self.assertEqual(
            self.watcher(host="ghe.example.com:8443").reported,
            {"enterprise-event"},
        )
        with (
            PR_WAIT.lock("github.com", "example/project", 7),
            PR_WAIT.lock("ghe.example.com:8443", "example/project", 7),
        ):
            pass


class TargetTests(unittest.TestCase):
    def setUp(self):
        self.gh = self.enterContext(patch.object(PR_WAIT, "gh"))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def test_pr_urls_preserve_the_host_including_custom_ports(self):
        for host in ["github.com", "ghe.example.com", "ghe.example.com:8443"]:
            with self.subTest(host=host):
                url = f"https://{host}/example/project/pull/7"
                self.gh.return_value.stdout = url + "\n"
                self.assertEqual(
                    PR_WAIT.parse_target(url + "?diff=split#discussion", None),
                    (host, "example/project", 7),
                )
                self.assertIn(url + "?diff=split#discussion", self.gh.call_args.args[0])

    def test_numeric_targets_use_gh_host_and_checkout_resolution(self):
        self.gh.return_value.stdout = "https://ghe.example.com/example/project/pull/7\n"
        for repo in [None, "example/project", "ghe.example.com/example/project"]:
            with self.subTest(repo=repo):
                self.assertEqual(
                    PR_WAIT.parse_target("#7", repo),
                    ("ghe.example.com", "example/project", 7),
                )
                args = self.gh.call_args.args[0]
                self.assertEqual(args[:3], ["pr", "view", "7"])
                if repo is None:
                    self.assertNotIn("-R", args)
                else:
                    self.assertEqual(args[args.index("-R") + 1], repo)

    def test_unreadable_target_stops_before_watching(self):
        self.gh.side_effect = PR_WAIT.GhError("HTTP 404", False)
        with self.assertRaises(SystemExit) as result:
            PR_WAIT.parse_target("7", "ghe.example.com/example/project")
        self.assertEqual(result.exception.code, 2)
        self.assertIn("HTTP 404", self.output.getvalue())

    def test_transient_resolution_failure_is_an_operational_error(self):
        self.gh.side_effect = PR_WAIT.GhError("HTTP 503", True)
        with self.assertRaises(SystemExit) as result:
            PR_WAIT.parse_target("7", "ghe.example.com/example/project")
        self.assertEqual(result.exception.code, 1)

    def test_invalid_canonical_url_does_not_start_a_watcher(self):
        self.gh.return_value.stdout = "not a PR URL\n"
        with self.assertRaises(SystemExit) as result:
            PR_WAIT.parse_target("7", "example/project")
        self.assertEqual(result.exception.code, 1)
        self.assertIn("gh returned an invalid PR URL", self.output.getvalue())


class HostRoutingTests(unittest.TestCase):
    def test_every_request_uses_the_resolved_host(self):
        host = "ghe.example.com:8443"
        repo = "example/project"

        def run_gh(args, allow=(0,)):
            if args[0] == "api":
                self.assertEqual(args[args.index("--hostname") + 1], host)
                if "graphql" in args:
                    self.assertIn("owner=example", args)
                    self.assertIn("name=project", args)
                    output = json.dumps(
                        {
                            "data": {
                                "repository": {"pullRequest": {}},
                                "viewer": {"login": "operator"},
                            }
                        }
                    )
                elif ".behind_by" in args:
                    output = "2\n"
                elif ".files[].filename" in args:
                    output = "changed.py\n"
                else:
                    output = "test\n"
            else:
                self.assertEqual(args[args.index("-R") + 1], f"{host}/{repo}")
                output = (
                    json.dumps([check()]) if args[1] == "checks" else "changed.py\n"
                )
            return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

        with (
            tempfile.TemporaryDirectory(prefix="pyre-pr-wait-host-") as directory,
            patch.object(PR_WAIT, "STATE_DIR", Path(directory)),
            patch.object(PR_WAIT, "gh", side_effect=run_gh) as gh,
            patch.dict(os.environ, GH_HOST="other.example.com"),
        ):
            watcher = PR_WAIT.Watcher(host, repo, 7, "green", 20)
            self.assertEqual(watcher.fetch_pr()["viewer"], "operator")
            self.assertEqual(set(watcher.fetch_checks()), {"test"})
            self.assertEqual(watcher.base_overlap("head", "old", "new"), ["changed.py"])
            self.assertIn("2 commits behind", watcher.behind("main", "base", "head"))
            self.assertEqual(PR_WAIT.required_checks(host, repo, "main"), {"test"})
            self.assertEqual(gh.call_count, 7)


class CliTests(unittest.TestCase):
    def test_enterprise_url_routes_polling_and_state_to_its_host(self):
        with tempfile.TemporaryDirectory(prefix="pyre-pr-wait-cli-") as directory:
            root = Path(directory)
            url = "https://ghe.example.com:8443/example/project/pull/7"
            fake_gh = root / "gh"
            fake_gh.write_text(
                f"#!{sys.executable}\n"
                + textwrap.dedent(
                    """\
                    import json
                    import os
                    import sys

                    args = sys.argv[1:]
                    with open(os.environ["PR_WAIT_LOG"], "a") as log:
                        log.write(json.dumps(args) + "\\n")
                    if args[:2] == ["pr", "view"]:
                        print(os.environ["PR_WAIT_URL"])
                    elif args[0] == "api" and "graphql" in args:
                        print(json.dumps({"data": {
                            "viewer": {"login": "operator"},
                            "repository": {"pullRequest": {
                                "url": os.environ["PR_WAIT_URL"], "state": "MERGED"
                            }}
                        }}))
                    else:
                        sys.exit("Unexpected gh command")
                    """
                )
            )
            fake_gh.chmod(0o700)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), url],
                check=False,
                cwd=directory,
                env=dict(
                    os.environ,
                    HOME=directory,
                    XDG_CONFIG_HOME=directory,
                    GH_CONFIG_DIR=directory,
                    PATH=directory,
                    GH_HOST="other.example.com",
                    PR_WAIT_URL=url,
                    PR_WAIT_LOG=str(root / "requests.jsonl"),
                ),
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(f"merged: {url}", result.stdout)
            requests = [
                json.loads(line)
                for line in (root / "requests.jsonl").read_text().splitlines()
            ]
            self.assertEqual(len(requests), 2)
            self.assertIn(url, requests[0])
            self.assertEqual(
                requests[1][requests[1].index("--hostname") + 1],
                "ghe.example.com:8443",
            )
            state_dir = root / ".local/state/pr-wait"
            state_files = sorted(path.name for path in state_dir.iterdir())
            self.assertEqual(
                state_files,
                [
                    "ghe.example.com%3A8443__example__project__7.json",
                    "ghe.example.com%3A8443__example__project__7.lock",
                ],
            )

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
