"""Require every changed skill to raise its metadata.version.

Run: python3 tests/check_skill_versions.py [--base REF]
Compares the working tree, including untracked files, with the merge base of
HEAD and REF (default origin/main). Python 3.10+; standard library only.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

SKILL_GLOBS = ("skills/*/SKILL.md", "host-skills/*/*/SKILL.md")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
METADATA_VERSION = re.compile(r'^metadata:\n(?:[ \t]+\S.*\n)*?[ \t]+version:[ \t]*(.*?)[ \t]*$', re.MULTILINE)
SEMVER = re.compile(r'"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"\Z')


def git(*args, cwd=None):
    return subprocess.run(("git", *args), cwd=cwd, check=True, capture_output=True, text=True).stdout


def parse_version(text):
    """Return (major, minor, patch), or an error message."""
    frontmatter = FRONTMATTER.match(text.replace("\r\n", "\n"))
    if not frontmatter:
        return "SKILL.md has no frontmatter"
    found = METADATA_VERSION.search(frontmatter[1] + "\n")
    if not found:
        return 'frontmatter has no metadata.version; add `metadata:` with `version: "1.0.0"`'
    version = SEMVER.match(found[1])
    if not version:
        return f'metadata.version is {found[1]}; use a quoted "MAJOR.MINOR.PATCH" version'
    return tuple(int(part) for part in version.groups())


def changed_paths(root, base):
    tracked = git("diff", "--name-only", "--no-renames", "-z", base, cwd=root).split("\0")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z", cwd=root).split("\0")
    return {path for path in tracked + untracked if path}


def base_skill(root, base, skill_md):
    try:
        return git("show", f"{base}:{skill_md}", cwd=root)
    except subprocess.CalledProcessError:
        return None


def check(base_ref):
    root = Path(git("rev-parse", "--show-toplevel").strip())
    base = git("merge-base", "HEAD", base_ref, cwd=root).strip()
    skills = sorted(path.relative_to(root).as_posix() for pattern in SKILL_GLOBS for path in root.glob(pattern))
    changed = changed_paths(root, base)
    errors = []
    for skill_md in skills:
        folder = skill_md.removesuffix("SKILL.md")
        current = parse_version((root / skill_md).read_text(encoding="utf-8"))
        if isinstance(current, str):
            errors.append(f"{skill_md}: {current}")
            continue
        if not any(path.startswith(folder) for path in changed):
            continue
        previous_text = base_skill(root, base, skill_md)
        previous = parse_version(previous_text) if previous_text is not None else None
        if isinstance(previous, tuple) and current <= previous:
            shown = ".".join(map(str, previous))
            errors.append(f"{skill_md}: {folder} changed since {base[:12]}, so raise metadata.version above {shown}")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="origin/main", help="Base ref to compare with (default origin/main)")
    args = parser.parse_args()
    try:
        errors = check(args.base)
    except subprocess.CalledProcessError as error:
        print(f"git {' '.join(error.cmd[1:])} failed: {error.stderr.strip()}", file=sys.stderr)
        return 2
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print("Skill versions OK.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
