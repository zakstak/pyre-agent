#!/usr/bin/env python3
"""Render normalized PR review JSON to a private, offline, standalone HTML file.

Python 3.10+; standard library only. See ../assets/example-review.json for input.
No input is executed, no credentials are read, and no network is used.
"""

import argparse
import base64
import hashlib
import html
import json
import re
import sys
from pathlib import Path


MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PATCH_CHARS = 4 * 1024 * 1024
MAX_PATCH_LINES = 10000
MAX_TOTAL_PATCH_LINES = 50000
MAX_FILES = 2000
GROUPS = (
    ("core", "Core logic", "Behavior, algorithms, state, and API changes. Start here."),
    ("wiring", "Wiring & integration", "Connections and configuration. Diffs start collapsed."),
    ("mechanical", "Boilerplate & mechanical", "Formatting, generated code, and routine changes. Expand when useful."),
)
STATUSES = {"added", "modified", "deleted", "removed", "renamed", "copied", "changed", "unchanged"}
PR_URL = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*\Z")
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


def _text(value, where, *, nonempty=False, limit=20000):
    if not isinstance(value, str):
        raise ValidationError(f"{where}: expected a string")
    if len(value) > limit:
        raise ValidationError(f"{where}: exceeds {limit} characters")
    if nonempty and not value.strip():
        raise ValidationError(f"{where}: must not be empty")
    if any((ord(c) < 32 and c not in "\t\n\r") or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValidationError(f"{where}: contains an unsupported control character or Unicode surrogate")


def validate_review(review):
    """Validate without changing or dropping input. Return the supplied object."""
    _object(review, "review", ("schema_version", "pr", "files"), ("summary", "files_complete"))
    if type(review["schema_version"]) is not int or review["schema_version"] != 1:
        raise ValidationError("review.schema_version: expected integer 1")
    _object(review["pr"], "pr", ("title",), ("url", "head_sha", "base_sha", "changed_files"))
    _text(review["pr"]["title"], "pr.title", nonempty=True)
    if "url" in review["pr"]:
        _text(review["pr"]["url"], "pr.url", nonempty=True)
        if not PR_URL.fullmatch(review["pr"]["url"]):
            raise ValidationError("pr.url: expected https://github.com/OWNER/REPO/pull/NUMBER, or omit url")
    for name in ("head_sha", "base_sha"):
        if name in review["pr"]:
            _text(review["pr"][name], f"pr.{name}")
            if not re.fullmatch(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})", review["pr"][name]):
                raise ValidationError(f"pr.{name}: expected a full 40- or 64-character hexadecimal commit hash")
    if "changed_files" in review["pr"] and (type(review["pr"]["changed_files"]) is not int or not 0 <= review["pr"]["changed_files"] <= 10**12):
        raise ValidationError("pr.changed_files: expected a nonnegative integer at most 1000000000000")
    if "files_complete" in review and type(review["files_complete"]) is not bool:
        raise ValidationError("files_complete: expected a boolean")
    if "summary" in review:
        _text(review["summary"], "summary")
    if not isinstance(review["files"], list) or len(review["files"]) > MAX_FILES:
        raise ValidationError(f"files: expected an array of at most {MAX_FILES} files")
    if review.get("files_complete") is True and review["pr"].get("changed_files") != len(review["files"]):
        raise ValidationError("files_complete: true requires pr.changed_files matching the supplied file count")
    seen = set()
    total_patch_lines = 0
    for i, file in enumerate(review["files"]):
        where = f"files[{i}]"
        _object(file, where, ("path", "status", "group", "additions", "deletions"),
                ("patch", "patch_complete", "summary", "pseudocode", "trace", "callouts"))
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
    return validate_review(review)


def escape(value):
    return html.escape(str(value), quote=True)


def _paragraph(value, css_class="commentary"):
    return f'<p class="{css_class}">{escape(value)}</p>' if value else ""


def _patch_html(patch):
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
        rows.append(f'<tr class="{kind}"><td class="line-number">{old_label}</td>'
                    f'<td class="line-number">{new_label}</td><td class="source"><code>{escape(line)}</code></td></tr>')
    return ('<div class="diff-scroll" tabindex="0" aria-label="Scrollable unified diff">'
            '<table class="diff"><thead><tr><th scope="col">Old</th><th scope="col">New</th>'
            '<th scope="col">Unified diff</th></tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>')


