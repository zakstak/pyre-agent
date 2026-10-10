"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_review_renderer.py'."""

import base64
import copy
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/review-canvas/scripts/render_review.py"
EXAMPLE = ROOT / "skills/review-canvas/assets/example-review.json"
SPEC = importlib.util.spec_from_file_location("render_review", SCRIPT)
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


class Document(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.texts = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def handle_data(self, data):
        self.texts.append(data)


def simple_review():
    return {
        "schema_version": 1,
        "pr": {"title": "Example", "url": "https://github.com/example/project/pull/7"},
        "files": [{"path": "a.py", "status": "modified", "group": "core", "additions": 1,
                   "deletions": 1, "patch": "@@ -1,2 +1,2 @@\n-old\n+new\n context\n"}],
    }


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.review = simple_review()

    def test_example_and_all_files_survive_grouping(self):
        review = renderer.load_review(EXAMPLE)
        page = renderer.render_review(review)
        parsed = Document(page)
        headers = [a["id"] for t, a in parsed.tags if t == "h2" and a.get("id", "").startswith("group-")]
        self.assertEqual(headers, ["group-core", "group-wiring", "group-mechanical"])
        cards = [a["id"] for t, a in parsed.tags if t == "article"]
        self.assertEqual(cards, ["file-1", "file-2", "file-0"])
        text = "".join(parsed.texts)
        for file in review["files"]:
            self.assertIn(file["path"], text)
            for line in (file.get("patch") or "").splitlines():
                self.assertIn(line, parsed.texts)

    def test_input_is_text_in_every_context(self):
        payload = '</script><img src="https://evil.invalid/x" onerror="alert(1)"><svg/onload=alert(2)>&\''
        review = self.review
        review["pr"]["title"] = payload
        review["summary"] = payload
        file = review["files"][0]
        file.update(path=payload, summary=payload, patch=payload, pseudocode=payload,
                    trace={"input": payload, "before": payload, "after": payload},
                    callouts=[{"tag": payload, "text": payload}])
        page = renderer.render_review(review)
        parsed = Document(page)
        self.assertNotIn("<img", page)
        self.assertNotIn("<svg", page)
        self.assertEqual(sum(t == "script" for t, _ in parsed.tags), 1)
        self.assertEqual(sum(t == "style" for t, _ in parsed.tags), 1)
        self.assertIn(payload, parsed.texts)
        card = next(a for t, a in parsed.tags if t == "article")
        self.assertIn(payload, card["data-search"])
        metadata = next(a for _, a in parsed.tags if a.get("id") == "review-data")
        self.assertEqual(json.loads(metadata["data-review"])["pr"]["title"], payload)
        self.assertFalse(any(name.startswith("on") for _, attrs in parsed.tags for name in attrs))

    def test_csp_exact_hashes_and_no_remote_resources(self):
        page = renderer.render_review(self.review)
        parsed = Document(page)
        csp = next(a["content"] for t, a in parsed.tags if a.get("http-equiv") == "Content-Security-Policy")
        for tag in ("script", "style"):
            content = re.search(f"<{tag}>(.*?)</{tag}>", page, re.S)[1]
            digest = base64.b64encode(hashlib.sha256(content.encode()).digest()).decode()
            self.assertIn(f"{tag}-src 'sha256-{digest}'", csp)
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'none'", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertFalse(any("src" in a for _, a in parsed.tags))
        links = [a for t, a in parsed.tags if t == "a" and a.get("href", "").startswith("https:")]
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["rel"], "noopener noreferrer")

    def test_missing_null_empty_patch_warns_including_mechanical(self):
        for patch in (None, "", "missing"):
            review = copy.deepcopy(self.review)
            file = review["files"][0]
            file["group"] = "mechanical"
            if patch == "missing":
                del file["patch"]
            else:
                file["patch"] = patch
            page = renderer.render_review(review)
            self.assertIn("Patch unavailable.", page)
            self.assertIn("1 missing patch<", page)

    def test_incomplete_patch_retained_and_warns(self):
        self.review["files"][0]["patch_complete"] = False
        page = renderer.render_review(self.review)
        self.assertIn("Patch marked incomplete.", page)
        self.assertIn("+new", page)

    def test_omitted_patch_completeness_warns(self):
        self.review["files"][0]["patch"] = "+possibly just one excerpt"
        page = renderer.render_review(self.review)
        self.assertIn("Patch completeness unverified", page)
        self.assertIn("1 unverified patch<", page)

    def test_line_numbers_multiple_hunks_and_markers(self):
        output = renderer._patch_html("@@ -2,2 +5,2 @@\n-old\n+new\n same\n\\ No newline at end of file\n@@ -20 +30 @@\n-a\n+b\n")
        self.assertIn('class="line-number">2</td><td class="line-number"></td>', output)
        self.assertIn('class="line-number"></td><td class="line-number">5</td>', output)
        self.assertIn('class="line-number">3</td><td class="line-number">6</td>', output)
        self.assertIn('class="line-number">20</td>', output)
        self.assertIn('class="line-number">30</td>', output)
        self.assertIn("\\ No newline at end of file", output)

    def test_unsupported_or_hostile_hunk_still_renders(self):
        patch = "@@ -" + "1" * 6000 + " +3 @@\nraw\u2028line\n+last"
        self.review["files"][0]["patch"] = patch
        page = renderer.render_review(self.review)
        self.assertIn("raw\u2028line", page)
        self.assertIn("+last", page)

    def test_completion_default_is_unverified(self):
        page = renderer.render_review(self.review)
        self.assertIn("File list completeness is unverified", page)
        self.assertIn("No commit snapshot supplied", page)
        self.review["pr"]["changed_files"] = 4
        self.assertIn("1 supplied / 4 declared changed files", renderer.render_review(self.review))

    def test_complete_list_matches_count_but_not_patch_guarantee(self):
        self.review["files_complete"] = True
        self.review["pr"]["changed_files"] = 1
        page = renderer.render_review(self.review)
        self.assertIn("File list marked complete", page)
        self.assertIn("patch completeness are not independently verified", page)

    def test_deterministic_html_and_metadata_fingerprint(self):
        page = renderer.render_review(self.review)
        self.assertEqual(page, renderer.render_review(self.review))
        metadata = json.loads(next(a["data-review"] for _, a in Document(page).tags if a.get("id") == "review-data"))
        original = metadata["input_sha256"]
        self.review["files"][0]["patch"] += "+another\n"
        updated = json.loads(next(a["data-review"] for _, a in Document(renderer.render_review(self.review)).tags if a.get("id") == "review-data"))
        self.assertNotEqual(original, updated["input_sha256"])
        self.assertNotIn("patch", metadata["files"][0])

    def test_empty_review_is_honest(self):
        self.review["files"] = []
        self.assertIn("No changed files supplied", renderer.render_review(self.review))


