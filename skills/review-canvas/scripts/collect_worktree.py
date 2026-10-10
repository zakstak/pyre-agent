#!/usr/bin/env python3
"""Collect the uncommitted changes in a local Git working tree as a version 2 review-canvas input skeleton.

Compares HEAD with the working tree: staged, unstaged, and untracked (not ignored) files. Every file starts in the
core group with no analysis; the agent adds both before rendering. Likely secret files keep their entry and stats,
but their contents are left out unless named with --include-secret-file.

Python 3.10+; standard library only. Git runs without a shell and never writes to the repository. Configured
filter drivers are switched off for every Git call, so nothing from the repository or its configuration is executed.
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_review  # noqa: E402
from fingerprint import DIFF_FLAGS, GitError, decode_path, file_fingerprint, git, git_executable, raw_changes  # noqa: E402


ATTEMPTS = 3
STATUSES = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied", "T": "changed", "U": "modified"}
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SECRET_NAMES = {".env", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd", "credentials",
                "credentials.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx")
SAFE_ENV_SUFFIXES = (".example", ".sample", ".template", ".dist")
# Written with quantifiers and classes so this file never matches its own patterns.
SECRET_TEXT = re.compile(
    r"-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}"
    r"|\bAKIA[0-9A-Z]{16}\b"
    r"|\bgh[pousr]_[A-Za-z0-9]{36,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{22,}"
    r"|\bxox[abprs]-[A-Za-z0-9-]{10,}"
    r"|(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}")


class CollectError(ValueError):
    """The working tree cannot be collected as review input."""


class Changed(Exception):
    """The working tree changed while it was being read."""


def between_reads():
    """Runs between the snapshot and the confirming reread. Tests replace it to simulate a concurrent write."""


@contextlib.contextmanager
def reading(path):
    # A file that vanishes or changes type mid-read is a concurrent write; only a permission problem is final.
    try:
        yield
    except PermissionError as error:
        raise CollectError(f"cannot read {path}: {error.strerror}") from error
    except OSError as error:
        raise Changed(f"{path}: {error.strerror}") from error


def blob_id(fmt, data):
    return hashlib.new(fmt, b"blob %d\0" % len(data) + data).hexdigest()


# O_NOFOLLOW and O_NONBLOCK exist only on POSIX; the file type check after opening covers every platform.
OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)


def filter_overrides(top):
    """Return -c options that switch off every configured filter driver.

    A clean or process filter is a command from Git configuration, and git diff runs it to compare working tree
    files, including during rename detection. With the drivers off, Git compares the bytes on disk, which are also
    what fingerprints hash."""
    try:
        listing = git(top, "config", "-z", "--get-regexp", r"^filter\.")
    except GitError:
        return ()  # no filter configured
    options, names = [], set()
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        key = entry.split(b"\n", 1)[0]
        try:
            names.add(key.decode("utf-8")[len("filter."):].rpartition(".")[0])
        except UnicodeDecodeError:
            # A replacement character would switch off a different driver and leave this one running.
            raise CollectError("cannot switch off the filter driver in " + key.decode("utf-8", "backslashreplace")
                               + "; its name is not valid UTF-8") from None
    for name in sorted(names):
        if "=" in name or not name:
            raise CollectError(f"cannot switch off the filter driver {name!r}; its name contains '=' or is empty")
        for setting in ("clean=", "smudge=", "process=", "required=false"):
            options += ["-c", f"filter.{name}.{setting}"]
    return tuple(options)


def read_blob(path, fmt, keep=0):
    """Stream a regular file into a Git blob ID with no filters. Keep its bytes only when it has at most keep bytes."""
    fd = os.open(path, OPEN_FLAGS)
    with open(fd, "rb") as handle:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Changed(f"{path} is no longer a regular file")
        digest = hashlib.new(fmt, b"blob %d\0" % info.st_size)
        size = lines = 0
        head, tail, kept = b"", b"\n", []
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
            lines += chunk.count(b"\n")
            tail = chunk[-1:]
            head += chunk[:8000 - len(head)]
            if size <= keep:
                kept.append(chunk)
    if size != info.st_size:
        raise Changed(f"{path} changed size while it was read")
    return {"blob": digest.hexdigest(), "size": size, "lines": lines + (tail != b"\n"), "binary": b"\0" in head,
            "mode": "100755" if info.st_mode & stat.S_IXUSR else "100644", "data": b"".join(kept) if size <= keep else None}


def repository_head(path):
    """The commit checked out in a submodule or nested repository, or None when it has none."""
    if not os.path.lexists(path / ".git"):  # without .git, Git would find the enclosing repository instead
        return None
    try:
        return git(path, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").decode().strip()
    except GitError:
        return None


def representable(path):
    if any(ord(c) < 32 and c not in "\t\n\r" for c in path):
        raise CollectError(f"path contains a control character, so review input cannot represent it: {path!r}")
    return path


def too_many(count):
    return CollectError(f"{count} changed files exceed the review limit of {render_review.MAX_FILES}. "
                        "Commit, stash, or ignore part of the work, then collect again.")


def link_blob(path, fmt):
    """A symlink's blob ID, which covers its target. With core.symlinks=false, Git checks a link out as a regular file
    holding the target, so that whole file is hashed instead."""
    try:
        return blob_id(fmt, os.readlink(os.fsencode(path)))
    except OSError:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise
    return read_blob(path, fmt)["blob"]


def disk_mode(path):
    """The Git mode of a working tree path, or None when it is absent."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISDIR(info.st_mode):
        return "160000"  # a checked-out submodule
    return "120000" if stat.S_ISLNK(info.st_mode) else "100755" if info.st_mode & stat.S_IXUSR else "100644"


