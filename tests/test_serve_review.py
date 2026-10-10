"""Standard-library tests: python3 -m unittest discover -s tests -p 'test_serve_review.py'.

Each test starts the review server on a real loopback port and sends requests with http.client or a raw socket.
Every security check has a test that sends the request it must reject.
"""

import base64
import contextlib
import errno
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/review-canvas/scripts"
FIXTURES = ROOT / "tests/fixtures"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


serve = load("serve_review")
state_module = serve.review_state
renderer = serve.render_review


def render_round(state, fixture):
    directory = state_module.new_round(state)
    shutil.copyfile(FIXTURES / fixture, directory / "input.json")
    with contextlib.redirect_stdout(io.StringIO()):
        assert renderer.main(["--round", str(directory)]) == 0
    return directory


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp)
        self.state = self.temp / "state"
        render_round(self.state, "worktree-review.json")
        self.server = serve.ReviewServer(self.state, idle_timeout=60)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port, self.token = self.server.port, self.server.token
        self.host = f"127.0.0.1:{self.port}"
        self.body = (FIXTURES / "worktree-feedback.json").read_bytes()

    def request(self, method, path, body=None, **overrides):
        headers = {"Host": self.host}
        headers.update(overrides)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(connection.close)
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for name, value in headers.items():
            if value is not None:
                connection.putheader(name, value)
        if body is not None and "Content-Length" not in headers:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        data = response.read()
        return response.status, dict(response.getheaders()), data

    def api(self, method, path, body=None, **overrides):
        headers = {"X-Review-Token": self.token}
        if method == "PUT":
            headers.update({"Origin": f"http://{self.host}", "Content-Type": "application/json", "X-Review-Revision": "none"})
        headers.update(overrides)
        status, response_headers, data = self.request(method, path, body, **headers)
        return status, json.loads(data) if data and response_headers.get("Content-Type", "").startswith("application/json") else data

    def raw(self, request):
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as connection:
            connection.sendall(request)
            data = b""
            while chunk := connection.recv(65536):
                data += chunk
        return int(data.split(b" ", 2)[1])


class PageTests(ServerCase):
    def test_page_needs_the_url_token_and_gets_a_session(self):
        status, headers, page = self.request("GET", f"/?token={self.token}")
        self.assertEqual(status, 200)
        page = page.decode()
        self.assertIn("connect-src &#x27;self&#x27;", page)
        self.assertNotIn("connect-src &#x27;none&#x27;", page)
        self.assertIn(f'<meta name="review-canvas-token" content="{self.token}"><meta name="review-canvas-round" content="1">'
                      '<meta name="review-canvas-poll" content="3000">', page)
        # A short idle timeout gets a shorter poll, so an open page still keeps the server running.
        self.server.idle_timeout = 1
        self.assertIn('<meta name="review-canvas-poll" content="333">', self.request("GET", f"/?token={self.token}")[2].decode())
        self.assertEqual(headers["Content-Security-Policy"], "frame-ancestors 'none'")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        # The script is unchanged, so its hash in the page's policy still matches.
        script = re.search(r"<script>(.*?)</script>", page, re.S)[1]
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        self.assertTrue(f"script-src &#x27;sha256-{digest}&#x27;" in page, "script hash no longer matches")
        on_disk = (self.state / "rounds/0001/review.html").read_text()
        self.assertIn("connect-src &#x27;none&#x27;", on_disk)
        self.assertNotIn(self.token, on_disk)
        for query in ("", "?token=wrong", f"?token={self.token}&extra=1", f"?token={self.token}&token={self.token}"):
            with self.subTest(query=query):
                self.assertEqual(self.request("GET", "/" + query)[0], 403)


