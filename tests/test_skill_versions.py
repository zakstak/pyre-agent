"""Version-raise check against throwaway Git repositories."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CHECK = Path(__file__).resolve().parent / 'check_skill_versions.py'
HOOK = Path(__file__).resolve().parents[1] / '.githooks/pre-commit'
ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
       'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}


def skill(name, version='"1.0.0"', body=''):
    metadata = f'metadata:\n  version: {version}\n' if version is not None else ''
    return f'---\nname: {name}\ndescription: Test skill.\n{metadata}---\n\n# {name}\n{body}'


UNRELATED = ''.join(f'Step {number}: do a separate thing.\n' for number in range(20))


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

    def move(self, old, new):
        (self.root / new).parent.mkdir(parents=True, exist_ok=True)
        (self.root / old).rename(self.root / new)

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'change')

    def check(self, cwd=None, staged=False):
        return subprocess.run((sys.executable, str(CHECK), '--base', 'main', *(['--staged'] if staged else [])),
                              cwd=cwd or self.root, env=ENV, capture_output=True, text=True)

    def assertPasses(self, cwd=None, staged=False):
        result = self.check(cwd, staged)
        self.assertEqual(result.returncode, 0, result.stderr)

    def assertFails(self, message, staged=False):
        result = self.check(staged=staged)
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

    def test_deleted_or_renamed_file_without_raise_fails(self):
        (self.root / 'skills/alpha/references/notes.md').unlink()
        self.assertFails('skills/alpha/ changed since')
        self.write('skills/alpha/references/renamed.md', 'Notes.\n')
        self.assertFails('skills/alpha/ changed since')
        self.write('skills/alpha/SKILL.md', skill('alpha', '"1.0.1"'))
        self.assertPasses()

    def test_staged_mode_checks_the_index_not_the_working_tree(self):
        self.write('skills/alpha/references/notes.md', 'Changed notes.\n')
        self.assertPasses(staged=True)
        self.git('add', 'skills/alpha/references/notes.md')
        self.write('skills/alpha/SKILL.md', skill('alpha', '"1.0.1"'))
        self.assertFails('raise metadata.version above 1.0.0', staged=True)
        self.git('add', 'skills/alpha/SKILL.md')
        self.assertPasses(staged=True)

    def test_renamed_skill_must_raise_its_major_version(self):
        self.move('skills/alpha', 'skills/omega')
        self.write('skills/omega/SKILL.md', skill('omega', '"1.1.0"'))
        self.assertFails('skills/omega/SKILL.md: renames skills/alpha/ at 1.0.0, so raise metadata.version to 2.0.0 or above')
        self.write('skills/omega/SKILL.md', skill('omega', '"2.0.0"'))
        self.assertPasses()

    def test_moved_skill_must_raise_its_version(self):
        self.move('skills/alpha', 'host-skills/claude-code/alpha')
        self.assertFails('moves skills/alpha/ at 1.0.0, so raise metadata.version above 1.0.0')
        self.write('host-skills/claude-code/alpha/SKILL.md', skill('alpha', '"1.0.1"'))
        self.assertPasses()

    def test_dissimilar_new_skill_is_not_a_rename(self):
        shutil.rmtree(self.root / 'skills/alpha')
        self.write('skills/omega/SKILL.md', skill('omega', '"0.1.0"', UNRELATED))
        self.assertPasses()

    def test_files_agents_load_must_not_name_a_removed_skill(self):
        self.git('switch', '-q', 'main')
        self.write('skills/old-name/SKILL.md', skill('old-name'))
        self.write('global/AGENTS.md', 'Use old-name for reviews.\n')
        self.write('README.md', 'Credits: the upstream old-name project.\n')
        self.commit()
        self.git('switch', '-q', '-C', 'change')
        shutil.rmtree(self.root / 'skills/old-name')
        self.assertFails('global/AGENTS.md:1: names old-name, a skill that was removed; remove the reference')
        self.write('global/AGENTS.md', 'Use not-old-name-at-all for reviews.\n')
        self.assertPasses()

    def test_one_word_names_count_only_as_invocations_or_code(self):
        shutil.rmtree(self.root / 'skills/alpha')
        self.write('global/AGENTS.md', 'Ship the alpha release.\n')
        self.assertPasses()
        for text in ('Run /alpha first.\n', 'Run $alpha first.\n', 'Load `alpha` first.\n'):
            self.write('global/AGENTS.md', text)
            self.assertFails('global/AGENTS.md:1: names alpha')

    def test_reference_to_a_renamed_skill_names_the_new_one(self):
        self.move('skills/alpha', 'skills/omega')
        self.write('skills/omega/SKILL.md', skill('omega', '"2.0.0"'))
        self.write('host-skills/claude-code/beta/SKILL.md', skill('beta', '"1.0.1"', 'Then run /alpha.\n'))
        self.assertFails('host-skills/claude-code/beta/SKILL.md:9: names alpha, which is now omega; update the reference')
        self.git('add', '-A')
        self.write('host-skills/claude-code/beta/SKILL.md', skill('beta', '"1.0.1"', 'Then run /omega.\n'))
        self.assertPasses()
        self.assertFails('names alpha, which is now omega', staged=True)

    def test_pre_commit_hook_blocks_a_commit_without_a_raise(self):
        self.write('tests/check_skill_versions.py', CHECK.read_text())
        (self.root / '.githooks').mkdir()
        shutil.copy(HOOK, self.root / '.githooks/pre-commit')
        self.git('config', 'core.hooksPath', '.githooks')
        self.git('update-ref', 'refs/remotes/origin/main', 'main')
        self.commit()
        self.write('skills/alpha/references/notes.md', 'Changed notes.\n')
        self.git('add', '-A')
        result = subprocess.run(('git', 'commit', '-q', '-m', 'change'), cwd=self.root, env=ENV, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('raise metadata.version above 1.0.0', result.stderr)
        self.write('skills/alpha/SKILL.md', skill('alpha', '"1.0.1"'))
        self.commit()

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