def _file_html(file, index):
    ident = f"file-{index}"
    is_core = file["group"] == "core"
    missing = not file.get("patch")
    warning = ""
    if missing:
        warning = '<p class="warning">Patch unavailable. This may be a binary, omitted, empty, or inaccessible diff. Inspect the source before marking it reviewed.</p>'
    elif file.get("patch_complete") is False:
        warning = '<p class="warning">Patch marked incomplete. Only the supplied lines are shown. Inspect the complete source before marking it reviewed.</p>'
    elif file.get("patch_complete") is not True:
        warning = '<p class="warning">Patch completeness unverified. No patch_complete declaration was supplied. Compare these lines with the complete source before marking it reviewed.</p>'
    commentary = _paragraph(file.get("summary"))
    if file.get("pseudocode"):
        commentary += '<section class="explanation"><h4>Pseudocode</h4><pre>' + escape(file["pseudocode"]) + '</pre></section>'
    if "trace" in file:
        trace = file["trace"]
        commentary += ('<section class="explanation"><h4>Example trace</h4><p class="trace-input"><strong>Input</strong></p><pre>'
                       + escape(trace["input"]) + '</pre><div class="trace-columns"><div><h5>Before</h5><pre>'
                       + escape(trace["before"]) + '</pre></div><div><h5>After</h5><pre>'
                       + escape(trace["after"]) + '</pre></div></div></section>')
    for callout in file.get("callouts", []):
        commentary += '<aside class="callout"><strong>' + escape(callout["tag"]) + '</strong>' + _paragraph(callout["text"]) + '</aside>'
    patch = ""
    if not missing:
        line_count = len(file["patch"].split("\n")) - int(file["patch"].endswith("\n"))
        patch = f'<details class="patch-details"{" open" if is_core else ""}><summary>Unified diff · {line_count:,} supplied lines</summary>{_patch_html(file["patch"])}</details>'
    search = " ".join((file["path"], file["status"], file["group"], file.get("summary", "")))
    return (f'<article class="file-card" id="{ident}" data-file-id="{ident}" data-search="{escape(search)}">'
            f'<header class="file-header"><div><h3>{escape(file["path"])}</h3><div class="file-meta"><span>{escape(file["status"])}</span>'
            f'<span class="additions">+{file["additions"]:,}</span><span class="deletions">−{file["deletions"]:,}</span></div></div>'
            f'<label class="review-toggle"><input class="reviewed" type="checkbox" autocomplete="off" aria-label="Mark {escape(file["path"])} reviewed"> Reviewed</label></header>'
            + warning + f'<details class="file-details"{" open" if file["group"] != "mechanical" else ""}><summary>Review details</summary>'
            + (commentary + patch if commentary or patch else '<p class="empty-detail">No review commentary or patch supplied.</p>')
            + f'</details><details class="notes-details"><summary>My notes<span class="note-indicator"></span></summary>'
            f'<label class="sr-only" for="notes-{index}">Notes for {escape(file["path"])}</label>'
            f'<textarea id="notes-{index}" class="file-notes" rows="3" autocomplete="off" spellcheck="false" placeholder="Questions, findings, or follow-up for this file"></textarea></details></article>')


