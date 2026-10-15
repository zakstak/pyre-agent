"""Exercise incomplete distributions rather than matching instruction wording."""

import shutil
import tempfile
import unittest
from pathlib import Path

from tests.check_skill_package import ROOT, graph_markdown, package_errors


class SkillPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pyre-skill-package-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("README.md", "LICENSE"):
            shutil.copyfile(ROOT / name, self.root / name)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_source_package_is_complete(self):
        self.assertEqual(package_errors(ROOT), [])

    def test_reference_cycle_is_valid_but_missing_companion_is_rejected(self):
        self.write("skills/first/SKILL.md", "[second](../second/SKILL.md)")
        second = self.write("skills/second/SKILL.md", "[first](../first/SKILL.md)")
        self.assertEqual(package_errors(self.root), [])
        second.unlink()
        self.assertEqual(
            package_errors(self.root),
            ["skills/first/SKILL.md: missing packaged file ../second/SKILL.md"],
        )

    def test_companions_referenced_from_supporting_instructions_are_required(self):
        self.write("skills/first/SKILL.md", "[patterns](references/patterns.md)")
        self.write(
            "skills/first/references/patterns.md", "[second](../../second/SKILL.md)"
        )
        self.assertEqual(len(package_errors(self.root)), 1)
        self.write("skills/second/SKILL.md", "# Second")
        self.assertEqual(package_errors(self.root), [])

    def test_actual_typescript_group_requires_transitive_companions(self):
        names = (
            "typescript-best-practices",
            "principle-type-system-discipline",
            "principle-boundary-discipline",
            "principle-encode-lessons-in-structure",
            "correct",
        )
        for name in names:
            shutil.copytree(ROOT / "skills" / name, self.root / "skills" / name)
        self.assertEqual(package_errors(self.root), [])
        patterns = self.root / "skills/typescript-best-practices/references/patterns.md"
        saved_patterns = patterns.read_text()
        patterns.unlink()
        self.assertTrue(
            any("references/patterns.md" in e for e in package_errors(self.root))
        )
        patterns.write_text(saved_patterns)
        shutil.rmtree(self.root / "skills/principle-encode-lessons-in-structure")
        self.assertTrue(
            any(
                "principle-encode-lessons-in-structure" in e
                for e in package_errors(self.root)
            )
        )

    def test_build_only_companion_is_required(self):
        self.write("skills/review-canvas/SKILL.md", "# Canvas")
        self.assertEqual(
            package_errors(self.root),
            [
                "skills/review-canvas/SKILL.md: missing build companion skills/internal-visual-style/SKILL.md"
            ],
        )
        self.assertIn("`internal-visual-style`", graph_markdown(self.root))
        self.write("skills/internal-visual-style/SKILL.md", "# Style")
        self.assertEqual(package_errors(self.root), [])

    def test_readme_carries_the_generated_companion_graph(self):
        readme = (ROOT / "README.md").read_text()
        start = "<!-- companion-skills:start -->\n"
        end = "<!-- companion-skills:end -->"
        self.assertEqual(readme.count(start), 1)
        self.assertEqual(readme.count(end), 1)
        section = readme.split(start)[1].split(end)[0]
        self.assertEqual(section, graph_markdown(ROOT))

    def test_graph_lists_transitive_companions_nearest_first(self):
        self.write("skills/first/SKILL.md", "[second](../second/SKILL.md)")
        self.write("skills/second/SKILL.md", "[third](../third/SKILL.md)")
        self.write("skills/third/SKILL.md", "[first](../first/SKILL.md)")
        self.write("skills/alone/SKILL.md", "# Alone")
        self.assertEqual(
            graph_markdown(self.root),
            "- `first` needs `second` and `third`.\n"
            "- `second` needs `third` and `first`.\n"
            "- `third` needs `first` and `second`.\n",
        )

    def test_host_specific_references_are_checked(self):
        self.write(
            "host-skills/claude-code/review/SKILL.md",
            "[contract](references/contract.md)",
        )
        self.assertEqual(len(package_errors(self.root)), 1)
        self.write("host-skills/claude-code/review/references/contract.md", "Contract")
        self.assertEqual(package_errors(self.root), [])

    def test_urls_and_fragments_do_not_need_local_files(self):
        self.write(
            "skills/first/SKILL.md",
            "[web](https://example.invalid/no-file) [message](mailto:dev@example.invalid) "
            "[heading](#heading) [local](references/file%20name.md#section)",
        )
        self.write("skills/first/references/file name.md", "# Section")
        self.assertEqual(package_errors(self.root), [])

    def test_file_outside_package_cannot_supply_a_missing_resource(self):
        with tempfile.TemporaryDirectory(prefix="pyre-outside-package-") as temp:
            external = Path(temp) / "resource.md"
            external.write_text("Resource")
            self.write("skills/first/SKILL.md", "[resource](resource.md)")
            (self.root / "skills/first/resource.md").symlink_to(external)
            self.assertEqual(len(package_errors(self.root)), 2)

    def test_empty_package_is_rejected(self):
        self.assertEqual(package_errors(self.root), ["No skill entrypoints found"])

    def test_root_credits_are_required_for_an_original_skill_subset(self):
        self.write("skills/original/SKILL.md", "# Original")
        (self.root / "README.md").unlink()
        self.assertEqual(
            package_errors(self.root), ["README.md: missing redistribution credits"]
        )

    def test_mit_permission_and_upstream_copyright_must_travel_with_skills(self):
        self.write("skills/technical-writing/SKILL.md", "# Writing")
        (self.root / "LICENSE").unlink()
        self.assertEqual(len(package_errors(self.root)), 3)
        shutil.copyfile(ROOT / "LICENSE", self.root / "LICENSE")
        (self.root / "README.md").write_text("Credits omitted")
        self.assertEqual(
            package_errors(self.root), ["README.md: missing pstack copyright notice"]
        )
        self.write("skills/review-canvas/SKILL.md", "# Canvas")
        self.write("skills/internal-visual-style/SKILL.md", "# Style")
        self.assertEqual(len(package_errors(self.root)), 2)


if __name__ == "__main__":
    unittest.main()
