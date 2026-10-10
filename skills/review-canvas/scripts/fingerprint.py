#!/usr/bin/env python3
"""Fingerprint changed files so a reviewer's approval can carry over between review rounds while a file is unchanged.

A fingerprint is the SHA-256 of canonical JSON naming one exact version of one changed file: its path, its old
path when renamed or copied, and the Git blob ID and mode on each side. For a GitHub PR review, print the
fingerprints that match the PR's "Files changed" (the merge base compared with the head) from a local clone:

    python3 fingerprint.py --repo DIR BASE HEAD

Python 3.10+; standard library only. Git runs without a shell, with options and environment that keep user
configuration from changing its output, starting helper programs, or selecting a different repository.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


# These would point Git at another repository, index, or object store, or change pathspec and diff parsing.
DROPPED_ENV = {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
               "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF",
               "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"}
# diff.autoRefreshIndex=false stops `git diff` from rewriting .git/index; callers drop stat-only entries by blob ID.
GIT_CONFIG = tuple(arg for setting in (
    "core.fsmonitor=false", "core.quotePath=false", "diff.suppressBlankEmpty=false", "diff.noprefix=false",
    "diff.mnemonicPrefix=false", "diff.relative=false", "diff.autoRefreshIndex=false") for arg in ("-c", setting))
# Submodules compare by commit only, so Git never runs inside them to check for local edits.
DIFF_FLAGS = ("--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "-M")


class GitError(RuntimeError):
    """A Git command failed or could not start."""


def git(cwd, *args, ok=(0,), env=None):
    """Run Git in cwd and return stdout bytes. Exit codes outside ok raise GitError."""
    environment = {key: value for key, value in os.environ.items() if key not in DROPPED_ENV}
    # GIT_NO_LAZY_FETCH keeps a partial clone from fetching missing objects over the network.
    environment.update(GIT_LITERAL_PATHSPECS="1", GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", **(env or {}))
    try:
        result = subprocess.run(["git", *GIT_CONFIG, *args], cwd=cwd, env=environment, stdin=subprocess.DEVNULL, capture_output=True)
    except OSError as error:
        raise GitError(f"cannot run git in {cwd}: {error.strerror}") from error
    if result.returncode not in ok:
        message = result.stderr.decode("utf-8", "replace").strip().removeprefix("fatal: ")
        raise GitError(message or f"git exited with status {result.returncode}")
    return result.stdout


def decode_path(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("path is not valid UTF-8, so review input cannot represent it: "
                         + raw.decode("utf-8", "backslashreplace")) from None


def raw_changes(data):
    """Parse `git diff --raw -z --no-abbrev` output. Absent modes and all-zero object IDs become None."""
    fields = data.split(b"\0")
    changes, i = [], 0
    while i < len(fields) and fields[i]:
        old_mode, new_mode, old_blob, new_blob, status = fields[i][1:].decode("ascii").split(" ")
        count = 2 if status[0] in "RC" else 1
        paths = [decode_path(raw) for raw in fields[i + 1:i + 1 + count]]
        i += 1 + count
        changes.append({"status": status[0], "path": paths[-1], "old_path": paths[0] if count == 2 else None,
                        "old_mode": None if old_mode == "000000" else old_mode,
                        "new_mode": None if new_mode == "000000" else new_mode,
                        "old_blob": old_blob if old_blob.strip("0") else None,
                        "new_blob": new_blob if new_blob.strip("0") else None})
    return changes


def file_fingerprint(path, old_path, old_blob, new_blob, old_mode, new_mode):
    """SHA-256 hex digest of one file version. Pass None for a side or rename source that does not exist."""
    for blob in (old_blob, new_blob):
        if blob is not None and not blob.strip("0"):
            raise ValueError("pass None for a missing blob, not the all-zero object ID")
    payload = json.dumps({"path": path, "old_path": old_path, "old_blob": old_blob, "new_blob": new_blob,
                          "old_mode": old_mode, "new_mode": new_mode},
                         sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def pr_fingerprints(repo, base, head):
    """Map each path changed between the merge base of base and head, and head, to its fingerprint."""
    git(repo, "rev-parse", "--git-dir")
    commits = []
    for ref in (base, head):
        try:
            commits.append(git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}").decode().strip())
        except GitError:
            raise GitError(f"{ref} does not name a commit in {repo}") from None
    try:
        merge_base = git(repo, "merge-base", *commits).decode().strip()
    except GitError:
        raise GitError(f"{base} and {head} have no merge base") from None
    changes = raw_changes(git(repo, "diff", "--raw", "-z", "--no-abbrev", *DIFF_FLAGS, merge_base, commits[1], "--"))
    return {c["path"]: file_fingerprint(c["path"], c["old_path"], c["old_blob"], c["new_blob"], c["old_mode"], c["new_mode"])
            for c in changes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path("."), help="Local clone of the PR's repository (default: current directory)")
    parser.add_argument("base", help="PR base branch or commit")
    parser.add_argument("head", help="PR head branch or commit")
    args = parser.parse_args(argv)
    try:
        result = pr_fingerprints(args.repo, args.base, args.head)
    except (GitError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
