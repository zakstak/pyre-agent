#!/usr/bin/env python3
"""Validate review-canvas feedback (feedback_schema_version 3), as the page's assets/feedback.js does.

The two validators must accept and reject the same documents; tests/fixtures/feedback/ holds shared cases for both.
Lengths count UTF-16 code units, and "nonempty" uses JavaScript's definition of whitespace, so a string has the same
size and emptiness in both languages.

    python3 feedback_contract.py FEEDBACK.json [--input rounds/NNNN/input.json]

Python 3.10+; standard library only.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path


VERSION = 3
MAX_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 32
HASH = re.compile(r"[a-f0-9]{64}")
SHA = re.compile(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}")
PR = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*")
ROOT = re.compile(r"(?:/|[A-Za-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+)")
COMMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
STATUSES = {"added", "modified", "deleted", "removed", "renamed", "copied", "changed", "unchanged"}
GROUPS = {"core", "wiring", "mechanical"}
ACTIONS = ("accept", "reopen", "reply")
# Reply times order a thread, so both languages must parse them alike: UTC, with optional milliseconds.
REPLY_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z")
# String.prototype.trim removes these: WhiteSpace (including every Zs character) and LineTerminator.
JS_SPACE = set("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
SAFE_INTEGER = 2**53 - 1


class FeedbackError(ValueError):
    """The document is not valid version 3 feedback."""


def units(value):
    """Length in UTF-16 code units, the unit of JavaScript string lengths and of anchor offsets."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _object(value, required, optional=()):
    if not isinstance(value, dict):
        raise FeedbackError("Expected an object.")
    if any(key not in value for key in required) or any(key not in required and key not in optional for key in value):
        raise FeedbackError("Missing or unsupported feedback fields.")


def _text(value, limit=20000, nonempty=False):
    if not isinstance(value, str) or units(value) > limit or (nonempty and all(c in JS_SPACE for c in value)):
        raise FeedbackError("Invalid or oversized feedback text.")
    for c in value:
        # Python decodes a valid surrogate pair to one character, so any surrogate left here is unpaired. The messages
        # match feedback.js, which reports a lone high surrogate separately.
        if 0xD800 <= ord(c) <= 0xDBFF:
            raise FeedbackError("Unpaired Unicode surrogate.")
        if (ord(c) < 32 and c not in "\t\n\r") or 0xDC00 <= ord(c) <= 0xDFFF:
            raise FeedbackError("Unsupported text character.")


def _integer(value, maximum=50000000, minimum=0):
    if type(value) is not int or not minimum <= value <= min(maximum, SAFE_INTEGER):
        raise FeedbackError("Invalid feedback position.")


def _target(value):
    if not isinstance(value, dict) or value.get("kind") not in ("github_pr", "worktree"):
        raise FeedbackError("Invalid review target.")
    if value["kind"] == "github_pr":
        _object(value, ("kind", "title"), ("url", "head_sha", "base_sha", "changed_files"))
        if "url" in value and (not isinstance(value["url"], str) or not PR.fullmatch(value["url"])):
            raise FeedbackError("Invalid PR identity.")
    else:
        _object(value, ("kind", "title", "root", "head_sha"), ("branch", "changed_files"))
        _text(value["root"], 4096, True)
        if not ROOT.match(value["root"]):
            raise FeedbackError("Invalid working tree root.")
        if "branch" in value:
            _text(value["branch"], 1024, True)
    _text(value["title"], 20000, True)
    for key in ("head_sha", "base_sha"):
        if key in value and (not isinstance(value[key], str) or not SHA.fullmatch(value[key])):
            raise FeedbackError("Invalid commit snapshot.")
    if "changed_files" in value:
        _integer(value["changed_files"], 10**12)


def pinned(target):
    return target["kind"] == "worktree" or bool(target.get("url") and target.get("head_sha"))


def _snapshot(value):
    _object(value, ("target", "input_sha256"))
    _target(value["target"])
    if not isinstance(value["input_sha256"], str) or not HASH.fullmatch(value["input_sha256"]):
        raise FeedbackError("Invalid input digest.")


