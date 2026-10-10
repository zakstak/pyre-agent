#!/usr/bin/env python3
"""Lay out a review's state directory, where each file has exactly one writer.

    rounds/NNNN/input.json   the agent: the collector skeleton, then analysis
    rounds/NNNN/review.html  render_review.py --round
    current                  render_review.py --round, after the round's page is written
    feedback.json            serve_review.py, for the browser
    server.json              serve_review.py, while it runs

A round directory never changes after it renders. The directory and its subdirectories are mode 0700, and the
files are mode 0600. For a working tree, use $(git rev-parse --absolute-git-dir)/review-canvas, so parallel Git
worktrees keep separate state. For a PR review, use a private temporary directory.

    python3 review_state.py new-round --state-dir STATE      # prints the new round directory

Python 3.10+; standard library only.
"""

import argparse
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


ROUND_NAME = re.compile(r"[0-9]{4}")


class StateError(ValueError):
    """The state directory is missing, shared with other users, or not laid out as expected."""


def private_dir(path, create=False):
    """Return path as a directory only this user can read, creating it with mode 0700 when asked."""
    path = Path(path)
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        except OSError as error:
            raise StateError(f"cannot create {path}: {error.strerror}") from error
    try:
        info = os.lstat(path)
    except OSError as error:
        raise StateError(f"{path} is not a review state directory: {error.strerror}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise StateError(f"{path} is not a directory")
    if hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise StateError(f"{path} must belong to you and be private (mode 0700); other users could read the review")
    return path


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
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


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


def publish(state, number):
    """Point current at a rendered round. A round never replaces a newer one."""
    current = read_current(state)
    if current is not None and number < current:
        raise StateError(f"round {number:04d} is older than the published round {current:04d}")
    write_private(Path(state) / "current", f"{number:04d}\n".encode("ascii"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("new-round", help="Create the next round directory and print its path")
    create.add_argument("--state-dir", type=Path, required=True, help="The review's state directory; created if missing")
    args = parser.parse_args(argv)
    try:
        print(new_round(args.state_dir))
    except StateError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
