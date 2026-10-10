#!/usr/bin/env python3
"""Write the agent's answers to review comments into a round's input, before the round renders.

    python3 reply.py carry --from STATE/rounds/0001/input.json --to STATE/rounds/0002/input.json
    python3 reply.py add --input STATE/rounds/0002/input.json --feedback STATE/feedback.json \\
        --comment COMMENT_ID --disposition fixed --body "What changed" --fixed-in-fingerprint FINGERPRINT

carry copies every agent reply from an earlier round, so earlier answers stay visible. add appends one reply with a
new ID, timed after every reply already in that thread, so it sorts after the reviewer reply it answers even when
the reviewer's clock runs ahead. Both validate the result and refuse a round that has already rendered.

Python 3.10+; standard library only.
"""

import argparse
import datetime
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feedback_contract  # noqa: E402
import render_review  # noqa: E402
import review_state  # noqa: E402


def load_round_input(path):
    path = Path(path)
    if (path.parent / "review.html").exists():
        raise render_review.ValidationError(f"{path.parent} has rendered; a round never changes after it renders. Start a new round.")
    return render_review.load_review(path)


def save_round_input(path, review):
    render_review.validate_review(review)
    data = (json.dumps(review, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(data) > render_review.MAX_INPUT_BYTES:
        raise render_review.ValidationError(f"the input would exceed {render_review.MAX_INPUT_BYTES} bytes; {path} was not changed")
    review_state.write_private(Path(path), data)


def carry(source, target):
    """Copy agent replies from an earlier round's input. Replies already present keep their place."""
    with review_state.round_lock(target):
        return _carry(source, target)


def _carry(source, target):
    previous = render_review.load_review(source)
    review = load_round_input(target)
    snapshot = lambda item: {"target": item["target"], "input_sha256": render_review.input_digest(item)}
    if not feedback_contract.same_target(snapshot(previous), snapshot(review)):
        raise render_review.ValidationError(f"{source} belongs to another review than {target}; replies were not copied")
    earlier = previous.get("replies", [])
    current = {reply["id"]: reply for reply in review.get("replies", [])}
    conflicts = sorted(reply["id"] for reply in earlier if reply["id"] in current and current[reply["id"]] != reply)
    if conflicts:
        raise render_review.ValidationError(f"{target} already has different replies with these IDs: {', '.join(conflicts)}; nothing was copied")
    known = set(current)
    review["replies"] = [reply for reply in earlier if reply["id"] not in known] + review.get("replies", [])
    save_round_input(target, review)
    return len(review["replies"]) - len(known)


def timestamp(moment):
    """Millisecond UTC ISO 8601, the reply time format."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def after(reply):
    """One millisecond after a reply, computed on the datetime so no float rounding can repeat its time."""
    return datetime.datetime.fromisoformat(reply["created_at"].replace("Z", "+00:00")) + datetime.timedelta(milliseconds=1)


def add(input_path, feedback_path, comment_id, disposition, body, fingerprint=None, commit=None, blocker=None, now=None):
    """Append one agent reply to a comment in the feedback. Return the reply."""
    with review_state.round_lock(input_path):
        return _add(input_path, feedback_path, comment_id, disposition, body, fingerprint, commit, blocker, now)


def _add(input_path, feedback_path, comment_id, disposition, body, fingerprint, commit, blocker, now):
    feedback = feedback_contract.read_feedback(feedback_path)
    comment = next((item for item in feedback["comments"] if item["id"] == comment_id), None)
    if comment is None:
        raise render_review.ValidationError(f"the feedback has no comment {comment_id}")
    review = load_round_input(input_path)
    feedback_contract.check_identity(feedback, {"target": review["target"], "input_sha256": render_review.input_digest(review)})
    thread = feedback_contract.thread(comment, review.get("replies", []))
    turn, label = feedback_contract.thread_state(thread)
    if label == "earlier answers missing":
        raise render_review.ValidationError(f"comment {comment_id} has reviewer replies but no earlier agent answer in {input_path}. "
                                            "Run reply.py carry from the previous round first.")
    if turn != "agent":
        raise render_review.ValidationError(f"comment {comment_id} is {label}, so it is not the agent's turn; a new answer would "
                                            "override the reviewer" if turn is None else f"comment {comment_id} is {label} and waits for the reviewer")
    if fingerprint and fingerprint not in {file.get("fingerprint") for file in review["files"]}:
        raise render_review.ValidationError(f"no file in {input_path} has fingerprint {fingerprint}; name the version in this round that fixes the comment")
    current = datetime.datetime.fromtimestamp(now, datetime.timezone.utc) if now is not None else datetime.datetime.now(datetime.timezone.utc)
    try:
        created = timestamp(max([current] + [after(reply) for reply in thread]))
    except (ValueError, OverflowError):
        raise render_review.ValidationError(f"comment {comment_id}'s latest reply is at the last representable time, so no later reply fits") from None
    reply = {"comment_id": comment_id, "id": f"agent-{uuid.uuid4().hex[:16]}", "actor": "agent", "created_at": created,
             "body": body, "disposition": disposition}
    if fingerprint or commit:
        reply["fixed_in"] = {"fingerprint": fingerprint} if fingerprint else {"commit": commit}
    if blocker:
        reply["blocker"] = blocker
    review.setdefault("replies", []).append(reply)
    save_round_input(input_path, review)
    return reply


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    copy = commands.add_parser("carry", help="Copy agent replies from an earlier round's input")
    copy.add_argument("--from", dest="source", type=Path, required=True, help="An earlier round's input.json")
    copy.add_argument("--to", dest="target", type=Path, required=True, help="The new round's input.json, before it renders")
    answer = commands.add_parser("add", help="Append one agent reply")
    answer.add_argument("--input", type=Path, required=True, help="The new round's input.json, before it renders")
    answer.add_argument("--feedback", type=Path, required=True, help="The feedback that holds the comment")
    answer.add_argument("--comment", required=True, help="The comment's id")
    answer.add_argument("--disposition", required=True, choices=render_review.DISPOSITIONS)
    answer.add_argument("--body", required=True, help="What changed, why not, what blocks it, or the question")
    fixed = answer.add_mutually_exclusive_group()
    fixed.add_argument("--fixed-in-fingerprint", help="For fixed: the fingerprint of the file version that fixes the comment")
    fixed.add_argument("--fixed-in-commit", help="For fixed: the full hash of the commit that fixes the comment")
    answer.add_argument("--blocker", help="For deferred: what blocks the change")
    args = parser.parse_args(argv)
    try:
        if args.command == "carry":
            print(f"Carried {carry(args.source, args.target)} agent replies into {args.target}")
        else:
            reply = add(args.input, args.feedback, args.comment, args.disposition, args.body,
                        args.fixed_in_fingerprint, args.fixed_in_commit, args.blocker)
            print(f"Added {reply['disposition']} reply {reply['id']} to comment {args.comment} at {reply['created_at']}")
    except (render_review.ValidationError, feedback_contract.FeedbackError, review_state.StateError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
