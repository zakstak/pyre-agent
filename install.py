#!/usr/bin/env python3
"""Install pyre-agent skills from a Git ref for Claude Code and Codex.

Run: python3 install.py [install|status|uninstall] [--ref REF] [--host HOST]
                        [--dry-run] [--offline] [--force]
Copies skills from the commit that REF names (default main), never from the
working tree, and changes only paths it recorded installing. Python 3.10+;
standard library only.
"""
import argparse
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


class Failure(Exception):
    pass


@dataclass(frozen=True)
class Host:
    name: str
    config_dir: Path
    skills_dir: Path


@dataclass(frozen=True)
class Action:
    kind: str  # install, update, adopt, remove, unlink, forget, current, conflict, edited
    name: str
    path: Path
    source: Path | None = None
    version: str | None = None
    old_version: str | None = None


def all_hosts():
    home = Path.home()
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude").expanduser()
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex").expanduser()
    return {
        "claude-code": Host("claude-code", claude, claude / "skills"),
        "codex": Host("codex", codex, home / ".agents" / "skills"),
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
    present = git("ls-tree", "--name-only", commit, "--", "skills", "host-skills").split()
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
    path = record_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


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
        for host in hosts:
            entry = record["hosts"].get(host.name, {"skills": {}})
            actions = plan(host, source_skills(tree, host.name), entry["skills"], args.force)
            was = entry.get("commit")
            report(host, actions, f"(was {entry['ref']} at {was[:12]})" if was and was != commit else "")
            problems += sum(action.kind in PROBLEMS for action in actions)
            if args.dry_run:
                continue
            record["hosts"][host.name] = entry
            apply(host, actions, entry["skills"], lambda: save_record(record))
            entry.update(ref=ref, commit=commit, installed_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            save_record(record)
    return 1 if problems else 0


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
    return 1 if problems else 0


def uninstall(args):
    record = load_record()
    problems = 0
    for host in pick_hosts(args.host, record):
        entry = record["hosts"].get(host.name, {"skills": {}})
        actions = plan(host, {}, entry["skills"], args.force)
        report(host, actions, "(dry run)" if args.dry_run else "")
        problems += sum(action.kind in PROBLEMS for action in actions)
        if args.dry_run or (host.name not in record["hosts"] and not actions):
            continue
        record["hosts"][host.name] = entry
        apply(host, actions, entry["skills"], lambda: save_record(record))
        if not entry["skills"]:
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
    parser.add_argument("--force", action="store_true", help="replace or remove installed skills that were edited locally")
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