def unfingerprintable(path):
    return CollectError(f"{path} is a nested repository or submodule with no commit checked out, so no fingerprint can cover "
                        "its contents. Commit in it, or ignore it, then collect again.")


def kind(mode):
    return {"160000": "submodule", "120000": "symlink"}.get(mode, "file")


def tracked_entry(top, change, fmt, config):
    path, old_mode, new_mode = representable(change["path"]), change["old_mode"], change["new_mode"]
    if change["status"] not in STATUSES:
        raise CollectError(f"unexpected Git status {change['status']} for {path}")
    # The current file decides what the reviewer sees: a symlink replaced by a file shows the file's contents.
    entry = {"path": path, "old_path": change["old_path"] and representable(change["old_path"]),
             "status": STATUSES[change["status"]], "untracked": False, "kind": kind(new_mode or old_mode), "hidden": change.get("hidden", False),
             "old_blob": change["old_blob"], "old_mode": old_mode, "new_blob": None, "new_mode": new_mode, "size": 0}
    full = top / path
    if new_mode == "160000":
        entry["new_blob"] = change["new_blob"] or repository_head(full)
        if entry["new_blob"] is None:
            raise unfingerprintable(path)
    elif new_mode == "120000":
        entry["new_blob"] = link_blob(full, fmt)
    elif new_mode and change["new_blob"] and not os.path.lexists(full):
        # A skip-worktree entry in a sparse checkout is staged but absent from disk; its content is the index blob.
        entry.update(new_blob=change["new_blob"], size=int(git(top, *config, "cat-file", "-s", change["new_blob"])), from_index=True)
    elif new_mode:
        blob = read_blob(full, fmt)
        entry.update(new_blob=blob["blob"], size=blob["size"], binary=blob["binary"])
    if entry["status"] == "modified" and entry["new_blob"] == entry["old_blob"]:
        if old_mode == new_mode:
            return None  # only the stat data changed; Git lists it because the index is never refreshed
        entry["status"] = "changed"
    entry["fingerprint"] = file_fingerprint(path, entry["old_path"], entry["old_blob"], entry["new_blob"], old_mode, new_mode)
    return entry


