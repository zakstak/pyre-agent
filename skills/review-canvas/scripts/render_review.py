#!/usr/bin/env python3
"""Render normalized review JSON for a GitHub PR or a local working tree to a private, offline, standalone HTML file.

Python 3.10+; standard library only. See ../assets/example-review.json for input.
No input is executed, no credentials are read, and no network is used.
"""

import argparse
import base64
import hashlib
import html
import json
import os
import re
import stat
import sys
from pathlib import Path


MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PATCH_CHARS = 4 * 1024 * 1024
MAX_PATCH_LINES = 10000
MAX_TOTAL_PATCH_LINES = 50000
MAX_FILES = 2000
MAX_FEEDBACK_PATH_BYTES = 6 * 1024 * 1024
GROUPS = (
    ("core", "Core logic", "Behavior, algorithms, state, and API changes. Start here."),
    ("wiring", "Wiring & integration", "Connections and configuration. Diffs start collapsed."),
    ("mechanical", "Boilerplate & mechanical", "Formatting, generated code, and routine changes. Files start collapsed."),
)
STATUSES = {"added", "modified", "deleted", "removed", "renamed", "copied", "changed", "unchanged"}
# Why a file has no patch, or why its patch differs from the bytes on disk. The renderer owns the wording.
PATCH_NOTES = {
    "binary": ("Binary file.", "The page shows no patch. Inspect the file with the project's own tools before you approve it."),
    "too_large": ("Patch too large.", "The patch exceeds the page limits, so the page leaves it out. Inspect the file directly before you approve it."),
    "symlink": ("Symbolic link.", "The page shows no text patch for a link. Check its target before you approve it."),
    "submodule": ("Submodule or nested repository.", "The page shows no text patch. Inspect the submodule commit before you approve it."),
    "secret": ("Likely secret file.", "The collector left its contents out. Inspect the file yourself, and keep its contents out of comments."),
    "no_content_change": ("No content change.", "Only the path or the file mode changed."),
    "empty": ("Empty file.", "The file has no content."),
    "replaced_characters": ("Characters replaced.", "Some bytes were not valid UTF-8 or were control characters. The patch shows replacement symbols for them."),
}
TEXT_PATCH_NOTES = {"replaced_characters"}
PR_URL = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*\Z")
SHA = re.compile(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\Z")
FINGERPRINT = re.compile(r"[a-f0-9]{64}\Z")
MODE = re.compile(r"[0-7]{6}\Z")
# POSIX, a Windows drive, or a Windows UNC share such as \\server\share.
ABSOLUTE_ROOT = re.compile(r"(?:/|[A-Za-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+)")
HUNK = re.compile(r"^@@ -([0-9]{1,12})(?:,[0-9]{1,12})? \+([0-9]{1,12})(?:,[0-9]{1,12})? @@")


class ValidationError(ValueError):
    """The supplied review does not conform to the normalized input contract."""


def _object(value, where, required, optional=()):
    if not isinstance(value, dict):
        raise ValidationError(f"{where}: expected an object")
    missing = set(required) - value.keys()
    unknown = value.keys() - set(required) - set(optional)
    if missing:
        raise ValidationError(f"{where}: missing fields: {', '.join(sorted(missing))}")
    if unknown:
        raise ValidationError(f"{where}: unknown fields: {', '.join(sorted(unknown))}")


CONTROL_ESCAPES = {**{code: f"\\u{code:04x}" for code in [*range(0x20), *range(0x7F, 0xA0), 0x2028, 0x2029]},
                   0x09: "\\t", 0x0A: "\\n", 0x0D: "\\r"}


def escaped(text):
    """Text for one terminal line, such as an error naming a path: control characters and line separators become escapes."""
    return str(text).translate(CONTROL_ESCAPES)


def shown(path):
    """A path for terminal output. Git allows control characters in names, so a name with one is quoted and escaped,
    and cannot forge or overwrite a line."""
    if not any(ord(character) < 0x20 or 0x7F <= ord(character) < 0xA0 or character in "\u2028\u2029" for character in path):
        return path
    return json.dumps(path, ensure_ascii=False).translate({code: f"\\u{code:04x}" for code in [*range(0x7F, 0xA0), 0x2028, 0x2029]})


def units(value):
    """Length in UTF-16 code units, the unit the page's JavaScript uses, so both sides apply the same limits."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _text(value, where, *, nonempty=False, limit=20000):
    if not isinstance(value, str):
        raise ValidationError(f"{where}: expected a string")
    if units(value) > limit:
        raise ValidationError(f"{where}: exceeds {limit} UTF-16 code units")
    if nonempty and not value.strip():
        raise ValidationError(f"{where}: must not be empty")
    if any((ord(c) < 32 and c not in "\t\n\r") or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValidationError(f"{where}: contains an unsupported control character or Unicode surrogate")


def _target(target):
    """A target is a GitHub PR or a local working tree. Only a pinned target can carry inline comments."""
    if not isinstance(target, dict) or target.get("kind") not in ("github_pr", "worktree"):
        raise ValidationError("target.kind: expected github_pr or worktree")
    if target["kind"] == "github_pr":
        _object(target, "target", ("kind", "title"), ("url", "head_sha", "base_sha", "changed_files"))
        if "url" in target:
            _text(target["url"], "target.url", nonempty=True)
            if not PR_URL.fullmatch(target["url"]):
                raise ValidationError("target.url: expected https://github.com/OWNER/REPO/pull/NUMBER, or omit url")
    else:
        _object(target, "target", ("kind", "title", "root", "head_sha"), ("branch", "changed_files"))
        _text(target["root"], "target.root", nonempty=True, limit=4096)
        if not ABSOLUTE_ROOT.match(target["root"]):
            raise ValidationError("target.root: expected an absolute path")
        if "branch" in target:
            _text(target["branch"], "target.branch", nonempty=True, limit=1024)
    _text(target["title"], "target.title", nonempty=True)
    for name in ("head_sha", "base_sha"):
        if name in target:
            _text(target[name], f"target.{name}")
            if not SHA.fullmatch(target[name]):
                raise ValidationError(f"target.{name}: expected a full 40- or 64-character hexadecimal commit hash")
    if "changed_files" in target and (type(target["changed_files"]) is not int or not 0 <= target["changed_files"] <= 10**12):
        raise ValidationError("target.changed_files: expected a nonnegative integer at most 1000000000000")


def validate_review(review):
    """Validate without changing or dropping input. Return the supplied object."""
    if isinstance(review, dict) and "schema_version" in review and review["schema_version"] != 2:
        raise ValidationError(f"review.schema_version: version {review['schema_version']!r} is not supported; expected integer 2. "
                              "Collect a new snapshot in the version 2 format; there is no migration")
    _object(review, "review", ("schema_version", "target", "files"), ("summary", "files_complete"))
    if type(review["schema_version"]) is not int:
        raise ValidationError("review.schema_version: expected integer 2")
    _target(review["target"])
    target = review["target"]
    if "files_complete" in review and type(review["files_complete"]) is not bool:
        raise ValidationError("files_complete: expected a boolean")
    if "summary" in review:
        _text(review["summary"], "summary")
    if not isinstance(review["files"], list) or len(review["files"]) > MAX_FILES:
        raise ValidationError(f"files: expected an array of at most {MAX_FILES} files")
    if review.get("files_complete") is True and target.get("changed_files") != len(review["files"]):
        raise ValidationError("files_complete: true requires target.changed_files matching the supplied file count")
    # Feedback lists every path twice, in files and approvals, within its 8 MiB limit. Leave room for notes and comments.
    paths = sum(len(json.dumps(file.get("path", ""))) for file in review["files"] if isinstance(file, dict))
    if 2 * paths + 200 * len(review["files"]) > MAX_FEEDBACK_PATH_BYTES:
        raise ValidationError("files: the paths are too long for feedback on this review to fit its 8 MiB limit; split the review")
    seen = set()
    total_patch_lines = 0
    for i, file in enumerate(review["files"]):
        where = f"files[{i}]"
        _object(file, where, ("path", "status", "group", "additions", "deletions"),
                ("fingerprint", "old_path", "old_mode", "new_mode", "patch", "patch_complete", "patch_note",
                 "summary", "pseudocode", "trace", "callouts"))
        _text(file["path"], f"{where}.path", nonempty=True, limit=4096)
        if file["path"] in seen:
            raise ValidationError(f"{where}.path: duplicate file path")
        seen.add(file["path"])
        if not isinstance(file["status"], str) or file["status"] not in STATUSES:
            raise ValidationError(f"{where}.status: expected one of {', '.join(sorted(STATUSES))}")
        if not isinstance(file["group"], str) or file["group"] not in {g[0] for g in GROUPS}:
            raise ValidationError(f"{where}.group: expected core, wiring, or mechanical")
        for stat in ("additions", "deletions"):
            if type(file[stat]) is not int or not 0 <= file[stat] <= 10**12:
                raise ValidationError(f"{where}.{stat}: expected a nonnegative integer at most 1000000000000")
        if "fingerprint" in file:
            if not isinstance(file["fingerprint"], str) or not FINGERPRINT.fullmatch(file["fingerprint"]):
                raise ValidationError(f"{where}.fingerprint: expected 64 lowercase hexadecimal characters")
        elif target["kind"] == "worktree":
            raise ValidationError(f"{where}.fingerprint: required for a worktree target")
        if "old_path" in file:
            _text(file["old_path"], f"{where}.old_path", nonempty=True, limit=4096)
            if file["status"] not in ("renamed", "copied") or file["old_path"] == file["path"]:
                raise ValidationError(f"{where}.old_path: allowed only for a renamed or copied file, and must differ from path")
        for name in ("old_mode", "new_mode"):
            if name in file and (not isinstance(file[name], str) or not MODE.fullmatch(file[name])):
                raise ValidationError(f"{where}.{name}: expected a six-digit octal Git mode such as 100644")
        if file.get("patch") is not None:
            _text(file["patch"], f"{where}.patch", limit=MAX_PATCH_CHARS)
            patch = file["patch"]
            line_count = patch.count("\n") + int(bool(patch) and not patch.endswith("\n"))
            if line_count > MAX_PATCH_LINES:
                raise ValidationError(f"{where}.patch: exceeds {MAX_PATCH_LINES} supplied lines; nothing was truncated")
            total_patch_lines += line_count
            if total_patch_lines > MAX_TOTAL_PATCH_LINES:
                raise ValidationError(f"files: patches exceed {MAX_TOTAL_PATCH_LINES} total supplied lines; nothing was truncated")
        if "patch_complete" in file and type(file["patch_complete"]) is not bool:
            raise ValidationError(f"{where}.patch_complete: expected a boolean")
        if "patch_note" in file:
            note = file["patch_note"]
            if not isinstance(note, str) or note not in PATCH_NOTES:
                raise ValidationError(f"{where}.patch_note: expected one of {', '.join(sorted(PATCH_NOTES))}")
            if (note in TEXT_PATCH_NOTES) != bool(file.get("patch")):
                raise ValidationError(f"{where}.patch_note: {note} " + ("needs a patch" if note in TEXT_PATCH_NOTES else "is only for a file without a patch"))
        for name in ("summary", "pseudocode"):
            if name in file:
                _text(file[name], f"{where}.{name}")
        if "trace" in file:
            _object(file["trace"], f"{where}.trace", ("input", "before", "after"))
            for name in ("input", "before", "after"):
                _text(file["trace"][name], f"{where}.trace.{name}")
        if "callouts" in file:
            if not isinstance(file["callouts"], list) or len(file["callouts"]) > 100:
                raise ValidationError(f"{where}.callouts: expected an array of at most 100 callouts")
            for j, callout in enumerate(file["callouts"]):
                label = f"{where}.callouts[{j}]"
                _object(callout, label, ("tag", "text"))
                _text(callout["tag"], f"{label}.tag", nonempty=True, limit=100)
                _text(callout["text"], f"{label}.text", nonempty=True)
    return review


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"JSON contains duplicate key: {key}")
        result[key] = value
    return result


def load_review(path):
    with Path(path).open("rb") as handle:
        raw = handle.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValidationError(f"input exceeds {MAX_INPUT_BYTES} bytes")
    try:
        review = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                            parse_constant=lambda value: (_ for _ in ()).throw(ValidationError(f"Invalid JSON constant: {value}")))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValidationError(f"invalid UTF-8 JSON: {error}") from error
    review = validate_review(review)
    # A rendered round records its input's digest. A later edit would make readers see other input than the page.
    recorded = Path(path).parent / "input.sha256"
    if Path(path).name == "input.json" and recorded.exists() and recorded.read_text(encoding="ascii").strip() != input_digest(review):
        raise ValidationError(f"{path} changed after its round rendered; a round never changes. Start a new round.")
    return review


def escape(value):
    return html.escape(str(value), quote=True)


def _code(value):
    # HTML parsing turns a raw CR into LF. A character reference keeps CRLF patch rows byte-exact for anchors.
    return escape(value).replace("\r", "&#13;")


def _paragraph(value, css_class="commentary"):
    return f'<p class="{css_class}">{escape(value)}</p>' if value else ""


def patch_lines(patch):
    """Keep every patch line, including headers, markers, and unknown formats."""
    old = new = None
    rows = []
    # Split only LF: splitlines() treats other characters in source as line breaks.
    lines = patch.split("\n")
    if patch.endswith("\n"):
        lines.pop()
    for line in lines:
        old_label = new_label = ""
        kind = "context"
        hunk = HUNK.match(line)
        if hunk:
            old, new = int(hunk[1]), int(hunk[2])
            kind = "hunk"
        elif line.startswith(("diff --git ", "index ", "--- ", "+++ ")) and old is None:
            kind = "meta"
        elif line.startswith("+"):
            kind = "addition"
            if new is not None:
                new_label, new = new, new + 1
        elif line.startswith("-"):
            kind = "deletion"
            if old is not None:
                old_label, old = old, old + 1
        elif line.startswith(" "):
            if old is not None:
                old_label, old = old, old + 1
            if new is not None:
                new_label, new = new, new + 1
        else:
            kind = "meta"
        rows.append({"text": line, "kind": kind, "old_line": old_label or None, "new_line": new_label or None})
    return rows


def coverage_counts(files):
    """Return the missing, incomplete, and unverified patch counts. A file with no content change misses nothing."""
    return (sum(not f.get("patch") and f.get("patch_note") not in ("no_content_change", "empty") for f in files),
            sum(bool(f.get("patch")) and f.get("patch_complete") is False for f in files),
            sum(bool(f.get("patch")) and "patch_complete" not in f for f in files))


def _plural(count, singular, plural=None):
    return f"{count:,} {singular if count == 1 else plural or singular + 's'}"


def _diffstat(additions, deletions):
    return (f'<span class="diffstat"><span class="additions">+{additions:,}<span class="sr-only"> added lines</span></span> '
            f'<span class="deletions">−{deletions:,}<span class="sr-only"> deleted lines</span></span></span>')


def _patch_html(patch, path=""):
    rows = []
    for i, line in enumerate(patch_lines(patch)):
        old, new = line["old_line"] or "", line["new_line"] or ""
        action = ""
        if line["kind"] not in ("hunk", "meta"):
            where = f"line {new}" if new else f"old line {old}" if old else f"diff row {i + 1}"
            action = f'<button class="comment-line" type="button" aria-label="Comment on {escape(path)} {where}">+</button>'
        rows.append(f'<tr class="{line["kind"]}" data-row="{i}" data-kind="{line["kind"]}" data-old="{old}" data-new="{new}">'
                    f'<td class="line-number">{old}</td><td class="line-number">{new}</td>'
                    f'<td class="line-action">{action}</td><td class="source"><code>{_code(line["text"])}</code></td></tr>')
    return (f'<div class="diff-scroll" tabindex="0" role="region" aria-label="Diff for {escape(path)}">'
            '<table class="diff"><thead><tr><th scope="col">Old line</th><th scope="col">New line</th>'
            '<th scope="col">Comment</th><th scope="col">Code</th></tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>')


def _notice(title, text, tone="warning"):
    return f'<p class="notice {tone} file-notice"><strong>{title}</strong> {text}</p>'


def _file_html(file, index):
    ident = f"file-{index}"
    path = file["path"]
    missing = not file.get("patch")
    note = file.get("patch_note")
    notice = ""
    if note:
        notice = _notice(*PATCH_NOTES[note], tone="" if note in ("no_content_change", "empty") else "warning")
    if missing and not note:
        notice += _notice("Patch unavailable.", "This may be a binary, omitted, empty, or inaccessible diff. Inspect the source before you approve it.")
    elif not missing and file.get("patch_complete") is False:
        notice += _notice("Patch marked incomplete.", "Only the supplied lines are shown. Inspect the complete source before you approve it.")
    elif not missing and file.get("patch_complete") is not True:
        notice += _notice("Patch completeness unverified.", "No patch_complete declaration was supplied. Compare these lines with the complete source before you approve it.")
    analysis = _paragraph(file.get("summary"))
    if file.get("pseudocode"):
        analysis += '<section class="explanation"><h4>Pseudocode</h4><pre class="code-block">' + escape(file["pseudocode"]) + '</pre></section>'
    if "trace" in file:
        trace = file["trace"]
        analysis += ('<section class="explanation trace"><h4>Example trace</h4><div class="trace-step"><p class="trace-label">Input</p><pre class="code-block">'
                     + escape(trace["input"]) + '</pre></div><div class="trace-columns"><div class="trace-step"><p class="trace-label">Before</p><pre class="code-block">'
                     + escape(trace["before"]) + '</pre></div><div class="trace-step"><p class="trace-label">After</p><pre class="code-block">'
                     + escape(trace["after"]) + '</pre></div></div></section>')
    for callout in file.get("callouts", []):
        analysis += '<aside class="callout"><p class="callout-tag">' + escape(callout["tag"]) + '</p>' + _paragraph(callout["text"]) + '</aside>'
    body = f'<div class="analysis">{analysis}</div>' if analysis else ""
    if not missing:
        line_count = len(file["patch"].split("\n")) - int(file["patch"].endswith("\n"))
        body += (f'<details class="patch-details"{"" if file["group"] == "wiring" else " open"}><summary>Diff '
                 f'<span class="summary-meta">{_plural(line_count, "line")}</span></summary>{_patch_html(file["patch"], path)}</details>')
    if not body and not note:
        body = '<p class="empty-detail">No review commentary or patch supplied.</p>'
    directory, slash, name = path.rpartition("/")
    path_html = (f'<span class="path-dir">{escape(directory + slash)}</span>' if slash else "") + f'<span class="path-name">{escape(name)}</span>'
    search = " ".join((path, file.get("old_path", ""), file["status"], file["group"], file.get("summary", "")))
    meta = f'<span class="chip">{escape(file["status"])}</span>{_diffstat(file["additions"], file["deletions"])}'
    if file.get("old_path"):
        meta += f'<span class="file-from">from <code>{escape(file["old_path"])}</code></span>'
    if file.get("old_mode") and file.get("new_mode") and file["old_mode"] != file["new_mode"]:
        meta += f'<span class="chip">mode {file["old_mode"]} → {file["new_mode"]}</span>'
    meta += '<span class="chip warning approval-changed" hidden>Changed since approval</span><span class="chip comment-count" hidden></span>'
    if file.get("fingerprint"):
        approve = f'<input class="approved" type="checkbox" autocomplete="off" aria-label="Approve {escape(path)}">'
    else:
        approve = (f'<input class="approved" type="checkbox" autocomplete="off" disabled aria-label="Approve {escape(path)}" aria-describedby="{ident}-no-fingerprint">'
                   f'<span class="sr-only" id="{ident}-no-fingerprint">Approval needs a file fingerprint in the input.</span>')
    return (f'<article class="file-card" id="{ident}" data-file-id="{ident}" data-group="{file["group"]}" data-search="{escape(search)}">'
            f'<header class="file-header"><h3 class="file-path"><button class="file-toggle" type="button" aria-expanded="true" aria-controls="{ident}-body">{path_html}</button></h3>'
            f'<div class="file-meta">{meta}</div>'
            f'<label class="review-toggle">{approve} Approved</label></header>'
            + notice + f'<div class="file-body" id="{ident}-body">{body}</div>'
            f'<details class="notes-details"><summary>Your notes<span class="note-indicator"></span></summary>'
            f'<label class="sr-only" for="notes-{index}">Notes for {escape(path)}</label>'
            f'<textarea id="notes-{index}" class="file-notes" rows="3" maxlength="20000" autocomplete="off" spellcheck="false" placeholder="Questions, findings, or follow-up for this file"></textarea></details></article>')


def _nav_html(review):
    groups = []
    for key, label, _ in GROUPS:
        items = []
        for i, file in enumerate(review["files"]):
            if file["group"] != key:
                continue
            directory, slash, name = file["path"].rpartition("/")
            items.append(f'<li data-file="file-{i}"><a href="#file-{i}"><span class="nav-mark" aria-hidden="true"></span>'
                         f'<span class="nav-text"><span class="nav-name">{escape(name)}</span>'
                         + (f'<span class="nav-dir">{escape(directory)}</span>' if slash else "")
                         + f'</span><span class="nav-count" hidden></span><span class="sr-only nav-state"></span>'
                         f'<span class="nav-stats" aria-hidden="true"><span class="additions">+{file["additions"]:,}</span> <span class="deletions">−{file["deletions"]:,}</span></span></a></li>')
        if items:
            groups.append(f'<div class="nav-group" data-group="{key}"><p class="nav-group-label">{escape(label)}</p><ol>' + "".join(items) + '</ol></div>')
    return ('<nav class="file-nav" aria-label="Changed files"><p class="nav-heading">Files <span class="muted">'
            f'{len(review["files"]):,}</span></p>' + "".join(groups) + '</nav>')


def shared_style(style_dir=None):
    """Consume the canonical companion at render time; embed it for offline delivery."""
    folder = Path(style_dir) if style_dir else Path(__file__).resolve().parents[2] / "internal-visual-style"
    assets = folder / "assets"
    try:
        css = (assets / "tokens.css").read_text(encoding="utf-8")
        fonts = (assets / "fonts.css").read_text(encoding="utf-8")
        components = (assets / "components.css").read_text(encoding="utf-8")
        def embed(match):
            name = match[1]
            if name not in {"atkinson-hyperlegible-next.ttf", "atkinson-hyperlegible-mono.ttf"}:
                raise ValidationError("shared font reference is unsupported; update the dependency adapter")
            data = base64.b64encode((assets / "fonts" / name).read_bytes()).decode()
            return f'url("data:font/ttf;base64,{data}")'
        fonts = re.sub(r'url\("\./fonts/([^"/]+)"\)', embed, fonts)
        if re.search(r'url\((?!"data:font/ttf;base64,)', fonts + components):
            raise ValidationError("shared font URL was not embedded")
        js = (assets / "theme.js").read_text(encoding="utf-8")
        notices = "\n\n".join((assets / "fonts" / name).read_text(encoding="utf-8") for name in ("OFL.txt", "atkinson-hyperlegible-mono-OFL.txt"))
        return css + "\n" + fonts + "\n" + components + "\n", js, notices
    except OSError as error:
        raise ValidationError("internal-visual-style companion is missing or unreadable. Install its complete folder beside review-canvas, or pass --style-dir /path/to/internal-visual-style. " + str(error)) from error


def input_digest(review):
    """Identify one input snapshot. Feedback records this digest as input_sha256."""
    return hashlib.sha256(json.dumps(review, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def render_review(review, style_dir=None):
    """Return a self-contained HTML document for a validated review object."""
    validate_review(review)
    assets = Path(__file__).resolve().parent.parent / "assets"
    css, theme_js, notices = shared_style(style_dir)
    css += (assets / "review.css").read_text(encoding="utf-8")
    js = theme_js + "\n" + (assets / "feedback.js").read_text(encoding="utf-8") + "\n" + (assets / "review.js").read_text(encoding="utf-8")
    digest = input_digest(review)
    metadata = {"schema_version": 2, "target": review["target"], "input_sha256": digest,
                "files": [{"id": f"file-{i}", "path": f["path"], "status": f["status"], "group": f["group"], "fingerprint": f.get("fingerprint"),
                           "patch_sha256": hashlib.sha256(f.get("patch", "").encode()).hexdigest() if f.get("patch") else None} for i, f in enumerate(review["files"])]}
    script_hash = base64.b64encode(hashlib.sha256(js.encode()).digest()).decode()
    style_hash = base64.b64encode(hashlib.sha256(css.encode()).digest()).decode()
    csp = (f"default-src 'none'; script-src 'sha256-{script_hash}'; style-src 'sha256-{style_hash}'; "
           "connect-src 'none'; img-src 'none'; font-src data:; object-src 'none'; base-uri 'none'; "
           "form-action 'none'; frame-src 'none'; worker-src 'none'")
    target = review["target"]
    worktree = target["kind"] == "worktree"
    product = "Working tree review" if worktree else "PR review"
    files = review["files"]
    groups = []
    for key, label, description in GROUPS:
        members = [(i, f) for i, f in enumerate(files) if f["group"] == key]
        if members:
            groups.append(f'<section class="review-group" data-group="{key}" aria-labelledby="group-{key}"><header class="group-header">'
                          f'<h2 id="group-{key}">{escape(label)} <span class="group-count">{len(members)}</span></h2><p>{description}</p></header>'
                          + "".join(_file_html(f, i) for i, f in members) + '</section>')
    missing_count, incomplete_count, unverified_count = coverage_counts(files)
    unapprovable = sum("fingerprint" not in f for f in files)
    pinned = worktree or bool(target.get("url") and target.get("head_sha"))
    chips = []
    if review.get("files_complete") is True:
        chips.append('<li class="chip">File list marked complete</li>')
    else:
        chips.append('<li class="chip warning">File list unverified</li>')
    for count, label in ((missing_count, "missing patch"), (incomplete_count, "incomplete patch"), (unverified_count, "unverified patch")):
        if count:
            chips.append(f'<li class="chip warning">{_plural(count, label, label + "es")}</li>')
    if unapprovable:
        chips.append(f'<li class="chip">Approval off for {_plural(unapprovable, "file")}</li>')
    if not pinned:
        chips.append('<li class="chip">Inline comments off</li>')
    scope = ('File list marked complete, with a matching declared changed-file count. '
             if review.get("files_complete") is True else
             'File list completeness is unverified. Reconcile every changed file against the source. ')
    if "changed_files" in target:
        scope += f'{len(files)} supplied / {target["changed_files"]} declared changed files. '
    scope += 'Every supplied patch line is included. Source and patch completeness are not independently verified. Counts and commentary come from the input; this renderer does not invent findings.'
    if unapprovable:
        scope += ' A file needs a fingerprint in the input before it can be approved.'
    if not pinned:
        scope += ' Inline comments need both a PR URL and a pinned head commit in the input.'
    facts = [f'<li>{_plural(len(files), "file")}</li>', f'<li>{_diffstat(sum(f["additions"] for f in files), sum(f["deletions"] for f in files))}</li>']
    snapshot = ""
    if worktree:
        facts.append(f'<li>Against HEAD <code title="{escape(target["head_sha"])}">{escape(target["head_sha"][:7])}</code></li>')
        snapshot += f'<dt>Working tree</dt><dd><code>{escape(target["root"])}</code></dd>'
        if "branch" in target:
            snapshot += f'<dt>Branch</dt><dd><code>{escape(target["branch"])}</code></dd>'
        snapshot += f'<dt>HEAD commit</dt><dd><code>{escape(target["head_sha"])}</code></dd>'
    else:
        for name, label in (("head_sha", "Head"), ("base_sha", "Base")):
            if name in target:
                facts.append(f'<li>{label} <code title="{escape(target[name])}">{escape(target[name][:7])}</code></li>')
                snapshot += f'<dt>{label} commit</dt><dd><code>{escape(target[name])}</code></dd>'
    snapshot = f'<dl class="snapshot">{snapshot}</dl>' if snapshot else '<p>No commit snapshot supplied. Re-check the PR before relying on this review.</p>'
    origin = ""
    if worktree:
        branch = f'<span>branch {escape(target["branch"])}</span>' if "branch" in target else "<span>detached HEAD</span>"
        origin = f'<p class="pr-origin worktree-origin"><span>Uncommitted changes in {escape(target["root"])}</span>{branch}</p>'
    elif target.get("url"):
        owner, repo, _, number = target["url"].split("/")[3:7]
        origin = (f'<p class="pr-origin"><span>{escape(owner)}/{escape(repo)} #{escape(number)}</span>'
                  f'<a href="{escape(target["url"])}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open on GitHub ↗</a></p>')
    comment_hint = ("Select code text, or use + beside a line, to add an inline comment." if pinned
                    else "Inline comments are off. The input needs a PR URL and pinned head commit.")
    return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{escape(csp)}">'
            '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">'
            f'<title>{escape(target["title"])} · {product}</title><style>{css}</style></head><body>'
            '<a class="skip-link" href="#files">Skip to changed files</a>'
            f'<header class="topbar"><p class="topbar-title"><span class="topbar-product">{product}</span><span class="topbar-pr">{escape(target["title"])}</span></p>'
            '<div class="topbar-actions"><div class="progress"><span class="progress-track" aria-hidden="true"><span class="progress-fill"></span></span>'
            f'<p id="progress" role="status" aria-live="polite">0 of {len(files)} approved</p></div>'
            '<span id="save-state" class="chip" hidden></span><a class="button" href="#feedback">Finish review</a>'
            '<button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="false" hidden><span class="theme-label">Dark mode</span></button></div></header>'
            '<div class="layout">' + _nav_html(review) + '<main id="main">'
            '<div id="server-notice" class="notice warning server-notice" role="status" hidden><p id="server-notice-text"></p>'
            '<button id="server-reload" class="primary" type="button" hidden>Reload</button></div>'
            f'<header class="pr-header">{origin}<h1>{escape(target["title"])}</h1>' + _paragraph(review.get("summary"), "lead")
            + '<ul class="pr-facts" aria-label="Snapshot">' + "".join(facts) + '</ul>'
            + '<ul class="pr-chips" aria-label="Coverage">' + "".join(chips) + '</ul>'
            + f'<details class="snapshot-details"><summary>Snapshot and coverage</summary><div class="snapshot-body"><p class="scope-note">{scope}</p>{snapshot}</div></details></header>'
            '<noscript><p class="notice warning"><strong>JavaScript is off.</strong> Diffs and commentary are readable, but filters, approvals, comments, and feedback export need JavaScript.</p></noscript>'
            '<section class="toolbar" aria-label="Review controls"><div class="toolbar-fields">'
            '<label class="sr-only" for="search">Find files</label><input id="search" type="search" placeholder="Filter by path, group, status, or summary" autocomplete="off">'
            '<label class="sr-only" for="review-filter">Show</label><select id="review-filter"><option value="all">All files</option><option value="remaining">Needs review</option><option value="approved">Approved</option></select></div>'
            '<div class="toolbar-actions"><button id="expand-all" class="quiet" type="button">Expand all</button><button id="collapse-all" class="quiet" type="button">Collapse all</button></div>'
            f'<p id="filter-status" class="toolbar-status" role="status" aria-live="polite">{_plural(len(files), "file")} shown</p>'
            f'<p class="toolbar-hint">{comment_hint}</p></section>'
            '<section id="orphan-comments" class="orphans" hidden aria-labelledby="orphan-heading"><h2 id="orphan-heading">Unattached comments</h2>'
            '<p class="orphans-intro">The code these comments pointed at changed, moved ambiguously, or is absent. Select the intended code, then choose <strong>Attach to selected text</strong>, or leave them here.</p>'
            '<div id="orphan-list"></div></section>'
            '<section id="files" aria-label="Changed files" tabindex="-1">' + ("".join(groups) if groups else '<p class="empty-detail">No changed files supplied. Verify the input if you expected a diff.</p>')
            + '<p id="no-results" class="empty-detail" hidden>No files match these filters.</p></section>'
            '<section id="feedback" class="finish panel" aria-labelledby="feedback-heading"><div class="finish-head"><h2 id="feedback-heading">Finish review</h2>'
            '<p id="review-summary" class="finish-summary"></p></div>'
            '<ol id="comment-index" class="comment-index" aria-label="Your comments"></ol>'
            '<div class="field"><label for="general-notes">Overall notes</label><textarea id="general-notes" maxlength="20000" rows="4" autocomplete="off" spellcheck="false" placeholder="Overall feedback, or a decision for the agent"></textarea></div>'
            '<div class="finish-actions"><button id="export-feedback" class="primary" type="button">Export feedback (.json)</button>'
            '<input id="import-feedback" class="file-input sr-only" type="file" accept=".json,application/json"><label class="button" for="import-feedback">Import saved feedback</label></div>'
            '<p id="export-status" class="finish-status" role="status" aria-live="polite"></p><p id="import-status" class="finish-status" role="status" aria-live="polite"></p>'
            '<details id="export-preview" hidden><summary>Copy exported JSON</summary><label class="sr-only" for="feedback-json">Exported feedback JSON</label><textarea id="feedback-json" rows="10" readonly spellcheck="false"></textarea></details>'
            '<details id="retained-reviews" hidden><summary>Notes from earlier snapshots</summary><pre id="retained-json" class="code-block"></pre></details>'
            '<details class="how-saving-works"><summary>How saving works</summary><p id="saving-file">Comments, notes, and approvals live only in this tab until you export them. Export writes a local JSON file; confirm the download saved before you close the tab. Import that file to restore this snapshot, or to carry comments and approvals into a later round of the same review. An approval covers one exact version of a file, so a file that changed since you approved it returns to the queue. Only the theme choice is stored automatically. The feedback file contains selected code, paths, and notes, so keep it private. Nothing is uploaded. Hand the JSON to your agent when you are ready.</p>'
            '<p id="saving-server" hidden>This page came from the agent\'s local review server. Comments, notes, and approvals save automatically to the agent\'s review folder on this computer. An open comment draft saves once you save the comment. When you finish, tell your agent; the page cannot reach it. When the agent renders a new round, this page offers to reload, and your approvals carry over for every file that did not change. Export still writes a copy to a file. Nothing leaves this computer.</p></details></section>'
            '<footer class="page-footer"><p>Review the actual source before relying on conclusions. This file may contain private code; share it only with approved recipients.</p>'
            + f'<details class="font-notices"><summary>Font licenses</summary><pre>{escape(notices)}</pre></details></footer></main></div>'
            '<div id="composer-home" hidden><section id="comment-composer" class="composer" hidden aria-labelledby="composer-heading">'
            '<div class="composer-head"><h4 id="composer-heading">New comment</h4><p id="composer-context" class="composer-context"></p></div>'
            '<pre id="selected-quote" class="comment-quote"></pre><label class="sr-only" for="comment-body">Comment</label>'
            '<textarea id="comment-body" maxlength="20000" rows="3" spellcheck="false" placeholder="Leave a comment"></textarea>'
            '<div class="composer-actions"><p class="composer-keys">Ctrl+Enter saves. Esc cancels.</p><button id="cancel-comment" class="quiet" type="button">Cancel</button>'
            '<button id="save-comment" class="primary" type="button">Save comment</button></div></section></div>'
            '<button id="comment-selection" class="primary selection-comment" type="button" disabled hidden>Comment</button>'
            f'<p id="selection-status" class="sr-only" role="status" aria-live="polite">{"No code text selected." if pinned else "Inline comments are off."}</p>'
            '<div id="toast" class="toast"><p id="comment-status" role="status" aria-live="polite"></p>'
            '<button id="undo-delete" type="button" hidden>Undo delete</button><button id="toast-dismiss" class="quiet" type="button" aria-label="Dismiss message" hidden>Dismiss</button></div>'
            f'<span id="review-data" hidden data-review="{escape(json.dumps(metadata, ensure_ascii=True, separators=(",", ":")))}"></span>'
            f'<script>{js}</script></body></html>\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="Normalized UTF-8 JSON review input")
    parser.add_argument("-o", "--output", type=Path, help="Standalone HTML output file")
    parser.add_argument("--round", type=Path, metavar="STATE/rounds/NNNN",
                        help="Render ROUND/input.json to ROUND/review.html once, then publish the round as current for serve_review.py")
    parser.add_argument("--style-dir", type=Path, help="Complete internal-visual-style companion folder (defaults to sibling)")
    args = parser.parse_args(argv)
    if args.round is not None and (args.input or args.output):
        parser.error("--round replaces INPUT and --output")
    if args.round is None and not (args.input and args.output):
        parser.error("give INPUT and --output, or --round")
    try:
        if args.round is not None:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import review_state
            state, number = review_state.round_of(args.round)
            # Build the paths from the checked state, not the path as given, which could pass through a symlink.
            round_dir = state / "rounds" / f"{number:04d}"
            args.input, args.output = round_dir / "input.json", round_dir / "review.html"
            # The publish lock spans the check, the read, the page, and current, so the collector cannot change the input
            # between them and the server cannot see a half-published round.
            with review_state.lock(state, "publish"):
                if args.output.exists():
                    raise ValidationError(f"{args.output} exists. A round never changes after it renders; start a new round with review_state.py new-round")
                # A link's target, or a hard link's other name, could change after the page renders, and later readers
                # would see other input.
                info = os.lstat(args.input)
                if stat.S_ISLNK(info.st_mode) or info.st_nlink > 1:
                    raise ValidationError(f"{args.input} is a symbolic or hard link. Put a private copy of the input in the round, so it cannot change after rendering.")
                review = load_review(args.input)
                page = render_review(review, args.style_dir)
                review_state.write_private(args.output, page.encode("utf-8"), replace=False)
                review_state.write_private(round_dir / "input.sha256", (input_digest(review) + "\n").encode("ascii"), replace=False)
                review_state.publish(state, number, held=True)
        else:
            if args.input.resolve() == args.output.resolve() or (args.output.exists() and args.input.samefile(args.output)):
                raise ValidationError("input and output must be different files")
            review = load_review(args.input)
            page = render_review(review, args.style_dir)
            args.output.write_text(page, encoding="utf-8")
    except (ValidationError, OSError, ValueError, RecursionError) as error:
        print(f"Error: {escaped(error)}", file=sys.stderr)
        return 2
    missing, incomplete, unverified = coverage_counts(review["files"])
    print(f"Wrote {shown(str(args.output))} ({_plural(len(review['files']), 'file')}; {_plural(missing, 'missing patch', 'missing patches')}; "
          f"{_plural(incomplete, 'incomplete patch', 'incomplete patches')}; {_plural(unverified, 'unverified patch', 'unverified patches')})")
    if args.round is not None:
        print(f"Published round {number:04d} in {shown(str(state))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
