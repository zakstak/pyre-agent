"""Keep every skill within its description, body, and line budgets.

Run: python3 tests/check_skill_shape.py [ROOT]
Checks skills/*/SKILL.md, host-skills/*/*/SKILL.md, and every Markdown file
below those folders. A SKILL.md description must open with "Use when" or
"Use for" within 250 characters, or with "Invoke only by name." within 120
when the skill sets disable-model-invocation. A SKILL.md body may hold 5,000
bytes for a principle and 14,000 bytes otherwise. In any file, a prose line
that could have been wrapped may not run past column 80, and a sentence may
not continue in lowercase after a fenced code block. Python 3.10+; standard
library only.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIDTH = 80
DESCRIPTION_BUDGET = 250
NAMED_DESCRIPTION_BUDGET = 120
PRINCIPLE_BODY_BUDGET = 5_000
BODY_BUDGET = 14_000
OPENINGS = ("Use when", "Use for")
NAMED_OPENING = "Invoke only by name."
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
DESCRIPTION = re.compile(r"^description:[ \t]*(.*)$", re.MULTILINE)
CONTINUATION = re.compile(r"^[ \t]+(\S.*)$")
BY_NAME_ONLY = re.compile(r"^disable-model-invocation:[ \t]*true[ \t]*$", re.MULTILINE)
CODE_SPAN = re.compile(r"(`+)(?!`).+?(?<!`)\1(?!`)")
LINK_SPAN = re.compile(r"\[[^\]\n]+\]\([^)]*\)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
BLOCK_SCALAR = re.compile(r"[>|](?:[+-]?[1-9]?|[1-9][+-]?)(?:[ \t]+#.*)?$")


def skill_files(root):
    """Return every Markdown file below a skill folder, SKILL.md first."""
    entries = sorted(root.glob("skills/*/SKILL.md")) + sorted(
        root.glob("host-skills/*/*/SKILL.md")
    )
    files = []
    for entry in entries:
        files.append(entry)
        files.extend(
            path for path in sorted(entry.parent.rglob("*.md")) if path != entry
        )
    return files


def split_frontmatter(text):
    """Return (frontmatter text or None, body text, body start line number)."""
    found = FRONTMATTER.match(text)
    if not found:
        return None, text, 1
    return found[1], text[found.end() :], text.count("\n", 0, found.end()) + 1


def parse_description(frontmatter):
    """Return (description joined on single spaces, its line number), or (None, None)."""
    found = DESCRIPTION.search(frontmatter)
    if not found:
        return None, None
    value = found[1].strip()
    block_scalar = BLOCK_SCALAR.fullmatch(value) is not None
    parts = ["" if block_scalar else value]
    for line in frontmatter[found.end() :].splitlines()[1:]:
        continued = CONTINUATION.match(line)
        if not continued:
            break
        parts.append(continued[1])
    joined = " ".join(" ".join(parts).split())
    for quote in "\"'":
        if (
            not block_scalar
            and len(joined) >= 2
            and joined[0] == quote
            and joined[-1] == quote
        ):
            joined = joined[1:-1]
    return joined, frontmatter.count("\n", 0, found.start()) + 2


def description_errors(frontmatter):
    description, line = parse_description(frontmatter)
    if description is None:
        return [(1, "frontmatter has no description")]
    errors = []
    if BY_NAME_ONLY.search(frontmatter):
        budget, openings = NAMED_DESCRIPTION_BUDGET, (NAMED_OPENING,)
    else:
        budget, openings = DESCRIPTION_BUDGET, OPENINGS
    opening = "|".join(re.escape(value) for value in openings)
    if not re.match(rf"(?:{opening})(?:\s|$)", description):
        errors.append(
            (line, f"description must start with {' or '.join(map(repr, openings))}")
        )
    if len(description) > budget:
        errors.append(
            (
                line,
                f"description is {len(description)} characters; the budget is {budget}",
            )
        )
    return errors


def body_budget(skill_md):
    if skill_md.parent.name.startswith("principle-"):
        return PRINCIPLE_BODY_BUDGET
    return BODY_BUDGET


def masked(line):
    """Return the line with code spans and links blanked, so their spaces cannot count."""
    chars = list(line)
    for pattern in (CODE_SPAN, LINK_SPAN):
        for found in pattern.finditer(line):
            for index in range(found.start(), found.end()):
                chars[index] = "x"
    return "".join(chars)


def prose_errors(body, first_line):
    """Flag wrappable lines past the width, and lowercase sentences resuming after a fence."""
    errors = []
    fence = None
    after_fence = False
    for offset, line in enumerate(body.splitlines()):
        number = first_line + offset
        opened = FENCE.match(line)
        if fence is not None:
            if (
                opened
                and opened[1][0] == fence[0]
                and len(opened[1]) >= len(fence)
                and not opened[2].strip()
            ):
                fence = None
                after_fence = True
            continue
        if opened and (opened[1][0] != "`" or "`" not in opened[2]):
            fence = opened[1]
            continue
        if not line.strip():
            continue
        if after_fence:
            after_fence = False
            if line[0].islower() and line[0].isascii():
                errors.append(
                    (
                        number,
                        "lowercase paragraph after a fenced block; a sentence was cut in half",
                    )
                )
        if line.startswith("|"):
            continue
        prose = masked(line).rstrip()
        wrap_points = list(re.finditer(r"(?<=\S)[ \t]+(?=\S)", prose))
        # Leave an unbreakable trailing URL, link or code span alone. Other
        # tokens can wrap even when their last separator is before WIDTH.
        wrappable = wrap_points and (
            len(prose.rsplit(None, 1)[-1]) <= WIDTH
            or any(point.start() >= WIDTH for point in wrap_points)
        )
        if len(line) > WIDTH and wrappable:
            errors.append(
                (
                    number,
                    f"line is {len(line)} columns and can be wrapped; limit is {WIDTH}",
                )
            )
    return errors


def file_errors(path, root):
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    frontmatter, body, first_line = split_frontmatter(text)
    errors = []
    if path.name == "SKILL.md":
        if frontmatter is None:
            errors.append((1, "SKILL.md has no frontmatter"))
        else:
            errors.extend(description_errors(frontmatter))
            size, budget = len(body.encode("utf-8")), body_budget(path)
            if size > budget:
                errors.append(
                    (first_line, f"body is {size:,} bytes; the budget is {budget:,}")
                )
    errors.extend(prose_errors(body, first_line))
    return [
        f"{path.relative_to(root).as_posix()}:{line}: {message}"
        for line, message in sorted(errors)
    ]


def shape_errors(root):
    root = Path(root).resolve()
    files = skill_files(root)
    if not files:
        return ["No skill entrypoints found"]
    return [error for path in files for error in file_errors(path, root)]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    args = parser.parse_args()
    errors = shape_errors(args.root)
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print("Skill shape OK.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
