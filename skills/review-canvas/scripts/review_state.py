#!/usr/bin/env python3
"""Lay out a review's state directory, where each file has exactly one writer.

    rounds/NNNN/input.json   the agent: the collector skeleton, then analysis
    rounds/NNNN/review.html  render_review.py --round
    current                  render_review.py --round, after the round's page is written
    feedback.json            serve_review.py, for the browser
    server.json              serve_review.py, while it runs
    server.lock              held by the running serve_review.py, so only one serves a review
    publish.lock             held while render_review.py --round publishes

A round directory never changes after it renders. The directory and its subdirectories are mode 0700, and the
files are mode 0600. For a working tree, use $(git rev-parse --absolute-git-dir)/review-canvas, so parallel Git
worktrees keep separate state. For a PR review, use a private temporary directory.

    python3 review_state.py new-round --state-dir STATE      # prints the new round directory
    python3 review_state.py archive --state-dir STATE        # moves a finished review aside before an unrelated one

Python 3.10+; standard library only.
"""

import argparse
import contextlib
import datetime
import errno
import os
import re
import stat
import struct
import sys
import tempfile
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt


ROUND_NAME = re.compile(r"[0-9]{4}")
# Ownership and mode bits prove privacy only where POSIX permissions apply and every ACL can be read. Python reads
# ACLs only on Linux, through extended attributes; on macOS and elsewhere an ACL could grant access unseen.
PRIVACY_CHECKABLE = hasattr(os, "getuid") and hasattr(os, "getxattr")


class StateError(ValueError):
    """The state directory is missing, shared with other users, or not laid out as expected."""


def _group_has_others(gid):
    import grp
    import pwd
    try:
        members = set(grp.getgrgid(gid).gr_mem) | {user.pw_name for user in pwd.getpwall() if user.pw_gid == gid}
        return bool(members - {pwd.getpwuid(os.getuid()).pw_name})
    except KeyError:
        return True


def _acl_writers(path, gid):
    """The users and groups a POSIX access ACL lets write to path, or None when path has none or the platform cannot
    read one. With an ACL, the mode's group bits are only its mask, so they cannot say who may write."""
    try:
        os.getxattr(path, "system.nfs4_acl")
    except (AttributeError, OSError):
        pass
    else:
        raise StateError(f"{path} uses NFSv4 access control lists, which these scripts cannot check. "
                         "Keep the review state on a local filesystem, or render with render_review.py INPUT --output.")
    try:
        raw = os.getxattr(path, "system.posix_acl_access")
    except (AttributeError, OSError):
        return None
    if len(raw) < 4 or (len(raw) - 4) % 8 or struct.unpack_from("<I", raw)[0] != 2:
        raise StateError(f"cannot read the access control list of {path}")
    entries = [struct.unpack_from("<HHI", raw, offset) for offset in range(4, len(raw), 8)]
    mask = next((perm for tag, perm, _ in entries if tag == 0x10), 0o7)  # ACL_MASK limits every entry below
    users = {uid for tag, perm, uid in entries if tag == 0x02 and perm & mask & 0o2}  # ACL_USER
    groups = {gid if tag == 0x04 else id_ for tag, perm, id_ in entries if tag in (0x04, 0x08) and perm & mask & 0o2}  # ACL_GROUP_OBJ, ACL_GROUP
    return users, groups


def _others_can_replace(path, info):
    """Whether another user could rename or replace entries in a directory with this stat result."""
    if info.st_uid not in (0, os.getuid()):
        return True
    if info.st_mode & stat.S_ISVTX:
        return False  # sticky, as /tmp is: only an entry's owner can rename it
    if info.st_mode & 0o002:
        return True
    acl = _acl_writers(path, info.st_gid)
    if acl is None:
        return bool(info.st_mode & 0o020 and _group_has_others(info.st_gid))
    users, groups = acl
    return bool(users - {0, os.getuid()}) or any(_group_has_others(gid) for gid in groups)


