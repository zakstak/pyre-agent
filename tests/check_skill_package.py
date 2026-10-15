"""Check local instruction links and redistribution notices in a skill package.

Run against a source checkout or an isolated native plugin cache. This reads
files only; it does not install skills or change host configuration.
"""

import argparse
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PSTACK_SKILLS = {
    "correct",
    "principle-boundary-discipline",
    "principle-encode-lessons-in-structure",
    "principle-fix-root-causes",
    "principle-migrate-callers-then-delete-legacy-apis",
    "principle-minimize-reader-load",
    "principle-type-system-discipline",
    "technical-writing",
    "typescript-best-practices",
    "unslop",
}
# The collection uses inline Markdown links. Ignore images and external URLs.
LINK = re.compile(r"(?<!!)\[[^\]\n]+\]\(([^\s)]+)\)")
MIT_GRANT = "Permission is hereby granted, free of charge"
MIT_CONDITION = "The above copyright notice and this permission notice"
# Dependencies that are not Markdown links: (skill, companion, reason). The
# review-canvas package build hashes and copies the style assets; see FOLDERS in
# packages/review-canvas/src/cli/stamp.ts.
BUILD_DEPENDENCIES = (
    ("review-canvas", "internal-visual-style", "the package build reads its assets"),
)


def skill_entries(root):
    """Every SKILL.md in the package, shared skills first."""
    return sorted(root.glob("skills/*/SKILL.md")) + sorted(
        root.glob("host-skills/*/*/SKILL.md")
    )


def local_links(source):
    """Yield (destination, target) for each local link in a Markdown file."""
    for destination in LINK.findall(source.read_text(encoding="utf-8")):
        url = urlsplit(destination)
        if url.scheme or url.netloc or not url.path:
            continue
        yield destination, (source.parent / unquote(url.path)).resolve()


def package_errors(root):
    """Require referenced files to exist within this package, including cycles."""
    root = Path(root).resolve()
    errors = []
    entries = skill_entries(root)
    if not entries:
        return ["No skill entrypoints found"]
    for entry in entries:
        for source in sorted(entry.parent.rglob("*.md")):
            if not source.resolve().is_relative_to(root):
                errors.append(f"{source.relative_to(root)} leaves the package")
                continue
            for destination, target in local_links(source):
                if not target.is_relative_to(root) or not target.is_file():
                    errors.append(
                        f"{source.relative_to(root)}: missing packaged file {destination}"
                    )

    license_path = root / "LICENSE"
    license_text = license_path.read_text() if license_path.is_file() else ""
    for notice in ("Copyright (c) 2026 Zak", MIT_GRANT, MIT_CONDITION):
        if notice not in license_text:
            errors.append(f"LICENSE: missing {notice}")
    credits_path = root / "README.md"
    credits = credits_path.read_text() if credits_path.is_file() else ""
    if not credits_path.is_file():
        errors.append("README.md: missing redistribution credits")
    names = {entry.parent.name for entry in entries}
    if names & PSTACK_SKILLS and "Copyright (c) 2026 Lauren Tan" not in credits:
        errors.append("README.md: missing pstack copyright notice")
    if "review-canvas" in names and "Copyright (c) 2026 Cursor" not in credits:
        errors.append("README.md: missing review canvas copyright notice")
    return errors


def companion_graph(root):
    """Map each skill to the skills its instructions link to, in link order."""
    root = Path(root).resolve()
    folders = {
        entry.parent.resolve(): entry.parent.name for entry in skill_entries(root)
    }
    graph = {name: [] for name in folders.values()}
    for folder, name in folders.items():
        for source in sorted(folder.rglob("*.md")):
            for _destination, target in local_links(source):
                for other, companion in folders.items():
                    if companion == name or companion in graph[name]:
                        continue
                    if target.is_relative_to(other):
                        graph[name].append(companion)
    for skill, companion, _reason in BUILD_DEPENDENCIES:
        if skill in graph and companion in graph and companion not in graph[skill]:
            graph[skill].append(companion)
    return graph


def companions(graph, skill):
    """Every skill reachable from one, nearest first, excluding itself."""
    found = []
    queue = list(graph[skill])
    while queue:
        companion = queue.pop(0)
        if companion != skill and companion not in found:
            found.append(companion)
            queue.extend(graph[companion])
    return found


def listed(names):
    names = [f"`{name}`" for name in names]
    if len(names) < 3:
        return " and ".join(names)
    return ", ".join(names[:-1]) + f", and {names[-1]}"


def graph_markdown(root):
    """The companion groups as Markdown bullets, one per dependent skill."""
    graph = companion_graph(root)
    lines = []
    for skill in sorted(graph):
        needs = companions(graph, skill)
        if not needs:
            continue
        reasons = [
            reason
            for dependent, companion, reason in BUILD_DEPENDENCIES
            if dependent == skill and companion in needs
        ]
        note = f" ({'; '.join(reasons)})" if reasons else ""
        lines.append(f"- `{skill}` needs {listed(needs)}{note}.")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    parser.add_argument(
        "--graph",
        action="store_true",
        help="print the companion groups as Markdown bullets instead of checking",
    )
    args = parser.parse_args()
    if args.graph:
        print(graph_markdown(args.root), end="")
        return 0
    errors = package_errors(args.root)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("Skill package links and notices pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
