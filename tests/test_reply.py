"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_reply.py'."""

import contextlib
import datetime
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
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
        self.store = round2["files"][0]["fingerprint"]
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
                          fingerprint=self.store, now=early)
        self.assertEqual(added["created_at"], "2026-10-10T11:00:00.001Z")
        self.assertEqual(self.replies()[-1], added)
        thread = reply.feedback_contract.thread(next(c for c in json.loads(self.feedback.read_text())["comments"] if c["id"] == "fixture-comment-2"), self.replies())
        self.assertEqual(reply.feedback_contract.thread_state(thread), ("reviewer", "answered: fixed"))
        later = datetime.datetime(2026, 10, 10, 12, tzinfo=datetime.timezone.utc).timestamp()
        self.assertEqual(reply.add(self.input, self.feedback, "fixture-comment-3", "question", "Which zone?", now=later)["created_at"], "2026-10-10T12:00:00.000Z")

    def test_add_refuses_what_the_input_contract_refuses(self):
        cases = [
            (dict(comment_id="missing", disposition="question", body="?"), "no comment missing"),
            (dict(comment_id="fixture-comment-2", disposition="fixed", body="Done."), "fixed_in"),
            (dict(comment_id="fixture-comment-2", disposition="fixed", body="Done.", fingerprint="c" * 64), "no file .* has fingerprint"),
            (dict(comment_id="fixture-comment-2", disposition="deferred", body="Later."), "blocker"),
            (dict(comment_id="fixture-comment-2", disposition="rejected", body="No.", blocker="x"), "blocker"),
            # The reviewer accepted comment 1's answer; another answer would silently reopen it.
            (dict(comment_id="fixture-comment-1", disposition="question", body="?"), "resolved, so it is not the agent's turn"),
        ]
        for options, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                reply.add(self.input, self.feedback, options.pop("comment_id"), options.pop("disposition"), options.pop("body"), **options)
        self.assertEqual(self.replies(), [])

    def test_an_answer_waiting_for_the_reviewer_is_not_answered_again(self):
        reply.carry(self.previous, self.input)
        with self.assertRaisesRegex(ValueError, "answered: deferred and waits for the reviewer"):
            reply.add(self.input, self.feedback, "fixture-comment-4", "question", "Any news?")

    def test_carry_refuses_a_different_reply_under_the_same_id(self):
        different = dict(self.earlier[0], body="A rewritten answer.")
        review = json.loads(self.input.read_text())
        review["replies"] = [different]
        self.input.write_text(json.dumps(review))
        before = self.input.read_bytes()
        with self.assertRaisesRegex(ValueError, "already has different replies with these IDs: agent-reply-1"):
            reply.carry(self.previous, self.input)
        self.assertEqual(self.input.read_bytes(), before)

    def test_carry_refuses_another_review(self):
        other = json.loads(self.previous.read_text())
        other["target"]["root"] = "/home/dev/elsewhere"
        other_path = self.temp / "other-round.json"
        other_path.write_text(json.dumps(other))
        with self.assertRaisesRegex(ValueError, "belongs to another review"):
            reply.carry(other_path, self.input)
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

    def test_reply_writes_wait_for_a_render_in_progress(self):
        done = threading.Event()
        with reply.review_state.lock(self.state, "publish"):
            worker = threading.Thread(target=lambda: (reply.carry(self.previous, self.input), done.set()))
            worker.start()
            self.assertFalse(done.wait(0.3), "carry wrote while the round's publish lock was held")
        self.assertTrue(done.wait(10))
        self.assertEqual(len(self.replies()), 4)

    def test_an_input_past_the_size_limit_is_not_written(self):
        before = self.input.read_bytes()
        review = json.loads(before)
        review["replies"] = self.earlier
        size = len((json.dumps(review, ensure_ascii=False, indent=2) + "\n").encode())
        with unittest.mock.patch.object(reply.render_review, "MAX_INPUT_BYTES", size - 1):
            with self.assertRaisesRegex(ValueError, "would exceed"):
                reply.save_round_input(self.input, review)
        self.assertEqual(self.input.read_bytes(), before)

    def test_a_symlinked_rounds_directory_takes_the_real_lock(self):
        alias = self.temp / "alias"
        os.symlink(self.state / "rounds", alias)
        done = threading.Event()
        with reply.review_state.lock(self.state, "publish"):
            worker = threading.Thread(target=lambda: (reply.carry(self.previous, alias / self.round.name / "input.json"), done.set()))
            worker.start()
            self.assertFalse(done.wait(0.3), "carry through the alias took a different lock")
        self.assertTrue(done.wait(10))

    def test_the_last_representable_time_is_refused_cleanly(self):
        feedback = json.loads(self.feedback.read_text())
        comment = next(c for c in feedback["comments"] if c["id"] == "fixture-comment-3")
        comment["replies"][0]["created_at"] = "9999-12-31T23:59:59.999Z"
        late = self.temp / "late.json"
        late.write_text(json.dumps(feedback))
        with self.assertRaisesRegex(ValueError, "last representable time"):
            reply.add(self.input, late, "fixture-comment-3", "question", "Which zone?")

    def test_command_line(self):
        run = lambda *args: subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
        result = run("carry", "--from", str(self.previous), "--to", str(self.input))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Carried 4 agent replies", result.stdout)
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "fixture-comment-3",
                     "--disposition", "deferred", "--body", "Waiting on the date decision.", "--blocker", "Which zone notes use.")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"^Added deferred reply agent-[0-9a-f]{16} to comment fixture-comment-3 at ")
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "fixture-comment-2",
                     "--disposition", "fixed", "--body", "x", "--fixed-in-fingerprint", "c" * 64, "--fixed-in-commit", "e" * 40)
        self.assertEqual(result.returncode, 2)
        result = run("add", "--input", str(self.input), "--feedback", str(self.feedback), "--comment", "nope", "--disposition", "question", "--body", "?")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no comment nope", result.stderr)


if __name__ == "__main__":
    unittest.main()
