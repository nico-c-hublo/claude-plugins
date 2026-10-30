"""Starts the daemon: `python -m pignon_decider --socket PATH --model DIR`."""

import argparse
import os
import signal
import threading

from .server import serve

PARENT_CHECK_SECONDS = 1


def _go_offline():
    """Makes the model libraries unable to reach a network, whatever we inherited.

    The engine can add variables to a child's environment but not remove them, so
    the daemon drops the Hub credentials and any proxy itself, before importing
    anything that reads them.
    """
    for name in list(os.environ):
        if name.upper().endswith("_PROXY") or name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_ENDPOINT"):
            del os.environ[name]
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def main(argv=None, load_scorer=None):
    """Runs until stopped. `load_scorer(model_dir)` is injectable for tests."""
    parser = argparse.ArgumentParser(prog="pignon_decider")
    parser.add_argument("--socket", required=True, help="path of the Unix socket to serve on")
    parser.add_argument("--model", required=True, help="directory of the converted checkpoint")
    args = parser.parse_args(argv)

    _go_offline()
    if load_scorer is None:
        from .mlx_scorer import load_scorer
    scorer = load_scorer(args.model)
    daemon = serve(args.socket, scorer)
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    thread = threading.Thread(target=daemon.serve_forever)
    thread.start()
    print(f"ready {os.getpid()}", flush=True)
    # The engine closes our stdin from the start, so the parent's death shows only
    # as a change of parent pid (we are adopted by launchd).
    parent = os.getppid()
    while not stop.wait(PARENT_CHECK_SECONDS) and os.getppid() == parent:
        pass
    daemon.shutdown()
    thread.join()
    daemon.server_close()
    return 0