class ValidationTests(unittest.TestCase):
    def test_bad_pr_links(self):
        for url in ("javascript:alert(1)", "http://github.com/a/b/pull/1", "https://github.com.evil/a/b/pull/1",
                    "https://user@github.com/a/b/pull/1", "https://github.com:443/a/b/pull/1",
                    "https://github.com/a/b/pull/0", "https://github.com/a/b/pull/1?x=y", "https://github.com/a/b/pull/1\n"):
            with self.subTest(url=url), self.assertRaises(renderer.ValidationError):
                review = simple_review()
                review["pr"]["url"] = url
                renderer.validate_review(review)

    def test_invalid_fields(self):
        cases = [
            ("review", "schema_version", True), ("review", "schema_version", 2),
            ("review", "files_complete", 1), ("review", "surprise", "unexpected"),
            ("pr", "title", ""), ("pr", "head_sha", "short"), ("pr", "base_sha", "z" * 40),
            ("pr", "changed_files", True), ("pr", "changed_files", -1),
            ("file", "path", ""), ("file", "path", "bad\x00path"), ("file", "path", "bad\ud800path"),
            ("file", "additions", True), ("file", "deletions", -1), ("file", "additions", 1.5),
            ("file", "group", "unknown"), ("file", "group", []), ("file", "status", {}),
            ("file", "patch_complete", "true"), ("file", "patch", []),
            ("file", "callouts", [{"tag": "T", "text": "T", "url": "https://x"}]),
            ("file", "trace", {"input": "x", "before": "y"}),
        ]
        for target, key, value in cases:
            with self.subTest(target=target, key=key, value=repr(value)), self.assertRaises(renderer.ValidationError):
                review = simple_review()
                obj = {"review": review, "pr": review["pr"], "file": review["files"][0]}[target]
                obj[key] = value
                renderer.validate_review(review)

    def test_missing_fields_and_duplicate_files(self):
        for key in ("path", "status", "group", "additions", "deletions"):
            review = simple_review()
            del review["files"][0][key]
            with self.assertRaises(renderer.ValidationError):
                renderer.validate_review(review)
        review = simple_review()
        review["files"].append(copy.deepcopy(review["files"][0]))
        with self.assertRaisesRegex(renderer.ValidationError, "duplicate file path"):
            renderer.validate_review(review)

    def test_false_completeness_claims_rejected(self):
        for count in (None, 0, 2):
            review = simple_review()
            review["files_complete"] = True
            if count is not None:
                review["pr"]["changed_files"] = count
            with self.assertRaisesRegex(renderer.ValidationError, "matching"):
                renderer.validate_review(review)

    def test_invalid_json_duplicate_keys_and_nonfinite_values(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "review.json"
            for raw in ('{"schema_version":1,"schema_version":1}', '{"x": NaN}', '{"x": Infinity}', '[invalid]', '"\ud800"'):
                path.write_text(raw, encoding="utf-8", errors="surrogatepass")
                with self.assertRaises(renderer.ValidationError):
                    renderer.load_review(path)

    def test_resource_limits(self):
        review = simple_review()
        review["files"][0]["patch"] = "x" * (renderer.MAX_PATCH_CHARS + 1)
        with self.assertRaisesRegex(renderer.ValidationError, "exceeds"):
            renderer.validate_review(review)
        review = simple_review()
        review["files"] = [{}] * (renderer.MAX_FILES + 1)
        with self.assertRaises(renderer.ValidationError):
            renderer.validate_review(review)

    def test_line_amplification_limits_do_not_silently_truncate(self):
        review = simple_review()
        review["files"][0]["patch"] = "\n" * 4
        with patch.object(renderer, "MAX_PATCH_LINES", 3):
            with self.assertRaisesRegex(renderer.ValidationError, "nothing was truncated"):
                renderer.validate_review(review)
        with patch.object(renderer, "MAX_PATCH_LINES", 4):
            renderer.validate_review(review)
        review["files"].append(dict(review["files"][0], path="b.py"))
        with patch.object(renderer, "MAX_TOTAL_PATCH_LINES", 7):
            with self.assertRaisesRegex(renderer.ValidationError, "total supplied lines"):
                renderer.validate_review(review)

    def test_example_hunk_counts_are_accurate(self):
        for file in renderer.load_review(EXAMPLE)["files"]:
            if not file.get("patch"):
                continue
            lines = file["patch"].splitlines()
            match = re.match(r"@@ -\d+,(\d+) \+\d+,(\d+) @@", lines[0])
            self.assertIsNotNone(match)
            self.assertEqual(int(match[1]), sum(line.startswith((" ", "-")) for line in lines[1:]))
            self.assertEqual(int(match[2]), sum(line.startswith((" ", "+")) for line in lines[1:]))

    def test_cli_output_and_invalid_input_does_not_touch_output(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "review.html"
            result = subprocess.run([sys.executable, str(SCRIPT), str(EXAMPLE), "-o", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            before = output.read_bytes()
            invalid = Path(temp) / "invalid.json"
            invalid.write_text('{"schema_version": 2}')
            result = subprocess.run([sys.executable, str(SCRIPT), str(invalid), "-o", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(before, output.read_bytes())
            result = subprocess.run([sys.executable, str(SCRIPT), str(invalid), "-o", str(invalid)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("must be different", result.stderr)

    def test_output_cannot_overwrite_hard_linked_input(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "review.json"
            source.write_text(json.dumps(simple_review()), encoding="utf-8")
            original = source.read_bytes()
            alias = Path(temp) / "review.html"
            os.link(source, alias)
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), "-o", str(alias)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("must be different", result.stderr)
            self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
