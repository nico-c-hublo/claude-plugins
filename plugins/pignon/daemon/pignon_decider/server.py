"""HTTP over a Unix socket: the only way a prompt reaches the model."""

import contextlib
import http.server
import json
import os
import socket
import socketserver
import stat
import sys
import threading
import time

ROUTES = ("/health", "/decide")

MAX_BODY_BYTES = 16 * 1024

# macOS allows 104 bytes in a socket path, the terminating NUL included.
MAX_SOCKET_PATH_BYTES = 103

# What the conductor's model card says a request may hold. Head only: whether the
# tail carries more signal is untested, so shadow mode decides.
MAX_PROMPT_CHARS = 400

# The conductor's labels, as pignon's tiers (see hooks/policy.ts).
TIER_OF = {"smol": "trivial", "default": "standard", "slow": "hard"}


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path, scorer):
        self.scorer = scorer
        # When a request last arrived, for a daemon that exits once nobody uses it.
        self.last_activity = time.monotonic()
        # One forward pass at a time: the model is not safe to call concurrently.
        self.scoring = threading.Lock()
        super().__init__(socket_path, _Handler)

    def server_close(self):
        super().server_close()
        # Closing a Unix socket leaves its file behind.
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.server_address)
        # The caller made the directory for this daemon alone. `rmdir` only takes an
        # empty one, so a directory that holds anything else stays.
        with contextlib.suppress(OSError):
            os.rmdir(os.path.dirname(self.server_address))


class _Handler(http.server.BaseHTTPRequestHandler):
    # A client that stalls mid-request frees its thread after this long.
    timeout = 5

    def do_GET(self):
        self.server.last_activity = time.monotonic()
        if self.path != "/health":
            self._refuse()
            return
        # The pid is how a client inspects the sockets of the process it reached.
        self._send(200, {"status": "ok", "ready": self.server.scorer.ready, "pid": os.getpid()})

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = lambda self: self._refuse()

    def do_POST(self):
        self.server.last_activity = time.monotonic()
        if self.path != "/decide":
            self._refuse()
            return
        parsed = self._parse_decide_request()
        if parsed is None:
            return
        prompt, context_tokens = parsed
        started = time.perf_counter()
        try:
            with self.server.scoring:
                probabilities = self.server.scorer.score(prompt, context_tokens)
            tiers = {TIER_OF[label]: p for label, p in probabilities.items()}
        except Exception as error:
            # The class only: a tokenizer's message may quote the prompt.
            sys.stderr.write(f"pignon-decider: scoring failed: {type(error).__name__}\n")
            self._send(500, {"error": "scoring failed"})
            return
        self._send(
            200,
            {
                "tiers": tiers,
                "tier": max(tiers, key=tiers.get),
                "model": self.server.scorer.model_name,
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
            },
        )

    def _refuse(self):
        """A 405 for a path that exists under another method, else a 404."""
        self._send(405 if self.path in ROUTES else 404, {"error": "not allowed" if self.path in ROUTES else "not found"})

    def send_error(self, code, message=None, explain=None):
        # The parser's own refusals (bad request line, oversized headers) come here;
        # an HTML page would be a surprise to a client that only speaks JSON.
        self.close_connection = True
        self._send(code, {"error": message or http.HTTPStatus(code).phrase})

    def _parse_decide_request(self):
        """The (prompt, contextTokens) of a valid request, else None after a 400."""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if length < 0:
            self._send(400, {"error": "a valid Content-Length is required"})
            return None
        if length > MAX_BODY_BYTES:
            # Answered before reading: the body is never taken off the socket.
            self.close_connection = True
            self._send(413, {"error": f"the body is over {MAX_BODY_BYTES} bytes"})
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            self._send(400, {"error": "the body must be JSON"})
            return None
        if not isinstance(body, dict) or not isinstance(body.get("prompt"), str):
            self._send(400, {"error": "prompt must be a string"})
            return None
        tokens = body.get("contextTokens")
        if tokens is not None and (isinstance(tokens, bool) or not isinstance(tokens, int)):
            self._send(400, {"error": "contextTokens must be an integer"})
            return None
        return body["prompt"][:MAX_PROMPT_CHARS], tokens

    def _send(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        # The default logs the client address, which a Unix socket does not have;
        # and a log line must never carry a prompt.
        pass


def _clear_stale_socket(path):
    """Removes the socket a crashed daemon left; refuses anything else at `path`."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise FileExistsError(f"{path} exists and is not a socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(path)
        except (ConnectionRefusedError, FileNotFoundError):
            os.unlink(path)
        else:
            raise FileExistsError(f"another daemon is serving on {path}")


def serve(socket_path, scorer):
    """Binds `socket_path` and returns the server; the caller runs `serve_forever`."""
    if len(os.fsencode(socket_path)) > MAX_SOCKET_PATH_BYTES:
        raise ValueError(f"{socket_path} is longer than the {MAX_SOCKET_PATH_BYTES} bytes a socket path may have")
    directory = os.path.dirname(socket_path)
    if stat.S_IMODE(os.stat(directory).st_mode) & 0o077:
        raise PermissionError(f"{directory} must not be accessible to group or others")
    _clear_stale_socket(socket_path)
    # The umask makes the socket owner-only from the moment it exists; a chmod
    # after bind would leave a window. Called before any thread is started.
    previous = os.umask(0o177)
    try:
        return _Server(socket_path, scorer)
    finally:
        os.umask(previous)
