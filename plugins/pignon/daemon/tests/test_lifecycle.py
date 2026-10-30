"""The daemon as a process: started, signalled and orphaned for real."""

import os
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
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
        process = self.start()

        status, body = request(self.socket_path, "GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "ready": True, "pid": process.pid})


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


class SharedDaemonTest(unittest.TestCase):
    """`--shared`: a daemon that detaches, serves every caller, and leaves when idle."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.socket_path = f"{self.directory}/s.sock"
        self.pids = []
        self.addCleanup(self.stop_all)

    def stop_all(self):
        for pid in self.pids:
            if is_alive(pid):
                os.kill(pid, signal.SIGKILL)

    def launch(self, *extra, scorer="FakeScorer"):
        """Runs the launcher as the engine's `process.run` does: no shell, all output read."""
        started = time.monotonic()
        done = subprocess.run(
            [sys.executable, "-c", launch_code(scorer), "--socket", self.socket_path, "--model", "unused", "--shared", *extra],
            cwd=DAEMON_DIR,
            capture_output=True,
            text=True,
            timeout=30,
        )
        done.seconds = time.monotonic() - started
        words = done.stdout.split()
        if words[:1] == ["ready"]:
            self.pids.append(int(words[1]))
        return done

    def test_the_launcher_returns_once_the_model_is_ready_and_the_daemon_stays(self):
        done = self.launch()

        self.assertEqual(done.returncode, 0)
        self.assertRegex(done.stdout, r"^ready \d+\n$")
        pid = int(done.stdout.split()[1])
        status, body = request(self.socket_path, "GET", "/health")
        self.assertEqual((status, body["pid"]), (200, pid))
        # Detached: adopted by launchd, in a session of its own.
        self.assertEqual(subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip(), "1")

    def test_a_second_launch_finds_the_daemon_and_loads_nothing(self):
        first = self.launch()

        second = self.launch()

        self.assertEqual((second.returncode, second.stdout), (0, "running\n"))
        _, body = request(self.socket_path, "GET", "/health")
        self.assertEqual(body["pid"], int(first.stdout.split()[1]))

    def test_launches_at_the_same_moment_start_exactly_one_daemon(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.launch())) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        outputs = sorted(done.stdout.split()[0] for done in results)
        self.assertEqual(outputs, ["ready", "running", "running", "running"])
        self.assertTrue(all(done.returncode == 0 for done in results))

    def test_leaves_after_the_idle_time_and_removes_its_socket(self):
        pid = int(self.launch("--idle-seconds", "1").stdout.split()[1])

        self.assertTrue(wait_for(lambda: not is_alive(pid), seconds=6), "the daemon never left")
        self.assertFalse(os.path.exists(self.socket_path))

    def test_a_request_keeps_it_from_leaving(self):
        pid = int(self.launch("--idle-seconds", "2").stdout.split()[1])

        for _ in range(7):  # 3.5 s of traffic, longer than the idle time
            time.sleep(0.5)
            request(self.socket_path, "GET", "/health")

        self.assertTrue(is_alive(pid))
        self.assertTrue(wait_for(lambda: not is_alive(pid), seconds=6), "the daemon never left")

    def test_the_next_launch_after_it_left_starts_a_new_daemon(self):
        old = int(self.launch("--idle-seconds", "1").stdout.split()[1])
        self.assertTrue(wait_for(lambda: not is_alive(old), seconds=6))

        new = self.launch()

        self.assertRegex(new.stdout, r"^ready \d+\n$")
        self.assertNotEqual(int(new.stdout.split()[1]), old)

    def test_a_failed_load_says_so_and_frees_the_lock(self):
        failed = self.launch(scorer="FailingScorer")

        self.assertEqual((failed.returncode, failed.stdout), (1, "failed: RuntimeError\n"))
        self.assertRegex(self.launch().stdout, r"^ready \d+\n$")

    def test_refuses_a_directory_other_users_can_enter(self):
        os.chmod(self.directory, 0o755)

        done = self.launch()

        self.assertEqual(done.returncode, 1)
        self.assertRegex(done.stdout, r"^failed: .*must not be accessible")
        self.assertFalse(os.path.exists(f"{self.directory}/lock"))

    def test_creates_its_directory_private_when_it_does_not_exist(self):
        self.directory = f"{self.directory}/run"
        self.socket_path = f"{self.directory}/s.sock"

        done = self.launch()

        self.assertEqual(done.returncode, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.directory).st_mode), 0o700)

    def test_its_log_and_lock_are_private_and_the_log_never_holds_a_prompt(self):
        self.launch(scorer="ExplodingScorer")
        request(self.socket_path, "POST", "/decide", {"prompt": "my secret plan"})

        for name in ("daemon.log", "lock"):
            self.assertEqual(stat.S_IMODE(os.stat(f"{self.directory}/{name}").st_mode), 0o600)
        with open(f"{self.directory}/daemon.log") as log:
            self.assertNotIn("secret", log.read())

    def test_sigterm_exits_cleanly_and_removes_the_socket(self):
        pid = int(self.launch().stdout.split()[1])

        os.kill(pid, signal.SIGTERM)

        self.assertTrue(wait_for(lambda: not is_alive(pid), seconds=5))
        self.assertFalse(os.path.exists(self.socket_path))


if __name__ == "__main__":
    unittest.main()
