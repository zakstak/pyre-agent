#!/usr/bin/env python3
"""Collect the uncommitted changes in a local Git working tree as a version 2 review-canvas input skeleton.

Compares HEAD with the working tree: staged, unstaged, and untracked (not ignored) files. Every file starts in the
core group with no analysis; the agent adds both before rendering. Likely secret files keep their entry and stats,
but their contents are left out unless named with --include-secret-file.

Python 3.10+; standard library only. Git runs without a shell and never writes to the repository, and nothing
from the repository is executed.
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
from fingerprint import DIFF_FLAGS, GitError, decode_path, file_fingerprint, git, raw_changes  # noqa: E402


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


def read_blob(path, fmt, keep=0):
    """Stream a regular file into a Git blob ID with no filters. Keep its bytes only when it has at most keep bytes."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
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


def tracked_entry(top, change, fmt):
    path, old_mode, new_mode = representable(change["path"]), change["old_mode"], change["new_mode"]
    if change["status"] not in STATUSES:
        raise CollectError(f"unexpected Git status {change['status']} for {path}")
    entry = {"path": path, "old_path": change["old_path"] and representable(change["old_path"]),
             "status": STATUSES[change["status"]], "untracked": False,
             "kind": "submodule" if "160000" in (old_mode, new_mode) else "symlink" if "120000" in (old_mode, new_mode) else "file",
             "old_blob": change["old_blob"], "old_mode": old_mode, "new_blob": None, "new_mode": new_mode, "size": 0}
    full = top / path
    if new_mode == "160000":
        entry["new_blob"] = change["new_blob"] or repository_head(full)
    elif new_mode == "120000":
        entry["new_blob"] = blob_id(fmt, os.readlink(os.fsencode(full)))
    elif new_mode:
        blob = read_blob(full, fmt)
        entry.update(new_blob=blob["blob"], size=blob["size"])
    if entry["status"] == "modified" and entry["new_blob"] == entry["old_blob"]:
        if old_mode == new_mode:
            return None  # only the stat data changed; Git lists it because the index is never refreshed
        entry["status"] = "changed"
    entry["fingerprint"] = file_fingerprint(path, entry["old_path"], entry["old_blob"], entry["new_blob"], old_mode, new_mode)
    return entry


def untracked_entry(top, path, nested, fmt):
    full = top / path
    entry = {"path": path, "old_path": None, "status": "added", "untracked": True, "old_blob": None, "old_mode": None, "size": 0}
    info = os.lstat(full)
    if nested:
        if not stat.S_ISDIR(info.st_mode):
            raise Changed(f"{path} is no longer a directory")
        entry.update(kind="submodule", new_mode="160000", new_blob=repository_head(full))
    elif stat.S_ISLNK(info.st_mode):
        entry.update(kind="symlink", new_mode="120000", new_blob=blob_id(fmt, os.readlink(os.fsencode(full))))
    else:
        blob = read_blob(full, fmt)
        entry.update(kind="file", new_mode=blob["mode"], new_blob=blob["blob"], size=blob["size"],
                     lines=blob["lines"], binary=blob["binary"])
    entry["fingerprint"] = file_fingerprint(path, None, None, entry["new_blob"], None, entry["new_mode"])
    return entry


