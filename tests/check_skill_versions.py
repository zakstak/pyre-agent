"""Require every changed skill to raise its metadata.version.

Run: python3 tests/check_skill_versions.py [--base REF] [--staged]
Compares the working tree, including untracked files, with the merge base of
HEAD and REF (default origin/main). --staged compares the index instead, as
the pre-commit hook does. A renamed skill must raise its major version, and no
file agents load may still name a skill that left. Python 3.10+; standard
library only.
"""
import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

SKILL_GLOBS = ("skills/*/SKILL.md", "host-skills/*/*/SKILL.md")
SKILL_MD = re.compile(r"(?:skills/[^/]+|host-skills/[^/]+/[^/]+)/SKILL\.md")
LOADED = ("skills", "host-skills", "global")
RENAME_SIMILARITY = 0.5
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


def shown(version):
    return ".".join(map(str, version))


def name(skill_md):
    return PurePosixPath(skill_md).parent.name


def current_skills(root, staged):
    """Return {SKILL.md path: text} from the index, or from the working tree including untracked files."""
    if staged:
        paths = [path for path in git("ls-files", "-z", cwd=root).split("\0") if SKILL_MD.fullmatch(path)]
        return {path: git("show", f":{path}", cwd=root) for path in paths}
    return {path.relative_to(root).as_posix(): path.read_text(encoding="utf-8")
            for pattern in SKILL_GLOBS for path in root.glob(pattern)}


def changed_paths(root, base, staged):
    if staged:
        return set(filter(None, git("diff", "--cached", "--name-only", "--no-renames", "-z", base, cwd=root).split("\0")))
    tracked = git("diff", "--name-only", "--no-renames", "-z", base, cwd=root).split("\0")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z", cwd=root).split("\0")
    return {path for path in tracked + untracked if path}


def renames(removed, added):
    """Pair each skill that left with the new skill whose SKILL.md is most similar. Return [(old, new)]."""
    scored = sorted(((difflib.SequenceMatcher(None, old_text.splitlines(), new_text.splitlines()).ratio(), old, new)
                     for old, old_text in removed.items() for new, new_text in added.items()), reverse=True)
    paired, pairs = set(), []
    for ratio, old, new in scored:
        if ratio >= RENAME_SIMILARITY and old not in paired and new not in paired:
            paired.update((old, new))
            pairs.append((old, new))
    return pairs


def stale_references(root, gone, staged):
    """Return an error for each line in a file agents load that still names a skill that left."""
    errors = []
    for old, new in sorted(gone.items()):
        # A hyphenated name is distinctive. A one-word name such as `correct` counts only as /name, $name, or `name`.
        if "-" in old:
            pattern = re.compile(rf"(?<![\w-]){re.escape(old)}(?![\w-])")
        else:
            pattern = re.compile(rf"(?<![\w-])(?:[/$]{re.escape(old)}(?![\w-])|`{re.escape(old)}`)")
        found = subprocess.run(("git", "grep", "-I", "-n", "-z", "-F", "-e", old, "--cached" if staged else "--untracked",
                                "--", *LOADED), cwd=root, capture_output=True, text=True)
        if found.returncode > 1:
            raise subprocess.CalledProcessError(found.returncode, found.args, stderr=found.stderr)
        left = f"which is now {new}; update the reference" if new else "a skill that was removed; remove the reference"
        for line in found.stdout.splitlines():
            path, number, text = line.split("\0", 2)
            if pattern.search(text):
                errors.append(f"{path}:{number}: names {old}, {left}")
    return errors


def check(base_ref, staged):
    root = Path(git("rev-parse", "--show-toplevel").strip())
    base = git("merge-base", "HEAD", base_ref, cwd=root).strip()
    current = current_skills(root, staged)
    at_base = {path for path in git("ls-tree", "-r", "-z", "--name-only", base, cwd=root).split("\0") if SKILL_MD.fullmatch(path)}
    changed = changed_paths(root, base, staged)
    errors, versions = [], {}
    for skill_md, text in sorted(current.items()):
        version = parse_version(text)
        if isinstance(version, str):
            errors.append(f"{skill_md}: {version}")
        else:
            versions[skill_md] = version
    for skill_md in sorted(versions.keys() & at_base):
        folder = skill_md.removesuffix("SKILL.md")
        if not any(path.startswith(folder) for path in changed):
            continue
        previous = parse_version(git("show", f"{base}:{skill_md}", cwd=root))
        if isinstance(previous, tuple) and versions[skill_md] <= previous:
            errors.append(f"{skill_md}: {folder} changed since {base[:12]}, so raise metadata.version above {shown(previous)}")
    removed = {path: git("show", f"{base}:{path}", cwd=root) for path in at_base - current.keys()}
    pairs = renames(removed, {path: current[path] for path in current.keys() - at_base})
    for old, new in pairs:
        previous = parse_version(removed[old])
        if new not in versions or not isinstance(previous, tuple):
            continue
        old_folder = old.removesuffix("SKILL.md")
        if name(old) == name(new) and versions[new] <= previous:
            errors.append(f"{new}: moves {old_folder} at {shown(previous)}, so raise metadata.version above {shown(previous)}")
        elif name(old) != name(new) and versions[new][0] <= previous[0]:
            errors.append(f"{new}: renames {old_folder} at {shown(previous)}, so raise metadata.version to {previous[0] + 1}.0.0 or above")
    names_now = {name(path) for path in current}
    gone = {name(path): None for path in removed if name(path) not in names_now}
    gone.update({name(old): name(new) for old, new in pairs if name(old) in gone})
    return errors + stale_references(root, gone, staged)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="origin/main", help="Base ref to compare with (default origin/main)")
    parser.add_argument("--staged", action="store_true", help="Check the index instead of the working tree")
    args = parser.parse_args()
    try:
        errors = check(args.base, args.staged)
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
