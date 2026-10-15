"""Shape check against throwaway skill packages, one passing and one failing case per rule."""

import tempfile
import unittest
from pathlib import Path

from tests.check_skill_shape import ROOT, shape_errors

USE_WHEN = "Use when a test needs a skill. Does nothing else."
BY_NAME = "Invoke only by name. Does nothing else."


def frontmatter(description, name="alpha", by_name=False, quoted=True):
    if quoted:
        description = f'"{description}"'
    invocation = "disable-model-invocation: true\n" if by_name else ""
    return (
        f"---\n{invocation}name: {name}\ndescription:\n  {description}\n"
        f'metadata:\n  version: "1.0.0"\n---\n'
    )


SHORT_LINE = "A short line.\n"
LONG_LINE = ("word " * 20).rstrip() + "\n"


class SkillShapeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-skill-shape-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def skill(self, body=SHORT_LINE, description=USE_WHEN, name="alpha", **options):
        return self.write(
            f"skills/{name}/SKILL.md",
            frontmatter(description, name=name, **options) + "\n" + body,
        )

    def test_real_repository_passes(self):
        self.assertEqual(shape_errors(ROOT), [])

    def test_empty_root_is_reported(self):
        self.assertEqual(shape_errors(self.root), ["No skill entrypoints found"])

    # Rule 1: description budget and opening.

    def test_description_within_budget_passes(self):
        self.skill(description=USE_WHEN)
        self.skill(description="Use for a second kind of test.", name="beta")
        self.skill(description=BY_NAME, name="gamma", by_name=True)
        self.skill(description=BY_NAME, name="delta", by_name=True, quoted=False)
        self.assertEqual(shape_errors(self.root), [])

    def test_description_over_budget_fails(self):
        self.skill(description=USE_WHEN + " More words." * 25)
        self.skill(description=BY_NAME + " More words." * 8, name="beta", by_name=True)
        errors = shape_errors(self.root)
        self.assertEqual(len(errors), 2)
        self.assertRegex(
            errors[0],
            r"^skills/alpha/SKILL.md:3: description is \d+ characters; the budget is 250$",
        )
        self.assertRegex(
            errors[1],
            r"^skills/beta/SKILL.md:4: description is \d+ characters; the budget is 120$",
        )

    def test_description_with_wrong_opening_fails(self):
        self.skill(description="Apply when a test needs a skill.")
        self.skill(description=USE_WHEN, name="beta", by_name=True)
        self.assertEqual(
            shape_errors(self.root),
            [
                "skills/alpha/SKILL.md:3: description must start with 'Use when' or 'Use for'",
                "skills/beta/SKILL.md:4: description must start with 'Invoke only by name.'",
            ],
        )

    def test_multiline_description_is_joined_on_single_spaces(self):
        wrapped = '"Use when a test needs a skill.\n  Does nothing   else,\n  at all."'
        self.skill(description=wrapped, quoted=False)
        self.assertEqual(shape_errors(self.root), [])

    def test_missing_description_or_frontmatter_fails(self):
        self.write(
            "skills/alpha/SKILL.md",
            '---\nname: alpha\nmetadata:\n  version: "1.0.0"\n---\n',
        )
        self.write("skills/beta/SKILL.md", "# beta\n")
        self.assertEqual(
            shape_errors(self.root),
            [
                "skills/alpha/SKILL.md:1: frontmatter has no description",
                "skills/beta/SKILL.md:1: SKILL.md has no frontmatter",
            ],
        )

    # Rule 2: body budget.

    def test_body_within_budget_passes(self):
        self.skill(body=SHORT_LINE * 300, name="principle-alpha")
        self.skill(body=SHORT_LINE * 900, name="beta")
        self.write("skills/beta/references/long.md", SHORT_LINE * 2000)
        self.assertEqual(shape_errors(self.root), [])

    def test_body_over_budget_fails(self):
        self.skill(body=SHORT_LINE * 400, name="principle-alpha")
        self.skill(body=SHORT_LINE * 1100, name="beta")
        self.assertEqual(
            shape_errors(self.root),
            [
                "skills/beta/SKILL.md:8: body is 15,401 bytes; the budget is 14,000",
                "skills/principle-alpha/SKILL.md:8: body is 5,601 bytes; the budget is 5,000",
            ],
        )

    # Rule 3: overlong prose line.

    def test_long_lines_without_a_wrap_point_pass(self):
        url = "https://example.com/" + "a" * 90
        self.skill(
            body=(
                f"[a link]({url} with spaces)\n"
                f"Ends here `a code span {'x ' * 40}`\n"
                f"{'x' * 100}\n"
                f"| a table | {'x ' * 50}|\n"
                f"```\n{LONG_LINE}```\n"
            )
        )
        self.write(
            "skills/alpha/references/notes.md", f"---\n{LONG_LINE}---\n{SHORT_LINE}"
        )
        self.assertEqual(shape_errors(self.root), [])

    def test_wrappable_long_line_fails(self):
        self.skill(body=SHORT_LINE + LONG_LINE)
        self.write("skills/alpha/references/notes.md", f"`{'x' * 80}` and more words\n")
        self.assertEqual(
            shape_errors(self.root),
            [
                "skills/alpha/SKILL.md:10: line is 99 columns and has a space past 80; wrap it",
                "skills/alpha/references/notes.md:1: line is 97 columns and has a space past 80; wrap it",
            ],
        )

    # Rule 4: lowercase paragraph after a fence.

    def test_capitalised_paragraph_after_a_fence_passes(self):
        self.skill(
            body=(
                "```sh\necho hi\n```\n\nThe command prints.\n"
                "```\n```\n- a list item\n"
                "```\n```\n| a | table |\n"
                "```\ncode\n```\n  indented continuation of a list item\n"
                "````\n```\nnested fence\n```\n````\n\nDone.\n"
            )
        )
        self.assertEqual(shape_errors(self.root), [])

    def test_lowercase_paragraph_after_a_fence_fails(self):
        self.skill(body="Run this:\n\n```sh\necho hi\n```\n\nwhich prints.\n")
        self.assertEqual(
            shape_errors(self.root),
            [
                "skills/alpha/SKILL.md:15: lowercase paragraph after a fenced block; a sentence was cut in half",
            ],
        )


if __name__ == "__main__":
    unittest.main()
