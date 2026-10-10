"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_feedback_contract.py'.

tests/fixtures/feedback/ holds the cases that both feedback validators must agree on. browser_review.unit.cjs runs the
same files through the page's assets/feedback.js.
"""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/review-canvas/scripts/feedback_contract.py"
FIXTURES = ROOT / "tests/fixtures/feedback"
SPEC = importlib.util.spec_from_file_location("feedback_contract", SCRIPT)
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


class SharedFixtureTests(unittest.TestCase):
    def test_fixture_set_covers_both_outcomes(self):
        self.assertGreaterEqual(len(list(FIXTURES.glob("valid-*.json"))), 5)
        self.assertGreaterEqual(len(list(FIXTURES.glob("invalid-*.json"))), 40)

    def test_valid_fixtures_pass(self):
        for path in sorted(FIXTURES.glob("valid-*.json")):
            with self.subTest(fixture=path.name):
                raw = path.read_bytes()
                self.assertEqual(contract.parse_feedback(raw), json.loads(raw))

    def test_invalid_fixtures_fail_for_their_own_reason(self):
        # expected-errors.json names the message each fixture must produce in both validators; null means a JSON
        # syntax error, whose wording differs by language.
        expected = json.loads((FIXTURES / "expected-errors.json").read_text())
        self.assertEqual(sorted(expected), sorted(path.name for path in FIXTURES.glob("invalid-*.json")))
        for name, message in expected.items():
            with self.subTest(fixture=name), self.assertRaises(contract.FeedbackError) as caught:
                contract.parse_feedback((FIXTURES / name).read_bytes())
            if message is None:
                self.assertTrue(str(caught.exception).startswith("Feedback is not valid UTF-8 JSON"), str(caught.exception))
            else:
                self.assertEqual(str(caught.exception), message)

    def test_old_versions_name_the_version(self):
        for name, version in (("invalid-version-2.json", "2"), ("invalid-version-1-pr-object.json", "1")):
            with self.assertRaisesRegex(contract.FeedbackError, f"version {version} is not supported"):
                contract.parse_feedback((FIXTURES / name).read_bytes())


class LimitTests(unittest.TestCase):
    def base(self):
        return json.loads((FIXTURES / "valid-pr.json").read_bytes())

    def test_size_and_text_budget(self):
        with self.assertRaisesRegex(contract.FeedbackError, "8 MiB"):
            contract.parse_feedback(b" " * (contract.MAX_BYTES + 1))
        value = self.base()
        value["comments"] = [dict(value["comments"][0], id=str(i), body="x" * 20000) for i in range(110)]
        with self.assertRaisesRegex(contract.FeedbackError, "budget"):
            contract.validate_feedback(value)

    def test_files_are_read_only_up_to_the_limit(self):
        handle = unittest.mock.MagicMock()
        handle.__enter__.return_value.read.return_value = b"x" * (contract.MAX_BYTES + 1)
        with unittest.mock.patch.object(contract.Path, "open", return_value=handle), \
                self.assertRaisesRegex(contract.FeedbackError, "exceeds 8 MiB"):
            contract.read_feedback("feedback.json")
        handle.__enter__.return_value.read.assert_called_once_with(contract.MAX_BYTES + 1)

    def test_utf16_units(self):
        self.assertEqual(contract.units("a🙂"), 3)
        self.assertEqual(contract.units("é"), 1)

    def test_identity(self):
        value = self.base()
        snapshot = {"target": value["target"], "input_sha256": "9" * 64}
        contract.check_identity(value, snapshot)
        other = dict(snapshot, target=dict(value["target"], url="https://github.com/other/repo/pull/2"))
        with self.assertRaisesRegex(contract.FeedbackError, "another review"):
            contract.check_identity(value, other)
        worktree = json.loads((FIXTURES / "valid-worktree.json").read_bytes())
        with self.assertRaisesRegex(contract.FeedbackError, "another review"):
            contract.check_identity(worktree, snapshot)
        moved = contract.snapshot_of(worktree)
        moved = dict(moved, target=dict(moved["target"], root="/elsewhere"))
        with self.assertRaises(contract.FeedbackError):
            contract.check_identity(worktree, moved)


class CommandLineTests(unittest.TestCase):
    def test_reports_approval_states_against_an_input(self):
        fixtures = ROOT / "tests/fixtures"
        result = subprocess.run([sys.executable, str(SCRIPT), str(fixtures / "worktree-feedback.json"), "--input", str(fixtures / "worktree-review-round2.json")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("an earlier snapshot of the same review", result.stdout)
        self.assertIn("2 approved", result.stdout)
        self.assertIn("1 changed since approval: src/notes/store.py", result.stdout)

    def test_reports_whose_turn_each_thread_is(self):
        fixtures = ROOT / "tests/fixtures"
        result = subprocess.run([sys.executable, str(SCRIPT), str(fixtures / "worktree-feedback-round2.json"), "--input", str(fixtures / "worktree-review-round2.json")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 comments need your answer: fixture-comment-2 (reopened), fixture-comment-3 (replied)", result.stdout)
        self.assertIn("1 comment waits for the reviewer: fixture-comment-4 (answered: deferred)", result.stdout)
        self.assertIn("1 comment is resolved: fixture-comment-1 (resolved)", result.stdout)

    def test_thread_order_and_state(self):
        agent = [{"comment_id": "c", "id": "a", "actor": "agent", "created_at": "2026-10-10T10:00:00Z", "disposition": "fixed", "body": "x"}]
        comment = {"id": "c", "replies": [{"id": "r", "actor": "reviewer", "created_at": "2026-10-10T10:00:00.001Z", "action": "reopen", "body": "y"}]}
        self.assertEqual([reply["id"] for reply in contract.thread(comment, agent)], ["a", "r"])
        self.assertEqual(contract.thread_state(contract.thread(comment, agent)), ("agent", "reopened"))
        self.assertEqual(contract.thread_state(agent), ("reviewer", "answered: fixed"))
        self.assertEqual(contract.thread_state([]), ("agent", "open"))
        # A reviewer accept with no agent answer before it means earlier answers were not carried forward.
        self.assertEqual(contract.thread_state(contract.thread(comment, [])), ("agent", "earlier answers missing"))
        # An accept must follow an agent answer, and a reopen an answer or an accept; otherwise an answer was not carried.
        def reviewer(id_, action, minute):
            return {"id": id_, "actor": "reviewer", "created_at": f"2026-10-10T10:{minute:02d}:00Z", "action": action, "body": "" if action == "accept" else "z"}
        for actions, state in (((("accept", 1), ("reopen", 2)), ("agent", "reopened")), ((("reply", 1), ("reply", 2)), ("agent", "replied")),
                               ((("reopen", 1), ("accept", 2)), ("agent", "earlier answers missing")),
                               ((("reply", 1), ("reopen", 2)), ("agent", "earlier answers missing"))):
            with self.subTest(actions=actions):
                replies = agent + [reviewer(f"r{minute}", action, minute) for action, minute in actions]
                self.assertEqual(contract.thread_state(replies), state)

    def test_rejects_invalid_feedback_and_another_review(self):
        result = subprocess.run([sys.executable, str(SCRIPT), str(FIXTURES / "invalid-version-2.json")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("version 2 is not supported", result.stderr)
        result = subprocess.run([sys.executable, str(SCRIPT), str(FIXTURES / "valid-pr.json"), "--input", str(ROOT / "tests/fixtures/worktree-review.json")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("another review", result.stderr)


if __name__ == "__main__":
    unittest.main()
