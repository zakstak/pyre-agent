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


def package_errors(root):
    """Require referenced files to exist within this package, including cycles."""
    root = Path(root).resolve()
    errors = []
    entries = sorted(root.glob("skills/*/SKILL.md")) + sorted(
        root.glob("host-skills/*/*/SKILL.md")
    )
    if not entries:
        return ["No skill entrypoints found"]
    for entry in entries:
        for source in sorted(entry.parent.rglob("*.md")):
            if not source.resolve().is_relative_to(root):
                errors.append(f"{source.relative_to(root)} leaves the package")
                continue
            for destination in LINK.findall(source.read_text(encoding="utf-8")):
                url = urlsplit(destination)
                if url.scheme or url.netloc or not url.path:
                    continue
                target = (source.parent / unquote(url.path)).resolve()
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    args = parser.parse_args()
    errors = package_errors(args.root)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("Skill package links and notices pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
