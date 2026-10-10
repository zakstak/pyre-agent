"""install.py against a throwaway home directory and a fixture repository with an origin."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

INSTALLER = Path(__file__).resolve().parents[1] / 'install.py'
GIT_ENV = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
           'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}


def skill(name, version='1.0.0', body=''):
    return f'---\nname: {name}\ndescription: Test skill.\nmetadata:\n  version: "{version}"\n---\n\n# {name}\n{body}'


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.home = base / 'home'
        (self.home / '.claude').mkdir(parents=True)
        (self.home / '.codex').mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_STATE_HOME')}
        self.env.update(GIT_ENV, HOME=str(self.home))
        self.upstream = base / 'upstream'
        self.upstream.mkdir()
        self.git(self.upstream, 'init', '-q', '-b', 'main')
        self.publish({'skills/alpha/SKILL.md': skill('alpha'),
                      'skills/alpha/references/notes.md': 'Notes.\n',
                      'skills/beta/SKILL.md': skill('beta'),
                      'host-skills/claude-code/gamma/SKILL.md': skill('gamma')}, push=False)
        self.git(base, 'clone', '-q', '--bare', str(self.upstream), 'origin.git')
        self.git(self.upstream, 'remote', 'add', 'origin', str(base / 'origin.git'))
        self.git(base, 'clone', '-q', str(base / 'origin.git'), 'checkout')
        self.checkout = base / 'checkout'
        shutil.copy(INSTALLER, self.checkout / 'install.py')
        self.claude = self.home / '.claude/skills'
        self.codex = self.home / '.agents/skills'

    def tearDown(self):
        self.temp.cleanup()

    def git(self, cwd, *args):
        return subprocess.run(('git', *args), cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout

    def publish(self, files, delete=(), push=True, tag=None):
        for path, text in files.items():
            (self.upstream / path).parent.mkdir(parents=True, exist_ok=True)
            (self.upstream / path).write_text(text)
        for path in delete:
            shutil.rmtree(self.upstream / path)
        self.git(self.upstream, 'add', '-A')
        self.git(self.upstream, 'commit', '-q', '-m', 'change')
        if tag:
            self.git(self.upstream, 'tag', '-f', tag)
        if push:
            self.git(self.upstream, 'push', '-q', '--force', 'origin', f'HEAD:{tag and "refs/tags/" + tag or "refs/heads/main"}')
        return self.git(self.upstream, 'rev-parse', 'HEAD').strip()

    def run_installer(self, *args, code=0):
        result = subprocess.run((sys.executable, str(self.checkout / 'install.py'), *args), cwd=self.home,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def record(self):
        return json.loads((self.home / '.local/state/pyre-agent/install.json').read_text())

    def names(self, folder):
        return sorted(path.name for path in folder.iterdir()) if folder.exists() else []

    def test_installs_copies_for_each_host_and_records_them(self):
        output = self.run_installer()
        self.assertIn('install   alpha 1.0.0', output)
        self.assertEqual(self.names(self.claude), ['alpha', 'beta', 'gamma'])
        self.assertEqual(self.names(self.codex), ['alpha', 'beta'])
        self.assertFalse((self.claude / 'alpha').is_symlink())
        self.assertEqual((self.claude / 'alpha/references/notes.md').read_text(), 'Notes.\n')
        record = self.record()
        self.assertEqual(record['hosts']['codex']['ref'], 'main')
        self.assertEqual(record['hosts']['claude-code']['skills']['gamma']['version'], '1.0.0')
        self.assertIn('3 up to date', self.run_installer())

    def test_updates_changed_skills_and_removes_skills_that_left(self):
        self.run_installer()
        self.publish({'skills/alpha/SKILL.md': skill('alpha', '1.1.0', 'New.\n')}, delete=['skills/beta'])
        output = self.run_installer()
        self.assertIn('update    alpha 1.0.0 -> 1.1.0', output)
        self.assertIn('remove    beta', output)
        self.assertIn('New.', (self.codex / 'alpha/SKILL.md').read_text())
        self.assertEqual(self.names(self.codex), ['alpha'])

    def test_preview_tag_installs_and_follows_a_moved_tag(self):
        self.run_installer()
        first = self.publish({'skills/delta/SKILL.md': skill('delta')}, tag='preview')
        self.assertIn(f'Installing preview at {first[:12]}', self.run_installer('--ref', 'preview'))
        self.assertIn('delta', self.names(self.codex))
        second = self.publish({'skills/delta/SKILL.md': skill('delta', '1.0.1')}, tag='preview')
        self.assertIn(f'preview now at {second[:12]}', self.run_installer('status', code=0))
        self.assertIn('update    delta 1.0.0 -> 1.0.1', self.run_installer('--ref', 'preview'))
        output = self.run_installer()
        self.assertIn('remove    delta', output)
        self.assertIn(f'(was preview at {second[:12]})', output)

    def test_offline_installs_an_unpushed_local_commit(self):
        (self.checkout / 'skills/epsilon').mkdir()
        (self.checkout / 'skills/epsilon/SKILL.md').write_text(skill('epsilon'))
        self.git(self.checkout, 'add', 'skills')
        self.git(self.checkout, 'commit', '-q', '-m', 'local')
        self.run_installer('--ref', 'HEAD', '--offline')
        self.assertIn('epsilon', self.names(self.codex))

    def test_working_tree_changes_never_reach_installs(self):
        (self.checkout / 'skills/alpha/SKILL.md').write_text('uncommitted\n')
        self.run_installer()
        self.assertEqual((self.codex / 'alpha/SKILL.md').read_text(), skill('alpha'))

    def test_existing_skill_with_the_same_name_is_a_conflict(self):
        (self.codex / 'alpha').mkdir(parents=True)
        (self.codex / 'alpha/SKILL.md').write_text('theirs\n')
        output = self.run_installer(code=1)
        self.assertIn('conflict  alpha: ~/.agents/skills/alpha exists', output)
        self.assertEqual((self.codex / 'alpha/SKILL.md').read_text(), 'theirs\n')
        self.assertIn('beta', self.names(self.codex))
        self.assertNotIn('alpha', self.record()['hosts']['codex']['skills'])

    def test_locally_edited_copy_is_kept_until_forced(self):
        self.run_installer()
        (self.codex / 'alpha/SKILL.md').write_text('mine\n')
        self.publish({'skills/alpha/SKILL.md': skill('alpha', '1.1.0')})
        self.assertIn('edited    alpha', self.run_installer(code=1))
        self.assertEqual((self.codex / 'alpha/SKILL.md').read_text(), 'mine\n')
        self.assertIn('edited locally', self.run_installer('status', code=1))
        self.run_installer('--force')
        self.assertEqual((self.codex / 'alpha/SKILL.md').read_text(), skill('alpha', '1.1.0'))

    def test_forced_removal_handles_a_copy_replaced_by_a_symlink(self):
        self.run_installer()
        shutil.rmtree(self.codex / 'beta')
        (self.codex / 'beta').symlink_to(self.home)
        self.publish({}, delete=['skills/beta'])
        self.assertIn('edited    beta', self.run_installer(code=1))
        self.run_installer('--force')
        self.assertFalse(os.path.lexists(self.codex / 'beta'))
        self.assertTrue(self.home.is_dir())

    def test_corrupt_record_fails_with_its_path(self):
        self.run_installer()
        (self.home / '.local/state/pyre-agent/install.json').write_text('{')
        self.assertIn('install.json is not valid JSON', self.run_installer(code=2))

    def test_old_readme_symlinks_are_replaced_and_stale_ones_removed(self):
        self.codex.mkdir(parents=True)
        (self.codex / 'alpha').symlink_to(self.checkout / 'skills/alpha')
        (self.codex / 'retired').symlink_to(self.checkout / 'skills/retired')
        output = self.run_installer()
        self.assertIn('adopt     alpha 1.0.0', output)
        self.assertIn('unlink    retired', output)
        self.assertFalse((self.codex / 'alpha').is_symlink())
        self.assertFalse(os.path.lexists(self.codex / 'retired'))

    def test_skill_folder_that_is_a_symlink_keeps_working(self):
        elsewhere = self.home / 'elsewhere/skills'
        elsewhere.mkdir(parents=True)
        (self.home / '.agents').mkdir()
        self.codex.symlink_to(elsewhere)
        self.run_installer()
        self.assertEqual(self.names(elsewhere), ['alpha', 'beta'])
        self.assertFalse((self.home / 'elsewhere/.pyre-agent-staging').exists())

    def test_dry_run_changes_no_installed_files(self):
        self.assertIn('Planning main', self.run_installer('--dry-run'))
        self.assertFalse(self.claude.exists())
        self.assertFalse((self.home / '.local/state/pyre-agent/install.json').exists())

    def test_uninstall_removes_only_installed_skills(self):
        self.run_installer()
        (self.codex / 'omarchy').mkdir()
        self.run_installer('uninstall')
        self.assertEqual(self.names(self.codex), ['omarchy'])
        self.assertEqual(self.names(self.claude), [])
        self.assertEqual(self.record()['hosts'], {})
        self.assertIn('Nothing installed.', self.run_installer('status'))

    def test_hosts_follow_existing_config_directories(self):
        shutil.rmtree(self.home / '.codex')
        claude = self.home / 'claude-config'
        claude.mkdir()
        self.env['CLAUDE_CONFIG_DIR'] = str(claude)
        self.run_installer()
        self.assertEqual(self.names(claude / 'skills'), ['alpha', 'beta', 'gamma'])
        self.assertFalse(self.codex.exists())
        self.assertFalse(self.claude.exists())

    def test_ambiguous_and_unknown_refs_fail(self):
        self.git(self.upstream, 'branch', 'preview')
        self.git(self.upstream, 'push', '-q', 'origin', 'preview')
        self.publish({'skills/delta/SKILL.md': skill('delta')}, tag='preview')
        self.assertIn('names both refs/tags/preview and origin/preview', self.run_installer('--ref', 'preview', code=2))
        self.assertIn('delta', self.run_installer('--ref', 'refs/tags/preview'))
        self.assertIn('cannot resolve nope', self.run_installer('--ref', 'nope', code=2))
        self.assertIn('invalid ref', self.run_installer('--ref=--upload-pack=x', code=2))

    def test_ref_without_skills_fails(self):
        self.publish({'other/file.txt': 'x\n'}, delete=['skills', 'host-skills'])
        self.assertIn('has no skills/ folder', self.run_installer(code=2))


if __name__ == '__main__':
    unittest.main()
