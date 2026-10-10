#!/usr/bin/env python3
"""Install pyre-agent skills and global instructions from a Git ref for Claude Code and Codex.

Run: python3 install.py [install|status|uninstall] [--ref REF] [--host HOST]
                        [--dry-run] [--offline] [--force]
Copies skills and global/AGENTS.md from the commit that REF names (default
main), never from the working tree. Changes only skill folders it recorded
installing and one marked block in each host's instruction file. Python 3.10+;
standard library only.
"""
import argparse
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent
RECORD_VERSION = 1
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
METADATA_VERSION = re.compile(r'^metadata:\n(?:[ \t]+\S.*\n)*?[ \t]+version:[ \t]*"?([^"\n]*?)"?[ \t]*$', re.MULTILINE)
PROBLEMS = ("conflict", "edited")
BEGIN = re.compile(r"^<!-- pyre-agent:begin\b[^\n]*-->[ \t]*$", re.MULTILINE)
END = re.compile(r"^<!-- pyre-agent:end -->[ \t]*$", re.MULTILINE)
QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})
PREAMBLE = "the text before the first heading"
INSTRUCTION_SUMMARY = {
    "create": "create it with the global instructions block",
    "update": "update the block",
    "adopt": "replace the symlink into this checkout with a file that holds the block",
    "merge": "back it up, then write the block followed by the sections it keeps",
    "current": "up to date",
    "edited": "the block changed since install; --force overwrites it",
    "conflict": "conflict, nothing written",
    "missing": "this commit has no global/AGENTS.md; unchanged",
    "remove": "remove the block",
    "delete": "delete it; install.py created it and only the block remains",
}


class Failure(Exception):
    pass


@dataclass(frozen=True)
class Host:
    name: str
    config_dir: Path
    skills_dir: Path
    instructions: Path


@dataclass(frozen=True)
class Action:
    kind: str  # install, update, adopt, remove, unlink, forget, current, conflict, edited
    name: str
    path: Path
    source: Path | None = None
    version: str | None = None
    old_version: str | None = None


@dataclass(frozen=True)
class Instructions:
    kind: str  # a key of INSTRUCTION_SUMMARY, or forget
    path: Path
    text: str | None = None
    body_hash: str | None = None
    notes: tuple[str, ...] = ()


def all_hosts():
    home = Path.home()
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude").expanduser()
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex").expanduser()
    return {
        "claude-code": Host("claude-code", claude, claude / "skills", claude / "CLAUDE.md"),
        "codex": Host("codex", codex, home / ".agents" / "skills", codex / "AGENTS.md"),
    }


def pick_hosts(requested, record):
    hosts = all_hosts()
    if requested:
        return [hosts[requested]]
    picked = [host for name, host in hosts.items() if host.config_dir.is_dir() or name in record["hosts"]]
    if not picked:
        raise Failure("found no Claude Code or Codex configuration directory; pass --host")
    return picked


def git(*args, binary=False):
    result = subprocess.run(("git", *args), cwd=REPO, capture_output=True, text=not binary)
    if result.returncode:
        stderr = result.stderr if isinstance(result.stderr, str) else result.stderr.decode(errors="replace")
        raise Failure(f"git {' '.join(args)} failed: {stderr.strip()}")
    return result.stdout


def try_rev(spec):
    result = subprocess.run(("git", "rev-parse", "--verify", "--quiet", spec), cwd=REPO, capture_output=True, text=True)
    return result.stdout.strip() or None


def fetch():
    git("fetch", "--quiet", "--force", "--tags", "origin")


def resolve(ref):
    if not ref or ref.startswith("-"):
        raise Failure(f"invalid ref {ref!r}")
    tag = try_rev(f"refs/tags/{ref}^{{commit}}")
    branch = try_rev(f"refs/remotes/origin/{ref}^{{commit}}") if ref != "HEAD" else None
    if tag and branch:
        raise Failure(f"{ref} names both refs/tags/{ref} and origin/{ref}; pass refs/tags/{ref} or origin/{ref}")
    commit = tag or branch or try_rev(f"{ref}^{{commit}}")
    if not commit:
        raise Failure(f"cannot resolve {ref} to a commit; check the name, or drop --offline to fetch it")
    return commit


