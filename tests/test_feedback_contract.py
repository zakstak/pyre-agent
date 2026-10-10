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