def _files(value):
    if not isinstance(value, list) or len(value) > 2000:
        raise FeedbackError("Invalid feedback file inventory.")
    paths = set()
    for file in value:
        _object(file, ("path", "status", "group", "notes"))
        _text(file["path"], 4096, True)
        _text(file["notes"])
        if file["path"] in paths or not isinstance(file["status"], str) or file["status"] not in STATUSES or not isinstance(file["group"], str) or file["group"] not in GROUPS:
            raise FeedbackError("Invalid or duplicate feedback file.")
        paths.add(file["path"])


def _approvals(value):
    if not isinstance(value, list) or len(value) > 2000:
        raise FeedbackError("Invalid approval list.")
    paths = set()
    for approval in value:
        _object(approval, ("path", "fingerprint", "approved_at"))
        _text(approval["path"], 4096, True)
        _text(approval["approved_at"], 40, True)
        if not isinstance(approval["fingerprint"], str) or not HASH.fullmatch(approval["fingerprint"]) or approval["path"] in paths:
            raise FeedbackError("Invalid or duplicate approval.")
        paths.add(approval["path"])


def _anchor(value):
    _object(value, ("snapshot", "path", "patch_sha256", "start", "end", "quote", "prefix", "suffix", "start_row", "end_row",
                    "side", "start_line", "end_line"))
    _snapshot(value["snapshot"])
    if not pinned(value["snapshot"]["target"]):
        raise FeedbackError("Comments require a pinned target: a PR URL and head commit, or a working tree.")
    _text(value["path"], 4096, True)
    if not isinstance(value["patch_sha256"], str) or not HASH.fullmatch(value["patch_sha256"]):
        raise FeedbackError("Invalid patch digest.")
    _integer(value["start"]); _integer(value["end"]); _integer(value["start_row"], 10000); _integer(value["end_row"], 10000)
    _text(value["quote"], 20000, True); _text(value["prefix"], 80); _text(value["suffix"], 80)
    if value["end"] <= value["start"] or value["end"] - value["start"] != units(value["quote"]) or value["end_row"] < value["start_row"]:
        raise FeedbackError("Invalid quote range.")
    if value["side"] not in ("old", "new"):
        raise FeedbackError("Invalid anchor side.")
    _integer(value["start_line"], 10**12, 1); _integer(value["end_line"], 10**12, 1)
    if value["end_line"] < value["start_line"]:
        raise FeedbackError("Invalid source line range.")


def _replies(value, ids):
    """A reviewer's answers to the agent. Agent replies live in the review input, so each file keeps one writer."""
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise FeedbackError("Invalid reviewer replies.")
    total = 0
    for reply in value:
        _object(reply, ("id", "actor", "created_at", "body", "action"))
        if not isinstance(reply["id"], str) or not COMMENT_ID.fullmatch(reply["id"]) or reply["id"] in ids:
            raise FeedbackError("Invalid or duplicate reply ID.")
        ids.add(reply["id"])
        if reply["actor"] != "reviewer":
            raise FeedbackError("Feedback replies come from the reviewer; agent replies belong in the review input.")
        if not isinstance(reply["action"], str) or reply["action"] not in ACTIONS:
            raise FeedbackError("Invalid reply action.")
        _text(reply["created_at"], 40, True)
        if not REPLY_TIME.fullmatch(reply["created_at"]):
            raise FeedbackError("Reply times must be UTC ISO 8601, such as 2026-10-10T09:00:00.000Z.")
        _text(reply["body"], 20000, reply["action"] != "accept")
        total += units(reply["body"])
    return total


def _attachment(value):
    _object(value, ("state", "reason", "start", "end"))
    if value["state"] not in ("attached", "orphan"):
        raise FeedbackError("Invalid attachment state.")
    _text(value["reason"], 200)
    if value["state"] == "attached":
        _integer(value["start"]); _integer(value["end"])
        if value["end"] <= value["start"]:
            raise FeedbackError("Invalid attachment range.")
    elif value["start"] is not None or value["end"] is not None:
        raise FeedbackError("Orphan range must be null.")


