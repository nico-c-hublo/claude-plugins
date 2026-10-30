"""Test helpers: a real daemon on a real Unix socket, spoken to over real HTTP."""

import http.client
import json
import os
import shutil
import socket
import tempfile
import threading
import time
from contextlib import contextmanager

from pignon_decider.server import serve


class FakeScorer:
    """Stands in for the model: fixed probabilities, no MLX."""

    ready = True
    model_name = "fake"

    def __init__(self, probabilities=None):
        self.probabilities = probabilities or {"smol": 0.2, "default": 0.6, "slow": 0.2}
        self.calls = []

    def score(self, text, context_tokens):
        self.calls.append((text, context_tokens))
        return self.probabilities


class ExplodingScorer(FakeScorer):
    """Fails the way a tokenizer does: with an error message that quotes its input."""

    def score(self, text, context_tokens):
        raise RuntimeError(f"cannot tokenize {text!r}")


class SlowLoadScorer(FakeScorer):
    """A model that takes a while to load, as the real one does; says when it starts."""

    def __init__(self):
        super().__init__()
        with open(os.environ["PIGNON_TEST_LOADING"], "w"):
            pass
        time.sleep(1.5)


class FailingScorer:
    """A model that cannot be loaded."""

    def __init__(self):
        raise RuntimeError("no model")


WATCHED_ENV = (
    "HF_HUB_OFFLINE",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HF_ENDPOINT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


class EnvReportingScorer(FakeScorer):
    """Reports, as its model name, the network-relevant environment it runs in."""

    @property
    def model_name(self):
        return ";".join(f"{name}={os.environ.get(name)}" for name in WATCHED_ENV)


class OverlapProbeScorer(FakeScorer):
    """Records how many `score` calls were running at once."""

    def __init__(self):
        super().__init__()
        self._guard = threading.Lock()
        self.active = 0
        self.max_active = 0

    def score(self, text, context_tokens):
        with self._guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.05)
        with self._guard:
            self.active -= 1
        return self.probabilities


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=5)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect(self._path)


def reap(process):
    """Cleanup for a subprocess a test started: stop it if running, close its pipes."""
    if process.poll() is None:
        process.kill()
    process.wait()
    for pipe in (process.stdout, process.stderr):
        if pipe:
            pipe.close()


@contextmanager
def running_daemon(scorer, prepare=None):
    """Yields the socket path of a daemon serving `scorer`.

    `prepare(path)` runs first, to leave something at the socket path.
    """
    # /tmp keeps the path under the ~104 bytes a macOS socket path allows.
    directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
    path = f"{directory}/s.sock"
    daemon = thread = None
    try:
        if prepare:
            prepare(path)
        daemon = serve(path, scorer)
        thread = threading.Thread(target=lambda: daemon.serve_forever(poll_interval=0.05), daemon=True)
        thread.start()
        yield path
    finally:
        if daemon:
            daemon.shutdown()
            daemon.server_close()
        if thread:
            thread.join(timeout=5)
        shutil.rmtree(directory, ignore_errors=True)


def raw_exchange(path, data):
    """Sends `data` as it is and returns (status, parsed JSON body) of the answer.

    For requests `http.client` would refuse to build, such as a Content-Length
    that promises a body which never comes.
    """
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(path)
        sock.sendall(data)
        response = http.client.HTTPResponse(sock)
        response.begin()
        return response.status, json.loads(response.read() or "null")


def request(path, method, target, body=None, raw=None):
    """One request over the socket; returns (status, parsed JSON body).

    `raw` sends bytes as they are, for bodies that are not valid JSON.
    """
    connection = _UnixConnection(path)
    try:
        payload = raw if raw is not None else None if body is None else json.dumps(body).encode()
        headers = {} if payload is None else {"Content-Type": "application/json"}
        connection.request(method, target, body=payload, headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read() or "null")
    finally:
        connection.close()
