"""`fetch_checkpoint` against a real local HTTP server serving small fixture files."""

import hashlib
import http.server
import shutil
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path

from pignon_decider.setup import ChecksumError, DownloadError, fetch_checkpoint

FILES = {
    "model.safetensors": b"weights" * 1000,
    "rl_agent_config.json": b'{"fine_tuned": true}',
    "encoder/config.json": b'{"hidden_size": 1024}',
}
PINS = {name: hashlib.sha256(content).hexdigest() for name, content in FILES.items()}
PREFIX = "/org/model/resolve/abc123"


@contextmanager
def file_server(files, prefix=PREFIX):
    """Serves `files` under `prefix`; yields (base_url, the paths requested so far)."""
    served = {f"{prefix}/{name}": content for name, content in files.items()}
    requested = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requested.append(self.path)
            body = served.get(self.path)
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}{prefix}", requested
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class FetchCheckpointTest(unittest.TestCase):
    def setUp(self):
        self.dest = Path(tempfile.mkdtemp(prefix="pds", dir="/tmp")) / "model"
        self.addCleanup(shutil.rmtree, self.dest.parent, ignore_errors=True)

    def test_downloads_every_pinned_file_to_its_relative_path(self):
        with file_server(FILES) as (base_url, _):
            fetch_checkpoint(self.dest, base_url, PINS)

        for name, content in FILES.items():
            self.assertEqual((self.dest / name).read_bytes(), content)


    def test_refuses_a_download_that_does_not_match_its_pin_and_leaves_nothing_behind(self):
        tampered = {**FILES, "model.safetensors": b"other weights"}

        with file_server(tampered) as (base_url, _):
            with self.assertRaises(ChecksumError) as raised:
                fetch_checkpoint(self.dest, base_url, PINS)

        self.assertIn("model.safetensors", str(raised.exception))
        self.assertEqual([path for path in self.dest.rglob("*") if path.is_file()], [])


    def test_a_second_run_fetches_only_what_is_missing_or_damaged(self):
        with file_server(FILES) as (base_url, _):
            fetch_checkpoint(self.dest, base_url, PINS)
        (self.dest / "rl_agent_config.json").write_bytes(b"damaged")
        (self.dest / "encoder" / "config.json").unlink()

        with file_server(FILES) as (base_url, requested):
            fetch_checkpoint(self.dest, base_url, PINS)

        self.assertEqual(sorted(requested), [f"{PREFIX}/encoder/config.json", f"{PREFIX}/rl_agent_config.json"])
        for name, content in FILES.items():
            self.assertEqual((self.dest / name).read_bytes(), content)


    def test_a_missing_file_or_an_unreachable_server_is_a_clear_error_that_writes_nothing(self):
        with file_server({}) as (base_url, _):
            with self.assertRaises(DownloadError) as missing:
                fetch_checkpoint(self.dest, base_url, PINS)
        with self.assertRaises(DownloadError) as unreachable:  # the server is closed by now
            fetch_checkpoint(self.dest, base_url, PINS)

        self.assertIn("model.safetensors", str(missing.exception))
        self.assertIn("404", str(missing.exception))
        self.assertIn("model.safetensors", str(unreachable.exception))
        self.assertEqual([path for path in self.dest.rglob("*") if path.is_file()], [])


if __name__ == "__main__":
    unittest.main()