def snapshot_of(value):
    return {"target": value["target"], "input_sha256": value["input_sha256"]}


def validate_feedback(value):
    """Validate a parsed document. Return it unchanged."""
    if isinstance(value, dict) and value.get("feedback_schema_version") != VERSION:
        raise FeedbackError(f"Feedback version {json.dumps(value.get('feedback_schema_version'))} is not supported; "
                            f"expected {VERSION}. There is no migration.")
    _object(value, ("feedback_schema_version", "target", "input_sha256", "exported_at", "general_notes", "files", "approvals",
                    "comments", "retained_reviews"))
    if type(value["feedback_schema_version"]) is not int:
        raise FeedbackError(f"Feedback version {value['feedback_schema_version']!r} is not supported; expected {VERSION}.")
    _snapshot(snapshot_of(value))
    _text(value["exported_at"], 40, True); _text(value["general_notes"]); _files(value["files"]); _approvals(value["approvals"])
    if not isinstance(value["comments"], list) or len(value["comments"]) > 1000 or not isinstance(value["retained_reviews"], list) or len(value["retained_reviews"]) > 50:
        raise FeedbackError("Feedback collection limit exceeded.")
    ids, reply_ids = set(), set()
    total = units(value["general_notes"]) + sum(units(file["notes"]) for file in value["files"])
    for comment in value["comments"]:
        _object(comment, ("id", "body", "created_at", "updated_at", "anchor", "history", "attachment"), ("replies",))
        if not isinstance(comment["id"], str) or not COMMENT_ID.fullmatch(comment["id"]) or comment["id"] in ids:
            raise FeedbackError("Invalid or duplicate comment ID.")
        ids.add(comment["id"])
        _text(comment["body"], 20000, True); _text(comment["created_at"], 40, True); _text(comment["updated_at"], 40, True)
        _anchor(comment["anchor"]); _attachment(comment["attachment"])
        if not isinstance(comment["history"], list) or len(comment["history"]) > 20:
            raise FeedbackError("Comment anchor history limit exceeded.")
        for previous in comment["history"]:
            _anchor(previous)
            total += units(previous["quote"]) + units(previous["path"])
        if "replies" in comment:
            total += _replies(comment["replies"], reply_ids)
        total += units(comment["body"]) + units(comment["anchor"]["quote"]) + units(comment["anchor"]["path"])
    retained = set()
    for review in value["retained_reviews"]:
        _object(review, ("target", "input_sha256", "general_notes", "files"))
        _snapshot(snapshot_of(review)); _text(review["general_notes"]); _files(review["files"])
        if review["input_sha256"] in retained:
            raise FeedbackError("Duplicate retained snapshot.")
        retained.add(review["input_sha256"])
        total += units(review["general_notes"]) + sum(units(file["notes"]) for file in review["files"])
    if total > 2 * 1024 * 1024:
        raise FeedbackError("Feedback text budget exceeded.")
    return value


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise FeedbackError("Duplicate JSON field.")
        result[key] = value
    return result


def _reject_number(token):
    raise FeedbackError("Feedback numbers must be integers.")


def _reject_constant(token):
    # JSON has no NaN or Infinity; JSON.parse calls them a syntax error, so this message matches that category.
    raise FeedbackError(f"Feedback is not valid UTF-8 JSON: {token} is not a JSON value")


def _depth(value, depth=0):
    if depth > MAX_DEPTH:
        raise FeedbackError("Feedback is nested too deeply.")
    children = value.values() if isinstance(value, dict) else value if isinstance(value, list) else ()
    for child in children:
        _depth(child, depth + 1)


def parse_feedback(raw):
    """Parse UTF-8 bytes and validate them. Reject duplicate keys, non-integer numbers, and deep nesting."""
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise FeedbackError("Feedback exceeds 8 MiB.")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_float=_reject_number, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise FeedbackError(f"Feedback is not valid UTF-8 JSON: {error}") from None
    _depth(value)
    return validate_feedback(value)


