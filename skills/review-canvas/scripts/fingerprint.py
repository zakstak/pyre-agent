#!/usr/bin/env python3
"""Fingerprint changed files so a reviewer's approval can carry over between review rounds while a file is unchanged.

A fingerprint is the SHA-256 of canonical JSON naming one exact version of one changed file: its path, its old
path when renamed, and the Git blob ID and mode on each side. Copy detection is off here and in the collector, so a
copy is an added file whose own content and mode the fingerprint covers. For a GitHub PR review, print the
fingerprints that match the PR's "Files changed" (the merge base compared with the head) from a local clone:

    python3 fingerprint.py --repo DIR BASE HEAD

Python 3.10+; standard library only. Git runs without a shell, with options and environment that keep user
configuration from changing its output, starting helper programs, or selecting a different repository.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


# These would point Git at another repository, index, or object store, or change pathspec and diff parsing.
DROPPED_ENV = {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
               "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF",
               # Grafts and a shallow file rewrite ancestry, which GIT_NO_REPLACE_OBJECTS does not cover.
               "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
               "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
               # GIT_CONFIG redirects git config but no other command, so filter discovery would read a different file.
               "GIT_CONFIG"}
# diff.autoRefreshIndex=false stops `git diff` from rewriting .git/index; callers drop stat-only entries by blob ID.
GIT_CONFIG = tuple(arg for setting in (
    "core.fsmonitor=false", "core.quotePath=false", "diff.suppressBlankEmpty=false", "diff.noprefix=false",
    "diff.mnemonicPrefix=false", "diff.relative=false", "diff.autoRefreshIndex=false",
    "diff.renameLimit=0",  # 0 is unlimited, so renames never depend on user configuration
    # A stale untracked cache could hide new files; listing them directly costs little.
    "core.untrackedCache=false") for arg in ("-c", setting))
# Submodules compare by commit only, so Git never runs inside them to check for local edits.
DIFF_FLAGS = ("--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "-M")


class GitError(RuntimeError):
    """A Git command failed or could not start."""


def trusted_path():
    """PATH without relative entries. With cwd set, a relative entry such as . would find a git file in the repository."""
    return os.pathsep.join(entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry and os.path.isabs(entry))


def repository_top(path):
    """The working tree root above path, found without running Git: the nearest directory holding .git."""
    for directory in (Path(path).resolve(), *Path(path).resolve().parents):
        if os.path.lexists(directory / ".git"):
            return directory
    return None


def configured_worktrees(repo):
    """Every working tree that core.worktree names in repo's config, read without running Git.

    The checkout under review may sit there, outside repo, so a git inside it must be refused before Git first runs.
    Included files count too, whatever their condition: refusing a git under a tree Git would not use costs nothing."""
    top = repository_top(repo)
    git_dir = top / ".git" if top is not None else Path(repo).resolve()
    if git_dir.is_file():  # a linked worktree or submodule: .git names the Git directory
        text = git_dir.read_text(errors="replace").strip()
        git_dir = (git_dir.parent / text.removeprefix("gitdir:").strip()).resolve() if text.startswith("gitdir:") else git_dir
    found, seen = [], set()

    def read(path, depth):
        if depth > 10 or path in seen:
            return
        seen.add(path)
        try:
            text = path.read_text(errors="surrogateescape")
        except OSError:
            return
        for section, key, value in config_entries(text):
            if value is None:
                continue
            if section == "core" and key == "worktree":
                found.append((git_dir / value).resolve())  # relative to the Git directory, as Git reads it
            elif (section == "include" or section.startswith("includeif.")) and key == "path":
                read((path.parent / Path(value).expanduser()).resolve(), depth + 1)

    for name in ("config", "config.worktree"):
        read(git_dir / name, 0)
    return found


CONFIG_ESCAPES = {"n": "\n", "t": "\t", "b": "\b", '"': '"', "\\": "\\"}


def config_entries(text):
    """Yield (section, key, value) from Git config text, decoded as Git's parser does: quotes removed, the escapes
    \\n \\t \\b \\" \\\\ decoded, a backslash before a line break continuing the line, comments after an unquoted
    # or ; dropped, and unquoted spaces trimmed at the ends. section is lowercase, with ".subsection" appended. A key with
    no = has the value None. Parsing stops at a line Git would reject, since Git then refuses the whole file."""
    i, n, section = 0, len(text), ""
    while i < n:
        character = text[i]
        if character in " \t\r\n":
            i += 1
        elif character in "#;":
            i = text.find("\n", i) + 1 or n
        elif character == "[":
            end = text.find("]", i)
            if end < 0:
                return
            name, _, subsection = text[i + 1:end].strip().partition(" ")
            subsection = subsection.strip()
            if subsection.startswith('"') and subsection.endswith('"'):
                subsection = re.sub(r'\\(.)', r'\1', subsection[1:-1])
            section = name.lower() + (f".{subsection}" if subsection else "")
            i = end + 1
        else:
            match = re.match(r"[A-Za-z][A-Za-z0-9-]*", text[i:])
            if not match:
                return
            key, i = match.group(0).lower(), i + len(match.group(0))
            while i < n and text[i] in " \t":
                i += 1
            if i >= n or text[i] != "=":
                yield section, key, None
                continue
            value, spaces, quoted, i = [], 0, False, i + 1
            while i < n and text[i] in " \t":
                i += 1
            while i < n:
                character = text[i]
                i += 1
                if character == "\n":
                    if quoted:
                        return
                    break
                if not quoted and character in " \t":
                    spaces += 1 if value else 0
                    continue
                if not quoted and character in "#;":
                    i = text.find("\n", i) + 1 or n
                    break
                value.append(" " * spaces)
                spaces = 0
                if character == "\\":
                    escaped = text[i] if i < n else ""
                    i += 1
                    if escaped == "\n":
                        continue  # the value continues on the next line
                    if escaped not in CONFIG_ESCAPES:
                        return
                    value.append(CONFIG_ESCAPES[escaped])
                elif character == '"':
                    quoted = not quoted
                else:
                    value.append(character)
            yield section, key, "".join(value)


def git_executable(repo=None):
    """The git to run: the first in an absolute PATH directory, and never one inside the repository under review."""
    executable = shutil.which("git", path=trusted_path())
    if executable is None:
        raise GitError("git was not found in any absolute PATH directory")
    # A bare repository has no .git child, so the supplied path itself counts too, as does a core.worktree elsewhere.
    roots = [] if repo is None else [Path(repo).resolve(), repository_top(repo), *configured_worktrees(repo)]
    if any(root is not None and Path(executable).resolve().is_relative_to(root) for root in roots):
        raise GitError(f"git resolves to {executable}, inside the repository under review. Put the system git earlier in PATH.")
    return executable


def git(cwd, *args, ok=(0,), env=None, into=None):
    """Run Git in cwd and return stdout bytes, or stream stdout into an open file when given. Exit codes outside ok
    raise GitError."""
    executable = git_executable()
    # Tracing variables would make every call append to a file, which could sit in the working tree.
    environment = {key: value for key, value in os.environ.items() if key not in DROPPED_ENV and not key.startswith("GIT_TRACE")}
    environment["PATH"] = trusted_path()
    # GIT_NO_LAZY_FETCH keeps a partial clone from fetching missing objects over the network.
    # An empty graft file replaces .git/info/grafts, whose fake ancestry would otherwise move the merge base.
    environment.update(GIT_LITERAL_PATHSPECS="1", GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1",
                       GIT_GRAFT_FILE=os.devnull, **(env or {}))
    try:
        result = subprocess.run([executable, *GIT_CONFIG, *args], cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                stdout=into or subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        raise GitError(f"cannot run git in {cwd}: {error.strerror}") from error
    if result.returncode not in ok:
        message = result.stderr.decode("utf-8", "replace").strip().removeprefix("fatal: ")
        raise GitError(message or f"git exited with status {result.returncode}")
    return result.stdout or b""


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
        git_executable(args.repo)
        result = pr_fingerprints(args.repo, args.base, args.head)
    except (GitError, ValueError) as error:
        import render_review
        print(f"Error: {render_review.escaped(error)}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