def untracked_entry(top, path, nested, fmt, modes_count=True):
    full = top / path
    entry = {"path": path, "old_path": None, "status": "added", "untracked": True, "old_blob": None, "old_mode": None, "size": 0}
    info = os.lstat(full)
    if nested:
        if not stat.S_ISDIR(info.st_mode):
            raise Changed(f"{path} is no longer a directory")
        entry.update(kind="submodule", new_mode="160000", new_blob=repository_head(full))
        if entry["new_blob"] is None:
            raise unfingerprintable(path)
    elif stat.S_ISLNK(info.st_mode):
        entry.update(kind="symlink", new_mode="120000", new_blob=blob_id(fmt, os.readlink(os.fsencode(full))))
    else:
        blob = read_blob(full, fmt)
        # With core.filemode off, Git adds a file as 100644 whatever its executable bit.
        entry.update(kind="file", new_mode=blob["mode"] if modes_count else "100644", new_blob=blob["blob"], size=blob["size"],
                     lines=blob["lines"], binary=blob["binary"])
    entry["fingerprint"] = file_fingerprint(path, None, None, entry["new_blob"], None, entry["new_mode"])
    return entry


def inventory(top, fmt, config):
    """Read HEAD and every changed path with its fingerprint. Equal reads before and after bracket a consistent snapshot."""
    try:
        head = git(top, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").decode().strip()
    except GitError:
        raise CollectError("HEAD has no commit yet. Make a first commit, then collect again.") from None
    try:
        branch = git(top, "symbolic-ref", "--quiet", "HEAD").decode("utf-8", "replace").strip().removeprefix("refs/heads/")
    except GitError:
        branch = None  # detached HEAD
    if git(top, "ls-files", "-z", "--unmerged"):
        # git diff HEAD hides a conflict whose working tree bytes match HEAD, so the snapshot would look clean.
        raise CollectError("the index has unresolved merge conflicts. Resolve and stage them, then collect again.")
    tracked = raw_changes(git(top, *config, "diff", "--raw", "-z", "--no-abbrev", *DIFF_FLAGS, "HEAD", "--"))
    tracked = assumed_unchanged(top, tracked, config)
    others = git(top, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")[:-1]
    if len(others) > render_review.MAX_FILES:
        raise too_many(len(others))
    modes_count = git_bool(top, "core.filemode")
    entries = {}
    for change in tracked:
        with reading(change["path"]):
            entry = tracked_entry(top, change, fmt, config)
        if entry:
            entries[entry["path"]] = entry
    for raw in others:
        # Git lists a nested repository as one directory entry ending in a slash.
        path = representable(decode_path(raw.removesuffix(b"/")))
        if path in entries:
            # git rm --cached deletes the path from Git but leaves the file: one path, two contradictory changes.
            raise CollectError(f"{path} is removed from Git's index but still on disk, as after git rm --cached. Restore it with "
                               "git restore --staged, or move or ignore the file, then collect again.")
        with reading(path):
            entries[path] = untracked_entry(top, path, raw.endswith(b"/"), fmt, modes_count)
    if len(entries) > render_review.MAX_FILES:
        raise too_many(len(entries))
    return {"head": head, "branch": branch, "entries": [entries[path] for path in sorted(entries)]}


def index_entries(top):
    """Map each index path to (mode, blob, tag), where tag is the ls-files -v letter: S marks skip-worktree."""
    tags = {decode_path(entry[2:]): entry[:1].decode("ascii") for entry in git(top, "ls-files", "-v", "-z").split(b"\0")[:-1]}
    entries = {}
    for entry in git(top, "ls-files", "-s", "-z").split(b"\0")[:-1]:
        info, raw = entry.split(b"\t", 1)
        mode, blob = info.decode("ascii").split(" ")[:2]
        entries[decode_path(raw)] = (mode, blob, tags.get(decode_path(raw), "H"))
    return entries


def git_bool(top, key):
    return git(top, "config", "--type=bool", "--default", "true", key).strip() == b"true"


def assumed_unchanged(top, tracked, config):
    """Compare files that Git trusts without reading by their bytes on disk: assume-unchanged files, and skip-worktree
    files that are present anyway. Git hides edits to both."""
    listing = git(top, "ls-files", "-v", "-z").split(b"\0")[:-1]
    # A lowercase tag marks assume-unchanged; S or s marks skip-worktree, read from the index only when absent.
    assumed = {decode_path(entry[2:]) for entry in listing
               if (entry[:1].islower() and entry[:1] != b"s") or (entry[:1] in b"Ss" and os.path.lexists(top / decode_path(entry[2:])))}
    if not assumed:
        return tracked
    changes = {change["path"]: change for change in tracked}
    head = {}
    for entry in git(top, *config, "ls-tree", "-z", "--full-tree", "HEAD", "--", *sorted(assumed)).split(b"\0")[:-1]:
        info, path = entry.split(b"\t", 1)
        mode, _, blob = info.decode("ascii").split(" ")
        head[decode_path(path)] = (mode, blob)
    index = index_entries(top)
    links_are_files = not git_bool(top, "core.symlinks")
    modes_count = git_bool(top, "core.filemode")
    for path in sorted(assumed):
        new_mode, indexed = disk_mode(top / path), index.get(path, ("",))[0]
        if links_are_files and indexed == "120000" and new_mode in ("100644", "100755"):
            new_mode = "120000"  # with core.symlinks off, Git checks a link out as a placeholder file and keeps the link mode
        elif not modes_count and indexed in ("100644", "100755") and new_mode in ("100644", "100755"):
            new_mode = indexed  # with core.filemode off, Git records the index mode, not the executable bit on disk
        elif new_mode == "160000" and indexed != "160000" and repository_head(top / path) is None:
            new_mode = None  # an ordinary directory replaced the file: a deletion, with its children collected as untracked
        if path in changes and not new_mode and path not in head:
            del changes[path]  # added to the index, then removed from disk: nothing changed between HEAD and the tree
        elif path in changes:
            changes[path].update(new_blob=None, new_mode=new_mode, status=changes[path]["status"] if new_mode else "D", hidden=True)
        elif path in head:
            old_mode, old_blob = head[path]
            changes[path] = {"status": "M" if new_mode else "D", "path": path, "old_path": None, "old_mode": old_mode,
                             "new_mode": new_mode, "old_blob": old_blob, "new_blob": None, "hidden": True}
    return list(changes.values())


def hidden_stats(top, entry, config):
    """Line counts for a file Git's own diff skips, such as one marked assume-unchanged: diff its exact bytes."""
    if entry["kind"] != "file":
        return 0, 0, False
    with tempfile.TemporaryDirectory(prefix="review-canvas-") as temp:
        old = os.devnull
        if entry["old_blob"]:
            old = str(Path(temp, "old"))
            with open(old, "wb") as handle:  # streamed, so a large blob never sits in memory
                git(top, *config, "cat-file", "blob", entry["old_blob"], into=handle)
        new = str(top / entry["path"]) if entry["new_mode"] else os.devnull
        output = git(temp, *config, "-c", f"core.attributesFile={os.devnull}", "diff", "--no-index", "--numstat", "--no-ext-diff",
                     "--no-textconv", "--", old, new, ok=(0, 1), env={"GIT_CEILING_DIRECTORIES": temp, "GIT_ATTR_NOSYSTEM": "1"})
    fields = output.split(b"\t")
    if len(fields) < 3:
        return 0, 0, False  # no difference in the bytes
    if fields[0] == b"-":
        return 0, 0, True  # binary
    return int(fields[0]), int(fields[1]), False


def numstat(top, config):
    """Map each tracked path to (additions, deletions, binary)."""
    fields = git(top, *config, "diff", "--numstat", "-z", *DIFF_FLAGS, "HEAD", "--").split(b"\0")
    stats, i = {}, 0
    while i < len(fields) and fields[i]:
        additions, deletions, path = fields[i].split(b"\t", 2)
        if path:
            i += 1
        else:  # a rename: the old and new paths follow as separate fields
            path, i = fields[i + 2], i + 3
        binary = additions == b"-"
        stats[decode_path(path)] = (0 if binary else int(additions), 0 if binary else int(deletions), binary)
    return stats


def secret_name(path):
    name = path.rpartition("/")[2].lower()
    if name == ".env" or name.startswith(".env."):
        return not name.endswith(SAFE_ENV_SUFFIXES)
    return name in SECRET_NAMES or name.endswith(SECRET_SUFFIXES)


def clean_text(data):
    """Decode patch bytes for display. Return (text, whether any byte or control character was replaced)."""
    try:
        text, replaced = data.decode("utf-8"), False
    except UnicodeDecodeError:
        text, replaced = data.decode("utf-8", "replace"), True
    cleaned = CONTROL.sub(lambda match: chr(0x2421 if match[0] == "\x7f" else 0x2400 + ord(match[0])), text)
    return cleaned, replaced or cleaned != text


def text_patch(old, new, config):
    """Diff two byte strings with Git's own algorithm, outside any repository. Return (patch_note, hunks)."""
    with tempfile.TemporaryDirectory(prefix="review-canvas-") as temp:
        names = []
        for name, data in (("old", old), ("new", new)):
            if data is None:
                names.append(os.devnull)
            else:
                Path(temp, name).write_bytes(data)
                names.append(name)
        # The ceiling keeps Git from finding a repository, and its attributes, above the temporary directory.
        # No attributes apply: a global core.attributesFile with * -diff would otherwise call text binary.
        output = git(temp, *config, "-c", f"core.attributesFile={os.devnull}", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", *names,
                     ok=(0, 1), env={"GIT_CEILING_DIRECTORIES": str(Path(temp).parent), "GIT_ATTR_NOSYSTEM": "1"})
    at = output.find(b"\n@@")
    header = output if at < 0 else output[:at]
    if any(line.startswith(b"Binary files ") and line.endswith(b" differ") for line in header.split(b"\n")):
        return "binary", None
    if at < 0:
        return "no_content_change", None
    return None, output[at + 1:]


def content(top, entry, fmt, binary, allow_secret, oversized, config):
    """Return (patch_note, patch bytes): bytes for a text diff, otherwise a note saying why there is none.

    The patch is built from the exact bytes the fingerprint covers: the old blob read from the object store, and the
    file read again and checked against its fingerprint. Diffing one pair of files never picks up a neighbor."""
    path = entry["path"]
    if entry["kind"] != "file":
        return entry["kind"], None
    if entry["old_blob"] == entry["new_blob"]:
        return "no_content_change", None
    if not allow_secret and any(p and secret_name(p) for p in (path, entry["old_path"])):
        return "secret", None
    # Binary means NUL bytes in the content, never a diff attribute: a text file marked -diff still shows its patch.
    if binary:
        return "binary", None
    # A symlink or submodule replaced by a file has no text on its old side, so the file reads as new.
    old_blob = entry["old_blob"] if kind(entry["old_mode"]) == "file" else None
    old_size = int(git(top, *config, "cat-file", "-s", old_blob)) if old_blob else 0
    if not old_size and not entry["size"]:
        return "empty", None
    if oversized or max(old_size, entry["size"]) > 4 * render_review.MAX_PATCH_CHARS:
        return "too_large", None
    old = git(top, *config, "cat-file", "blob", old_blob) if old_blob else None
    new = None
    if entry.get("from_index"):
        new = git(top, *config, "cat-file", "blob", entry["new_blob"])
    elif entry["new_blob"] is not None:
        with reading(path):
            blob = read_blob(top / path, fmt, keep=entry["size"])
        if blob["blob"] != entry["new_blob"] or blob["data"] is None:
            raise Changed(f"{path} changed while it was read")
        new = blob["data"]
    if any(b"\0" in data[:8000] for data in (old, new) if data):
        return "binary", None
    return text_patch(old, new, config)


def build(top, snapshot, fmt, include, config):
    """Turn an inventory into review file entries. Return (files, secret-flagged paths)."""
    stats = numstat(top, config)
    files, flagged = [], []
    total_lines = total_bytes = 0
    for entry in snapshot["entries"]:
        path = entry["path"]
        binary = entry.get("binary", False)
        if entry["untracked"]:
            additions, deletions = (entry["lines"] if entry["kind"] == "file" and not binary else 0), 0
        elif path in stats and (binary or not stats[path][2]):
            additions, deletions, _ = stats[path]
        elif entry.get("hidden") or path in stats:
            # numstat skipped the file, or called its text binary because of a diff attribute: count the exact bytes.
            additions, deletions, _ = hidden_stats(top, entry, config)
        else:
            additions, deletions = 0, 0
        file = {"path": path, "status": entry["status"], "group": "core", "additions": additions, "deletions": deletions,
                "fingerprint": entry["fingerprint"]}
        if entry["old_path"]:
            file["old_path"] = entry["old_path"]
        for side in ("old_mode", "new_mode"):
            if entry[side]:
                file[side] = entry[side]
        budget = min(render_review.MAX_PATCH_LINES, render_review.MAX_TOTAL_PATCH_LINES - total_lines)
        note, data = content(top, entry, fmt, binary, path in include, additions + deletions > budget, config)
        if data is not None:
            patch, replaced = clean_text(data)
            hunk_lines = patch.split("\n")
            file["additions"] = sum(line.startswith("+") for line in hunk_lines)
            file["deletions"] = sum(line.startswith("-") for line in hunk_lines)
            lines = patch.count("\n") + (not patch.endswith("\n"))
            size = len(json.dumps(patch, ensure_ascii=False).encode())
            if path not in include and SECRET_TEXT.search(patch):
                note = "secret"
            # Patches may fill half of the renderer's input limit, leaving room for paths and the agent's analysis.
            elif render_review.units(patch) > render_review.MAX_PATCH_CHARS or lines > budget or total_bytes + size > render_review.MAX_INPUT_BYTES // 2:
                note = "too_large"
            else:
                total_lines += lines
                total_bytes += size
                file.update(patch=patch, patch_complete=True)
                note = "replaced_characters" if replaced else None
        if note == "too_large":
            file["patch_complete"] = False
        if note == "secret":
            flagged.append(path)
        if note:
            file["patch_note"] = note
        files.append(file)
    return files, flagged


def collect(repo, title=None, include_secret=(), output=None):
    """Return (validated review, secret-flagged paths) for the working tree containing repo."""
    git_executable(repo)  # before any Git call: a git inside the repository would be code from the change
    top = Path(decode_path(git(repo, "rev-parse", "--show-toplevel").removesuffix(b"\n")))
    if output is not None:
        git_dir = Path(decode_path(git(top, "rev-parse", "--absolute-git-dir").removesuffix(b"\n")))
        # Replacing a symlink writes a regular file where the link was, so judge the link's own location.
        if os.path.islink(output):
            raise CollectError(f"--output {output} is a symbolic link; name the real file instead")
        destination = Path(output).absolute().parent.resolve() / Path(output).name
        if destination.is_relative_to(top.resolve()) and not destination.is_relative_to(git_dir.resolve()):
            raise CollectError(f"--output {output} is inside the working tree, where the snapshot would become an untracked "
                               f"change of its own. Write it outside {top} or inside {git_dir}.")
    fmt = git(top, "rev-parse", "--show-object-format").decode().strip()
    config = filter_overrides(top)
    if Path(tempfile.gettempdir()).resolve().is_relative_to(top.resolve()):
        # Scratch diffs hold copies of the reviewed files; they must never land inside the tree they come from.
        raise CollectError(f"the temporary directory {tempfile.gettempdir()} is inside the working tree. Set TMPDIR elsewhere.")
    include = set(include_secret)
    reason = "HEAD or a changed file differed between two reads"
    for _ in range(ATTEMPTS):
        try:
            snapshot = inventory(top, fmt, config)
            unknown = include - {entry["path"] for entry in snapshot["entries"]}
            if unknown:
                raise CollectError("--include-secret-file names a path that is not a changed file: " + ", ".join(sorted(unknown)))
            files, flagged = build(top, snapshot, fmt, include, config)
            between_reads()
            if inventory(top, fmt, config) == snapshot:
                break
            reason = "HEAD or a changed file differed between two reads"
        except Changed as change:
            reason = str(change)
    else:
        raise CollectError(f"the working tree kept changing during {ATTEMPTS} attempts ({reason}). "
                           "Collect again when writes finish.")
    head, branch = snapshot["head"], snapshot["branch"]
    target = {"kind": "worktree", "title": title if title is not None else
              f"Uncommitted changes on {branch}" if branch else f"Uncommitted changes at {head[:7]}",
              "root": str(top), "head_sha": head}
    if branch:
        target["branch"] = branch
    target["changed_files"] = len(files)
    review = {"schema_version": 2, "target": target, "files_complete": True, "files": files}
    return render_review.validate_review(review), flagged


def staged_differently(top, config):
    """Paths whose staged version differs from both HEAD and the working tree. The review shows the working tree, but a
    commit records the staged version."""
    fmt = git(top, "rev-parse", "--show-object-format").decode().strip()
    staged = {decode_path(path) for path in git(top, *config, "diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--").split(b"\0") if path}
    # With core.filemode off, Git ignores the executable bit on disk, so only content can differ.
    modes_count = git_bool(top, "core.filemode")
    links_are_links = git_bool(top, "core.symlinks")
    found = []
    index = index_entries(top)
    # A staged deletion has no index entry; a file kept on disk at that path means the commit removes what was reviewed.
    found += [path for path in staged - index.keys() if os.path.lexists(top / path)]
    for path, (mode, blob, tag) in index.items():
        full = top / path
        if path not in staged or (tag in "Ss" and not os.path.lexists(full)):
            continue  # unstaged, or a sparse entry whose staged blob is what the review showed
        try:
            if mode == "160000":
                differs = repository_head(full) != blob
            elif mode == "120000":
                # A regular file holding the target's bytes has the same blob; only the mode shows the type change.
                differs = link_blob(full, fmt) != blob or (links_are_links and disk_mode(full) != "120000")
            else:
                differs = read_blob(full, fmt)["blob"] != blob or (modes_count and disk_mode(full) != mode)
        except (OSError, Changed):
            differs = True
        if differs:
            found.append(path)
    return sorted(found)


def write_atomic(path, text):
    """Replace path in one step with a private file, so no reader sees a partial snapshot."""
    path = Path(path)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")  # created with mode 0600
    try:
        with open(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temp, path)
    except BaseException:
        os.unlink(temp)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path("."), help="Directory inside the working tree (default: current directory)")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Review JSON to write, outside the working tree or inside its Git directory")
    parser.add_argument("--title", help="Review title (default: Uncommitted changes on BRANCH)")
    parser.add_argument("--include-secret-file", action="append", default=[], metavar="PATH",
                        help="Include the contents of this likely secret file (exact repository-relative path; repeatable)")
    args = parser.parse_args(argv)
    try:
        review, flagged = collect(args.repo, args.title, args.include_secret_file, args.output)
        root = Path(review["target"]["root"])
        staged = staged_differently(root, filter_overrides(root))  # before writing, so a failure writes nothing
        write_atomic(args.output, json.dumps(review, ensure_ascii=False, indent=2) + "\n")
    except (ValueError, GitError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    notes = [file.get("patch_note") for file in review["files"]]
    count = len(notes)
    print(f"Wrote {args.output} ({count} file{'' if count == 1 else 's'}; {notes.count('binary')} binary; "
          f"{notes.count('too_large')} too large; {len(flagged)} likely secret)")
    for path in flagged:
        print(f"Likely secret, contents left out: {path}")
    for path in staged:
        print(f"Staged version differs from the reviewed file, so a commit would record unreviewed content: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