def private_dir(path, create=False):
    """Return path as a directory only this user can read, creating it with mode 0700 when asked.

    Its resolved ancestors must also be safe from other users, who could otherwise swap in a directory of their own
    after the check, for example one holding a page that reads the session token."""
    if not PRIVACY_CHECKABLE:
        raise StateError("this platform cannot confirm that only you can read the review state. "
                         "Render with render_review.py INPUT --output and use export and import instead.")
    path = Path(path)
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        except OSError as error:
            raise StateError(f"cannot create {path}: {error.strerror}") from error
    if os.path.islink(path):
        raise StateError(f"{path} is a symbolic link; name the state directory itself")
    # Resolve first and check what the path resolves to: a symlink on the way could otherwise be retargeted between the
    # check and its use. Once no ancestor can be replaced by another user, the resolved path stays this directory.
    resolved = path.resolve()
    for parent in resolved.parents:
        if _others_can_replace(parent, os.stat(parent)):
            raise StateError(f"another user can rename or replace entries in {parent}, an ancestor of {path}. "
                             "Keep the review state under directories only you and root can change.")
    try:
        info = os.lstat(resolved)
    except OSError as error:
        raise StateError(f"{path} is not a review state directory: {error.strerror}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise StateError(f"{path} is not a directory")
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise StateError(f"{path} must belong to you and be private (mode 0700); other users could read the review")
    _acl_writers(resolved, info.st_gid)  # mode 0700 bounds a POSIX ACL; this refuses an ACL it cannot read
    return resolved


def write_private(path, data, replace=True):
    """Write bytes to a mode 0600 temporary file, then move it into place in one step.

    With replace=False, fail instead of replacing an existing file."""
    path = Path(path)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with open(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if replace:
            os.replace(temp, path)
        else:
            os.link(temp, path)
            os.unlink(temp)
    except BaseException:
        _remove_if_present(temp)
        raise
    # Flush the rename itself. Windows cannot open a directory this way, and some file systems cannot sync one; the
    # file is already in place, so only those cases are skipped.
    try:
        directory = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(directory)
    except OSError as error:
        if error.errno not in {errno.EINVAL, getattr(errno, "ENOTSUP", errno.EINVAL), getattr(errno, "EOPNOTSUPP", errno.EINVAL)}:
            raise
    finally:
        os.close(directory)


@contextlib.contextmanager
def lock(state, name, wait=True):
    """Hold an exclusive lock on STATE/NAME.lock. The system releases it when the process ends, even after a crash.

    With wait=False, raise StateError at once if another process holds it."""
    path = Path(state) / f"{name}.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            else:
                msvcrt.locking(fd, msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise StateError(f"another process holds {path}") from error
        yield
    finally:
        os.close(fd)


def _remove_if_present(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def new_round(state):
    """Create the next empty round directory and return it."""
    state = private_dir(state, create=True)
    rounds = private_dir(state / "rounds", create=True)
    number = max((int(entry.name) for entry in rounds.iterdir() if ROUND_NAME.fullmatch(entry.name)), default=0) + 1
    while number <= 9999:
        try:
            (rounds / f"{number:04d}").mkdir(mode=0o700)
            return rounds / f"{number:04d}"
        except FileExistsError:
            number += 1
    raise StateError(f"{rounds} has no free round number; start a new state directory")


def round_of(directory):
    """Return (state directory, round number) for a rounds/NNNN directory."""
    directory = Path(directory).resolve()
    if directory.parent.name != "rounds" or not ROUND_NAME.fullmatch(directory.name):
        raise StateError(f"{directory} is not a round directory: expected STATE/rounds/NNNN")
    private_dir(directory)
    return private_dir(directory.parent.parent), int(directory.name)


def read_current(state):
    """Return the published round number, or None before the first round renders."""
    try:
        text = (Path(state) / "current").read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as error:
        raise StateError(f"cannot read {state}/current: {error}") from error
    if not ROUND_NAME.fullmatch(text):
        raise StateError(f"{state}/current does not name a round")
    return int(text)


def publish(state, number, held=False):
    """Point current at a rendered round. A round never replaces a newer one, even when two renders finish together.

    Pass held=True when the caller already holds the publish lock."""
    with contextlib.nullcontext() if held else lock(state, "publish"):
        current = read_current(state)
        if current is not None and number < current:
            raise StateError(f"round {number:04d} is older than the published round {current:04d}")
        write_private(Path(state) / "current", f"{number:04d}\n".encode("ascii"))


def round_lock(input_path):
    """The publish lock of the review that holds a round's input, or no lock for an input outside a state directory.

    Rendering, the collector, and reply.py hold it from checking that a round has not rendered to writing, so none
    can change a round under another."""
    # Resolve aliases first, so a symlinked rounds directory still names the lock that rendering takes.
    path = Path(input_path).resolve()
    if path.name != "input.json" or path.parent.parent.name != "rounds" or not ROUND_NAME.fullmatch(path.parent.name):
        return contextlib.nullcontext()
    try:
        state = private_dir(path.parent.parent.parent)
    except StateError:
        return contextlib.nullcontext()  # not a review state directory, so no round to protect
    return lock(state, "publish")


def archive(state):
    """Move a finished review's state aside, so an unrelated review starts empty. Return the new location."""
    state = private_dir(state)
    # The publish lock waits for any render or input write to finish, so none lands in the moved or a new directory.
    with lock(state, "server", wait=False), lock(state, "publish"):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        destination = state.with_name(f"{state.name}.archived-{stamp}")
        os.rename(state, destination)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("new-round", help="Create the next round directory and print its path")
    create.add_argument("--state-dir", type=Path, required=True, help="The review's state directory; created if missing")
    aside = commands.add_parser("archive", help="Move a finished review's state aside and print where it went")
    aside.add_argument("--state-dir", type=Path, required=True, help="The review's state directory; no server may be running for it")
    args = parser.parse_args(argv)
    try:
        if args.command == "archive":
            try:
                print(archive(args.state_dir))
            except StateError as error:
                if "another process holds" in str(error):
                    raise StateError("a server still runs for this review; stop it before archiving") from None
                raise
        else:
            print(new_round(args.state_dir))
    except (StateError, OSError) as error:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import render_review
        print(f"Error: {render_review.escaped(error)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