def render_review(review):
    """Return a self-contained HTML document for a validated review object."""
    validate_review(review)
    assets = Path(__file__).resolve().parent.parent / "assets"
    css = (assets / "review.css").read_text(encoding="utf-8")
    js = (assets / "review.js").read_text(encoding="utf-8")
    digest = hashlib.sha256(json.dumps(review, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
    metadata = {"schema_version": 1, "pr": review["pr"], "input_sha256": digest,
                "files": [{"id": f"file-{i}", "path": f["path"], "status": f["status"], "group": f["group"]} for i, f in enumerate(review["files"])]}
    script_hash = base64.b64encode(hashlib.sha256(js.encode()).digest()).decode()
    style_hash = base64.b64encode(hashlib.sha256(css.encode()).digest()).decode()
    csp = (f"default-src 'none'; script-src 'sha256-{script_hash}'; style-src 'sha256-{style_hash}'; "
           "connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; "
           "form-action 'none'; frame-src 'none'; worker-src 'none'")
    groups = []
    for key, label, description in GROUPS:
        files = [(i, f) for i, f in enumerate(review["files"]) if f["group"] == key]
        if files:
            groups.append(f'<section class="review-group" aria-labelledby="group-{key}"><div class="group-header"><h2 id="group-{key}">{label} <span>({len(files)})</span></h2><p>{description}</p></div>'
                          + "".join(_file_html(f, i) for i, f in files) + '</section>')
    missing_count = sum(not f.get("patch") for f in review["files"])
    incomplete_count = sum(bool(f.get("patch")) and f.get("patch_complete") is False for f in review["files"])
    unverified_count = sum(bool(f.get("patch")) and "patch_complete" not in f for f in review["files"])
    warnings = f' · {missing_count} missing patches' if missing_count else ""
    warnings += f' · {incomplete_count} incomplete patches' if incomplete_count else ""
    warnings += f' · {unverified_count} unverified patches' if unverified_count else ""
    pr_link = f'<a href="{escape(review["pr"]["url"])}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open PR on GitHub ↗</a>' if review["pr"].get("url") else ""
    total_additions = sum(f["additions"] for f in review["files"])
    total_deletions = sum(f["deletions"] for f in review["files"])
    scope = ('File list marked complete, with a matching declared changed-file count. '
             if review.get("files_complete") is True else
             'File list completeness is unverified. Reconcile every changed file against the PR source. ')
    if "changed_files" in review["pr"]:
        scope += f'{len(review["files"])} supplied / {review["pr"]["changed_files"]} declared changed files. '
    scope += 'Every supplied patch line is included. Source and patch completeness are not independently verified. Counts and commentary come from the input; this renderer does not invent findings.'
    snapshot = ""
    for name, label in (("base_sha", "Base commit"), ("head_sha", "Head commit")):
        if name in review["pr"]:
            snapshot += f'<dt>{label}</dt><dd><code>{escape(review["pr"][name])}</code></dd>'
    snapshot = f'<dl class="snapshot">{snapshot}</dl>' if snapshot else '<p class="scope-note">No commit snapshot supplied. Re-check the PR before relying on this review.</p>'
    return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{escape(csp)}">'
            '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">'
            f'<title>{escape(review["pr"]["title"])} · PR review</title><style>{css}</style></head><body>'
            '<a class="skip-link" href="#files">Skip to changed files</a><main><header class="page-header"><p class="eyebrow">Private · Offline PR review</p>'
            f'<h1>{escape(review["pr"]["title"])}</h1><div class="pr-link">{pr_link}</div>'
            + _paragraph(review.get("summary"), "lead")
            + f'<p class="totals">{len(review["files"])} supplied files · <span class="additions">+{total_additions:,}</span> <span class="deletions">−{total_deletions:,}</span>{warnings}</p>'
            + f'<p class="scope-note">{scope}</p>' + snapshot + '</header>'
            '<noscript><p class="warning">JavaScript is disabled. Diffs and commentary are readable, but filters, review tracking, and feedback export require JavaScript. Notes cannot be saved here.</p></noscript>'
            '<section class="toolbar" aria-label="Review controls"><label>Find files<input id="search" type="search" placeholder="Path, group, status, or summary" autocomplete="off"></label>'
            '<label>Show<select id="review-filter"><option value="all">All files</option><option value="remaining">Not reviewed</option><option value="reviewed">Reviewed</option></select></label>'
            '<div class="toolbar-buttons"><button id="expand-all" type="button">Expand shown diffs</button><button id="collapse-all" type="button">Collapse shown diffs</button></div>'
            f'<p id="progress" role="status" aria-live="polite">0 of {len(review["files"])} reviewed</p><p id="filter-status" role="status" aria-live="polite">{len(review["files"])} files shown</p></section>'
            '<section id="files" aria-label="Changed files">' + ("".join(groups) if groups else '<p class="empty-detail">No changed files supplied. Verify the input if you expected a diff.</p>')
            + '<p id="no-results" hidden>No files match these filters.</p></section>'
            '<section class="feedback" aria-labelledby="feedback-heading"><h2 id="feedback-heading">Send your review back</h2>'
            '<p>Notes and reviewed flags stay in this tab’s memory. Nothing is uploaded or stored by this page. Reloading or closing can lose changes. Download your feedback and send the JSON file to your agent manually. It contains your notes and file paths, but does not copy the patches.</p>'
            '<label for="general-notes">Overall notes</label><textarea id="general-notes" rows="4" autocomplete="off" spellcheck="false" placeholder="Overall feedback or a decision for the agent"></textarea>'
            '<button id="export-feedback" class="primary" type="button">Export feedback (.json)</button><p id="export-status" role="status" aria-live="polite"></p>'
            '<details id="export-preview" hidden><summary>Copy exported JSON</summary><label class="sr-only" for="feedback-json">Exported feedback JSON</label><textarea id="feedback-json" rows="10" readonly spellcheck="false"></textarea></details></section>'
            '<footer>Review the actual source before relying on conclusions. This file may contain private code; share it only with approved recipients.</footer></main>'
            f'<span id="review-data" hidden data-review="{escape(json.dumps(metadata, ensure_ascii=True, separators=(",", ":")))}"></span>'
            f'<script>{js}</script></body></html>\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Normalized UTF-8 JSON review input")
    parser.add_argument("-o", "--output", required=True, type=Path, help="Standalone HTML output file")
    args = parser.parse_args(argv)
    try:
        if args.input.resolve() == args.output.resolve() or (args.output.exists() and args.input.samefile(args.output)):
            raise ValidationError("input and output must be different files")
        review = load_review(args.input)
        page = render_review(review)
        args.output.write_text(page, encoding="utf-8")
    except (ValidationError, OSError, ValueError, RecursionError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    missing = sum(not f.get("patch") for f in review["files"])
    incomplete = sum(bool(f.get("patch")) and f.get("patch_complete") is False for f in review["files"])
    unverified = sum(bool(f.get("patch")) and "patch_complete" not in f for f in review["files"])
    print(f"Wrote {args.output} ({len(review['files'])} files; {missing} missing patches; {incomplete} incomplete patches; {unverified} unverified patches)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