class ShutdownTests(ServerCase):
    def test_a_save_in_progress_finishes_before_shutdown(self):
        body = self.body
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        self.addCleanup(connection.close)
        connection.sendall((f"PUT /feedback HTTP/1.1\r\nHost: {self.host}\r\nOrigin: http://{self.host}\r\nContent-Type: application/json\r\n"
                            f"X-Review-Token: {self.token}\r\nX-Review-Revision: none\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body[:100])
        time.sleep(0.2)
        stopping = threading.Thread(target=lambda: (self.server.shutdown(), self.server.finish_saves(10), self.server.server_close()))
        stopping.start()
        time.sleep(0.2)
        self.assertTrue(stopping.is_alive(), "shutdown did not wait for the save in progress")
        connection.sendall(body[100:])
        reply = connection.recv(65536)
        stopping.join(10)
        self.assertEqual(int(reply.split(b" ", 2)[1]), 200)
        self.assertEqual((self.state / "feedback.json").read_bytes(), body)

    def test_a_client_that_never_finishes_its_headers_does_not_hold_shutdown(self):
        stalled = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        self.addCleanup(stalled.close)
        stalled.sendall(f"GET /round HTTP/1.1\r\nHost: {self.host}\r\n".encode())
        time.sleep(0.2)
        started = time.monotonic()
        self.server.shutdown()
        self.assertTrue(self.server.finish_saves(5))
        self.server.server_close()
        self.assertLess(time.monotonic() - started, 3)

    def test_a_client_that_leaves_gets_no_second_reply(self):
        statuses = []
        def respond(handler, status, *rest, **options):
            statuses.append(status)
            raise BrokenPipeError(errno.EPIPE, "Broken pipe")
        errors = io.StringIO()
        with unittest.mock.patch.object(serve.Handler, "respond", respond), contextlib.redirect_stderr(errors):
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as client:
                client.sendall(f"GET /round HTTP/1.1\r\nHost: {self.host}\r\n\r\n".encode())
                client.recv(100)
            time.sleep(0.2)
        self.assertEqual(statuses, [403], "a failed write was answered again as a state error")
        self.assertEqual(errors.getvalue(), "")

    def test_saves_after_shutdown_begins_are_refused(self):
        self.assertTrue(self.server.finish_saves(1))
        status, reply = self.api("PUT", "/feedback", self.body)
        self.assertEqual(status, 503)
        self.assertIn("stopping", reply["error"])
        self.assertFalse((self.state / "feedback.json").exists())

    def test_requests_without_the_token_do_not_keep_the_server_alive(self):
        before = self.server.last_request
        time.sleep(0.01)
        self.assertEqual(self.request("GET", "/round", **{"X-Review-Token": self.token})[0], 200)
        self.assertGreater(self.server.last_request, before, "a request with the token is activity")
        self.server.idle_timeout = 1
        watcher = threading.Thread(target=self.server.watch_idle, daemon=True)
        watcher.start()
        deadline = time.monotonic() + 4
        while watcher.is_alive() and time.monotonic() < deadline:
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), timeout=0.5) as probe:
                probe.sendall(f"GET /round HTTP/1.1\r\nHost: {self.host}\r\n\r\n".encode())
                probe.recv(100)
            time.sleep(0.2)
        self.assertFalse(watcher.is_alive(), "requests without the token kept the server running")


class PolicyTextTests(unittest.TestCase):
    def test_reviewed_text_that_repeats_the_policy_does_not_break_the_page(self):
        temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp)
        state = temp / "state"
        directory = state_module.new_round(state)
        review = json.loads((FIXTURES / "worktree-review.json").read_text())
        review["summary"] = "This change sets connect-src 'none' and <meta charset=\"utf-8\"> in the page."
        (directory / "input.json").write_text(json.dumps(review))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(renderer.main(["--round", str(directory)]), 0)
        server = serve.ReviewServer(state, idle_timeout=60)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
        self.addCleanup(connection.close)
        connection.request("GET", f"/?token={server.token}")
        response = connection.getresponse()
        page = response.read().decode()
        self.assertEqual(response.status, 200)
        policy = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', page)[1]
        self.assertIn("connect-src &#x27;self&#x27;", policy)
        self.assertIn("This change sets connect-src &#x27;none&#x27; and &lt;meta charset", page)


class HostTests(ServerCase):
    def test_only_loopback_host_names_with_this_port_are_answered(self):
        self.assertEqual(self.api("GET", "/round", Host=f"localhost:{self.port}")[0], 200)
        for host in (f"attacker.example:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port + 1}", f"LOCALHOST:{self.port}", f"[::1]:{self.port}"):
            with self.subTest(host=host):
                self.assertEqual(self.api("GET", "/round", Host=host)[0], 403)
                self.assertEqual(self.request("GET", f"/?token={self.token}", Host=host)[0], 403)

    def test_missing_or_repeated_host_is_rejected(self):
        self.assertEqual(self.raw(f"GET /round HTTP/1.0\r\nX-Review-Token: {self.token}\r\n\r\n".encode()), 403)
        self.assertEqual(self.raw(f"GET /round HTTP/1.1\r\nHost: {self.host}\r\nHost: {self.host}\r\nX-Review-Token: {self.token}\r\n\r\n".encode()), 403)