def extract(commit, dest):
    present = git("ls-tree", "--name-only", commit, "--", "skills", "host-skills", "global").split()
    if "skills" not in present:
        raise Failure(f"commit {commit[:12]} has no skills/ folder")
    data = git("archive", "--format=tar", commit, "--", *present, binary=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        if hasattr(tarfile, "data_filter"):
            archive.extractall(dest, filter="data")
        else:
            archive.extractall(dest)


def source_skills(tree, host):
    found = {}
    for base in (tree / "skills", tree / "host-skills" / host):
        for skill_md in sorted(base.glob("*/SKILL.md")):
            name = skill_md.parent.name
            if name in found:
                raise Failure(f"skill {name} exists in both skills/ and host-skills/{host}/")
            found[name] = skill_md.parent
    return found


def skill_version(folder):
    text = (folder / "SKILL.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    frontmatter = FRONTMATTER.match(text)
    found = frontmatter and METADATA_VERSION.search(frontmatter[1] + "\n")
    return found[1] if found else None


def tree_hash(path):
    """Hash names, types, executable bits, file bytes and link targets; None if path is not a real directory."""
    if path.is_symlink() or not path.is_dir():
        return None
    digest = hashlib.sha256()

    def walk(directory, prefix):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            name = (prefix + entry.name).encode()
            if entry.is_symlink():
                digest.update(b"L\0" + name + b"\0" + os.fsencode(os.readlink(entry.path)) + b"\0")
            elif entry.is_dir():
                digest.update(b"D\0" + name + b"\0")
                walk(entry.path, prefix + entry.name + "/")
            else:
                executable = b"x" if entry.stat().st_mode & stat.S_IXUSR else b"-"
                content = hashlib.sha256(Path(entry.path).read_bytes()).digest()
                digest.update(b"F\0" + name + b"\0" + executable + content)

    walk(path, "")
    return "sha256:" + digest.hexdigest()


def legacy_link(path):
    """True for a symlink into this checkout's skill folders, as the old README install made."""
    if not path.is_symlink():
        return False
    target = Path(os.path.realpath(path))
    return any(target.is_relative_to(REPO / folder) for folder in ("skills", "host-skills"))


def plan(host, sources, recorded, force):
    actions = []
    for name, source in sorted(sources.items()):
        dest = host.skills_dir / name
        version = skill_version(source)
        old = recorded.get(name)
        if old and Path(old["path"]) != dest:
            old = None
        if legacy_link(dest):
            kind = "adopt"
        elif old is None:
            kind = "conflict" if os.path.lexists(dest) else "install"
        elif not os.path.lexists(dest):
            kind = "install"
        elif tree_hash(dest) != old["hash"]:
            kind = "update" if force else "edited"
        elif tree_hash(source) == old["hash"]:
            kind = "current"
        else:
            kind = "update"
        actions.append(Action(kind, name, dest, source, version, old and old.get("version")))
    for name, old in sorted(recorded.items()):
        path = Path(old["path"])
        if name in sources and path == host.skills_dir / name:
            continue
        if not os.path.lexists(path):
            kind = "forget"
        elif tree_hash(path) != old["hash"] and not force:
            kind = "edited"
        else:
            kind = "remove"
        actions.append(Action(kind, name, path, old_version=old.get("version")))
    if host.skills_dir.is_dir():
        for entry in sorted(host.skills_dir.iterdir()):
            if entry.name not in sources and entry.name not in recorded and legacy_link(entry):
                actions.append(Action("unlink", entry.name, entry))
    return actions


def shown(path):
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if text == home or text.startswith(home + os.sep) else text


def describe(action):
    version = action.version or "unversioned"
    if action.kind == "install":
        return f"install   {action.name} {version}"
    if action.kind == "update":
        old = action.old_version or "unversioned"
        change = f"{old} -> {version}" if old != version else f"{version}, content changed"
        return f"update    {action.name} {change}"
    if action.kind == "adopt":
        return f"adopt     {action.name} {version}, replacing a symlink into this checkout"
    if action.kind == "remove":
        return f"remove    {action.name}"
    if action.kind == "unlink":
        return f"unlink    {action.name}, a stale symlink into this checkout"
    if action.kind == "conflict":
        return f"conflict  {action.name}: {shown(action.path)} exists and install.py did not install it"
    if action.kind == "edited":
        return f"edited    {action.name}: changed since install; --force replaces it"
    return None


def report(host, actions, header):
    print("  ".join(part for part in (host.name, shown(host.skills_dir), header) if part))
    lines = [line for line in map(describe, actions) if line]
    for line in lines:
        print(f"  {line}")
    current = sum(action.kind == "current" for action in actions)
    if current:
        print(f"  {current} up to date")
    if not lines and not current:
        print("  nothing to do")


def apply(host, actions, skills, save):
    staging = Path(os.path.realpath(host.skills_dir)).parent / ".pyre-agent-staging"
    try:
        for action in actions:
            if action.kind in ("install", "update", "adopt"):
                host.skills_dir.mkdir(parents=True, exist_ok=True)
                staging.mkdir(exist_ok=True)
                new, old = staging / f"{action.name}.new", staging / f"{action.name}.old"
                shutil.rmtree(new, ignore_errors=True)
                shutil.rmtree(old, ignore_errors=True)
                shutil.copytree(action.source, new, symlinks=True)
                if action.path.is_symlink():
                    action.path.unlink()
                elif os.path.lexists(action.path):
                    os.replace(action.path, old)
                os.replace(new, action.path)
                shutil.rmtree(old, ignore_errors=True)
                skills[action.name] = {"path": str(action.path), "version": action.version, "hash": tree_hash(action.path)}
            elif action.kind == "remove":
                if action.path.is_symlink() or not action.path.is_dir():
                    action.path.unlink()
                else:
                    staging.mkdir(parents=True, exist_ok=True)
                    old = staging / f"{action.name}.old"
                    shutil.rmtree(old, ignore_errors=True)
                    os.replace(action.path, old)
                    shutil.rmtree(old)
                del skills[action.name]
            elif action.kind == "unlink":
                action.path.unlink()
            elif action.kind == "forget":
                del skills[action.name]
            else:
                continue
            save()
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def text_hash(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.pyre-tmp")
    temporary.write_text(text, encoding="utf-8")
    if path.exists() and not path.is_symlink():
        shutil.copymode(path, temporary)
    os.replace(temporary, path)


def render_block(body, commit):
    return (f"<!-- pyre-agent:begin {commit[:12]}. install.py writes this block from global/AGENTS.md. Edit outside it. -->\n"
            f"{body}<!-- pyre-agent:end -->\n")


def find_block(text):
    """Return (start, end, body) of the owned block, or None without markers. Raise Failure for broken markers."""
    begins, ends = list(BEGIN.finditer(text)), list(END.finditer(text))
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0].start() < begins[0].end():
        raise Failure("its pyre-agent markers are broken; keep exactly one begin line above one end line")
    end = ends[0].end() + (text[ends[0].end():ends[0].end() + 1] == "\n")
    return begins[0].start(), end, text[begins[0].end() + 1:ends[0].start()]


def sections(text):
    """Split Markdown at level-2 headings outside code fences into (heading, text) pairs. The first heading is None."""
    parts, heading, lines, fence = [], None, [], None
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            fence = None if fence == stripped[:3] else fence or stripped[:3]
        elif fence is None and line.startswith("## "):
            parts.append((heading, "".join(lines)))
            heading, lines = line[3:].strip(), []
        lines.append(line)
    parts.append((heading, "".join(lines)))
    return parts


def strip_legacy_imports(text):
    """Drop `@path` lines that import this checkout's global/AGENTS.md, as the old README told Claude Code users to add."""
    target = REPO / "global" / "AGENTS.md"
    kept, removed = [], []
    for line in text.splitlines(keepends=True):
        found = re.fullmatch(r"@(\S+)\s*", line)
        if found and Path(os.path.realpath(os.path.expanduser(found[1]))) == target:
            removed.append(found[0].strip())
        else:
            kept.append(line)
    return "".join(kept), removed


def merge(existing, body):
    """Drop sections the block repeats, keep local ones, and report sections whose heading matches but text differs."""
    def normalize(text):
        return " ".join(text.translate(QUOTES).split())

    repo = dict(sections(body))
    kept, kept_names, dropped, conflicts = [], [], [], []
    for heading, text in sections(existing):
        if not text.strip():
            continue
        name = heading or PREAMBLE
        if heading is not None and heading in repo and normalize(text) != normalize(repo[heading]):
            diff = difflib.unified_diff(text.splitlines(), repo[heading].splitlines(), "yours", "global/AGENTS.md", lineterm="")
            conflicts.append((name, list(diff)))
        elif normalize(text) == normalize(repo.get(heading, "")):
            dropped.append(name)
        else:
            kept.append(text if text.endswith("\n") else text + "\n")
            kept_names.append(name)
    return kept, kept_names, dropped, conflicts


def plan_instructions(host, body, commit, recorded, force):
    path = host.instructions
    if body is None:
        return Instructions("missing", path)
    block, body_hash = render_block(body, commit), text_hash(body)
    if path.is_symlink():
        if Path(os.path.realpath(path)) == REPO / "global" / "AGENTS.md":
            return Instructions("adopt", path, block, body_hash)
        return Instructions("conflict", path, notes=(f"{shown(path)} is a symlink, and install.py does not write through it",))
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if not existing.strip():
        return Instructions("create", path, block, body_hash)
    try:
        found = find_block(existing)
    except Failure as error:
        return Instructions("conflict", path, notes=(str(error),))
    if found:
        start, end, current = found
        if recorded and text_hash(current) != recorded["hash"] and not force:
            return Instructions("edited", path)
        if current == body:
            return Instructions("current", path, body_hash=body_hash)
        return Instructions("update", path, existing[:start] + block + existing[end:], body_hash)
    existing, imports = strip_legacy_imports(existing)
    kept, kept_names, dropped, conflicts = merge(existing, body)
    if conflicts:
        notes = []
        for name, diff in conflicts:
            notes.append(f"{name}: same heading as global/AGENTS.md, different text. Edit or rename your section, then run again.")
            notes.extend(f"  {line}" for line in diff)
        return Instructions("conflict", path, notes=tuple(notes))
    notes = [f"remove the import line {line}" for line in imports]
    if dropped:
        notes.append("drop, because the block repeats them: " + ", ".join(dropped))
    if kept_names:
        notes.append("keep after the block: " + ", ".join(kept_names) + ". Delete any that repeat the block under another heading.")
    return Instructions("merge", path, block + ("\n" + "".join(kept) if kept else ""), body_hash, tuple(notes))


def plan_instructions_removal(host, recorded, force):
    path = host.instructions
    if path.is_symlink() or not path.exists():
        return Instructions("forget", path) if recorded else None
    existing = path.read_text(encoding="utf-8")
    try:
        found = find_block(existing)
    except Failure as error:
        return Instructions("conflict", path, notes=(str(error),))
    if not found:
        return Instructions("forget", path) if recorded else None
    start, end, current = found
    if recorded and text_hash(current) != recorded["hash"] and not force:
        return Instructions("edited", path)
    backup = (f"your file from before the first install is at {shown(recorded['backup'])}",) if recorded and recorded.get("backup") else ()
    rest = (existing[:start] + existing[end:]).lstrip("\n")
    if not rest.strip() and (not recorded or recorded.get("created")):
        return Instructions("delete", path, notes=backup)
    return Instructions("remove", path, rest, notes=backup)


def report_instructions(host, instructions):
    if instructions.kind == "forget":
        return
    print(f"  instructions  {shown(instructions.path)}: {INSTRUCTION_SUMMARY[instructions.kind]}")
    for note in instructions.notes:
        print(f"    {note}")
    override = host.config_dir / "AGENTS.override.md"
    if host.name == "codex" and instructions.kind not in ("remove", "delete") and override.is_file() and override.read_text(encoding="utf-8").strip():
        print(f"    warning: {shown(override)} is not empty, so Codex reads it instead of AGENTS.md")


def apply_instructions(instructions, recorded):
    """Write the planned file and return its new record entry."""
    path = instructions.path
    created = recorded["created"] if recorded else instructions.kind in ("create", "adopt")
    backup = recorded.get("backup") if recorded else None
    if instructions.kind == "merge":
        backup = str(path.with_name(f"{path.name}.pyre-backup-{datetime.now().strftime('%Y%m%dT%H%M%S')}"))
        shutil.copy2(path, backup)
    if instructions.text is not None:
        write_atomic(path, instructions.text)
    return {"path": str(path), "hash": instructions.body_hash, "created": created, "backup": backup}


def apply_instructions_removal(instructions):
    if instructions.kind == "delete":
        instructions.path.unlink()
    elif instructions.kind == "remove":
        write_atomic(instructions.path, instructions.text)


def record_path():
    base = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    return Path(base).expanduser() / "pyre-agent" / "install.json"


def load_record():
    path = record_path()
    if not path.exists():
        return {"version": RECORD_VERSION, "hosts": {}}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise Failure(f"{path} is not valid JSON ({error}); fix or delete it") from error
    if record.get("version") != RECORD_VERSION:
        raise Failure(f"{path} has record version {record.get('version')!r}; this install.py reads version {RECORD_VERSION}")
    return record


def save_record(record):
    write_atomic(record_path(), json.dumps(record, indent=2, sort_keys=True) + "\n")


def install(args):
    ref = args.ref or "main"
    if not args.offline:
        fetch()
    commit = resolve(ref)
    record = load_record()
    hosts = pick_hosts(args.host, record)
    print(f"{'Planning' if args.dry_run else 'Installing'} {ref} at {commit[:12]}")
    problems = 0
    with tempfile.TemporaryDirectory(prefix="pyre-agent-") as temporary:
        tree = Path(temporary)
        extract(commit, tree)
        body = read_body(tree)
        for host in hosts:
            entry = record["hosts"].get(host.name, {"skills": {}})
            actions = plan(host, source_skills(tree, host.name), entry["skills"], args.force)
            instructions = plan_instructions(host, body, commit, entry.get("instructions"), args.force)
            was = entry.get("commit")
            report(host, actions, f"(was {entry['ref']} at {was[:12]})" if was and was != commit else "")
            report_instructions(host, instructions)
            problems += sum(action.kind in PROBLEMS for action in actions) + (instructions.kind in PROBLEMS)
            if args.dry_run:
                continue
            record["hosts"][host.name] = entry
            apply(host, actions, entry["skills"], lambda: save_record(record))
            if instructions.kind in ("create", "update", "adopt", "merge", "current"):
                entry["instructions"] = apply_instructions(instructions, entry.get("instructions"))
            entry.update(ref=ref, commit=commit, installed_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            save_record(record)
    return 1 if problems else 0


def read_body(tree):
    path = tree / "global" / "AGENTS.md"
    if not path.is_file():
        return None
    body = path.read_text(encoding="utf-8")
    return body if body.endswith("\n") else body + "\n"


def status(args):
    record = load_record()
    hosts = [host for host in pick_hosts(args.host, record) if host.name in record["hosts"]] if record["hosts"] else []
    if not hosts:
        print("Nothing installed.")
        return 0
    if not args.offline:
        fetch()
    main = try_rev("refs/remotes/origin/main^{commit}")
    with tempfile.TemporaryDirectory(prefix="pyre-agent-") as temporary:
        tree = Path(temporary)
        if main:
            extract(main, tree)
        problems = 0
        main_body = read_body(tree) if main else None
        for host in hosts:
            entry = record["hosts"][host.name]
            main_skills = source_skills(tree, host.name) if main else {}
            try:
                now = resolve(entry["ref"])
            except Failure:
                now = None
            moved = "" if now == entry["commit"] else f", {entry['ref']} now at {now[:12]}" if now else f", {entry['ref']} no longer resolves"
            print(f"{host.name}  {shown(host.skills_dir)}  {entry['ref']} at {entry['commit'][:12]}{moved}")
            for name, item in sorted(entry["skills"].items()):
                notes = []
                path = Path(item["path"])
                if not os.path.lexists(path):
                    notes.append("missing")
                elif tree_hash(path) != item["hash"]:
                    notes.append("edited locally")
                if main and name not in main_skills:
                    notes.append("not on main")
                elif main and skill_version(main_skills[name]) != item["version"]:
                    notes.append(f"main has {skill_version(main_skills[name]) or 'unversioned'}")
                problems += "missing" in notes or "edited locally" in notes
                print(f"  {name:<52} {item['version'] or 'unversioned':<12} {', '.join(notes)}".rstrip())
            if "instructions" in entry:
                state = instruction_state(entry["instructions"], main_body)
                problems += state.startswith(("missing", "edited"))
                print(f"  instructions  {shown(entry['instructions']['path'])}: {state}")
    return 1 if problems else 0


def instruction_state(recorded, main_body):
    path = Path(recorded["path"])
    if path.is_symlink() or not path.is_file():
        return "missing"
    try:
        found = find_block(path.read_text(encoding="utf-8"))
    except Failure as error:
        return f"edited: {error}"
    if not found:
        return "missing its block"
    if text_hash(found[2]) != recorded["hash"]:
        return "edited inside the block"
    if main_body is not None and text_hash(main_body) != recorded["hash"]:
        return "up to date with the installed ref; main has different instructions"
    return "up to date"


def uninstall(args):
    record = load_record()
    problems = 0
    for host in pick_hosts(args.host, record):
        entry = record["hosts"].get(host.name, {"skills": {}})
        actions = plan(host, {}, entry["skills"], args.force)
        removal = plan_instructions_removal(host, entry.get("instructions"), args.force)
        report(host, actions, "(dry run)" if args.dry_run else "")
        if removal:
            report_instructions(host, removal)
        problems += sum(action.kind in PROBLEMS for action in actions) + bool(removal and removal.kind in PROBLEMS)
        if args.dry_run or (host.name not in record["hosts"] and not actions and removal is None):
            continue
        record["hosts"][host.name] = entry
        apply(host, actions, entry["skills"], lambda: save_record(record))
        if removal and removal.kind in ("remove", "delete", "forget"):
            apply_instructions_removal(removal)
            entry.pop("instructions", None)
        if not entry["skills"] and "instructions" not in entry:
            del record["hosts"][host.name]
        save_record(record)
    return 1 if problems else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", nargs="?", default="install", choices=("install", "status", "uninstall"))
    parser.add_argument("--ref", help="tag, origin branch or commit to install (default main)")
    parser.add_argument("--host", choices=tuple(all_hosts()), help="act on one host (default: every host found)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and change no installed files")
    parser.add_argument("--offline", action="store_true", help="skip git fetch and use refs already in this checkout")
    parser.add_argument("--force", action="store_true", help="overwrite or remove installed skills and instruction blocks that were edited locally")
    args = parser.parse_args()
    if args.ref is not None and args.command != "install":
        parser.error("--ref applies only to install")
    try:
        return {"install": install, "status": status, "uninstall": uninstall}[args.command](args)
    except (Failure, OSError) as error:
        print(f"install.py: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
