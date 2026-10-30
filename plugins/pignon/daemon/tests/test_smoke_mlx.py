"""The real conductor on MLX. Opt-in: needs the venv and the pinned checkpoint.

    PIGNON_SMOKE_PYTHON=/path/to/venv/bin/python PIGNON_SMOKE_MODEL=/path/to/checkpoint \
        python3 -m unittest tests.test_smoke_mlx
"""

import os
import select
import shutil
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.support import reap, request

PYTHON = os.environ.get("PIGNON_SMOKE_PYTHON")
MODEL = os.environ.get("PIGNON_SMOKE_MODEL")
DAEMON_DIR = Path(__file__).resolve().parent.parent

# Top probability of the expected tier for each prompt, measured with an independent
# harness (a script calling laya-mlx directly, 2026-10-30), not recomputed here.
PROBED = [
    ("rename the variable foo to bar in utils.ts", "trivial", 0.83),
    ("write a unit test for the parseDate function", "standard", 0.65),
    ("the nightly job intermittently deadlocks in production and we have no idea why; find the root cause", "hard", 0.81),
]


@unittest.skipUnless(PYTHON and MODEL, "set PIGNON_SMOKE_PYTHON and PIGNON_SMOKE_MODEL to run")
class RealModelTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="pd", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.socket_path = f"{self.directory}/s.sock"

    def spawn(self, model):
        # A token and a proxy in the environment, which the daemon must ignore.
        env = {**os.environ, "HF_TOKEN": "hf_canary", "HTTPS_PROXY": "http://127.0.0.1:9"}
        process = subprocess.Popen(
            [PYTHON, "-m", "pignon_decider", "--socket", self.socket_path, "--model", model],
            cwd=DAEMON_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(reap, process)
        return process

    def test_routes_clear_prompts_as_the_probe_did_and_holds_no_network_socket(self):
        process = self.spawn(MODEL)
        ready, _, _ = select.select([process.stdout], [], [], 120)
        self.assertTrue(ready, "the daemon never announced it was ready")
        self.assertEqual(process.stdout.readline().strip(), f"ready {process.pid}", process.stderr.read() if process.poll() else "")

        for prompt, tier, probed in PROBED:
            with self.subTest(prompt=prompt):
                status, body = request(self.socket_path, "POST", "/decide", {"prompt": prompt, "contextTokens": 28000})

                self.assertEqual(status, 200)
                self.assertEqual(body["tier"], tier)
                self.assertAlmostEqual(body["tiers"][tier], probed, delta=0.02)
                self.assertAlmostEqual(sum(body["tiers"].values()), 1.0, delta=0.01)
                self.assertLess(body["latencyMs"], 200)

        # `-i` lists Internet sockets only; the daemon's Unix socket is not one of them.
        sockets = subprocess.run(
            ["/usr/sbin/lsof", "-a", "-p", str(process.pid), "-i", "-n", "-P"], capture_output=True, text=True
        )
        self.assertEqual(sockets.stdout, "")

        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)

    def test_refuses_a_checkpoint_that_does_not_match_the_pinned_hashes(self):
        tampered = Path(self.directory) / "checkpoint"
        shutil.copytree(MODEL, tampered, symlinks=False, ignore=shutil.ignore_patterns("model.safetensors"))
        (tampered / "model.safetensors").symlink_to(Path(MODEL) / "model.safetensors")
        config = tampered / "rl_agent_config.json"
        config.write_text(config.read_text().replace('"cost_wrong_act": 3.0', '"cost_wrong_act": 0.0'))

        process = self.spawn(str(tampered))
        stdout, stderr = process.communicate(timeout=120)

        self.assertNotEqual(process.returncode, 0)
        self.assertNotIn("ready", stdout)
        self.assertFalse(os.path.exists(self.socket_path))
        self.assertIn("sha256", stderr.lower())


if __name__ == "__main__":
    unittest.main()
