#!/usr/bin/env python3
"""Serve a review's current round on loopback, and save the reviewer's feedback into its state directory.

    python3 serve_review.py --state-dir STATE [--idle-timeout SECONDS]

It prints the review URL and writes it to STATE/server.json. It stops after the idle timeout, or when it gets
SIGTERM or SIGINT. It reads files and writes STATE/feedback.json. It never runs Git, the agent, or code from the
review. See ../references/server.md for the checks each request must pass.

Python 3.10+; standard library only.
"""

import argparse
import contextlib
import hashlib
import hmac
import html
import json
import math
import os
import re
import secrets
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feedback_contract  # noqa: E402
import render_review  # noqa: E402
import review_state  # noqa: E402


MAX_PAGE_BYTES = 256 * 1024 * 1024
REVISION = re.compile(r"none|[a-f0-9]{64}")
# The renderer escapes the policy inside its meta tag; the served page may call back to its own origin only.
CSP_CONNECT = html.escape("connect-src 'none'", quote=True)
CSP_CONNECT_SERVED = html.escape("connect-src 'self'", quote=True)
CSP_META = '<meta http-equiv="Content-Security-Policy" content="'
CHARSET_META = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
COMMON_HEADERS = (("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                  ("Cross-Origin-Resource-Policy", "same-origin"), ("Cross-Origin-Opener-Policy", "same-origin"))


def revision(data):
    return hashlib.sha256(data).hexdigest() if data is not None else "none"


class ReviewServer(ThreadingHTTPServer):
    # Shutdown waits only for saves in progress, with a deadline (finish_saves). Other request threads, including a
    # client that never finishes its headers, do not keep the process or its lock alive.
    daemon_threads = True
    block_on_close = False

    def __init__(self, state, idle_timeout, port=0):
        self.state = review_state.private_dir(state)
        if review_state.read_current(self.state) is None:
            raise review_state.StateError(f"{self.state} has no rendered round. Run render_review.py --round first.")
        super().__init__(("127.0.0.1", port), Handler)
        self.port = self.server_address[1]
        self.token = secrets.token_urlsafe(32)
        # Only these Host values reach a handler, so a DNS-rebound name such as attacker.example:PORT gets nothing.
        self.hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}
        self.url = f"http://127.0.0.1:{self.port}/?token={self.token}"
        self.idle_timeout = idle_timeout
        self.last_request = time.monotonic()
        self.save_lock = threading.Lock()
        self.snapshots = {}
        self.active_saves = 0
        self.saves_done = threading.Condition()

    def finish_saves(self, timeout):
        """Wait up to timeout seconds for saves in progress to finish. Return whether they did."""
        with self.saves_done:
            return self.saves_done.wait_for(lambda: self.active_saves == 0, timeout)

    def snapshot(self, number):
        """The target and input digest of a round, read once from its immutable input."""
        if number not in self.snapshots:
            review = render_review.load_review(self.state / "rounds" / f"{number:04d}" / "input.json")
            self.snapshots[number] = {"target": review["target"], "input_sha256": render_review.input_digest(review)}
        return self.snapshots[number]

    def saved(self):
        try:
            return (self.state / "feedback.json").read_bytes()
        except FileNotFoundError:
            return None

    def watch_idle(self):
        while True:
            time.sleep(min(1.0, self.idle_timeout))
            if time.monotonic() - self.last_request > self.idle_timeout:
                self.shutdown()
                return


class Handler(BaseHTTPRequestHandler):
    server_version = "review-canvas"
    timeout = 30
    sys_version = ""

    def log_message(self, format, *args):
        """Stay quiet: request lines would repeat paths and tokens in the agent's terminal."""

    def __getattr__(self, name):
        # Every method other than GET and PUT, including HEAD, POST, and OPTIONS, gets a 404.
        if name.startswith("do_"):
            return self.not_found
        raise AttributeError(name)

    def respond(self, status, body, content_type="application/json; charset=utf-8", policy="default-src 'none'; frame-ancestors 'none'"):
        self.send_response(status)
        for name, value in COMMON_HEADERS:
            self.send_header(name, value)
        self.send_header("Content-Security-Policy", policy)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def reply(self, status, **fields):
        self.respond(status, json.dumps(fields).encode())

    def not_found(self):
        self.close_connection = True
        self.reply(404, error="Not found.")

    def do_GET(self):
        self.guarded()

    def do_PUT(self):
        self.guarded()

    def guarded(self):
        try:
            self.route()
        except (review_state.StateError, render_review.ValidationError, OSError) as error:
            self.reply(500, error=f"The review state is unreadable: {error}")

    def route(self):
        self.server.last_request = time.monotonic()
        self.close_connection = True
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1 or hosts[0] not in self.server.hosts:
            return self.reply(403, error="Unknown Host header.")
        parts = urlsplit(self.path)
        if self.command == "GET" and parts.path == "/":
            return self.page(parts.query)
        routes = {("GET", "/feedback"): self.load, ("GET", "/round"): self.round, ("PUT", "/feedback"): self.save}
        handler = routes.get((self.command, parts.path))
        if handler is None or parts.query:
            return self.not_found()
        if self.command == "PUT":
            origins = self.headers.get_all("Origin") or []
            if len(origins) != 1 or origins[0] != f"http://{hosts[0]}":
                return self.reply(403, error="Origin must be this server.")
            media, _, parameters = (self.headers.get("Content-Type") or "").partition(";")
            if media.strip().lower() != "application/json" or parameters.replace(" ", "").lower() not in ("", "charset=utf-8"):
                return self.reply(415, error="Content-Type must be application/json.")
        if not self.token_matches(self.headers.get("X-Review-Token")):
            return self.reply(403, error="Missing or wrong session token. Reload the page from the URL the agent gave you.")
        return handler()

    def token_matches(self, value):
        return isinstance(value, str) and hmac.compare_digest(value.encode(), self.server.token.encode())

    def page(self, query):
        values = parse_qs(query, keep_blank_values=True, strict_parsing=False)
        if list(values) != ["token"] or len(values["token"]) != 1 or not self.token_matches(values["token"][0]):
            return self.respond(403, b"Open the review URL that the agent gave you.\n", "text/plain; charset=utf-8")
        number = review_state.read_current(self.server.state)
        path = self.server.state / "rounds" / f"{number:04d}" / "review.html"
        if path.stat().st_size > MAX_PAGE_BYTES:
            return self.reply(500, error="The rendered page is too large to serve.")
        page = path.read_text(encoding="utf-8")
        # Edit only the renderer's own head. Reviewed text is escaped, but its escaped form can repeat the policy text.
        start = page.find(CSP_META, 0, page.find("</head>"))
        end = page.find('">', start)
        policy = page[start:end]
        if not page.startswith(CHARSET_META) or start < 0 or policy.count(CSP_CONNECT) != 1:
            return self.reply(500, error="The rendered page lacks the expected security policy.")
        # The script and its hash are unchanged, and so is the file on disk.
        # The page asks for the round well inside the idle timeout, so an open page keeps the server running.
        poll = max(250, min(3000, int(self.server.idle_timeout * 1000 / 3)))
        session = (f'<meta name="review-canvas-token" content="{self.server.token}"><meta name="review-canvas-round" content="{number}">'
                   f'<meta name="review-canvas-poll" content="{poll}">')
        page = CHARSET_META + session + page[len(CHARSET_META):start] + policy.replace(CSP_CONNECT, CSP_CONNECT_SERVED) + page[end:]
        self.respond(200, page.encode("utf-8"), "text/html; charset=utf-8", "frame-ancestors 'none'")

    def round(self):
        self.reply(200, round=review_state.read_current(self.server.state))

    def load(self):
        data = self.server.saved()
        if data is None:
            return self.reply(200, revision="none", feedback=None)
        try:
            feedback = feedback_contract.parse_feedback(data)
        except feedback_contract.FeedbackError as error:
            return self.reply(500, error=f"The saved feedback is invalid, so saving is paused: {error}", revision=revision(data))
        self.reply(200, revision=revision(data), feedback=feedback)

    def save(self):
        with self.server.saves_done:
            self.server.active_saves += 1
        try:
            self.write_feedback()
        finally:
            with self.server.saves_done:
                self.server.active_saves -= 1
                self.server.saves_done.notify_all()

    def write_feedback(self):
        if self.headers.get("Transfer-Encoding"):
            return self.reply(411, error="Send a Content-Length, not a chunked body.")
        length = self.headers.get("Content-Length") or ""
        if not length.isdigit():
            return self.reply(411, error="Content-Length is required.")
        if int(length) > feedback_contract.MAX_BYTES:
            return self.reply(413, error="Feedback exceeds 8 MiB.")
        base = self.headers.get("X-Review-Revision") or ""
        if not REVISION.fullmatch(base):
            return self.reply(400, error="X-Review-Revision must name the revision this save is based on.")
        body = self.rfile.read(int(length))
        if len(body) != int(length):
            return self.reply(400, error="The body ended early.")
        try:
            feedback = feedback_contract.parse_feedback(body)
            feedback_contract.check_identity(feedback, self.server.snapshot(review_state.read_current(self.server.state)))
        except feedback_contract.FeedbackError as error:
            return self.reply(400, error=str(error))
        with self.server.save_lock:
            current = revision(self.server.saved())
            if base != current:
                return self.reply(409, error="Feedback changed since this page loaded it, in another tab or round. Reload to continue.", revision=current)
            review_state.write_private(self.server.state / "feedback.json", body)
        self.reply(200, revision=revision(body))


def write_server_file(server):
    record = {"url": server.url, "port": server.port, "pid": os.getpid()}
    review_state.write_private(server.state / "server.json", (json.dumps(record, indent=2) + "\n").encode())


def running_server(state):
    """Return the URL recorded by the server that holds this review's lock. The lock, not a process probe, proves it
    runs: on Windows, os.kill with signal 0 would terminate the process."""
    try:
        return json.loads((Path(state) / "server.json").read_text(encoding="utf-8"))["url"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--state-dir", type=Path, required=True, help="The review's state directory")
    parser.add_argument("--idle-timeout", type=float, default=3600, help="Stop after this many seconds without a request (default 3600)")
    args = parser.parse_args(argv)
    if not math.isfinite(args.idle_timeout) or args.idle_timeout < 1:
        parser.error("--idle-timeout must be at least 1 second, so an open page can poll inside it")
    # One server per review: its lock lasts as long as the process, so two starts cannot both serve and both save.
    ownership = contextlib.ExitStack()
    try:
        # Everything below uses the checked, resolved directory, so a symlink on the way cannot point the lock elsewhere.
        state = review_state.private_dir(args.state_dir)
        try:
            ownership.enter_context(review_state.lock(state, "server", wait=False))
        except review_state.StateError:
            raise review_state.StateError(f"a server already runs for this review: {running_server(state) or 'see server.json'}") from None
        server = ReviewServer(state, args.idle_timeout)
        write_server_file(server)
    except (review_state.StateError, OSError) as error:
        ownership.close()
        print(f"Error: {error}", file=sys.stderr)
        return 2
    with ownership:
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
        threading.Thread(target=server.watch_idle, daemon=True).start()
        print(f"Review server: {server.url}", flush=True)
        print(f"It stops after {args.idle_timeout:g} seconds without a request. Feedback saves to {server.state / 'feedback.json'}.", flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            server.finish_saves(30)
            server.server_close()
            (server.state / "server.json").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
