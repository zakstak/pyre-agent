"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_collect_worktree.py'.

Each test builds throwaway Git repositories in a temporary directory. User and system Git configuration is shut out.
"""

import hashlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/review-canvas/scripts"
COLLECT = SCRIPTS / "collect_worktree.py"
FINGERPRINT = SCRIPTS / "fingerprint.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collector = load("collect_worktree", COLLECT)
fingerprint = load("fingerprint_script", FINGERPRINT)
renderer = collector.render_review  # the module whose limits the collector reads at call time
real_git = collector.git
GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
# Assembled from pieces so this file does not match the collector's secret patterns.
PRIVATE_KEY = "-" * 5 + "BEGIN RSA " + "PRIVATE KEY" + "-" * 5 + "\nMIIBsecretbody\n"
GITHUB_TOKEN = "gh" + "p_" + "A1b2" * 9


def blob(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        environment = mock.patch.dict(os.environ, GIT_ENV)
        environment.start()
        self.addCleanup(environment.stop)
        self.base = Path(temp.name).resolve()
        self.root = self.init(self.base / "repo")

    def init(self, path):
        subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "-q", str(path)], check=True)
        self.configure(path)
        return path

    def configure(self, path):
        for key, value in (("user.name", "Test"), ("user.email", "test@example.com"),
                           ("commit.gpgsign", "false"), ("init.defaultBranch", "main")):
            self.git(path, "config", key, value)

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True).stdout.decode()

    def write(self, name, data, root=None):
        path = (root or self.root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def commit(self, files=(), root=None, message="commit"):
        root = root or self.root
        for name, data in dict(files).items():
            self.write(name, data, root)
        self.git(root, "add", "-A")
        self.git(root, "commit", "-q", "--allow-empty", "-m", message)

    def head(self, root=None):
        return self.git(root or self.root, "rev-parse", "HEAD").strip()

    def collect(self, **options):
        self.review, self.flagged = collector.collect(self.root, **options)
        return {file["path"]: file for file in self.review["files"]}

    def main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = collector.main(["--repo", str(self.root), *args])
        return code, out.getvalue(), err.getvalue()


class InventoryTests(Fixture):
    def test_staged_unstaged_and_untracked_changes_appear_but_ignored_files_do_not(self):
        self.commit({"staged.txt": "one\n", "unstaged.txt": "one\n", ".gitignore": "*.log\nbuild/\n"})
        self.write("staged.txt", "one\nstaged\n")
        self.git(self.root, "add", "staged.txt")
        self.write("unstaged.txt", "one\nunstaged\n")
        self.write("dir/new.txt", "a\nb\n")
        self.write("debug.log", "ignored\n")
        self.write("build/out.txt", "ignored\n")
        files = self.collect()
        self.assertEqual(sorted(files), ["dir/new.txt", "staged.txt", "unstaged.txt"])
        self.assertEqual(files["staged.txt"]["patch"], "@@ -1 +1,2 @@\n one\n+staged\n")
        self.assertEqual(files["unstaged.txt"]["patch"], "@@ -1 +1,2 @@\n one\n+unstaged\n")
        new = files["dir/new.txt"]
        self.assertEqual(new, {"path": "dir/new.txt", "status": "added", "group": "core", "additions": 2, "deletions": 0,
                               "fingerprint": new["fingerprint"], "new_mode": "100644",
                               "patch": "@@ -0,0 +1,2 @@\n+a\n+b\n", "patch_complete": True})
        self.assertEqual(self.review["target"], {"kind": "worktree", "title": "Uncommitted changes on main", "root": str(self.root),
                                                 "head_sha": self.head(), "branch": "main", "changed_files": 3})
        self.assertIs(self.review["files_complete"], True)
        self.assertEqual(self.flagged, [])

    def test_binary_files_keep_entry_and_stats_without_a_patch(self):
        self.commit({"image.bin": b"\x00\x01\x02\n"})
        self.write("image.bin", b"\x00\x03\n")
        self.write("blob.dat", b"text\x00more\n")
        files = self.collect()
        self.assertEqual(files["image.bin"]["status"], "modified")
        self.assertEqual(files["blob.dat"]["status"], "added")
        for file in files.values():
            self.assertEqual((file["patch_note"], file["additions"], file["deletions"]), ("binary", 0, 0))
            self.assertNotIn("patch", file)
            self.assertNotIn("patch_complete", file)

    def test_rename_detection_ignores_the_configured_limit(self):
        self.commit({f"f{i}.txt": "".join(f"f{i} line {n}\n" for n in range(50)) for i in range(3)})
        for i in range(3):
            self.git(self.root, "mv", f"f{i}.txt", f"g{i}.txt")
            self.write(f"g{i}.txt", "".join(f"f{i} line {n}\n" for n in range(50)) + "extra\n")
        self.git(self.root, "config", "diff.renameLimit", "1")
        self.assertEqual(sorted(file["status"] for file in self.collect().values()), ["renamed"] * 3)

    def test_staged_rename_with_an_edit_and_a_pure_rename(self):
        lines = "".join(f"line {i}\n" for i in range(10))
        self.commit({"old.txt": lines, "same.txt": "same\n"})
        self.git(self.root, "mv", "old.txt", "new.txt")
        self.write("new.txt", lines + "added\n")
        self.git(self.root, "mv", "same.txt", "moved.txt")
        files = self.collect()
        self.assertEqual(sorted(files), ["moved.txt", "new.txt"])
        edited = files["new.txt"]
        self.assertEqual((edited["status"], edited["old_path"], edited["additions"], edited["deletions"]), ("renamed", "old.txt", 1, 0))
        self.assertEqual(edited["patch"], "@@ -8,3 +8,4 @@ line 6\n line 7\n line 8\n line 9\n+added\n")
        pure = files["moved.txt"]
        self.assertEqual((pure["status"], pure["old_path"], pure["patch_note"]), ("renamed", "same.txt", "no_content_change"))
        self.assertNotIn("patch", pure)

    def test_deletion_and_mode_only_change(self):
        self.commit({"gone.txt": "bye\n", "run.sh": "echo hi\n"})
        (self.root / "gone.txt").unlink()
        (self.root / "run.sh").chmod(0o755)
        files = self.collect()
        gone = files["gone.txt"]
        self.assertEqual((gone["status"], gone["deletions"], gone["old_mode"], gone["patch"]), ("deleted", 1, "100644", "@@ -1 +0,0 @@\n-bye\n"))
        self.assertNotIn("new_mode", gone)
        run = files["run.sh"]
        self.assertEqual((run["status"], run["patch_note"], run["old_mode"], run["new_mode"]), ("changed", "no_content_change", "100644", "100755"))
        self.assertNotIn("patch", run)

    def test_symlinks_submodules_and_nested_repositories_have_no_patch(self):
        source = self.init(self.base / "source")
        self.commit({"s.txt": "s\n"}, root=source)
        os.symlink("target-a", self.root / "link")
        self.commit({"file.txt": "f\n"})
        self.git(self.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(source), "sub")
        self.commit(message="add submodule")
        old_commit = self.head(self.root / "sub")
        self.configure(self.root / "sub")
        self.commit({"t.txt": "t\n"}, root=self.root / "sub")
        (self.root / "link").unlink()
        os.symlink("target-b", self.root / "link")
        os.symlink("file.txt", self.root / "new-link")
        nested = self.init(self.root / "nested")
        self.commit({"n.txt": "n\n"}, root=nested)
        files = self.collect()
        self.assertEqual(sorted(files), ["link", "nested", "new-link", "sub"])
        for path, note in (("link", "symlink"), ("new-link", "symlink"), ("sub", "submodule"), ("nested", "submodule")):
            self.assertEqual(files[path]["patch_note"], note, path)
            self.assertNotIn("patch", files[path])
        self.assertEqual(files["link"]["fingerprint"],
                         collector.file_fingerprint("link", None, blob(b"target-a"), blob(b"target-b"), "120000", "120000"))
        self.assertEqual(files["new-link"]["new_mode"], "120000")
        # Git counts a link target or a submodule commit as one line, staged or not.
        self.assertEqual({path: (files[path]["additions"], files[path]["deletions"]) for path in files},
                         {"link": (1, 1), "new-link": (1, 0), "sub": (1, 1), "nested": (1, 0)})
        sub = files["sub"]
        self.assertEqual((sub["status"], sub["old_mode"], sub["new_mode"]), ("modified", "160000", "160000"))
        self.assertEqual(sub["fingerprint"], collector.file_fingerprint("sub", None, old_commit, self.head(self.root / "sub"), "160000", "160000"))
        self.assertEqual((files["nested"]["status"], files["nested"]["new_mode"]), ("added", "160000"))
        self.assertEqual(files["nested"]["fingerprint"], collector.file_fingerprint("nested", None, None, self.head(nested), None, "160000"))

    def test_type_changes_follow_the_current_file(self):
        os.symlink("target", self.root / "link")
        self.commit({"plain.txt": "was a file\n"})
        (self.root / "link").unlink()
        self.write("link", "now a regular file\n")
        (self.root / "plain.txt").unlink()
        os.symlink("elsewhere", self.root / "plain.txt")
        files = self.collect()
        link = files["link"]
        self.assertEqual((link["status"], link["old_mode"], link["new_mode"], link["patch"]),
                         ("changed", "120000", "100644", "@@ -0,0 +1 @@\n+now a regular file\n"))
        self.assertNotIn("patch_note", link)
        self.assertEqual((files["plain.txt"]["patch_note"], files["plain.txt"]["new_mode"]), ("symlink", "120000"))

    def test_symlink_placeholder_without_symlink_support(self):
        self.commit({"keep.txt": "k\n"})
        self.git(self.root, "config", "core.symlinks", "false")
        target = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=self.root, input=b"old-target", capture_output=True, check=True).stdout.decode().strip()
        self.git(self.root, "update-index", "--add", "--cacheinfo", f"120000,{target},link")
        self.git(self.root, "commit", "-q", "-m", "link")
        self.git(self.root, "checkout", "--", "link")
        self.assertFalse((self.root / "link").is_symlink())
        self.write("link", b"new-target")
        files = self.collect()
        self.assertEqual((files["link"]["patch_note"], files["link"]["new_mode"]), ("symlink", "120000"))
        self.assertEqual(files["link"]["fingerprint"], fingerprint.file_fingerprint("link", None, target, blob(b"new-target"), "120000", "120000"))
        # A placeholder past 1 MiB is hashed in full, so a change near its end still changes the fingerprint.
        big = b"t" * (2 << 20)
        self.write("link", big)
        first = self.collect()["link"]["fingerprint"]
        self.write("link", big[:-1] + b"u")
        self.assertNotEqual(self.collect()["link"]["fingerprint"], first)

    def test_a_text_file_marked_minus_diff_still_shows_its_patch(self):
        self.commit({".gitattributes": "*.lock -diff\n", "deps.lock": "a 1\n"})
        self.write("deps.lock", "a 2\n")
        files = self.collect()
        self.assertEqual(files["deps.lock"]["patch"], "@@ -1 +1 @@\n-a 1\n+a 2\n")
        self.assertEqual((files["deps.lock"]["additions"], files["deps.lock"]["deletions"]), (1, 1))
        self.assertNotIn("patch_note", files["deps.lock"])

    def test_intent_to_add_file_matches_the_untracked_entry(self):
        self.commit({"base.txt": "b\n"})
        self.write("ita.txt", "first\nlast")
        self.write("empty.txt", b"")
        untracked = self.collect()
        self.git(self.root, "add", "-N", "ita.txt", "empty.txt")
        marked = self.collect()
        self.assertEqual(marked, untracked)
        self.assertEqual(marked["ita.txt"]["patch"], "@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file\n")
        self.assertEqual((marked["empty.txt"]["status"], marked["empty.txt"]["patch_note"]), ("added", "empty"))
        self.assertNotIn("patch", marked["empty.txt"])

    def test_invalid_utf8_and_control_characters_are_replaced_and_crlf_is_kept(self):
        self.commit({"feed.txt": "a\n", "crlf.txt": "one\r\ntwo\r\n"})
        self.write("latin1.txt", "café\n".encode("latin-1"))
        self.write("feed.txt", "a\n\x0cb\x7f\n")
        self.write("crlf.txt", "one\r\nTWO\r\n")
        self.write("win.txt", "x\r\ny\r\n")
        files = self.collect()
        self.assertEqual((files["latin1.txt"]["patch_note"], files["latin1.txt"]["patch"]), ("replaced_characters", "@@ -0,0 +1 @@\n+caf�\n"))
        self.assertEqual((files["feed.txt"]["patch_note"], files["feed.txt"]["patch"]), ("replaced_characters", "@@ -1 +1,2 @@\n a\n+␌b␡\n"))
        self.assertEqual(files["crlf.txt"]["patch"], "@@ -1,2 +1,2 @@\n one\r\n-two\r\n+TWO\r\n")
        self.assertEqual(files["win.txt"]["patch"], "@@ -0,0 +1,2 @@\n+x\r\n+y\r\n")
        self.assertNotIn("patch_note", files["crlf.txt"])
        self.assertNotIn("patch_note", files["win.txt"])

    def test_non_utf8_path_fails_with_the_escaped_name(self):
        self.commit({"a.txt": "a\n"})
        with open(os.path.join(os.fsencode(self.root), b"bad\xff.txt"), "wb") as handle:
            handle.write(b"x\n")
        with self.assertRaisesRegex(ValueError, r"not valid UTF-8.*bad\\xff\.txt"):
            self.collect()

    def test_path_removed_from_index_but_kept_on_disk_stops_collection(self):
        # A deletion and an untracked file at one path cannot both be reviewed, and neither alone is the truth.
        self.commit({"kept.txt": "k\n"})
        self.git(self.root, "rm", "-q", "--cached", "kept.txt")
        with self.assertRaisesRegex(collector.CollectError, "kept.txt is removed from Git's index but still on disk"):
            self.collect()

    def test_assume_unchanged_files_are_compared_by_their_bytes(self):
        self.commit({"hidden.txt": "a\n", "gone.txt": "g\n", "same.txt": "s\n"})
        self.git(self.root, "update-index", "--assume-unchanged", "hidden.txt", "gone.txt", "same.txt")
        self.write("hidden.txt", "b\n")
        (self.root / "gone.txt").unlink()
        files = self.collect()
        self.assertEqual(sorted(files), ["gone.txt", "hidden.txt"])
        self.assertEqual(files["hidden.txt"]["patch"], "@@ -1 +1 @@\n-a\n+b\n")
        self.assertEqual(files["gone.txt"]["status"], "deleted")

    def test_a_submodule_marked_assume_unchanged_stays_a_submodule(self):
        library = self.init(self.base / "library")
        self.commit({"lib.txt": "l\n"}, root=library)
        self.git(self.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(library), "sub")
        self.commit({"a.txt": "a\n"})
        self.git(self.root, "update-index", "--assume-unchanged", "sub")
        self.assertEqual(self.collect(), {})

    def test_present_skip_worktree_files_are_compared_by_their_bytes(self):
        self.commit({"pinned.txt": "a\n"})
        self.git(self.root, "update-index", "--skip-worktree", "pinned.txt")
        self.write("pinned.txt", "b\n")
        self.assertEqual(self.collect()["pinned.txt"]["patch"], "@@ -1 +1 @@\n-a\n+b\n")

    def test_unresolved_merge_conflicts_stop_collection(self):
        self.commit({"f.txt": "base\n"})
        self.git(self.root, "checkout", "-q", "-b", "other")
        self.commit({"f.txt": "other\n"})
        self.git(self.root, "checkout", "-q", "main")
        self.commit({"f.txt": "mine\n"})
        subprocess.run(["git", "merge", "other"], cwd=self.root, capture_output=True)
        self.write("f.txt", "mine\n")  # resolved to HEAD's bytes, but not staged
        with self.assertRaisesRegex(collector.CollectError, "unresolved merge conflicts"):
            self.collect()

    def test_an_assume_unchanged_addition_missing_from_disk_is_no_change(self):
        self.commit({"a.txt": "a\n"})
        self.write("new.txt", "n\n")
        self.git(self.root, "add", "new.txt")
        self.git(self.root, "update-index", "--assume-unchanged", "new.txt")
        (self.root / "new.txt").unlink()
        self.assertEqual(self.collect(), {})

    def test_a_temporary_directory_inside_the_tree_is_refused(self):
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        (self.root / "tmp").mkdir()
        with mock.patch.object(collector.tempfile, "tempdir", str(self.root / "tmp")), \
                self.assertRaisesRegex(collector.CollectError, "is inside the working tree. Set TMPDIR elsewhere"):
            self.collect()

    def test_a_staged_mode_change_reverted_on_disk_is_named(self):
        self.commit({"run.sh": "echo\n"})
        (self.root / "run.sh").chmod(0o755)
        self.git(self.root, "add", "run.sh")
        (self.root / "run.sh").chmod(0o644)
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn("would record unreviewed content: run.sh", out)

    def test_staged_symlinks_that_differ_from_the_working_tree_are_named(self):
        os.symlink("a", self.root / "link")
        self.commit({"keep.txt": "k\n"})
        (self.root / "link").unlink(); os.symlink("b", self.root / "link")
        self.git(self.root, "add", "link")
        (self.root / "link").unlink(); os.symlink("c", self.root / "link")
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn("would record unreviewed content: link", out)

    def test_a_sparse_entry_shown_from_the_index_is_not_named(self):
        self.commit({"sparse.txt": "a\n"})
        self.write("sparse.txt", "b\n")
        self.git(self.root, "add", "sparse.txt")
        self.git(self.root, "update-index", "--skip-worktree", "sparse.txt")
        (self.root / "sparse.txt").unlink()
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertNotIn("unreviewed content", out)

    def test_a_hidden_symlink_placeholder_stays_a_symlink(self):
        self.commit({"keep.txt": "k\n"})
        self.git(self.root, "config", "core.symlinks", "false")
        target = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=self.root, input=b"old", capture_output=True, check=True).stdout.decode().strip()
        self.git(self.root, "update-index", "--add", "--cacheinfo", f"120000,{target},link")
        self.git(self.root, "commit", "-q", "-m", "link")
        self.git(self.root, "checkout", "--", "link")
        self.git(self.root, "update-index", "--assume-unchanged", "link")
        self.write("link", b"new")
        # The placeholder is diffed in place, never read whole into memory.
        with mock.patch.object(collector.Path, "read_bytes", side_effect=AssertionError("read whole")):
            link = self.collect()["link"]
        self.assertEqual((link["new_mode"], link["patch_note"], link["additions"], link["deletions"]), ("120000", "symlink", 1, 1))

    def test_hidden_symlink_changes_keep_their_line_counts(self):
        os.symlink("old", self.root / "link")
        self.commit({"keep.txt": "k\n"})
        self.git(self.root, "update-index", "--assume-unchanged", "link")
        (self.root / "link").unlink(); os.symlink("new", self.root / "link")
        link = self.collect()["link"]
        self.assertEqual((link["additions"], link["deletions"], link["patch_note"]), (1, 1, "symlink"))

    def test_absent_sparse_symlinks_are_read_from_the_index(self):
        os.symlink("a", self.root / "link")
        self.commit({"keep.txt": "k\n"})
        (self.root / "link").unlink(); os.symlink("b", self.root / "link")
        self.git(self.root, "add", "link")
        self.git(self.root, "update-index", "--skip-worktree", "link")
        (self.root / "link").unlink()
        link = self.collect()["link"]
        staged = self.git(self.root, "rev-parse", ":link").strip()
        self.assertEqual((link["status"], link["new_mode"], link["patch_note"], link["additions"], link["deletions"]), ("modified", "120000", "symlink", 1, 1))
        self.assertEqual(link["fingerprint"], fingerprint.file_fingerprint("link", None, blob(b"a"), staged, "120000", "120000"))

    def test_hidden_files_keep_the_index_mode_when_file_modes_are_off(self):
        self.commit({"plain.txt": "a\n"})
        self.git(self.root, "config", "core.filemode", "false")
        self.git(self.root, "update-index", "--assume-unchanged", "plain.txt")
        self.write("plain.txt", "b\n")
        (self.root / "plain.txt").chmod(0o755)
        plain = self.collect()["plain.txt"]
        self.assertEqual((plain["old_mode"], plain["new_mode"]), ("100644", "100644"))

    def test_hidden_files_without_a_patch_keep_their_stats(self):
        self.commit({".env": "A=1\n"})
        self.git(self.root, "update-index", "--assume-unchanged", ".env")
        self.write(".env", "A=2\nB=3\n")
        secret = self.collect()[".env"]
        self.assertEqual((secret["patch_note"], secret["additions"], secret["deletions"]), ("secret", 2, 1))

    def test_a_staged_deletion_with_the_file_kept_on_disk_is_named(self):
        self.commit({"old.txt": "".join(f"line {i}\n" for i in range(10))})
        self.git(self.root, "mv", "old.txt", "new.txt")
        shutil.copy(self.root / "new.txt", self.root / "old.txt")
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn("would record unreviewed content: old.txt", out)

    def test_a_staged_link_replaced_by_a_file_with_the_same_bytes_is_named(self):
        os.symlink("foo", self.root / "link")
        self.commit({"keep.txt": "k\n"})
        (self.root / "link").unlink(); os.symlink("bar", self.root / "link")
        self.git(self.root, "add", "link")
        (self.root / "link").unlink(); self.write("link", "bar")
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn("would record unreviewed content: link", out)

    def test_attribute_binary_text_keeps_real_stats_without_a_patch(self):
        self.commit({".gitattributes": "* -diff\n", ".env.local": "A=1\n"})
        self.write(".env.local", "A=2\nB=3\n")
        secret = self.collect()[".env.local"]
        self.assertEqual((secret["patch_note"], secret["additions"], secret["deletions"]), ("secret", 2, 1))

    def test_untracked_files_honor_core_filemode(self):
        self.commit({"a.txt": "a\n"})
        self.git(self.root, "config", "core.filemode", "false")
        self.write("run.sh", "echo\n")
        (self.root / "run.sh").chmod(0o755)
        self.assertEqual(self.collect()["run.sh"]["new_mode"], "100644")

    def test_a_hidden_file_replaced_by_a_directory_is_a_deletion(self):
        self.commit({"thing": "t\n"})
        self.git(self.root, "update-index", "--assume-unchanged", "thing")
        (self.root / "thing").unlink()
        self.write("thing/inside.txt", "i\n")
        files = self.collect()
        self.assertEqual((files["thing"]["status"], files["thing/inside.txt"]["status"]), ("deleted", "added"))

    def test_hidden_file_stats_stream_the_old_blob(self):
        self.commit({"big.txt": "x\n" * 1000})
        self.git(self.root, "update-index", "--assume-unchanged", "big.txt")
        self.write("big.txt", "y\n")
        captured = []
        real = collector.git

        def record(cwd, *args, **options):
            output = real(cwd, *args, **options)
            if "blob" in args:
                captured.append(len(output))
            return output

        with mock.patch.object(renderer, "MAX_PATCH_CHARS", 16), mock.patch.object(collector, "git", record):
            big = self.collect()["big.txt"]
        self.assertEqual((big["patch_note"], big["additions"], big["deletions"]), ("too_large", 1, 1000))
        self.assertTrue(captured and not any(captured), "the old blob was read into memory")

    def test_an_assumed_rename_target_that_vanishes_leaves_the_source_deleted(self):
        self.commit({"old.txt": "o\n"})
        self.git(self.root, "mv", "old.txt", "new.txt")
        self.git(self.root, "update-index", "--assume-unchanged", "new.txt")
        (self.root / "new.txt").unlink()
        files = self.collect()
        self.assertEqual(sorted(files), ["old.txt"])
        self.assertEqual(files["old.txt"]["status"], "deleted")

    def test_a_case_only_rename_without_case_folding_is_a_deletion_and_an_addition(self):
        self.commit({"foo.txt": "f\n"})
        self.git(self.root, "config", "core.ignoreCase", "false")
        os.rename(self.root / "foo.txt", self.root / "FOO.txt")
        self.assertEqual({path: file["status"] for path, file in self.collect().items()}, {"FOO.txt": "added", "foo.txt": "deleted"})

    def test_hidden_entries_behind_a_file_are_deletions(self):
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                if (self.root / "dir").is_file():
                    (self.root / "dir").unlink()
                    self.git(self.root, "checkout", "--", "dir")
                self.commit({"dir/child": "c\n", "keep.txt": "k\n"})
                self.git(self.root, "update-index", flag, "dir/child")
                shutil.rmtree(self.root / "dir")
                self.write("dir", "now a file\n")
                files = self.collect()
                self.assertEqual((files["dir/child"]["status"], files["dir"]["status"]), ("deleted", "added"))
                self.git(self.root, "update-index", "--no-assume-unchanged", "--no-skip-worktree", "dir/child")

    def test_hidden_entries_behind_a_symlinked_directory_are_deletions(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "file").write_text("outside the tree\n")
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                if (self.root / "dir").is_symlink():
                    (self.root / "dir").unlink()
                    self.git(self.root, "checkout", "--", "dir")
                self.commit({"dir/file": "a\n", "keep.txt": "k\n"})
                self.git(self.root, "update-index", flag, "dir/file")
                shutil.rmtree(self.root / "dir")
                os.symlink(outside, self.root / "dir")
                files = self.collect()
                self.assertEqual((files["dir/file"]["status"], files["dir"]["new_mode"]), ("deleted", "120000"))
                self.assertNotIn("outside the tree", json.dumps(self.review))
                self.git(self.root, "update-index", "--no-assume-unchanged", "--no-skip-worktree", "dir/file")

    def test_the_divergence_check_reads_only_staged_index_entries(self):
        self.commit({"a.txt": "a\n", "b.txt": "b\n"})
        calls, real = [], collector.git
        def recording(cwd, *args, **options):
            calls.append(args)
            return real(cwd, *args, **options)
        with mock.patch.object(collector, "git", recording):
            self.assertEqual(collector.staged_differently(self.root, ()), [])
        self.assertFalse([args for args in calls if "ls-files" in args], "nothing is staged, so the index is not read")
        self.write("a.txt", "staged\n")
        self.git(self.root, "add", "a.txt")
        self.write("a.txt", "on disk\n")
        calls.clear()
        with mock.patch.object(collector, "git", recording):
            self.assertEqual(collector.staged_differently(self.root, ()), ["a.txt"])
        listings = [args for args in calls if "ls-files" in args]
        self.assertTrue(listings and all(args[-2:] == ("--", "a.txt") for args in listings), listings)

    def test_a_case_only_rename_hidden_by_ignore_case_stops_collection(self):
        self.commit({"foo": "f\n"})
        self.git(self.root, "config", "core.ignoreCase", "true")
        os.rename(self.root / "foo", self.root / "FOO")
        with self.assertRaisesRegex(collector.CollectError, "renamed by case only"):
            self.collect()

    def test_many_long_hidden_paths_fit(self):
        names = [f"{'d' * 200}/{i:04d}-{'n' * 150}.txt" for i in range(300)]
        self.commit({name: "x\n" for name in names})
        for start in range(0, len(names), 50):
            self.git(self.root, "update-index", "--assume-unchanged", *names[start:start + 50])
        self.write(names[0], "y\n")
        with mock.patch.object(collector, "git", side_effect=lambda cwd, *args, **options: (
                (_ for _ in ()).throw(AssertionError("one command carried too many paths")) if len(args) > 260 else real_git(cwd, *args, **options))):
            self.assertEqual(list(self.collect()), [names[0]])

    def test_a_failure_after_collecting_writes_nothing(self):
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        output = self.base / "review.json"
        with mock.patch.object(collector, "staged_differently", side_effect=collector.GitError("late failure")):
            code, _, err = self.main("--output", str(output))
        self.assertEqual(code, 2)
        self.assertFalse(output.exists())

    def test_a_staged_version_that_differs_from_the_working_tree_is_named(self):
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        self.git(self.root, "add", "a.txt")
        self.write("a.txt", "a\n")
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn("Staged version differs from the reviewed file, so a commit would record unreviewed content: a.txt", out)

    def test_staged_skip_worktree_entry_reads_the_index(self):
        self.commit({"sparse.txt": "a\n"})
        self.write("sparse.txt", "b\n")
        self.git(self.root, "add", "sparse.txt")
        self.git(self.root, "update-index", "--skip-worktree", "sparse.txt")
        (self.root / "sparse.txt").unlink()
        files = self.collect()
        self.assertEqual((files["sparse.txt"]["status"], files["sparse.txt"]["patch"]), ("modified", "@@ -1 +1 @@\n-a\n+b\n"))

    def test_nested_repository_without_a_commit_stops_collection(self):
        self.commit({"a.txt": "a\n"})
        self.init(self.root / "nested")
        self.write("nested/file.txt", "x\n")
        with self.assertRaisesRegex(collector.CollectError, "nested is a nested repository or submodule with no commit"):
            self.collect()


class LimitTests(Fixture):
    def setUp(self):
        super().setUp()
        self.commit({"base.txt": "b\n"})

    def test_patch_over_the_line_limit_keeps_the_entry(self):
        self.write("big.txt", "".join(f"{i}\n" for i in range(5)))
        self.write("small.txt", "1\n")
        with mock.patch.object(renderer, "MAX_PATCH_LINES", 3):
            files = self.collect()
        big = files["big.txt"]
        self.assertEqual((big["patch_note"], big["patch_complete"], big["additions"]), ("too_large", False, 5))
        self.assertNotIn("patch", big)
        self.assertEqual(files["small.txt"]["patch"], "@@ -0,0 +1 @@\n+1\n")

    def test_total_patch_lines_are_counted_in_output_order(self):
        self.write("a.txt", "1\n2\n")
        self.write("b.txt", "1\n2\n")
        self.write("c.txt", "1\n")
        with mock.patch.object(renderer, "MAX_TOTAL_PATCH_LINES", 5):
            files = self.collect()
        self.assertTrue(files["a.txt"]["patch_complete"])
        self.assertEqual((files["b.txt"]["patch_note"], files["b.txt"]["patch_complete"]), ("too_large", False))
        self.assertTrue(files["c.txt"]["patch_complete"])

    def test_patch_over_the_character_limit_and_a_huge_untracked_file(self):
        self.write("base.txt", "b\n" + "x" * 40 + "\n")
        self.write("huge.txt", "123456789\n" * 100)
        with mock.patch.object(renderer, "MAX_PATCH_CHARS", 16):
            files = self.collect()
        for path in ("base.txt", "huge.txt"):
            self.assertEqual((files[path]["patch_note"], files[path]["patch_complete"]), ("too_large", False))
        self.assertEqual(files["huge.txt"]["additions"], 100)

    def test_old_side_size_is_checked_before_reading_it(self):
        self.commit({"long.txt": "x" * 200 + "\n", "shrink.txt": "y" * 200 + "\n"})
        (self.root / "long.txt").unlink()
        self.write("shrink.txt", "z\n")
        outputs = []
        real = collector.git

        def record(cwd, *args, **options):
            outputs.append(real(cwd, *args, **options))
            return outputs[-1]

        with mock.patch.object(renderer, "MAX_PATCH_CHARS", 16), mock.patch.object(collector, "git", record):
            files = self.collect()
        for path in ("long.txt", "shrink.txt"):
            self.assertEqual((files[path]["patch_note"], files[path]["patch_complete"]), ("too_large", False))
        # Neither 200-byte old side was read or diffed into memory; only its size was asked for.
        self.assertFalse([output for output in outputs if b"x" * 100 in output or b"y" * 100 in output])

    def test_too_many_files_is_an_error(self):
        for name in ("a", "b", "c"):
            self.write(name, "x\n")
        with mock.patch.object(renderer, "MAX_FILES", 2), self.assertRaisesRegex(collector.CollectError, "3 changed files exceed the review limit of 2"):
            self.collect()


class SecretTests(Fixture):
    def setUp(self):
        super().setUp()
        self.commit({"config.txt": "name = demo\n"})
        self.write(".env.local", "API_TOKEN=hunter2-very-secret\n")
        self.write(".env.example", "API_TOKEN=\n")
        self.write("config.txt", "name = demo\n" + PRIVATE_KEY)
        self.write("notes.md", f"token {GITHUB_TOKEN}\n")
        self.write("deploy/id_ed25519", "key material\n")
        self.write("deploy/id_ed25519.pub", "ssh-ed25519 AAAA\n")

    def test_likely_secrets_are_flagged_and_absent_from_the_output_file(self):
        output = self.base / "review.json"
        code, out, _ = self.main("--output", str(output))
        self.assertEqual(code, 0)
        data = output.read_bytes()
        for secret in (b"hunter2-very-secret", b"key material", GITHUB_TOKEN.encode(), b"MIIBsecretbody"):
            self.assertNotIn(secret, data)
        files = {file["path"]: file for file in json.loads(data)["files"]}
        flagged = [".env.local", "config.txt", "deploy/id_ed25519", "notes.md"]
        self.assertEqual(sorted(path for path, file in files.items() if file.get("patch_note") == "secret"), flagged)
        self.assertEqual(files[".env.local"]["additions"], 1)
        self.assertEqual(files["config.txt"]["status"], "modified")
        self.assertIn("patch", files[".env.example"])
        self.assertIn("patch", files["deploy/id_ed25519.pub"])
        self.assertEqual(out.splitlines(), [f"Wrote {output} (6 files; 0 binary; 0 too large; 4 likely secret)"]
                         + [f"Likely secret, contents left out: {path}" for path in flagged])

    def test_a_secret_under_a_directory_that_replaced_a_file_stays_out(self):
        self.commit({"settings": "plain\n"})
        self.git(self.root, "rm", "-q", "settings")
        self.write("settings/.env", "DB_PASSWORD=super-secret-value\n")
        self.git(self.root, "add", "settings/.env")
        output = self.base / "review.json"
        code, out, _ = self.main("--output", str(output))
        self.assertEqual(code, 0)
        files = {file["path"]: file for file in json.loads(output.read_text())["files"]}
        self.assertEqual(files["settings"]["patch"], "@@ -1 +0,0 @@\n-plain\n")
        self.assertEqual(files["settings/.env"]["patch_note"], "secret")
        self.assertNotIn(b"super-secret-value", output.read_bytes())
        self.assertIn("Likely secret, contents left out: settings/.env", out)

    def test_include_secret_file_restores_one_file(self):
        files = self.collect(include_secret=[".env.local"])
        self.assertEqual(files[".env.local"]["patch"], "@@ -0,0 +1 @@\n+API_TOKEN=hunter2-very-secret\n")
        self.assertNotIn("patch_note", files[".env.local"])
        self.assertEqual(self.flagged, ["config.txt", "deploy/id_ed25519", "notes.md"])

    def test_include_secret_file_must_name_a_changed_file(self):
        with self.assertRaisesRegex(collector.CollectError, "not a changed file: missing.env"):
            self.collect(include_secret=["missing.env"])
        code, _, err = self.main("--output", str(self.base / "review.json"), "--include-secret-file", "missing.env")
        self.assertEqual(code, 2)
        self.assertTrue(err.startswith("Error: --include-secret-file"))

    def test_secret_names_and_patterns(self):
        for name in (".env", "app/.ENV.production", "server.pem", "tls.key", "id_rsa", "credentials.json", ".npmrc", "_netrc"):
            self.assertTrue(collector.secret_name(name), name)
        for name in (".env.example", ".env.local.sample", "id_rsa.pub", "environment.py", "key.txt", "credentials.md"):
            self.assertFalse(collector.secret_name(name), name)
        for text in ("AKIA" + "ABCDEFGHIJKLMNOP", "xox" + "b-1234567890-abc", "x=sk-" + "ant-" + "a" * 24,
                     "sk-" + "proj-" + "B" * 30, "github_" + "pat_" + "a" * 30, GITHUB_TOKEN, PRIVATE_KEY):
            self.assertRegex(text, collector.SECRET_TEXT)
        for text in ("task-" + "a" * 30, "AKIA" + "short", "gh" + "p_short"):
            self.assertNotRegex(text, collector.SECRET_TEXT)
        for path in (COLLECT, FINGERPRINT, Path(__file__)):
            self.assertNotRegex(path.read_text(encoding="utf-8"), collector.SECRET_TEXT, path)


class ConsistencyTests(Fixture):
    def setUp(self):
        super().setUp()
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "first\n")

    def test_change_between_reads_triggers_a_successful_retry(self):
        calls = []

        def write_once():
            calls.append(None)
            if len(calls) == 1:
                self.write("a.txt", "second\n")

        with mock.patch.object(collector, "between_reads", write_once):
            files = self.collect()
        self.assertEqual(len(calls), 2)
        self.assertEqual(files["a.txt"]["patch"], "@@ -1 +1 @@\n-a\n+second\n")

    def test_an_edit_restored_before_the_second_read_cannot_mix_versions(self):
        real, calls = collector.content, []

        def edit_and_restore(*args, **options):
            calls.append(None)
            if len(calls) > 1:
                return real(*args, **options)
            self.write("a.txt", "intruder\n")
            try:
                return real(*args, **options)
            finally:
                self.write("a.txt", "first\n")

        with mock.patch.object(collector, "content", edit_and_restore):
            files = self.collect()
        self.assertEqual(files["a.txt"]["patch"], "@@ -1 +1 @@\n-a\n+first\n")
        self.assertNotIn("intruder", json.dumps(self.review))

    def test_change_on_every_attempt_fails(self):
        calls = []

        def write_always():
            calls.append(None)
            self.write("a.txt", "x" * len(calls) + "\n")

        with mock.patch.object(collector, "between_reads", write_always), \
                self.assertRaisesRegex(collector.CollectError, "kept changing.*Collect again when writes finish"):
            self.collect()
        self.assertEqual(len(calls), collector.ATTEMPTS)


class HeadTests(Fixture):
    def test_unborn_head_needs_a_first_commit(self):
        self.write("a.txt", "a\n")
        with self.assertRaisesRegex(collector.CollectError, "no commit yet. Make a first commit"):
            self.collect()

    def test_detached_head_omits_branch(self):
        self.commit({"a.txt": "a\n"})
        self.git(self.root, "checkout", "-q", "--detach")
        self.write("a.txt", "b\n")
        self.collect()
        self.assertNotIn("branch", self.review["target"])
        self.assertEqual(self.review["target"]["title"], f"Uncommitted changes at {self.head()[:7]}")


class FingerprintTests(Fixture):
    def test_fingerprint_is_sha256_of_canonical_json(self):
        canonical = '{"new_blob":"b","new_mode":"100644","old_blob":"a","old_mode":"100644","old_path":null,"path":"café.txt"}'
        self.assertEqual(fingerprint.file_fingerprint("café.txt", None, "a", "b", "100644", "100644"),
                         hashlib.sha256(canonical.encode()).hexdigest())
        with self.assertRaisesRegex(ValueError, "not the all-zero object ID"):
            fingerprint.file_fingerprint("a.txt", None, "0" * 40, None, "100644", None)

    def test_fingerprints_follow_content_and_mode(self):
        self.commit({"same.txt": "s\n", "edit.txt": "e\n", "mode.txt": "m\n"})
        for name in ("same.txt", "edit.txt", "mode.txt"):
            self.write(name, "changed\n")
        first, second = self.collect(), self.collect()
        self.assertEqual({p: f["fingerprint"] for p, f in first.items()}, {p: f["fingerprint"] for p, f in second.items()})
        self.write("edit.txt", "changed again\n")
        (self.root / "mode.txt").chmod(0o755)
        third = self.collect()
        self.assertEqual(third["same.txt"]["fingerprint"], first["same.txt"]["fingerprint"])
        self.assertNotEqual(third["edit.txt"]["fingerprint"], first["edit.txt"]["fingerprint"])
        self.assertNotEqual(third["mode.txt"]["fingerprint"], first["mode.txt"]["fingerprint"])

    def test_cli_matches_the_collector_after_the_change_is_committed(self):
        self.commit({"a.txt": "a\n", "old.txt": "o\n" * 5, "gone.txt": "g\n", "run.sh": "r\n"})
        self.write("a.txt", "a\nb\n")
        self.git(self.root, "mv", "old.txt", "new.txt")
        (self.root / "gone.txt").unlink()
        (self.root / "run.sh").chmod(0o755)
        self.write("added.txt", "new\n")
        os.symlink("a.txt", self.root / "link")
        files = self.collect()
        self.assertEqual(len(files), 6)
        self.commit(message="change")
        result = subprocess.run([sys.executable, str(FINGERPRINT), "--repo", str(self.root), "HEAD~1", "HEAD"],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {path: file["fingerprint"] for path, file in files.items()})

    def test_cli_compares_the_merge_base_with_the_head(self):
        self.commit({"a.txt": "a\n"})
        self.git(self.root, "checkout", "-q", "-b", "feature")
        self.commit({"feature.txt": "f\n"})
        self.git(self.root, "checkout", "-q", "main")
        self.commit({"main.txt": "m\n"})
        self.assertEqual(fingerprint.pr_fingerprints(self.root, "main", "feature"),
                         {"feature.txt": fingerprint.file_fingerprint("feature.txt", None, None, blob(b"f\n"), None, "100644")})

    def test_a_git_executable_inside_a_bare_repository_never_runs(self):
        self.commit({"a.txt": "a\n"})
        bare = self.base / "bare.git"
        self.git(self.base, "clone", "-q", "--bare", str(self.root), str(bare))
        marker = self.base / "bare-git-ran"
        (bare / "bin").mkdir()
        fake = bare / "bin/git"
        fake.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        fake.chmod(0o755)
        environment = dict(os.environ, PATH=str(bare / "bin") + os.pathsep + os.environ["PATH"])
        result = subprocess.run([sys.executable, str(FINGERPRINT), "--repo", str(bare), "HEAD", "HEAD"], capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 2)
        self.assertIn("inside the repository under review", result.stderr)
        self.assertFalse(marker.exists())

    def test_cli_errors(self):
        self.commit({"a.txt": "a\n"})
        plain = self.base / "plain"
        plain.mkdir()
        for repo, ref, message in ((self.root, "nosuch", "Error: nosuch does not name a commit"), (plain, "HEAD", "Error: not a git repository")):
            result = subprocess.run([sys.executable, str(FINGERPRINT), "--repo", str(repo), ref, "HEAD"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertTrue(result.stderr.startswith(message), result.stderr)


class OutputTests(Fixture):
    def setUp(self):
        super().setUp()
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")

    def test_refuses_output_inside_the_working_tree(self):
        code, _, err = self.main("--output", str(self.root / "review.json"))
        self.assertEqual(code, 2)
        self.assertRegex(err, r"^Error: --output .* is inside the working tree")
        self.assertFalse((self.root / "review.json").exists())

    def test_refuses_git_files_as_output(self):
        head = (self.root / ".git" / "HEAD").read_bytes()
        for name in ("HEAD", "config", "review.json"):
            with self.subTest(name=name):
                code, _, err = self.main("--output", str(self.root / ".git" / name))
                self.assertEqual(code, 2)
                self.assertIn("is inside the Git directory, where it could replace Git's own files", err)
        self.assertEqual((self.root / ".git" / "HEAD").read_bytes(), head)
        self.assertFalse((self.root / ".git" / "review.json").exists())

    def test_a_worktree_setting_that_leads_to_another_repository_is_refused(self):
        other = self.init(self.base / "other")
        self.commit({"theirs.txt": "t\n"}, root=other)
        self.write("theirs.txt", "changed\n", root=other)
        self.git(self.root, "config", "core.worktree", str(other))
        with self.assertRaisesRegex(collector.CollectError, "sets core.worktree to .*another repository"):
            self.collect()

    def test_notices_escape_control_characters_in_paths(self):
        self.write("a\nLikely secret, contents left out: forged/.env", "A=1\n")
        code, out, _ = self.main("--output", str(self.base / "review.json"))
        self.assertEqual(code, 0)
        self.assertIn('Likely secret, contents left out: "a\\nLikely secret, contents left out: forged/.env"\n', out)
        self.assertNotIn("\nLikely secret, contents left out: forged/.env\n", out)

    def test_refuses_a_symlinked_output(self):
        outside = self.base / "outside.json"
        os.symlink(outside, self.root / "review.json")
        code, _, err = self.main("--output", str(self.root / "review.json"))
        self.assertEqual(code, 2)
        self.assertIn("is a symbolic link", err)
        self.assertTrue((self.root / "review.json").is_symlink())
        self.assertFalse(outside.exists())

    def test_writes_private_valid_output_inside_the_git_directory(self):
        (self.root / ".git" / "review-canvas").mkdir()
        output = self.root / ".git" / "review-canvas" / "review.json"
        code, out, _ = self.main("--output", str(output))
        self.assertEqual(code, 0)
        self.assertEqual(out, f"Wrote {output} (1 file; 0 binary; 0 too large; 0 likely secret)\n")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(list(output.parent.glob(".review.json.*")), [])
        review = renderer.load_review(output)
        self.assertEqual([file["path"] for file in self.collect().values()], ["a.txt"])  # the snapshot is not a change itself
        self.assertIn("<!doctype html>", renderer.render_review(review))

    def test_cli_end_to_end(self):
        output = self.base / "review.json"
        result = subprocess.run([sys.executable, str(COLLECT), "--repo", str(self.root), "--output", str(output), "--title", "Check"],
                                capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(result.stdout, f"Wrote {output} (1 file; 0 binary; 0 too large; 0 likely secret)\n")
        review = renderer.load_review(output)
        self.assertEqual((review["target"]["title"], review["files"][0]["patch"]), ("Check", "@@ -1 +1 @@\n-a\n+b\n"))
        plain = self.base / "plain"
        plain.mkdir()
        result = subprocess.run([sys.executable, str(COLLECT), "--repo", str(plain), "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr.startswith("Error: not a git repository"), result.stderr)


class IsolationTests(Fixture):
    def test_configuration_and_environment_cannot_redirect_output_or_run_programs(self):
        marker = self.base / "ran"
        tool = self.base / "tool.sh"
        tool.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
        tool.chmod(0o755)
        other = self.init(self.base / "other")
        self.commit({"other.txt": "o\n"}, root=other)
        self.commit({"code.txt": "a\n\nb\n", "naïve.txt": "n\n", "touched.txt": "t\n", ".gitattributes": "*.txt diff=tool\n"})
        self.write("code.txt", "a\n\nB\n")
        self.write("naïve.txt", "N\n")
        os.utime(self.root / "touched.txt", (1, 1))  # stat-only change: tempts Git to refresh and rewrite the index
        for key, value in (("diff.noprefix", "true"), ("diff.mnemonicPrefix", "true"), ("diff.suppressBlankEmpty", "true"),
                           ("color.ui", "always"), ("core.quotePath", "true"), ("diff.external", str(tool)),
                           ("diff.tool.textconv", str(tool)), ("diff.tool.command", str(tool)), ("core.fsmonitor", str(tool))):
            self.git(self.root, "config", key, value)
        marker.unlink(missing_ok=True)
        git_dir = self.root / ".git"
        before = {path: path.read_bytes() for path in git_dir.rglob("*") if path.is_file()}
        hostile = {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other), "GIT_INDEX_FILE": str(self.base / "index")}
        with mock.patch.dict(os.environ, hostile):
            files = self.collect()
        self.assertEqual(sorted(files), ["code.txt", "naïve.txt"])
        self.assertEqual(files["code.txt"]["patch"], "@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n")
        self.assertFalse(marker.exists())
        self.assertEqual({path: path.read_bytes() for path in git_dir.rglob("*") if path.is_file()}, before)

    def test_global_attributes_cannot_hide_a_text_patch(self):
        attributes = self.base / "attributes"
        attributes.write_text("* -diff\n")
        config = self.base / "global-config"
        config.write_text(f"[core]\n\tattributesFile = {attributes}\n")
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(config)}):
            files = self.collect()
        self.assertEqual(files["a.txt"]["patch"], "@@ -1 +1 @@\n-a\n+b\n")

    def test_configured_filter_drivers_never_run(self):
        marker = self.base / "filter-ran"
        tool = self.base / "filter.sh"
        tool.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n")
        tool.chmod(0o755)
        lines = "".join(f"line {i}\n" for i in range(10))
        self.commit({".gitattributes": "*.txt filter=mark\n", "a.txt": "a\n", "old.txt": lines})
        self.write("a.txt", "b\n")
        self.write("new.txt", lines + "more\n")
        self.git(self.root, "rm", "-q", "--cached", "old.txt")
        (self.root / "old.txt").unlink()
        self.git(self.root, "add", "-N", "new.txt")
        # Configure the driver last: from here on, any git diff that compares these files would run it.
        for key in ("clean", "smudge", "process"):
            self.git(self.root, "config", f"filter.mark.{key}", str(tool))
        self.git(self.root, "config", "filter.mark.required", "true")
        files = self.collect()
        self.assertFalse(marker.exists(), "a configured filter driver ran")
        self.assertEqual(files["a.txt"]["patch"], "@@ -1 +1 @@\n-a\n+b\n")
        self.assertEqual(files["new.txt"]["old_path"], "old.txt")

    def test_a_git_file_in_the_repository_never_runs_through_a_relative_path_entry(self):
        marker = self.base / "fake-git-ran"
        fake = self.root / "git"
        fake.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        fake.chmod(0o755)
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        with mock.patch.dict(os.environ, {"PATH": "." + os.pathsep + os.pathsep + os.environ["PATH"]}):
            files = self.collect()
        self.assertFalse(marker.exists(), "the repository's git file ran")
        self.assertEqual(files["a.txt"]["patch"], "@@ -1 +1 @@\n-a\n+b\n")

    def test_the_lock_the_final_check_and_the_write_use_one_resolved_path(self):
        import review_state
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        round_dir = review_state.new_round(self.base / "state")
        alias = self.base / "alias"
        os.symlink(round_dir, alias)
        seen = []
        def record(real):
            return lambda path, *rest: (seen.append(Path(path)), real(path, *rest))[1]
        with mock.patch.object(review_state, "round_lock", record(review_state.round_lock)), \
                mock.patch.object(collector, "rendered_round_input", record(collector.rendered_round_input)), \
                mock.patch.object(collector, "write_atomic", record(collector.write_atomic)):
            code, _, err = self.main("--output", str(alias / "input.json"))
        self.assertEqual(code, 0, err)
        self.assertEqual(len(seen), 4)  # the check in collect, the lock, the final check, and the write
        self.assertEqual(set(seen), {round_dir.resolve() / "input.json"})

    def test_a_git_executable_inside_the_repository_never_runs(self):
        marker = self.base / "repo-git-ran"
        (self.root / "bin").mkdir()
        fake = self.root / "bin/git"
        fake.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
        fake.chmod(0o755)
        self.commit({"a.txt": "a\n"})
        with mock.patch.dict(os.environ, {"PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"]}), \
                self.assertRaisesRegex(collector.GitError, "inside the repository under review"):
            self.collect()
        self.assertFalse(marker.exists())

    def test_git_tracing_cannot_write_into_the_working_tree(self):
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        with mock.patch.dict(os.environ, {"GIT_TRACE": str(self.root / "trace.log"), "GIT_TRACE2_EVENT": str(self.root / "trace2.log")}):
            files = self.collect()
        self.assertEqual(sorted(files), ["a.txt"])
        self.assertFalse((self.root / "trace.log").exists())

    def test_git_config_cannot_hide_a_filter_from_discovery(self):
        marker = self.base / "filter-ran"
        tool = self.base / "filter.sh"
        tool.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n")
        tool.chmod(0o755)
        self.commit({".gitattributes": "*.txt filter=mark\n", "a.txt": "a\n"})
        self.write("a.txt", "b\n")
        self.git(self.root, "config", "filter.mark.clean", str(tool))
        empty = self.base / "empty-config"
        empty.write_text("")
        with mock.patch.dict(os.environ, {"GIT_CONFIG": str(empty)}):
            self.collect()
        self.assertFalse(marker.exists(), "a repository filter ran because GIT_CONFIG hid it from discovery")

    def test_filter_driver_names_that_are_not_utf8_stop_collection(self):
        self.commit({"a.txt": "a\n"})
        self.write("a.txt", "b\n")
        subprocess.run([b"git", b"config", b"filter.\xff.clean", b"cat"], cwd=self.root, check=True)
        with self.assertRaisesRegex(collector.CollectError, r"filter\.\\xff\.clean; its name is not valid UTF-8"):
            self.collect()


if __name__ == "__main__":
    unittest.main()