def same_target(a, b):
    """Two snapshots belong to one review when they name the same PR, or the same working tree root."""
    if a["target"]["kind"] != b["target"]["kind"]:
        return False
    if a["target"]["kind"] == "worktree":
        return a["target"]["root"] == b["target"]["root"]
    if a["target"].get("url") and b["target"].get("url"):
        return a["target"]["url"] == b["target"]["url"]
    return a["input_sha256"] == b["input_sha256"]


def check_identity(feedback, snapshot):
    """Raise unless every snapshot named in the feedback belongs to the same review as snapshot."""
    named = [snapshot_of(feedback)] + [snapshot_of(review) for review in feedback["retained_reviews"]]
    for comment in feedback["comments"]:
        named += [comment["anchor"]["snapshot"]] + [anchor["snapshot"] for anchor in comment["history"]]
    if not all(same_target(item, snapshot) for item in named):
        raise FeedbackError("Feedback belongs to another review target or an unidentified snapshot.")


def reply_time(reply):
    """Sort key matching the page: the reply time, unparseable times last."""
    try:
        return datetime.datetime.fromisoformat(reply["created_at"].replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("inf")


def thread(comment, agent_replies):
    """One comment's replies in order: the agent's from the review input, the reviewer's from feedback."""
    replies = [reply for reply in agent_replies if reply["comment_id"] == comment["id"]] + comment.get("replies", [])
    return sorted(replies, key=lambda reply: (reply_time(reply), reply["actor"] != "agent", reply["id"]))


def thread_state(replies):
    """Return whose turn it is, from the last reply: agent, reviewer, or None once the reviewer accepts."""
    if not replies:
        return "agent", "open"
    last = replies[-1]
    if last["actor"] == "agent":
        return "reviewer", f"answered: {last['disposition']}"
    return (None, "resolved") if last["action"] == "accept" else ("agent", {"reopen": "reopened", "reply": "replied"}[last["action"]])


def main(argv=None):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import render_review

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("feedback", type=Path, help="Feedback JSON exported by the page or saved by serve_review.py")
    parser.add_argument("--input", type=Path, help="Review input of the round to compare with: target identity and approvals")
    args = parser.parse_args(argv)
    try:
        feedback = parse_feedback(args.feedback.read_bytes())
        review = render_review.load_review(args.input) if args.input else None
        if review:
            check_identity(feedback, {"target": review["target"], "input_sha256": render_review.input_digest(review)})
    except (FeedbackError, render_review.ValidationError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    orphans = sum(comment["attachment"]["state"] == "orphan" for comment in feedback["comments"])
    print(f"Valid feedback for {feedback['target']['title']}: {len(feedback['comments'])} comments ({orphans} unattached when saved), "
          f"{len(feedback['approvals'])} approvals.")
    if review:
        approvals = {record["path"]: record["fingerprint"] for record in feedback["approvals"]}
        states = {"approved": [], "changed since approval": [], "not approved": []}
        for file in review["files"]:
            stored = approvals.get(file["path"])
            states["not approved" if stored is None else "approved" if stored == file.get("fingerprint") else "changed since approval"].append(file["path"])
        same = feedback["input_sha256"] == render_review.input_digest(review)
        print(f"Against {args.input}: {'same snapshot' if same else 'an earlier snapshot of the same review'}.")
        for state, paths in states.items():
            print(f"  {len(paths)} {state}" + (": " + ", ".join(paths) if paths and state != "approved" else ""))
        turns = {"agent": [], "reviewer": [], None: []}
        for comment in feedback["comments"]:
            turn, label = thread_state(thread(comment, review.get("replies", [])))
            turns[turn].append(f"{comment['id']} ({label})")
        for turn, one, many in (("agent", "needs your answer", "need your answer"), ("reviewer", "waits for the reviewer", "wait for the reviewer"),
                                (None, "is resolved", "are resolved")):
            count = len(turns[turn])
            print(f"  {count} comment{'' if count == 1 else 's'} {one if count == 1 else many}" + (": " + ", ".join(turns[turn]) if turns[turn] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
