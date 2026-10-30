import contextlib
import io
import json
import os
import shutil
import socket
import stat
import tempfile
import threading
import unittest

from pignon_decider.server import serve
from tests.support import ExplodingScorer, FakeScorer, OverlapProbeScorer, raw_exchange, request, running_daemon


class HealthTest(unittest.TestCase):
    def test_reports_ready_over_the_unix_socket(self):
        with running_daemon(FakeScorer()) as socket_path:
            status, body = request(socket_path, "GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "ready": True})


class DecideTest(unittest.TestCase):
    def test_maps_model_probabilities_onto_pignon_tiers(self):
        cases = [
            ({"smol": 0.7, "default": 0.2, "slow": 0.1}, {"trivial": 0.7, "standard": 0.2, "hard": 0.1}, "trivial"),
            ({"smol": 0.1, "default": 0.6, "slow": 0.3}, {"trivial": 0.1, "standard": 0.6, "hard": 0.3}, "standard"),
            ({"smol": 0.1, "default": 0.2, "slow": 0.7}, {"trivial": 0.1, "standard": 0.2, "hard": 0.7}, "hard"),
        ]
        for probabilities, tiers, tier in cases:
            with self.subTest(tier=tier), running_daemon(FakeScorer(probabilities)) as socket_path:
                status, body = request(socket_path, "POST", "/decide", {"prompt": "find why the nightly job deadlocks"})

                self.assertEqual(status, 200)
                self.assertEqual(body["tiers"], tiers)
                self.assertEqual(body["tier"], tier)
                self.assertEqual(body["model"], "fake")
                self.assertIsInstance(body["latencyMs"], (int, float))


class ValidationTest(unittest.TestCase):
    def test_refuses_malformed_requests_without_scoring_them(self):
        bad_requests = {
            "not JSON": {"raw": b"{not json"},
            "not an object": {"body": ["a prompt"]},
            "no prompt": {"body": {}},
            "prompt not a string": {"body": {"prompt": 5}},
            "context tokens not a number": {"body": {"prompt": "x", "contextTokens": "many"}},
        }
        scorer = FakeScorer()
        with running_daemon(scorer) as socket_path:
            for name, kwargs in bad_requests.items():
                with self.subTest(name):
                    status, body = request(socket_path, "POST", "/decide", **kwargs)

                    self.assertEqual(status, 400)
                    self.assertIsInstance(body["error"], str)
        self.assertEqual(scorer.calls, [])


class SocketSecurityTest(unittest.TestCase):
    def test_socket_is_owner_only_even_under_a_permissive_umask(self):
        previous = os.umask(0)
        try:
            with running_daemon(FakeScorer()) as socket_path:
                mode = stat.S_IMODE(os.stat(socket_path).st_mode)
        finally:
            os.umask(previous)

        self.assertEqual(mode, 0o600)

    def test_refuses_a_directory_other_users_can_enter(self):
        directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        os.chmod(directory, 0o755)

        with self.assertRaises(PermissionError):
            serve(f"{directory}/s.sock", FakeScorer())

        self.assertFalse(os.path.exists(f"{directory}/s.sock"))


class OccupiedPathTest(unittest.TestCase):
    def test_replaces_the_socket_a_crashed_daemon_left_behind(self):
        def leave_a_stale_socket(path):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
                stale.bind(path)  # closing does not remove the file

        with running_daemon(FakeScorer(), prepare=leave_a_stale_socket) as socket_path:
            status, _ = request(socket_path, "GET", "/health")

        self.assertEqual(status, 200)

    def test_never_deletes_a_file_that_is_not_a_socket(self):
        directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        path = f"{directory}/s.sock"
        with open(path, "w") as file:
            file.write("precious")

        with self.assertRaises(FileExistsError):
            serve(path, FakeScorer())

        with open(path) as file:
            self.assertEqual(file.read(), "precious")

    def test_never_takes_over_a_socket_another_daemon_is_serving(self):
        with running_daemon(FakeScorer()) as socket_path:
            with self.assertRaises(FileExistsError):
                serve(socket_path, FakeScorer())

            status, _ = request(socket_path, "GET", "/health")

        self.assertEqual(status, 200)


class FailureTest(unittest.TestCase):
    def test_a_scoring_error_is_a_500_that_leaks_no_prompt_and_leaves_the_daemon_serving(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), running_daemon(ExplodingScorer()) as socket_path:
            status, body = request(socket_path, "POST", "/decide", {"prompt": "the password is hunter2"})
            health_status, _ = request(socket_path, "GET", "/health")

        self.assertEqual(status, 500)
        self.assertNotIn("hunter2", json.dumps(body))
        self.assertNotIn("hunter2", stderr.getvalue())
        self.assertEqual(health_status, 200)


class RoutingTest(unittest.TestCase):
    def test_answers_every_misrouted_request_with_a_json_error(self):
        cases = [
            ("GET", "/nope", 404),
            ("POST", "/nope", 404),
            ("GET", "/decide", 405),
            ("POST", "/health", 405),
            ("PUT", "/decide", 405),
            ("DELETE", "/health", 405),
            ("PUT", "/nope", 404),
        ]
        with running_daemon(FakeScorer()) as socket_path:
            for method, target, expected in cases:
                with self.subTest(method=method, target=target):
                    status, body = request(socket_path, method, target)

                    self.assertEqual(status, expected)
                    self.assertIsInstance(body["error"], str)

    def test_answers_an_unparseable_request_with_a_json_error(self):
        with running_daemon(FakeScorer()) as socket_path:
            status, body = raw_exchange(socket_path, b"GARBAGE\r\n\r\n")

        self.assertEqual(status, 400)
        self.assertIsInstance(body["error"], str)


class ConcurrencyTest(unittest.TestCase):
    def test_scores_one_request_at_a_time(self):
        scorer = OverlapProbeScorer()
        statuses = []

        with running_daemon(scorer) as socket_path:

            def ask():
                statuses.append(request(socket_path, "POST", "/decide", {"prompt": "x"})[0])

            threads = [threading.Thread(target=ask) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(statuses, [200] * 4)
        self.assertEqual(scorer.max_active, 1)


class WhatTheModelSeesTest(unittest.TestCase):
    def test_gets_the_first_400_characters_of_a_long_prompt(self):
        scorer = FakeScorer()
        with running_daemon(scorer) as socket_path:
            request(socket_path, "POST", "/decide", {"prompt": "a" * 400 + "b" * 600})

        self.assertEqual(scorer.calls, [("a" * 400, None)])

    def test_gets_a_short_prompt_and_the_context_size_unchanged(self):
        scorer = FakeScorer()
        with running_daemon(scorer) as socket_path:
            request(socket_path, "POST", "/decide", {"prompt": "rename foo to bar", "contextTokens": 28000})

        self.assertEqual(scorer.calls, [("rename foo to bar", 28000)])


class BodyLimitTest(unittest.TestCase):
    LIMIT = 16 * 1024

    def head(self, content_length):
        return (
            f"POST /decide HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
            f"Content-Length: {content_length}\r\n\r\n"
        ).encode()

    def test_refuses_a_body_over_the_limit_without_reading_it(self):
        scorer = FakeScorer()
        with running_daemon(scorer) as socket_path:
            # Only the headers are sent: a server that tried to read the body would hang.
            for length in (self.LIMIT + 1, 10**9):
                with self.subTest(length=length):
                    status, body = raw_exchange(socket_path, self.head(length))

                    self.assertEqual(status, 413)
                    self.assertIsInstance(body["error"], str)
        self.assertEqual(scorer.calls, [])

    def test_refuses_a_negative_content_length(self):
        with running_daemon(FakeScorer()) as socket_path:
            status, _ = raw_exchange(socket_path, self.head(-1))

        self.assertEqual(status, 400)

    def test_accepts_a_body_exactly_at_the_limit(self):
        padding = self.LIMIT - len(json.dumps({"prompt": ""}))
        with running_daemon(FakeScorer()) as socket_path:
            status, _ = request(socket_path, "POST", "/decide", {"prompt": "a" * padding})

        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
