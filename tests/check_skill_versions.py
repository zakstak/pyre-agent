"""Require every changed skill to raise its metadata.version.

Run: python3 tests/check_skill_versions.py [--base REF] [--staged]
Compares the working tree, including untracked files, with the merge base of
HEAD and REF (default origin/main). --staged compares the index instead, as
the pre-commit hook does. A renamed skill, or one that moves into host-skills/,
must raise its major version, and no file agents load may still name a skill
that left. Python 3.10+; standard library only.
"""

import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

SKILL_MD = re.compile(r"(?:skills/[^/]+|host-skills/[^/]+/[^/]+)/SKILL\.md")
LOADED = ("skills", "host-skills", "context")
RENAME_SIMILARITY = 0.5
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
NAME = re.compile(r"""^name:[ \t]*["']?(.*?)["']?[ \t]*$""", re.MULTILINE)
METADATA_VERSION = re.compile(
    r"^metadata:\n(?:[ \t]+\S.*\n)*?[ \t]+version:[ \t]*(.*?)[ \t]*$", re.MULTILINE
)
SEMVER = re.compile(r'"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"\Z')


def git(*args, cwd=None):
    return subprocess.run(
        ("git", *args), cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


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
        return (
            f'metadata.version is {found[1]}; use a quoted "MAJOR.MINOR.PATCH" version'
        )
    return tuple(int(part) for part in version.groups())


def parse_name(text):
    frontmatter = FRONTMATTER.match(text.replace("\r\n", "\n"))
    found = frontmatter and NAME.search(frontmatter[1])
    return found[1] if found else None


def shown(version):
    return ".".join(map(str, version))


def name(skill_md):
    return PurePosixPath(skill_md).parent.name


def current_skills(root, staged):
    """Return {SKILL.md path: text} from the index, or from the working tree including untracked files."""
    listed = git(
        "ls-files",
        "-z",
        *([] if staged else ["--cached", "--others", "--exclude-standard"]),
        cwd=root,
    )
    paths = {path for path in listed.split("\0") if SKILL_MD.fullmatch(path)}
    if staged:
        return {path: git("show", f":{path}", cwd=root) for path in paths}
    return {
        path: (root / path).read_text(encoding="utf-8")
        for path in paths
        if (root / path).is_file()
    }


def merge_base(root, base_ref):
    """Return the commit to compare with. While a merge is in progress, its other parent counts too."""
    heads = ["HEAD"]
    if (root / git("rev-parse", "--git-path", "MERGE_HEAD", cwd=root).strip()).exists():
        heads.append("MERGE_HEAD")
    return git("merge-base", base_ref, *heads, cwd=root).strip()


def changed_paths(root, base, staged):
    if staged:
        return set(
            filter(
                None,
                git(
                    "diff",
                    "--cached",
                    "--name-only",
                    "--no-renames",
                    "-z",
                    base,
                    cwd=root,
                ).split("\0"),
            )
        )
    tracked = git("diff", "--name-only", "--no-renames", "-z", base, cwd=root).split(
        "\0"
    )
    untracked = git("ls-files", "--others", "--exclude-standard", "-z", cwd=root).split(
        "\0"
    )
    return {path for path in tracked + untracked if path}


def similarity(old_text, new_text):
    """Share of matching non-blank lines after the frontmatter, so shared boilerplate cannot pair unrelated skills."""

    def body(text):
        text = text.replace("\r\n", "\n")
        frontmatter = FRONTMATTER.match(text)
        return [
            line
            for line in text[frontmatter.end() if frontmatter else 0 :].splitlines()
            if line.strip()
        ]

    return difflib.SequenceMatcher(None, body(old_text), body(new_text)).ratio()


def pair_moves(removed, added):
    """Pair each skill that left with the new skill that replaces it: one with the same name, else the most similar."""
    scored = sorted(
        (
            (
                2 if name(old) == name(new) else similarity(removed[old], added[new]),
                old,
                new,
            )
            for old in removed
            for new in added
        ),
        reverse=True,
    )
    paired, pairs = set(), []
    for score, old, new in scored:
        if score >= RENAME_SIMILARITY and old not in paired and new not in paired:
            paired.update((old, new))
            pairs.append((old, new))
    return pairs


def stale_references(root, gone, staged):
    """Return an error for each line in a file agents load that still names a skill that left."""
    errors = []
    for old, new in sorted(gone.items()):
        # A one-word name counts only as an invocation or code, optionally namespaced.
        if "-" in old:
            pattern = re.compile(rf"(?<![\w-]){re.escape(old)}(?![\w-])")
        else:
            pattern = re.compile(
                rf"[/$](?:pyre-agent:)?{re.escape(old)}(?![\w-])|`(?:pyre-agent:)?{re.escape(old)}`"
            )
        found = subprocess.run(
            (
                "git",
                "grep",
                "--no-color",
                "-I",
                "-n",
                "-z",
                "-F",
                "-e",
                old,
                "--cached" if staged else "--untracked",
                "--",
                *LOADED,
            ),
            check=False,
            cwd=root,
            capture_output=True,
        )
        if found.returncode > 1:
            raise subprocess.CalledProcessError(
                found.returncode,
                found.args,
                stderr=found.stderr.decode(errors="replace"),
            )
        left = (
            f"which is now {new}; update the reference"
            if new
            else "a skill that was removed; remove the reference"
        )
        for line in filter(None, found.stdout.split(b"\n")):
            path, number, text = line.decode(errors="replace").split("\0", 2)
            if pattern.search(text):
                errors.append(f"{path}:{number}: names {old}, {left}")
    return errors


def check(base_ref, staged):
    root = Path(git("rev-parse", "--show-toplevel").strip())
    base = merge_base(root, base_ref)
    current = current_skills(root, staged)
    at_base = {
        path
        for path in git("ls-tree", "-r", "-z", "--name-only", base, cwd=root).split(
            "\0"
        )
        if SKILL_MD.fullmatch(path)
    }
    changed = changed_paths(root, base, staged)
    errors, versions = [], {}
    for skill_md, text in sorted(current.items()):
        version = parse_version(text)
        if isinstance(version, str):
            errors.append(f"{skill_md}: {version}")
            continue
        versions[skill_md] = version
        if parse_name(text) != name(skill_md):
            errors.append(
                f"{skill_md}: frontmatter name is {parse_name(text)}; use the folder name, {name(skill_md)}"
            )
    for skill_md in sorted(versions.keys() & at_base):
        folder = skill_md.removesuffix("SKILL.md")
        if not any(path.startswith(folder) for path in changed):
            continue
        previous = parse_version(git("show", f"{base}:{skill_md}", cwd=root))
        if isinstance(previous, tuple) and versions[skill_md] <= previous:
            errors.append(
                f"{skill_md}: {folder} changed since {base[:12]}, so raise metadata.version above {shown(previous)}"
            )
    removed = {
        path: git("show", f"{base}:{path}", cwd=root)
        for path in at_base - current.keys()
    }
    pairs = pair_moves(
        removed, {path: current[path] for path in current.keys() - at_base}
    )
    for old, new in pairs:
        previous = parse_version(removed[old])
        if new not in versions or not isinstance(previous, tuple):
            continue
        # A new name breaks /old-name, and a move into host-skills/ drops the skill from every other host.
        if name(old) != name(new):
            breaking = f"renames {old.removesuffix('SKILL.md')} at {shown(previous)}"
        elif new.startswith("host-skills/"):
            breaking = f"moves {old.removesuffix('SKILL.md')} at {shown(previous)}, which drops it from other hosts"
        else:
            breaking = None
        if breaking and versions[new][0] <= previous[0]:
            errors.append(
                f"{new}: {breaking}, so raise metadata.version to {previous[0] + 1}.0.0 or above"
            )
        elif not breaking and versions[new] <= previous:
            errors.append(
                f"{new}: moves {old.removesuffix('SKILL.md')} at {shown(previous)}, so raise metadata.version above {shown(previous)}"
            )
    names_now = {name(path) for path in current}
    gone = {name(path): None for path in removed if name(path) not in names_now}
    gone.update({name(old): name(new) for old, new in pairs if name(old) in gone})
    return errors + stale_references(root, gone, staged)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--base",
        default="origin/main",
        help="Base ref to compare with (default origin/main)",
    )
    parser.add_argument(
        "--staged",
        action="store_true",
        help="Check the index instead of the working tree",
    )
    args = parser.parse_args()
    try:
        errors = check(args.base, args.staged)
    except subprocess.CalledProcessError as error:
        print(
            f"git {' '.join(error.cmd[1:])} failed: {error.stderr.strip()}",
            file=sys.stderr,
        )
        return 2
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print("Skill versions OK.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
