"""Version-raise check against throwaway Git repositories."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CHECK = Path(__file__).resolve().parent / 'check_skill_versions.py'
ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
       'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}


def skill(name, version='"1.0.0"'):
    metadata = f'metadata:\n  version: {version}\n' if version is not None else ''
    return f'---\nname: {name}\ndescription: Test skill.\n{metadata}---\n\n# {name}\n'


class SkillVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        self.write('skills/alpha/SKILL.md', skill('alpha'))
        self.write('skills/alpha/references/notes.md', 'Notes.\n')
        self.write('host-skills/claude-code/beta/SKILL.md', skill('beta'))
        self.write('README.md', 'Readme.\n')
        self.commit()
        self.git('switch', '-q', '-c', 'change')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        subprocess.run(('git', *args), cwd=self.root, env=ENV, check=True, capture_output=True)

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'change')

    def check(self, cwd=None):
        return subprocess.run((sys.executable, str(CHECK), '--base', 'main'), cwd=cwd or self.root,
                              env=ENV, capture_output=True, text=True)

    def assertPasses(self, cwd=None):
        result = self.check(cwd)
        self.assertEqual(result.returncode, 0, result.stderr)

    def assertFails(self, message):
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(message, result.stderr)

    def test_unchanged_skills_and_other_files_pass(self):
        self.write('README.md', 'Changed readme.\n')
        self.commit()
        self.assertPasses()

    def test_changed_file_without_raise_fails(self):
        self.write('skills/alpha/references/notes.md', 'Changed notes.\n')
        self.commit()
        self.assertFails('skills/alpha/ changed since')

    def test_uncommitted_and_untracked_changes_count(self):
        self.write('skills/alpha/references/new.md', 'Untracked.\n')
        self.assertFails('raise metadata.version above 1.0.0')

    def test_host_skill_change_without_raise_fails(self):
        self.write('host-skills/claude-code/beta/SKILL.md', skill('beta') + 'More.\n')
        self.assertFails('host-skills/claude-code/beta/SKILL.md')

    def test_raised_version_passes(self):
        for version in ('"1.0.1"', '"1.1.0"', '"2.0.0"'):
            self.write('skills/alpha/SKILL.md', skill('alpha', version) + 'More.\n')
            self.assertPasses()

    def test_lowered_version_fails(self):
        self.write('skills/alpha/SKILL.md', skill('alpha', '"0.9.9"'))
        self.assertFails('raise metadata.version above 1.0.0')

    def test_invalid_or_missing_version_fails_even_when_unchanged(self):
        for version, message in (('"1.0"', 'use a quoted "MAJOR.MINOR.PATCH" version'),
                                 ('1.0.1', 'use a quoted'), ('"01.0.0"', 'use a quoted'),
                                 (None, 'frontmatter has no metadata.version')):
            self.write('skills/alpha/SKILL.md', skill('alpha', version))
            self.commit()
            self.git('switch', '-q', '-C', 'main')
            self.git('switch', '-q', '-C', 'change')
            self.assertFails(message)

    def test_new_skill_needs_only_a_valid_version(self):
        self.write('skills/gamma/SKILL.md', skill('gamma', '"0.1.0"'))
        self.assertPasses()

    def test_first_versions_on_unversioned_base_pass(self):
        self.git('switch', '-q', 'main')
        self.write('skills/delta/SKILL.md', skill('delta', None))
        self.commit()
        self.git('switch', '-q', '-C', 'change')
        self.write('skills/delta/SKILL.md', skill('delta'))
        self.assertPasses()

    def test_runs_from_a_subdirectory(self):
        self.write('skills/alpha/SKILL.md', skill('alpha', '"1.0.1"'))
        self.assertPasses(cwd=self.root / 'skills/alpha')


if __name__ == '__main__':
    unittest.main()
