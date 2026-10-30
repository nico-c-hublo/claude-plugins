"""The daemon as a process: started, signalled and orphaned for real."""

import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.support import reap, request

DAEMON_DIR = Path(__file__).resolve().parent.parent

def launch_code(scorer):
    """Python source that runs the real `main`, with the named test scorer in place of MLX."""
    return (
        f"import sys; from pignon_decider.cli import main; from tests.support import {scorer}; "
        f"sys.exit(main(sys.argv[1:], load_scorer=lambda model: {scorer}()))"
    )


LAUNCH = launch_code("FakeScorer")


# Starts the daemon as its child, prints the child's pid, then idles until killed.
LAUNCHER = (
    "import subprocess, sys, time; "
    "child = subprocess.Popen([sys.executable, '-c', sys.argv[1], '--socket', sys.argv[2], '--model', 'unused']); "
    "print(child.pid, flush=True); time.sleep(600)"
)


def is_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_for(condition, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.socket_path = f"{self.directory}/s.sock"

    def start(self, scorer="FakeScorer", env=None):
        process = subprocess.Popen(
            [sys.executable, "-c", launch_code(scorer), "--socket", self.socket_path, "--model", "unused"],
            cwd=DAEMON_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(reap, process)
        ready, _, _ = select.select([process.stdout], [], [], 10)
        self.assertTrue(ready, "the daemon never announced it was ready")
        # The pid is how the mod inspects the daemon's sockets.
        self.assertEqual(process.stdout.readline().strip(), f"ready {process.pid}")
        return process

    def test_announces_ready_and_then_serves(self):
        self.start()

        status, body = request(self.socket_path, "GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "ready": True})


    def test_goes_offline_and_drops_tokens_and_proxies_before_loading_the_model(self):
        env = {
            **os.environ,
            "HF_TOKEN": "hf_canary",
            "HUGGING_FACE_HUB_TOKEN": "hf_canary",
            "HF_ENDPOINT": "https://mirror.example",
            "HTTP_PROXY": "http://proxy.example:3128",
            "HTTPS_PROXY": "http://proxy.example:3128",
            "ALL_PROXY": "http://proxy.example:3128",
            "http_proxy": "http://proxy.example:3128",
            "https_proxy": "http://proxy.example:3128",
            "all_proxy": "http://proxy.example:3128",
        }
        self.start(scorer="EnvReportingScorer", env=env)

        _, body = request(self.socket_path, "POST", "/decide", {"prompt": "x"})

        seen = dict(pair.split("=", 1) for pair in body["model"].split(";"))
        self.assertEqual(seen.pop("HF_HUB_OFFLINE"), "1")
        self.assertEqual(seen, {name: "None" for name in seen})

    def test_sigterm_exits_cleanly_and_removes_the_socket(self):
        process = self.start()
        self.assertTrue(os.path.exists(self.socket_path))

        process.send_signal(signal.SIGTERM)

        self.assertEqual(process.wait(timeout=5), 0)
        self.assertFalse(os.path.exists(self.socket_path))
        # The directory was made for this daemon alone; leaving it would pile up in $TMPDIR.
        self.assertFalse(os.path.exists(self.directory))

    def test_exits_when_its_parent_dies(self):
        launcher = subprocess.Popen(
            [sys.executable, "-c", LAUNCHER, LAUNCH, self.socket_path],
            cwd=DAEMON_DIR,
            stdout=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(reap, launcher)
        daemon_pid = int(launcher.stdout.readline())
        self.addCleanup(lambda: is_alive(daemon_pid) and os.kill(daemon_pid, signal.SIGKILL))
        self.assertTrue(wait_for(lambda: os.path.exists(self.socket_path)), "the daemon never bound its socket")

        launcher.kill()  # SIGKILL: no chance to stop its child
        launcher.wait()

        self.assertTrue(wait_for(lambda: not is_alive(daemon_pid), seconds=6), "the daemon outlived its parent")
        self.assertFalse(os.path.exists(self.socket_path))
        self.assertFalse(os.path.exists(self.directory))


if __name__ == "__main__":
    unittest.main()