class SaveCheckTests(ServerCase):
    def test_origin_must_be_this_server(self):
        for origin in (None, "null", "http://attacker.example", f"https://{self.host}", f"http://localhost:{self.port}", f"http://{self.host}/"):
            with self.subTest(origin=origin):
                self.assertEqual(self.api("PUT", "/feedback", self.body, Origin=origin)[0], 403)
        self.assertFalse((self.state / "feedback.json").exists())
        self.assertEqual(self.api("PUT", "/feedback", self.body)[0], 200)

    def test_a_repeated_origin_is_rejected(self):
        body = self.body
        request = (f"PUT /feedback HTTP/1.1\r\nHost: {self.host}\r\nOrigin: http://{self.host}\r\nOrigin: http://{self.host}\r\n"
                   f"Content-Type: application/json\r\nX-Review-Token: {self.token}\r\nX-Review-Revision: none\r\n"
                   f"Content-Length: {len(body)}\r\n\r\n").encode() + body
        self.assertEqual(self.raw(request), 403)
        self.assertFalse((self.state / "feedback.json").exists())

    def test_content_type_must_be_json(self):
        for content_type in (None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x",
                             "application/json-patch+json", "application/json; charset=latin-1"):
            with self.subTest(content_type=content_type):
                self.assertEqual(self.api("PUT", "/feedback", self.body, **{"Content-Type": content_type})[0], 415)
        self.assertEqual(self.api("PUT", "/feedback", self.body, **{"Content-Type": "application/json; charset=UTF-8"})[0], 200)

    def test_session_token_is_required(self):
        for token in (None, "", "wrong", self.token + "x"):
            with self.subTest(token=token):
                self.assertEqual(self.api("PUT", "/feedback", self.body, **{"X-Review-Token": token})[0], 403)
                self.assertEqual(self.api("GET", "/feedback", **{"X-Review-Token": token})[0], 403)
                self.assertEqual(self.api("GET", "/round", **{"X-Review-Token": token})[0], 403)

    def test_body_limits(self):
        self.assertEqual(self.api("PUT", "/feedback", b"", **{"Content-Length": str(8 * 1024 * 1024 + 1)})[0], 413)
        self.assertEqual(self.raw((f"PUT /feedback HTTP/1.1\r\nHost: {self.host}\r\nOrigin: http://{self.host}\r\nContent-Type: application/json\r\n"
                                   f"X-Review-Token: {self.token}\r\nX-Review-Revision: none\r\n\r\n").encode()), 411)
        self.assertEqual(self.raw((f"PUT /feedback HTTP/1.1\r\nHost: {self.host}\r\nOrigin: http://{self.host}\r\nContent-Type: application/json\r\n"
                                   f"X-Review-Token: {self.token}\r\nX-Review-Revision: none\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n").encode()), 411)

    def test_a_body_that_ends_early_is_not_saved(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as connection:
            connection.sendall((f"PUT /feedback HTTP/1.1\r\nHost: {self.host}\r\nOrigin: http://{self.host}\r\nContent-Type: application/json\r\n"
                                f"X-Review-Token: {self.token}\r\nX-Review-Revision: none\r\nContent-Length: {len(self.body)}\r\n\r\n").encode() + self.body[:10])
            connection.shutdown(socket.SHUT_WR)
            reply = b""
            while chunk := connection.recv(65536):
                reply += chunk
        self.assertEqual(int(reply.split(b" ", 2)[1]), 400)
        self.assertIn(b"ended early", reply)
        self.assertFalse((self.state / "feedback.json").exists())

    def test_whole_document_is_validated_before_writing(self):
        other = json.loads(self.body)
        other["target"]["root"] = "/home/dev/elsewhere"
        cases = {
            b"{not json": "not valid UTF-8 JSON",
            self.body.replace(b'"feedback_schema_version": 3', b'"feedback_schema_version": 2'): "version 2 is not supported",
            self.body.replace(b'"general_notes": ""', b'"general_notes": "", "general_notes": ""'): "Duplicate",
            json.dumps(other).encode(): "another review target",
        }
        for body, message in cases.items():
            with self.subTest(message=message):
                status, reply = self.api("PUT", "/feedback", body)
                self.assertEqual(status, 400)
                self.assertIn(message, reply["error"])
        self.assertFalse((self.state / "feedback.json").exists())


class RevisionTests(ServerCase):
    def test_a_stale_revision_conflicts(self):
        self.assertEqual(self.api("GET", "/feedback")[1], {"revision": "none", "feedback": None})
        status, reply = self.api("PUT", "/feedback", self.body)
        self.assertEqual((status, reply), (200, {"revision": hashlib.sha256(self.body).hexdigest()}))
        first = reply["revision"]
        self.assertEqual(self.api("GET", "/feedback")[1], {"revision": first, "feedback": json.loads(self.body)})
        # A second tab that loaded before the first save is based on "none".
        status, reply = self.api("PUT", "/feedback", self.body)
        self.assertEqual((status, reply["revision"]), (409, first))
        changed = self.body.replace(b'"general_notes": ""', b'"general_notes": "second save"')
        status, reply = self.api("PUT", "/feedback", changed, **{"X-Review-Revision": first})
        self.assertEqual(status, 200)
        self.assertEqual(self.api("PUT", "/feedback", self.body, **{"X-Review-Revision": first})[0], 409)
        for base in (None, "", "abc", first.upper()):
            with self.subTest(base=base):
                self.assertEqual(self.api("PUT", "/feedback", self.body, **{"X-Review-Revision": base})[0], 400)
        self.assertEqual((self.state / "feedback.json").read_bytes(), changed)

    def test_saves_are_atomic_and_private(self):
        self.assertEqual(self.api("PUT", "/feedback", self.body)[0], 200)
        saved = self.state / "feedback.json"
        self.assertEqual(saved.read_bytes(), self.body)
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
        self.assertEqual(sorted(path.name for path in self.state.iterdir()), ["current", "feedback.json", "publish.lock", "rounds"])

    def test_invalid_saved_feedback_pauses_saving(self):
        (self.state / "feedback.json").write_text("{}")
        status, reply = self.api("GET", "/feedback")
        self.assertEqual(status, 500)
        self.assertIn("saving is paused", reply["error"])


class RoutingTests(ServerCase):
    def test_everything_else_is_not_found(self):
        for method, path in (("GET", "/rounds/0001/input.json"), ("GET", "/rounds/"), ("GET", "/current"), ("GET", "/feedback.json"),
                             ("GET", "/../current"), ("GET", "/feedback?x=1"), ("GET", "/index.html"), ("POST", "/feedback"),
                             ("DELETE", "/feedback"), ("OPTIONS", "/feedback"), ("HEAD", "/"), ("PATCH", "/feedback"), ("PUT", "/round")):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.api(method, path)[0], 404)

    def test_round_follows_each_publish(self):
        self.assertEqual(self.api("GET", "/round")[1], {"round": 1})
        render_round(self.state, "worktree-review-round2.json")
        self.assertEqual(self.api("GET", "/round")[1], {"round": 2})
        self.assertIn(b'<meta name="review-canvas-round" content="2">', self.request("GET", f"/?token={self.token}")[2])
        # Feedback from the open round 1 page still belongs to this review, so it saves.
        self.assertEqual(self.api("PUT", "/feedback", self.body)[0], 200)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp)
        self.state = self.temp / "state"

    def test_new_rounds_are_private_and_numbered(self):
        first, second = state_module.new_round(self.state), state_module.new_round(self.state)
        self.assertEqual((first.name, second.name), ("0001", "0002"))
        for path in (self.state, self.state / "rounds", first):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        result = subprocess.run([sys.executable, str(SCRIPTS / "review_state.py"), "new-round", "--state-dir", str(self.state)], capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, str(self.state / "rounds/0003")))

    def test_a_round_renders_once_and_never_replaces_a_newer_one(self):
        first = render_round(self.state, "worktree-review.json")
        self.assertEqual(stat.S_IMODE((first / "review.html").stat().st_mode), 0o600)
        self.assertEqual(state_module.read_current(self.state), 1)
        quiet = contextlib.redirect_stderr(io.StringIO())
        with quiet:
            self.assertEqual(renderer.main(["--round", str(first)]), 2)
        second = state_module.new_round(self.state)
        third = render_round(self.state, "worktree-review-round2.json")
        self.assertEqual(state_module.read_current(self.state), 3)
        shutil.copyfile(FIXTURES / "worktree-review.json", second / "input.json")
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(renderer.main(["--round", str(second)]), 2)
            self.assertEqual(renderer.main(["--round", str(self.temp)]), 2)
        self.assertEqual(state_module.read_current(self.state), 3)
        self.assertTrue(third.exists())

    def test_a_rendered_round_input_cannot_change_unnoticed(self):
        directory = render_round(self.state, "worktree-review.json")
        self.assertTrue((directory / "input.sha256").exists())
        review = json.loads((directory / "input.json").read_text())
        review["summary"] = "Edited after the page rendered."
        (directory / "input.json").write_text(json.dumps(review))
        with self.assertRaisesRegex(renderer.ValidationError, "changed after its round rendered"):
            renderer.load_review(directory / "input.json")
        self.assertEqual(renderer.load_review(FIXTURES / "worktree-review.json")["target"]["kind"], "worktree")  # loose inputs are not checked
        (directory / "input.sha256").unlink()  # a rendered round without its digest cannot show its input is unchanged
        with self.assertRaisesRegex(renderer.ValidationError, "rendered but has no readable input.sha256"):
            renderer.load_review(directory / "input.json")

    def test_the_collector_never_writes_into_a_superseded_round(self):
        older = state_module.new_round(self.state)
        render_round(self.state, "worktree-review.json")  # round 2 publishes; round 1 can never publish now
        collector = load("collect_worktree")
        with self.assertRaisesRegex(collector.CollectError, "or a newer round has"):
            collector.collect(ROOT, output=older / "input.json")

    def test_acl_read_errors_refuse_the_directory(self):
        def failing(code):
            def getxattr(path, name):
                raise OSError(code, os.strerror(code))
            return unittest.mock.patch.object(state_module.os, "getxattr", getxattr, create=True)
        for code in (errno.ENODATA, errno.ENOTSUP):
            with self.subTest(code=code), failing(code):
                self.assertIsNone(state_module._acl_writers("/x", 1000))
        for code in (errno.EACCES, errno.EIO):
            with self.subTest(code=code), failing(code), self.assertRaisesRegex(state_module.StateError, "cannot read the access control list"):
                state_module._acl_writers("/x", 1000)

    def test_a_symlinked_round_input_is_refused(self):
        directory = state_module.new_round(self.state)
        outside = self.temp / "outside.json"
        shutil.copyfile(FIXTURES / "worktree-review.json", outside)
        os.symlink(outside, directory / "input.json")
        error = io.StringIO()
        with contextlib.redirect_stderr(error), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(renderer.main(["--round", str(directory)]), 2)
        self.assertIn("is a symbolic or hard link", error.getvalue())
        self.assertFalse((directory / "review.html").exists())
        self.assertIsNone(state_module.read_current(self.state))

    def test_a_hard_linked_round_input_is_refused(self):
        directory = state_module.new_round(self.state)
        outside = self.temp / "outside.json"
        shutil.copyfile(FIXTURES / "worktree-review.json", outside)
        os.link(outside, directory / "input.json")
        error = io.StringIO()
        with contextlib.redirect_stderr(error), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(renderer.main(["--round", str(directory)]), 2)
        self.assertIn("is a symbolic or hard link", error.getvalue())
        self.assertFalse((directory / "review.html").exists())

    def test_only_a_state_round_input_takes_the_round_lock(self):
        directory = state_module.new_round(self.state)
        with state_module.round_lock(directory / "input.json"):
            self.assertTrue((self.state / "publish.lock").exists())
        loose = self.temp / "shared" / "rounds" / "0001"
        loose.mkdir(parents=True)
        os.chmod(self.temp / "shared", 0o755)
        for path in (loose / "review.json", loose / "input.json"):
            with state_module.round_lock(path):
                pass
        self.assertFalse((self.temp / "shared" / "publish.lock").exists())

    def test_rendering_uses_the_validated_round_path(self):
        directory = state_module.new_round(self.state)
        shutil.copyfile(FIXTURES / "worktree-review.json", directory / "input.json")
        link = self.temp / "link"
        os.symlink(self.temp, link)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(renderer.main(["--round", str(link / "state" / "rounds" / directory.name)]), 0)
        self.assertTrue((directory / "review.html").exists())
        real = []
        with unittest.mock.patch.object(renderer, "load_review", side_effect=lambda path: real.append(Path(path)) or json.loads((FIXTURES / "worktree-review.json").read_text())):
            second = state_module.new_round(self.state)
            shutil.copyfile(FIXTURES / "worktree-review.json", second / "input.json")
            with contextlib.redirect_stdout(io.StringIO()):
                renderer.main(["--round", str(link / "state" / "rounds" / second.name)])
        self.assertEqual(real, [second.resolve() / "input.json"])

    def test_publish_waits_for_another_publish(self):
        render_round(self.state, "worktree-review.json")
        second = state_module.new_round(self.state)
        done = threading.Event()
        with state_module.lock(self.state, "publish"):
            worker = threading.Thread(target=lambda: (state_module.publish(self.state, int(second.name)), done.set()))
            worker.start()
            self.assertFalse(done.wait(0.3), "publish ran while another publish held the lock")
        self.assertTrue(done.wait(5))
        self.assertEqual(state_module.read_current(self.state), 2)

    def test_directory_sync_that_the_file_system_refuses_is_skipped(self):
        state_module.private_dir(self.state, create=True)
        real = os.fsync

        def refuse(errno_value):
            def fsync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError(errno_value, os.strerror(errno_value))
                return real(fd)
            return fsync

        with unittest.mock.patch.object(state_module.os, "fsync", refuse(errno.EINVAL)):
            state_module.write_private(self.state / "file", b"saved")
        self.assertEqual((self.state / "file").read_bytes(), b"saved")
        with unittest.mock.patch.object(state_module.os, "fsync", refuse(errno.EIO)), self.assertRaises(OSError):
            state_module.write_private(self.state / "file", b"again")

    def test_archive_moves_a_finished_review_aside(self):
        render_round(self.state, "worktree-review.json")
        with state_module.lock(self.state, "server", wait=False):
            result = subprocess.run([sys.executable, str(SCRIPTS / "review_state.py"), "archive", "--state-dir", str(self.state)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("a server still runs", result.stderr)
        result = subprocess.run([sys.executable, str(SCRIPTS / "review_state.py"), "archive", "--state-dir", str(self.state)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        archived = Path(result.stdout.strip())
        self.assertRegex(archived.name, r"^state\.archived-\d{8}T\d{6}Z$")
        self.assertTrue((archived / "rounds/0001/review.html").exists())
        self.assertFalse(self.state.exists())
        self.assertEqual(state_module.new_round(self.state).name, "0001")

    def test_archive_waits_for_a_publish_in_progress(self):
        render_round(self.state, "worktree-review.json")
        done = threading.Event()
        with state_module.lock(self.state, "publish"):
            worker = threading.Thread(target=lambda: (state_module.archive(self.state), done.set()))
            worker.start()
            self.assertFalse(done.wait(0.3), "archive moved the state while a publish held its lock")
            self.assertTrue(self.state.exists())
        self.assertTrue(done.wait(10))
        self.assertFalse(self.state.exists())

    def test_ancestors_another_user_could_replace_are_refused(self):
        shared = self.temp / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)
        with self.assertRaisesRegex(state_module.StateError, "another user can rename or replace entries"):
            state_module.new_round(shared / "state")
        os.chmod(shared, 0o1777)  # sticky, as /tmp is
        self.assertEqual(state_module.new_round(shared / "state").name, "0001")

    @unittest.skipUnless(shutil.which("setfacl") and hasattr(os, "getxattr"), "needs POSIX ACLs")
    def test_ancestors_writable_through_a_named_acl_entry_are_refused(self):
        shared = self.temp / "acl"
        shared.mkdir(mode=0o700)
        if subprocess.run(["setfacl", "-m", "u:nobody:rwx", str(shared)], capture_output=True).returncode:
            self.skipTest("this filesystem or system has no POSIX ACLs or no nobody user")
        with self.assertRaisesRegex(state_module.StateError, "another user can rename or replace entries"):
            state_module.new_round(shared / "state")
        subprocess.run(["setfacl", "-m", "m::r-x", str(shared)], check=True)  # the mask now withholds write from every entry
        self.assertEqual(state_module.new_round(shared / "state").name, "0001")

    def test_acl_entries_count_only_within_the_mask(self):
        def acl(*entries):
            return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
        undefined = 0xFFFFFFFF
        cases = [
            (acl((1, 7, undefined), (2, 7, 4242), (4, 5, undefined), (0x10, 7, undefined), (0x20, 5, undefined)), ({4242}, set())),
            (acl((1, 7, undefined), (2, 7, 4242), (4, 7, undefined), (0x10, 5, undefined), (0x20, 5, undefined)), (set(), set())),
            (acl((1, 7, undefined), (4, 7, undefined), (8, 7, 77), (0x10, 7, undefined), (0x20, 5, undefined)), (set(), {1000, 77})),
        ]
        def attributes(**values):
            def getxattr(path, name):
                if name not in values:
                    raise OSError(errno.ENODATA, "No data available")
                return values[name]
            return unittest.mock.patch.object(state_module.os, "getxattr", getxattr, create=True)
        for raw, expected in cases:
            with self.subTest(expected=expected), attributes(**{"system.posix_acl_access": raw}):
                self.assertEqual(state_module._acl_writers("/x", 1000), expected)
        with attributes(**{"system.posix_acl_access": b"\x01\x00\x00\x00"}), \
                self.assertRaisesRegex(state_module.StateError, "cannot read the access control list"):
            state_module._acl_writers("/x", 1000)
        # An NFSv4 ACL can grant access the mode bits do not show, and these scripts cannot read it.
        with attributes(**{"system.nfs4_acl": b"\x00"}), self.assertRaisesRegex(state_module.StateError, "uses NFSv4 access control lists"):
            state_module._acl_writers("/x", 1000)

    def test_the_checked_resolved_path_is_the_one_used(self):
        render_round(self.state, "worktree-review.json")
        # A symlink partway along the path could be retargeted after the check, so the resolved path is what is used.
        link = self.temp / "link"
        os.symlink(self.temp, link)
        self.assertEqual(state_module.private_dir(link / "state"), self.state.resolve())
        server = serve.ReviewServer(link / "state", 60)
        self.addCleanup(server.server_close)
        self.assertEqual(server.state, self.state.resolve())

    def test_the_collector_never_writes_into_a_rendered_round(self):
        directory = render_round(self.state, "worktree-review.json")
        collector = load("collect_worktree")
        with self.assertRaisesRegex(collector.CollectError, "has rendered, or a newer round has; a round never changes"):
            collector.collect(ROOT, output=directory / "input.json")
        # The file workflow keeps review.json beside review.html outside any round; that stays allowed, even in a folder
        # that happens to be called rounds.
        repo = self.temp / "repo"
        for command in (["git", "-c", "init.defaultBranch=main", "init", "-q", str(repo)],
                        ["git", "-C", str(repo), "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(command, check=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})
        for loose in (self.temp / "loose", self.temp / "rounds" / "not-a-round"):
            loose.mkdir(parents=True)
            (loose / "review.html").write_text("rendered")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(collector.main(["--repo", str(repo), "--output", str(loose / "review.json")]), 0, loose)

    def test_the_collector_final_check_sees_through_a_symlinked_round(self):
        directory = render_round(self.state, "worktree-review.json")
        alias = self.temp / "alias"
        os.symlink(self.state / "rounds", alias)
        repo = self.temp / "repo"
        for command in (["git", "-c", "init.defaultBranch=main", "init", "-q", str(repo)],
                        ["git", "-C", str(repo), "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(command, check=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})
        before = (directory / "input.json").read_bytes()
        collector = load("collect_worktree")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(collector.main(["--repo", str(repo), "--output", str(alias / directory.name / "input.json")]), 2)
        self.assertEqual((directory / "input.json").read_bytes(), before)

    def test_the_collector_write_waits_for_rendering_and_rechecks(self):
        repo = self.temp / "repo"
        for command in (["git", "-c", "init.defaultBranch=main", "init", "-q", str(repo)],
                        ["git", "-C", str(repo), "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(command, check=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})
        (repo / "a.txt").write_text("a\n")
        directory = state_module.new_round(self.state)
        collector = load("collect_worktree")
        result = {}
        with state_module.lock(self.state, "publish"):
            worker = threading.Thread(target=lambda: result.update(code=collector.main(["--repo", str(repo), "--output", str(directory / "input.json")])))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                worker.start()
                worker.join(2)
                self.assertTrue(worker.is_alive(), "the collector wrote while rendering held the lock")
                (directory / "review.html").write_text("rendered meanwhile")
        worker.join(30)
        self.assertEqual(result["code"], 2)
        self.assertFalse((directory / "input.json").exists())

    def test_platforms_without_posix_permissions_are_refused(self):
        with unittest.mock.patch.object(state_module, "PRIVACY_CHECKABLE", False), \
                self.assertRaisesRegex(state_module.StateError, "cannot confirm that only you can read"):
            state_module.new_round(self.state)

    def test_server_needs_a_private_state_with_a_rendered_round(self):
        with self.assertRaisesRegex(state_module.StateError, "not a review state directory"):
            serve.ReviewServer(self.state, 60)
        state_module.new_round(self.state)
        with self.assertRaisesRegex(state_module.StateError, "no rendered round"):
            serve.ReviewServer(self.state, 60)
        render_round(self.state, "worktree-review.json")
        os.chmod(self.state, 0o755)
        with self.assertRaisesRegex(state_module.StateError, "private"):
            serve.ReviewServer(self.state, 60)


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp)
        self.state = self.temp / "state"
        render_round(self.state, "worktree-review.json")

    def start(self, *args):
        process = subprocess.Popen([sys.executable, str(SCRIPTS / "serve_review.py"), "--state-dir", str(self.state), *args],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        url = process.stdout.readline().strip().removeprefix("Review server: ")
        return process, url

    def test_server_file_second_server_signal_and_idle_stop(self):
        process, url = self.start()
        record = json.loads((self.state / "server.json").read_text())
        self.assertEqual((record["url"], record["pid"]), (url, process.pid))
        self.assertEqual(stat.S_IMODE((self.state / "server.json").stat().st_mode), 0o600)
        self.assertTrue(url.startswith("http://127.0.0.1:") and "/?token=" in url)
        second = subprocess.run([sys.executable, str(SCRIPTS / "serve_review.py"), "--state-dir", str(self.state)], capture_output=True, text=True, timeout=30)
        self.assertEqual(second.returncode, 2)
        self.assertIn("already runs", second.stderr)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertFalse((self.state / "server.json").exists())
        # The lock proves a server runs; reading its URL never probes or signals a process.
        (self.state / "server.json").write_text(json.dumps({"url": "http://127.0.0.1:1/?token=t", "port": 1, "pid": 1}))
        with unittest.mock.patch.object(serve.os, "kill", side_effect=AssertionError("os.kill called")):
            self.assertEqual(serve.running_server(self.state), "http://127.0.0.1:1/?token=t")
        (self.state / "server.json").unlink()
        # Started through a symlinked parent, the server locks and records the resolved state directory.
        link = self.temp / "link"
        os.symlink(self.temp, link)
        linked = subprocess.Popen([sys.executable, str(SCRIPTS / "serve_review.py"), "--state-dir", str(link / "state")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: linked.poll() is None and linked.kill())
        linked.stdout.readline()
        self.assertTrue((self.state / "server.json").exists())
        with self.assertRaises(state_module.StateError):
            with state_module.lock(self.state, "server", wait=False):
                pass
        linked.send_signal(signal.SIGTERM)
        self.assertEqual(linked.wait(timeout=10), 0)
        # A process that holds the review's server lock keeps any other server from starting.
        with state_module.lock(self.state, "server", wait=False):
            blocked = subprocess.run([sys.executable, str(SCRIPTS / "serve_review.py"), "--state-dir", str(self.state)], capture_output=True, text=True, timeout=30)
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("already runs", blocked.stderr)
        self.assertFalse((self.state / "server.json").exists())
        for value in ("0.2", "nan", "inf"):
            refused = subprocess.run([sys.executable, str(SCRIPTS / "serve_review.py"), "--state-dir", str(self.state), "--idle-timeout", value], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, value)
            self.assertIn("at least 1 second", refused.stderr)
        process, url = self.start("--idle-timeout", "1")
        started = time.monotonic()
        self.assertEqual(process.wait(timeout=15), 0)
        self.assertLess(time.monotonic() - started, 10)
        self.assertFalse((self.state / "server.json").exists())


if __name__ == "__main__":
    unittest.main()
