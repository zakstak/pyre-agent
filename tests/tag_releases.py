#!/usr/bin/env python3
"""Tag each plugin release on main that has no tag yet.

Hosts install core from main, so the first-parent commit on main that raises the
plugin version is that version's release. This finds every such commit, skips
versions that already have a tag, and creates an annotated vMAJOR.MINOR.PATCH
tag with the commit's subject. It prints what it would tag unless given --push,
which creates the tags and pushes them.

Run it after each merge that raises the version:

    git fetch origin --tags
    python3 tests/tag_releases.py            # show the tags it would create
    python3 tests/tag_releases.py --push     # create and push them
"""

import argparse
import json
import subprocess
import sys

MANIFESTS = (
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".antigravity-plugin/plugin.json",
)


def git(*args, check=True):
    result = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result


def version_at(commit):
    """The plugin version at a commit, or None when its manifests disagree or are missing."""
    versions = set()
    for path in MANIFESTS:
        shown = git("show", f"{commit}:{path}", check=False)
        if shown.returncode != 0:
            # Older commits predate the Antigravity manifest.
            continue
        versions.add(json.loads(shown.stdout).get("version"))
    return versions.pop() if len(versions) == 1 else None


def releases(branch):
    """Each version's first first-parent commit on the branch, oldest first, as (version, commit)."""
    commits = git(
        "rev-list", "--first-parent", "--reverse", branch, "--", *MANIFESTS
    ).stdout.split()
    seen, out = set(), []
    for commit in commits:
        version = version_at(commit)
        if version and version not in seen:
            seen.add(version)
            out.append((version, commit))
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--branch", default="origin/main")
    parser.add_argument(
        "--since", default="4.12.1", help="oldest version to consider (default 4.12.1)"
    )
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--push", action="store_true", help="create and push the tags")
    args = parser.parse_args()

    head = version_at(args.branch)
    if head is None:
        sys.exit(f"The plugin manifests on {args.branch} disagree on the version.")
    since = tuple(int(part) for part in args.since.split("."))
    tags = set(git("tag", "--list", "v*").stdout.split())
    missing = [
        (version, commit)
        for version, commit in releases(args.branch)
        if f"v{version}" not in tags
        and tuple(int(p) for p in version.split(".")) >= since
    ]
    if not missing:
        print(f"Every release on {args.branch} is tagged; the latest is v{head}.")
        return
    for version, commit in missing:
        subject = git("log", "-1", "--format=%s", commit).stdout.strip()
        print(f"v{version}  {commit[:7]}  {subject}")
        if args.push:
            git(
                "tag",
                "-a",
                f"v{version}",
                "-m",
                f"Pyre Agent {version}: {subject}",
                commit,
            )
    if args.push:
        git("push", args.remote, *(f"refs/tags/v{version}" for version, _ in missing))
        print(f"Pushed {len(missing)} tag(s) to {args.remote}.")
    else:
        print("Run again with --push to create and push these tags.")


if __name__ == "__main__":
    main()
