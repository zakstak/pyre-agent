"""Black-box bridge regressions. Fake Codex only: no credentials or API calls."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import importlib.util
import hashlib
import shlex
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "host-skills/claude-code/codex-branch-review"
SCRIPT = SKILL / "scripts/review_bridge.py"
PROFILE = SKILL / "references/adversarial-branch-review.config.toml"
MODEL = "gpt-6.1-sol"
FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
mode = os.environ.get("FAKE_MODE", "ok")
if args == ["exec", "--help"]:
    print("--ignore-user-config --ignore-rules --ephemeral --output-schema --output-last-message --sandbox --model" if mode != "old_cli" else "old CLI")
    raise SystemExit(0)
if args == ["login", "status"]:
    raise SystemExit(1 if mode == "no_auth" else 0)
if args[-2:] == ["debug", "models"]:
    print(json.dumps({"models": [] if mode == "missing_model" else [{"slug": "gpt-6.1-sol"}]}))
    raise SystemExit(0)
assert args[0] == "exec", args
if mode == "never_read":
    time.sleep(30)
prompt = sys.stdin.read()
output = pathlib.Path(args[args.index("--output-last-message") + 1])
record = {"argv": args, "prompt": prompt, "cwd": os.getcwd(), "pid": os.getpid(), "name": output.stem}
fd = os.open(os.environ["FAKE_LOG"], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(record) + "\n").encode()); os.close(fd)
if mode in ("sleep", "fail_peer"):
    if mode == "fail_peer" and output.stem == "specialist-fail":
        time.sleep(.2)
        raise SystemExit(9)
    time.sleep(30)
if mode == "runtime_readonly":
    print("failed to initialize in-process app-server client: Read-only file system (os error 30)", file=sys.stderr)
    raise SystemExit(1)
if mode == "fail":
    print("model gpt-6.1-sol is not supported for this account", file=sys.stderr)
    raise SystemExit(1)
review = {"verdict": "findings", "summary": "Introduced authorization bypass", "findings": [
    {"severity": "P1", "title": "Restore administrator check", "path": "auth.py", "line_start": 2, "line_end": 2,
     "evidence": "is_admin returns True for every user", "impact": "Any user becomes an administrator",
     "recommendation": "Read the user's administrator flag", "confidence": .99}],
    "coverage": ["Authorization path"], "limitations": ["Tests were not executed"]}
if mode == "incomplete" and output.stem.startswith("specialist-"):
    review["verdict"] = "incomplete"
    review["limitations"] = ["Missing deployment context"]
if mode == "huge_integer": review["findings"][0]["line_start"] = 10**1000
if mode == "flood": print("x" * (9 * 1024 * 1024))
if mode == "bad_path": review["findings"][0]["path"] = "../escape.py"
if mode == "bad_lines": review["findings"][0]["line_end"] = 1
if mode == "bad_verdict": review["verdict"] = "no_findings"
if mode != "no_output":
    output.write_text("not JSON" if mode == "bad_json" else json.dumps(review))
if mode == "bad_event": print("not JSON")
if mode == "failed_event": print(json.dumps({"type": "turn.failed"}))
if mode == "wrong_model": print(json.dumps({"type": "thread.started", "model": "another-model"}))
if mode != "no_completion": print(json.dumps({"type": "turn.completed"}))
'''


@unittest.skipIf(sys.version_info < (3, 11), "Bridge requires Python 3.11+")
class ReviewBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="review-bridge-test-")
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo with spaces"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.repo / "auth.py").write_text('def is_admin(user):\n    return user.get("admin", False)\n')
        self.git("add", "auth.py")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.repo / "auth.py").write_text("def is_admin(user):\n    return True\n")
        self.git("commit", "-qam", "regression")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.binary = self.root / "fake codex"
        self.binary.write_text(FAKE_CODEX)
        self.binary.chmod(0o700)
        self.log = self.root / "calls.jsonl"
        self.env = dict(os.environ, FAKE_LOG=str(self.log), FAKE_MODE="ok")
        # Deliberately don't inherit a repo-contained TMPDIR from a caller.
        self.env["TMPDIR"] = str(self.root)
        self.request = {"repo": str(self.repo), "base": self.base}

    def tearDown(self):
        for record in self.calls():
            if self.alive(record["pid"]):
                try:
                    os.kill(record["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def argv(self, script=SCRIPT):
        return [sys.executable, str(script), "--request", "-", "--codex-bin", str(self.binary)]

    def invoke(self, *, mode="ok", request=None, extra=(), script=SCRIPT):
        return subprocess.run([*self.argv(script), *extra], input=json.dumps(self.request if request is None else request),
                              text=True, capture_output=True, env={**self.env, "FAKE_MODE": mode}, timeout=8)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
            stat = Path(f"/proc/{pid}/stat")
            return not stat.exists() or stat.read_text().split()[2] != "Z"
        except ProcessLookupError:
            return False

    def assert_error(self, result, code=None):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout, "")
        error = json.loads(result.stderr)["error"]
        if code:
            self.assertEqual(error["code"], code, error)
        for call in self.calls():
            self.assertFalse(Path(call["cwd"]).exists(), "Temporary report directory leaked")
        return error

    def test_success_exact_model_personality_and_sandbox(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["model_requested"], MODEL)
        self.assertEqual(value["scope"]["head_sha"], self.head)
        self.assertEqual(value["scope"]["merge_base"], self.base)
        self.assertEqual(value["review"]["findings"][0]["severity"], "P1")
        self.assertEqual(self.git("status", "--porcelain"), "")
        call = self.calls()[0]
        args = call["argv"]
        self.assertEqual(args[args.index("--model") + 1], MODEL)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"):
            self.assertIn(flag, args)
        for setting in ("mcp_servers={}", "features.apps=false", "features.plugins=false", "features.hooks=false",
                        "features.memories=false", "features.multi_agent=false", 'approval_policy="never"', "project_doc_max_bytes=0"):
            self.assertIn(setting, args)
        self.assertTrue(any(a.startswith("developer_instructions=") and "REVIEW ONLY" in a for a in args))
        self.assertFalse(Path(call["cwd"]).exists())
        self.assertFalse(Path(call["cwd"]).is_relative_to(self.repo))

    def test_focus_and_shell_metacharacters_are_only_prompt_data(self):
        sentinel = self.root / "injected"
        focus = f'$(touch "{sentinel}"); `touch {sentinel}`\n"quoted"'
        self.request.update(focus=[focus], context=focus)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.calls()[0]
        self.assertNotIn(focus, call["argv"])
        self.assertIn(json.dumps(focus)[1:-1], call["prompt"])
        self.assertFalse(sentinel.exists())

    def test_dirty_changes_explicitly_excluded(self):
        (self.repo / "auth.py").write_text("uncommitted\n")
        (self.repo / "untracked").write_text("untracked")
        value = json.loads(self.invoke().stdout)
        self.assertTrue(value["scope"]["local_changes_excluded"])
        self.assertEqual(value["scope"]["head_sha"], self.head)

    def test_invalid_refs_rejected_without_cli_invocation(self):
        for ref in ("--help", "not-a-ref", "HEAD;touch /tmp/bridge-should-not-exist"):
            with self.subTest(ref=ref):
                self.assert_error(self.invoke(request={**self.request, "base": ref}), "invalid_git_target")
        self.assertEqual(self.calls(), [])

    def test_invalid_request_and_unknown_fields(self):
        for data in ({}, {**self.request, "model": "other"}, {**self.request, "focus": "security"},
                     {**self.request, "subagents": [{"name": "Bad Name", "task": "review"}]},
                     {**self.request, "subagents": [{"name": "same", "task": "review"}] * 2}):
            with self.subTest(data=data):
                self.assert_error(self.invoke(request=data), "invalid_request")

    def test_duplicate_json_keys_rejected(self):
        result = subprocess.run(self.argv(), input='{"repo":"one","repo":"two","base":"HEAD"}',
                                text=True, capture_output=True, env=self.env)
        self.assert_error(result, "invalid_json")

    def test_missing_cli_no_fallback(self):
        self.assert_error(self.invoke(extra=("--codex-bin", str(self.root / "missing"))), "missing_cli")

    def test_preflight_failures_no_fallback(self):
        for mode, code in (("old_cli", "unsupported_cli"), ("no_auth", "authentication_required"), ("missing_model", "model_unavailable")):
            with self.subTest(mode=mode):
                self.assert_error(self.invoke(mode=mode), code)
        self.assertEqual(self.calls(), [])

    def test_runtime_readonly_is_an_actionable_blocker(self):
        self.assert_error(self.invoke(mode="runtime_readonly"), "cli_runtime_unavailable")

    def test_check_does_not_run_inference(self):
        value = json.loads(self.invoke(extra=("--check",)).stdout)
        self.assertEqual(value["status"], "preflight_passed")
        self.assertEqual(self.calls(), [])

    def test_failure_or_malformed_output_is_not_success(self):
        for mode in ("fail", "bad_json", "no_output", "bad_event", "failed_event", "wrong_model",
                     "no_completion", "bad_path", "bad_lines", "bad_verdict", "huge_integer"):
            with self.subTest(mode=mode):
                self.assert_error(self.invoke(mode=mode))

    def test_specialists_run_and_reports_reach_lead(self):
        self.request["subagents"] = [{"name": "security", "task": "Inspect authorization"},
                                      {"name": "compat", "task": "Inspect compatibility"}]
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(len(value["delegated_reviews"]), 2)
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1]["name"], "lead")
        self.assertIn("completed_specialist_reviews", calls[-1]["prompt"])
        self.assertIn("specialist-security", calls[-1]["prompt"])
        for call in calls:
            self.assertEqual(call["argv"][call["argv"].index("--model") + 1], MODEL)

    def test_incomplete_specialist_forces_incomplete_verdict(self):
        self.request["subagents"] = [{"name": "security", "task": "Inspect authorization"}]
        value = json.loads(self.invoke(mode="incomplete").stdout)
        self.assertEqual(value["review"]["verdict"], "incomplete")
        self.assertTrue(any("required specialist" in s for s in value["review"]["limitations"]))

    def test_specialist_failure_cancels_peers_and_never_starts_lead(self):
        self.request["subagents"] = [{"name": "slow", "task": "Inspect authorization"},
                                      {"name": "fail", "task": "Inspect compatibility"}]
        start = time.monotonic()
        self.assert_error(self.invoke(mode="fail_peer"), "codex_failed")
        self.assertLess(time.monotonic() - start, 4)
        self.assertNotIn("lead", [c["name"] for c in self.calls()])
        self.assertTrue(all(not self.alive(c["pid"]) for c in self.calls()))

    def test_timeout_kills_process_and_cleans_temp(self):
        self.assert_error(self.invoke(mode="sleep", extra=("--timeout", "1")), "timeout")
        self.assertTrue(all(not self.alive(c["pid"]) for c in self.calls()))

    def test_large_prompt_deadline_when_child_never_reads_stdin(self):
        self.request["context"] = "x" * 16000
        self.request["focus"] = ["y" * 16000] * 3
        started = time.monotonic()
        self.assert_error(self.invoke(mode="never_read", extra=("--timeout", "1")), "timeout")
        self.assertLess(time.monotonic() - started, 4)

    def test_relative_executable_and_relative_path_entry(self):
        for use_path in (False, True):
            with self.subTest(relative_path_entry=use_path):
                argv = self.argv()
                argv[-1] = self.binary.name if use_path else "./" + self.binary.name
                env = dict(self.env)
                if use_path:
                    env["PATH"] = "." + os.pathsep + env["PATH"]
                result = subprocess.run(argv, cwd=self.root, input=json.dumps(self.request),
                                        text=True, capture_output=True, env=env, timeout=8)
                self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(os.name == "posix", "POSIX deterministic signal regression")
    def test_signal_between_child_creation_and_registration(self):
        harness = self.root / "signal-harness.py"
        harness.write_text('''import importlib.util, os, signal, subprocess, sys
spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
original = subprocess.Popen
children = []
def interrupting_popen(*args, **kwargs):
    child = original([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
    children.append(child)
    os.kill(os.getpid(), int(os.environ["TEST_SIGNAL"]))
    return child
bridge.subprocess.Popen = interrupting_popen
code = bridge.main(sys.argv[2:])
assert code == 130, code
assert children and all(child.poll() is not None for child in children)
assert not bridge._ACTIVE
raise SystemExit(code)
''')
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                result = subprocess.run([sys.executable, str(harness), str(SCRIPT), *self.argv()[2:]],
                                        input=json.dumps(self.request), text=True, capture_output=True,
                                        env={**self.env, "TEST_SIGNAL": str(int(sig))}, timeout=8)
                self.assertEqual(result.returncode, 130, result.stderr)
                self.assertEqual(json.loads(result.stderr)["error"]["code"], "cancelled")

    @unittest.skipUnless(os.name == "posix", "POSIX signal regression")
    def test_interrupt_while_waiting_for_request_stdin(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                process = subprocess.Popen(self.argv(), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, env=self.env)
                time.sleep(.15)
                process.send_signal(sig)
                _, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 130, stderr)
                self.assertEqual(json.loads(stderr)["error"]["code"], "cancelled")

    @unittest.skipUnless(os.name == "posix", "POSIX process group test")
    def test_interrupt_and_terminate_cancel_specialists(self):
        self.request["subagents"] = [{"name": "slow", "task": "Inspect authorization"}]
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                self.log.unlink(missing_ok=True)
                process = subprocess.Popen(self.argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, text=True, env={**self.env, "FAKE_MODE": "sleep"})
                process.stdin.write(json.dumps(self.request)); process.stdin.close(); process.stdin = None
                deadline = time.monotonic() + 4
                while not self.calls() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(self.calls(), "Specialist did not start")
                process.send_signal(sig)
                stdout, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 130, stderr)
                self.assertEqual(stdout, "")
                self.assertEqual(json.loads(stderr)["error"]["code"], "cancelled")
                self.assertTrue(all(not self.alive(c["pid"]) for c in self.calls()))
                self.assertNotIn("lead", [c["name"] for c in self.calls()])
                self.assertTrue(all(not Path(c["cwd"]).exists() for c in self.calls()))

    def test_git_fsmonitor_helper_is_not_executed(self):
        sentinel = self.root / "fsmonitor-ran"
        helper = self.root / "fsmonitor"
        helper.write_text(f"#!/bin/sh\ntouch '{sentinel}'\n")
        helper.chmod(0o700)
        self.git("config", "core.fsmonitor", str(helper))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX executable filter fixture")
    def test_dirty_check_neutralizes_clean_and_process_filters(self):
        sentinel = self.root / "clean-filter-ran"
        helper = self.root / "clean-filter.py"
        helper.write_text("import pathlib,sys\npathlib.Path(" + repr(str(sentinel)) + ").touch()\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n")
        (self.repo / ".gitattributes").write_text("auth.py filter=sentinel\n")
        self.git("add", ".gitattributes")
        self.git("commit", "-qm", "declare filter")
        command = shlex.quote(sys.executable) + " " + shlex.quote(str(helper))
        self.git("config", "filter.sentinel.clean", command)
        (self.repo / "auth.py").write_text("def is_admin(user):\n    return None\n")
        # Establish that the unchanged-size file really triggers the unsafe
        # status path, then assert neither configured helper is used by bridge.
        self.git("status", "--porcelain")
        self.assertTrue(sentinel.exists())
        sentinel.unlink()
        self.git("config", "filter.sentinel.process", command)
        self.git("config", "filter.sentinel.required", "true")
        for check in (False, True):
            with self.subTest(check_only=check):
                result = self.invoke(extra=("--check",) if check else ())
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(json.loads(result.stdout)["scope"]["local_changes_excluded"])
                self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX remote-helper fixture")
    def test_missing_promised_tree_never_fetches_or_writes_objects(self):
        partial = self.root / "partial"
        self.git("config", "uploadpack.allowFilter", "true")
        subprocess.run(["git", "clone", "--quiet", "--no-checkout", "--no-local", "--filter=tree:0",
                        self.repo.as_uri(), str(partial)], check=True)
        tree = self.git("rev-parse", self.base + "^{tree}").strip()
        present = subprocess.run(["git", "--no-lazy-fetch", "-C", str(partial), "cat-file", "-e", tree],
                                 capture_output=True)
        self.assertNotEqual(present.returncode, 0, "Fixture must lack the promised tree")
        sentinel = self.root / "remote-helper-ran"
        helper = self.root / "git-remote-sentinel"
        helper.write_text("#!/usr/bin/env python3\nimport pathlib\npathlib.Path(" + repr(str(sentinel)) + ").touch()\nraise SystemExit(1)\n")
        helper.chmod(0o700)
        subprocess.run(["git", "-C", str(partial), "config", "remote.origin.url", "sentinel::forbidden"], check=True)
        subprocess.run(["git", "-C", str(partial), "config", "protocol.sentinel.allow", "always"], check=True)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        # Prove this fixture attempts remote access without protection. The
        # controlled helper writes a sentinel and exits; it performs no network.
        subprocess.run(["git", "-C", str(partial), "cat-file", "-e", tree], capture_output=True,
                       env={**self.env, "GIT_NO_LAZY_FETCH": "0"}, timeout=8)
        self.assertTrue(sentinel.exists(), "Unprotected object read must invoke the fixture remote")
        sentinel.unlink()
        self.env["GIT_NO_LAZY_FETCH"] = "1"
        request = dict(self.request, repo=str(partial))
        objects = partial / ".git/objects"
        def snapshot():
            return {str(p.relative_to(objects)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in objects.rglob("*") if p.is_file()}
        before = snapshot()
        for check in (False, True):
            with self.subTest(check_only=check):
                self.assert_error(self.invoke(request=request, extra=("--check",) if check else ()), "invalid_git_target")
                self.assertFalse(sentinel.exists())
                self.assertEqual(snapshot(), before)

    @unittest.skipUnless(os.name == "posix", "POSIX executable filter fixture")
    def test_filter_name_that_cannot_be_overridden_fails_closed(self):
        sentinel = self.root / "unusual-filter-ran"
        helper = self.root / "unusual-filter.py"
        helper.write_text("import pathlib,sys\npathlib.Path(" + repr(str(sentinel)) + ").touch()\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n")
        (self.repo / ".gitattributes").write_text("auth.py filter=sentinel=key\n")
        self.git("add", ".gitattributes")
        self.git("commit", "-qm", "declare unusual filter")
        self.git("config", "filter.sentinel=key.clean", shlex.quote(sys.executable) + " " + shlex.quote(str(helper)))
        (self.repo / "auth.py").write_text("def is_admin(user):\n    return None\n")
        self.git("status", "--porcelain")
        self.assertTrue(sentinel.exists())
        sentinel.unlink()
        self.assert_error(self.invoke(extra=("--check",)), "invalid_git_target")
        self.assertFalse(sentinel.exists())

    def test_legacy_grafts_do_not_rewrite_merge_base(self):
        self.git("checkout", "-qb", "sibling", self.base)
        (self.repo / "sibling.txt").write_text("sibling change\n")
        self.git("add", "sibling.txt")
        self.git("commit", "-qm", "sibling branch")
        sibling = self.git("rev-parse", "HEAD").strip()
        graft = self.repo / ".git/info/grafts"
        graft.write_text(sibling + " " + self.head + "\n")
        wrong = subprocess.check_output(["git", "-C", str(self.repo), "merge-base", sibling, self.head],
                                        text=True, stderr=subprocess.DEVNULL).strip()
        self.assertEqual(wrong, self.head, "Fixture must hide the branch through its graft")
        contents = graft.read_bytes()
        result = self.invoke(request=dict(self.request, base=sibling, head=self.head))
        self.assertEqual(result.returncode, 0, result.stderr)
        scope = json.loads(result.stdout)["scope"]
        self.assertEqual(scope["merge_base"], self.base)
        self.assertFalse(scope["empty_diff"])
        self.assertEqual(graft.read_bytes(), contents)

    def test_shallow_history_with_successful_wrong_merge_base_is_rejected(self):
        (self.repo / "descendant.txt").write_text("descendant\n")
        self.git("add", "descendant.txt")
        self.git("commit", "-qm", "descendant")
        descendant = self.git("rev-parse", "HEAD").strip()
        tree = self.git("rev-parse", "HEAD^{tree}").strip()
        merge = self.git("commit-tree", tree, "-p", descendant, "-p", self.base,
                         "-m", "merge with redundant ancestor parent").strip()
        self.assertEqual(self.git("merge-base", self.head, merge).strip(), self.head)
        (self.repo / ".git/shallow").write_text(descendant + "\n")
        self.assertEqual(self.git("merge-base", self.head, merge).strip(), self.base,
                         "Fixture must return a unique but wrong merge base")
        request = dict(self.request, base=self.head, head=merge)
        for check in (False, True):
            with self.subTest(check_only=check):
                self.assert_error(self.invoke(request=request, extra=("--check",) if check else ()), "invalid_git_target")
                self.assertFalse(self.calls())

    @unittest.skipUnless(os.name == "posix", "POSIX PATH executable fixture")
    def test_target_git_cannot_shadow_installed_git_through_relative_path(self):
        sentinel = self.root / "repo-git-ran"
        executable = self.repo / "git"
        executable.write_text("#!/usr/bin/env python3\nimport pathlib\npathlib.Path(" + repr(str(sentinel)) + ").touch()\nraise SystemExit(99)\n")
        executable.chmod(0o700)
        env = {**self.env, "PATH": "." + os.pathsep + self.env["PATH"]}
        for cwd in (self.root, self.repo):
            with self.subTest(caller_directory=cwd):
                result = subprocess.run(self.argv(), input=json.dumps(self.request), cwd=cwd,
                                        text=True, capture_output=True, env=env, timeout=8)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(sentinel.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX PATH executable fixture")
    def test_default_codex_cannot_be_shadowed_by_repository_executable(self):
        sentinel = self.root / "repo-codex-ran"
        attacker = self.repo / "codex"
        attacker.write_text("#!/usr/bin/env python3\nimport pathlib\npathlib.Path(" + repr(str(sentinel)) + ").touch()\nraise SystemExit(99)\n")
        attacker.chmod(0o700)
        trusted_dir = self.root / "trusted-bin"
        trusted_dir.mkdir()
        trusted = trusted_dir / "codex"
        trusted.write_text(FAKE_CODEX); trusted.chmod(0o700)
        env = {**self.env, "PATH": os.pathsep.join([".", str(trusted_dir), self.env["PATH"]])}
        result = subprocess.run(self.argv()[:-2], input=json.dumps(self.request), cwd=self.repo,
                                text=True, capture_output=True, env=env, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(sentinel.exists())

    def test_deadline_applies_while_stdin_producer_keeps_pipe_open(self):
        process = subprocess.Popen([*self.argv(), "--timeout", "1"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        started = time.monotonic()
        try:
            process.stdin.write(json.dumps(self.request)); process.stdin.flush()
            process.wait(timeout=4)
            self.assert_error(subprocess.CompletedProcess([], process.returncode, process.stdout.read(), process.stderr.read()), "timeout")
            self.assertLess(time.monotonic() - started, 4)
            self.assertFalse(self.calls())
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            try: process.stdin.close()
            except BrokenPipeError: pass
            process.stdout.close(); process.stderr.close()

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO input regression")
    def test_deadline_applies_when_request_fifo_has_no_writer(self):
        fifo = self.root / "request.fifo"
        os.mkfifo(fifo)
        argv = self.argv(); argv[argv.index("--request") + 1] = str(fifo)
        started = time.monotonic()
        result = subprocess.run([*argv, "--timeout", "1"], capture_output=True, text=True, env=self.env, timeout=4)
        self.assert_error(result, "timeout")
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(self.calls())

    def test_committed_gitlink_diff_overrides_ignore_submodules(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.base + ",dependency")
        self.git("commit", "-qm", "initial gitlink")
        base = self.git("rev-parse", "HEAD").strip()
        self.git("update-index", "--cacheinfo", "160000," + self.head + ",dependency")
        self.git("commit", "-qm", "update gitlink")
        head = self.git("rev-parse", "HEAD").strip()
        self.git("config", "diff.ignoreSubmodules", "all")
        self.assertEqual(self.git("diff", "--name-only", base, head).strip(), "")
        result = self.invoke(request=dict(self.request, base=base, head=head))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["scope"]["empty_diff"])

    def test_isolated_global_copy_with_bundled_profile(self):
        installed = self.root / "global/skills/codex-branch-review"
        shutil.copytree(SKILL, installed)
        shutil.copy2(PROFILE, installed / "references" / PROFILE.name)
        result = self.invoke(script=installed / "scripts/review_bridge.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["model_requested"], MODEL)

    def test_missing_or_unsafe_paired_profile_fails(self):
        self.assert_error(self.invoke(extra=("--profile-file", str(self.root / "missing.toml"))), "invalid_profile")
        bad = self.root / "bad.toml"
        bad.write_text(PROFILE.read_text().replace('model = "gpt-6.1-sol"', 'model = "other-model"'))
        self.assert_error(self.invoke(extra=("--profile-file", str(bad))), "invalid_profile")

    def test_git_replacement_refs_cannot_hide_the_diff(self):
        tree = self.git("rev-parse", self.base + "^{tree}").strip()
        replacement = self.git("commit-tree", tree, "-p", self.base, "-m", "replacement").strip()
        self.git("replace", self.head, replacement)
        self.assertEqual(self.git("diff", "--name-only", self.base, self.head), "")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["scope"]["empty_diff"])

    def test_inherited_git_environment_cannot_redirect_repository(self):
        other = self.root / "other-repo"
        shutil.copytree(self.repo, other)
        self.env.update(GIT_DIR=str(other / ".git"), GIT_WORK_TREE=str(other),
                        GIT_INDEX_FILE=str(self.root / "wrong-index"), GIT_CONFIG_COUNT="1",
                        GIT_CONFIG_KEY_0="core.fsmonitor", GIT_CONFIG_VALUE_0="/missing-helper")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["scope"]["repo"], str(self.repo))

    def test_event_stream_is_bounded(self):
        self.assert_error(self.invoke(mode="flood"), "output_limit")

    def test_repo_configuration_cannot_be_temp_launch_root(self):
        (self.root / ".codex").mkdir()
        (self.root / ".codex/config.toml").write_text('model="other-model"\n')
        self.assert_error(self.invoke(), "unsafe_temp_dir")


class ProcessDeadlineTests(unittest.TestCase):
    def test_windows_python311_pathext_discovery_in_absolute_directories(self):
        spec = importlib.util.spec_from_file_location("windows_lookup_bridge", SCRIPT)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "git.exe").touch(); (root / "codex.cmd").touch()
            looked_up = []
            def python311_direct_path_lookup(command):
                # Emulate 3.11's directory-qualified fast path and Windows'
                # case-insensitive filesystem; no automatic suffix expansion.
                candidate = Path(command)
                self.assertTrue(candidate.is_absolute())
                self.assertEqual(candidate.parent, root)
                looked_up.append(candidate.name)
                candidate = candidate.with_name(candidate.name.lower())
                return str(candidate) if candidate.is_file() else None
            env = {"PATH": os.pathsep.join([".", str(root)]), "PATHEXT": ".EXE;.CMD"}
            with patch.object(bridge, "_WINDOWS", True), patch.dict(os.environ, env), \
                 patch.object(bridge.shutil, "which", python311_direct_path_lookup):
                self.assertEqual(bridge.implicit_binary("git"), str(root / "git.exe"))
                self.assertEqual(bridge.implicit_binary("codex"), str(root / "codex.cmd"))
            self.assertIn("git.EXE", looked_up)
            self.assertIn("codex.CMD", looked_up)

    @unittest.skipUnless(os.name == "nt", "Native Windows executable lookup regression")
    def test_native_windows_executable_suffix_lookup(self):
        spec = importlib.util.spec_from_file_location("native_windows_bridge", SCRIPT)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"PATH": tmp, "PATHEXT": ".EXE;.CMD"}):
            root = Path(tmp)
            (root / "git.exe").touch(); (root / "codex.cmd").touch()
            self.assertEqual(Path(bridge.implicit_binary("git")).name.lower(), "git.exe")
            self.assertEqual(Path(bridge.implicit_binary("codex")).name.lower(), "codex.cmd")

    def test_large_stdin_deadline_without_child_reads(self):
        # Uses the Python executable directly, so this regression can also run
        # on Windows without relying on executable shebang support.
        spec = importlib.util.spec_from_file_location("deadline_bridge", SCRIPT)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        children = []
        original = subprocess.Popen
        def capture(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge.subprocess, "Popen", capture):
            started = time.monotonic()
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.run([sys.executable, "-c", "import time; time.sleep(30)"],
                           cwd=Path(tmp), deadline=started + .5, stdin="x" * (1024 * 1024))
            self.assertEqual(caught.exception.code, "timeout")
            self.assertLess(time.monotonic() - started, 4)
            self.assertTrue(children and all(child.poll() is not None for child in children))
            self.assertFalse(bridge._ACTIVE)


if __name__ == "__main__":
    unittest.main()
