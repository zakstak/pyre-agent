"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_reply.py'."""

import contextlib
import datetime
import importlib.util
import io
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/review-canvas/scripts/reply.py"
FIXTURES = ROOT / "tests/fixtures"
SPEC = importlib.util.spec_from_file_location("reply", SCRIPT)
reply = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reply)


class ReplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp)
        self.state = self.temp / "state"
        self.round = reply.review_state.new_round(self.state)
        self.input = self.round / "input.json"
        round2 = json.loads((FIXTURES / "worktree-review-round2.json").read_text())
        self.earlier = round2.pop("replies")
        self.input.write_text(json.dumps(round2))
        self.previous = self.temp / "previous.json"
        self.previous.write_text((FIXTURES / "worktree-review-round2.json").read_text())
        self.feedback = FIXTURES / "worktree-feedback-round2.json"

    def replies(self):
        return json.loads(self.input.read_text()).get("replies", [])

    def test_carry_copies_earlier_replies_once(self):
        self.assertEqual(reply.carry(self.previous, self.input), 4)
        self.assertEqual(self.replies(), self.earlier)
        self.assertEqual(reply.carry(self.previous, self.input), 0)
        self.assertEqual(stat.S_IMODE(self.input.stat().st_mode), 0o600)

    def test_add_sorts_after_a_reviewer_reply_from_a_clock_that_ran_ahead(self):
        reply.carry(self.previous, self.input)
        # The reviewer's reply to comment 2 is stamped 11:00; this machine's clock says 08:00.
        early = datetime.datetime(2026, 10, 10, 8, tzinfo=datetime.timezone.utc).timestamp()
        added = reply.add(self.input, self.feedback, "fixture-comment-2", "fixed", "The CLI now reports a missing file.",
                          fingerprint="c" * 64, now=early)
        self.assertEqual(added["created_at"], "2026-10-10T11:00:00.001Z")
        self.assertEqual(self.replies()[-1], added)
        thread = reply.feedback_contract.thread(next(c for c in json.loads(self.feedback.read_text())["comments"] if c["id"] == "fixture-comment-2"), self.replies())
        self.assertEqual(reply.feedback_contract.thread_state(thread), ("reviewer", "answered: fixed"))
        later = datetime.datetime(2026, 10, 10, 12, tzinfo=datetime.timezone.utc).timestamp()
        self.assertEqual(reply.add(self.input, self.feedback, "fixture-comment-3", "question", "Which zone?", now=later)["created_at"], "2026-10-10T12:00:00.000Z")

    def test_add_refuses_what_the_input_contract_refuses(self):
        cases = [
            (dict(comment_id="missing", disposition="question", body="?"), "no comment missing"),
            (dict(comment_id="fixture-comment-1", disposition="fixed", body="Done."), "fixed_in"),
            (dict(comment_id="fixture-comment-1", disposition="deferred", body="Later."), "blocker"),
            (dict(comment_id="fixture-comment-1", disposition="rejected", body="No.", blocker="x"), "blocker"),
        ]
        for options, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                reply.add(self.input, self.feedback, options.pop("comment_id"), options.pop("disposition"), options.pop("body"), **options)
        self.assertEqual(self.replies(), [])

    def test_a_rendered_round_or_another_review_is_refused(self):
        other = json.loads((FIXTURES / "feedback/valid-pr.json").read_text())
        other_path = self.temp / "other.json"
        other["comments"][0]["id"] = "fixture-comment-1"
        other_path.write_text(json.dumps(other))
        with self.assertRaisesRegex(ValueError, "another review"):
            reply.add(self.input, other_path, "fixture-comment-1", "question", "?")
        (self.round / "review.html").write_text("rendered")
        for call in (lambda: reply.carry(self.previous, self.input), lambda: reply.add(self.input, self.feedback, "fixture-comment-3", "question", "?")):
            with self.assertRaisesRegex(ValueError, "never changes after it renders"):
                call()

    def test_command_line(self):
        run = lambda *args: subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
        result = run("carry", "--from", str(self.previous), "--to", str(self.input))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Carried 4 agent replies", result.stdout)
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "fixture-comment-4",
                     "--disposition", "deferred", "--body", "Still waiting.", "--blocker", "The encoding decision.")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"^Added deferred reply agent-[0-9a-f]{16} to comment fixture-comment-4 at ")
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "fixture-comment-4",
                     "--disposition", "fixed", "--body", "x", "--fixed-in-fingerprint", "c" * 64, "--fixed-in-commit", "e" * 40)
        self.assertEqual(result.returncode, 2)
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "nope", "--disposition", "question", "--body", "?")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no comment nope", result.stderr)


if __name__ == "__main__":
    unittest.main()