def inventory(top, fmt):
    """Read HEAD and every changed path with its fingerprint. Equal reads before and after bracket a consistent snapshot."""
    try:
        head = git(top, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").decode().strip()
    except GitError:
        raise CollectError("HEAD has no commit yet. Make a first commit, then collect again.") from None
    try:
        branch = git(top, "symbolic-ref", "--quiet", "HEAD").decode("utf-8", "replace").strip().removeprefix("refs/heads/")
    except GitError:
        branch = None  # detached HEAD
    tracked = raw_changes(git(top, "diff", "--raw", "-z", "--no-abbrev", *DIFF_FLAGS, "HEAD", "--"))
    others = git(top, "ls-files", "-z", "--others", "--exclude-standard").split(b"\0")[:-1]
    if len(others) > render_review.MAX_FILES:
        raise too_many(len(others))
    entries = {}
    for change in tracked:
        with reading(change["path"]):
            entry = tracked_entry(top, change, fmt)
        if entry:
            entries[entry["path"]] = entry
    for raw in others:
        # Git lists a nested repository as one directory entry ending in a slash.
        path = representable(decode_path(raw.removesuffix(b"/")))
        if path not in entries:  # a path removed from the index but kept on disk stays a deletion
            with reading(path):
                entries[path] = untracked_entry(top, path, raw.endswith(b"/"), fmt)
    if len(entries) > render_review.MAX_FILES:
        raise too_many(len(entries))
    return {"head": head, "branch": branch, "entries": [entries[path] for path in sorted(entries)]}


def numstat(top):
    """Map each tracked path to (additions, deletions, binary)."""
    fields = git(top, "diff", "--numstat", "-z", *DIFF_FLAGS, "HEAD", "--").split(b"\0")
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


def new_file_patch(data):
    """The hunk Git writes for a new file, built from bytes on disk without touching the index."""
    lines = data.split(b"\n")
    if data.endswith(b"\n"):
        lines.pop()
    header = b"@@ -0,0 +1 @@\n" if len(lines) == 1 else b"@@ -0,0 +1,%d @@\n" % len(lines)
    return header + b"".join(b"+" + line + b"\n" for line in lines) + (b"" if data.endswith(b"\n") else b"\\ No newline at end of file\n")


def content(top, entry, fmt, binary, allow_secret, oversized):
    """Return (patch_note, patch bytes): bytes for a text diff, otherwise a note saying why there is none."""
    path = entry["path"]
    if entry["kind"] != "file":
        return entry["kind"], None
    if entry["old_blob"] == entry["new_blob"]:
        return "no_content_change", None
    if not allow_secret and any(p and secret_name(p) for p in (path, entry["old_path"])):
        return "secret", None
    if binary:
        return "binary", None
    if entry["untracked"] and not entry["size"]:
        return "empty", None
    if oversized or entry["size"] > 4 * render_review.MAX_PATCH_CHARS:
        return "too_large", None
    if entry["untracked"]:
        with reading(path):
            blob = read_blob(top / path, fmt, keep=entry["size"])
        if blob["blob"] != entry["new_blob"] or blob["data"] is None:
            raise Changed(f"{path} changed while it was read")
        return None, new_file_patch(blob["data"])
    # Name both sides of a rename so Git pairs them; keep only the hunks, as GitHub's files API does.
    paths = [path, entry["old_path"]] if entry["old_path"] else [path]
    output = git(top, "diff", "-p", "--full-index", "--unified=3", *DIFF_FLAGS, "HEAD", "--", *paths)
    at = output.find(b"\n@@")
    header = output if at < 0 else output[:at]
    if any(line.startswith(b"Binary files ") and line.endswith(b" differ") for line in header.split(b"\n")):
        return "binary", None
    if at < 0:
        return ("empty" if entry["status"] in ("added", "deleted") else "no_content_change"), None
    return None, output[at + 1:]


def build(top, snapshot, fmt, include):
    """Turn an inventory into review file entries. Return (files, secret-flagged paths)."""
    stats = numstat(top)
    files, flagged = [], []
    total_lines = total_bytes = 0
    for entry in snapshot["entries"]:
        path = entry["path"]
        if entry["untracked"]:
            binary = entry.get("binary", False)
            additions, deletions = (entry["lines"] if entry["kind"] == "file" and not binary else 0), 0
        else:
            additions, deletions, binary = stats.get(path, (0, 0, False))
        file = {"path": path, "status": entry["status"], "group": "core", "additions": additions, "deletions": deletions,
                "fingerprint": entry["fingerprint"]}
        if entry["old_path"]:
            file["old_path"] = entry["old_path"]
        for side in ("old_mode", "new_mode"):
            if entry[side]:
                file[side] = entry[side]
        budget = min(render_review.MAX_PATCH_LINES, render_review.MAX_TOTAL_PATCH_LINES - total_lines)
        note, data = content(top, entry, fmt, binary, path in include, additions + deletions > budget)
        if data is not None:
            patch, replaced = clean_text(data)
            lines = patch.count("\n") + (not patch.endswith("\n"))
            size = len(json.dumps(patch, ensure_ascii=False).encode())
            if path not in include and SECRET_TEXT.search(patch):
                note = "secret"
            # Patches may fill half of the renderer's input limit, leaving room for paths and the agent's analysis.
            elif len(patch) > render_review.MAX_PATCH_CHARS or lines > budget or total_bytes + size > render_review.MAX_INPUT_BYTES // 2:
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
    top = Path(decode_path(git(repo, "rev-parse", "--show-toplevel").removesuffix(b"\n")))
    if output is not None:
        git_dir = Path(decode_path(git(top, "rev-parse", "--absolute-git-dir").removesuffix(b"\n")))
        destination = Path(output).resolve()
        if destination.is_relative_to(top.resolve()) and not destination.is_relative_to(git_dir.resolve()):
            raise CollectError(f"--output {output} is inside the working tree, where the snapshot would become an untracked "
                               f"change of its own. Write it outside {top} or inside {git_dir}.")
    fmt = git(top, "rev-parse", "--show-object-format").decode().strip()
    include = set(include_secret)
    reason = "HEAD or a changed file differed between two reads"
    for _ in range(ATTEMPTS):
        try:
            snapshot = inventory(top, fmt)
            unknown = include - {entry["path"] for entry in snapshot["entries"]}
            if unknown:
                raise CollectError("--include-secret-file names a path that is not a changed file: " + ", ".join(sorted(unknown)))
            files, flagged = build(top, snapshot, fmt, include)
            between_reads()
            if inventory(top, fmt) == snapshot:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
