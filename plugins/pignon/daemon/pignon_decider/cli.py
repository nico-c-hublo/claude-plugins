"""Starts the daemon: `python -m pignon_decider --socket PATH --model DIR [--shared]`."""

import argparse
import fcntl
import os
import select
import signal
import stat
import sys
import threading
import time

from .server import serve

PARENT_CHECK_SECONDS = 1

# A shared daemon belongs to no session; it leaves once nobody has asked it anything.
DEFAULT_IDLE_SECONDS = 1800
# Loading the model takes seconds; this is for a launch that is stuck.
STARTUP_SECONDS = 120


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
    # Read first: a parent that dies during the seconds the model takes to load
    # must not leave us waiting on launchd, whose pid we would then take for the parent's.
    parent = os.getppid()
    parser = argparse.ArgumentParser(prog="pignon_decider")
    parser.add_argument("--socket", required=True, help="path of the Unix socket to serve on")
    parser.add_argument("--model", required=True, help="directory of the converted checkpoint")
    parser.add_argument(
        "--shared",
        action="store_true",
        help="detach and serve every session, leaving after --idle-seconds without a request",
    )
    parser.add_argument("--idle-seconds", type=int, default=DEFAULT_IDLE_SECONDS, help="with --shared only")
    args = parser.parse_args(argv)
    if args.idle_seconds < 1:
        parser.error("--idle-seconds must be positive")

    _go_offline()
    if args.shared:
        return _run_shared(args, load_scorer)
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
    while not stop.wait(PARENT_CHECK_SECONDS) and os.getppid() == parent:
        pass
    daemon.shutdown()
    thread.join()
    daemon.server_close()
    return 0


def _run_shared(args, load_scorer):
    """Detaches from the caller, then serves until idle. The caller gets one line.

    The line is `ready PID` once the model answers, `running` when a daemon already
    holds the lock, or `failed: Reason`. The exit status is 0 for the first two.
    """
    directory = os.path.dirname(args.socket)
    try:
        _private_directory(directory)
    except OSError as error:
        print(f"failed: {error}", flush=True)
        return 1

    # Forked before the model is touched: Metal does not survive a fork.
    pipe, is_daemon = _detach()
    if not is_daemon:
        return _await_start(pipe)

    status = _serve_shared(args, load_scorer, directory, pipe)
    os.close(pipe)

    return status


def _private_directory(path):
    """Makes `path` a directory only we can enter, or refuses what is there."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    found = os.lstat(path)
    if not stat.S_ISDIR(found.st_mode):
        raise NotADirectoryError(f"{path} is not a directory")
    if found.st_uid != os.getuid():
        raise PermissionError(f"{path} belongs to someone else")
    if stat.S_IMODE(found.st_mode) & 0o077:
        raise PermissionError(f"{path} must not be accessible to group or others")


def _detach():
    """Double-forks into a session of its own.

    Returns (pipe, False) in the caller, which reads the daemon's status from
    `pipe`, and (pipe, True) in the daemon, which writes to it.
    """
    reader, writer = os.pipe()
    first = os.fork()
    if first != 0:
        os.close(writer)
        os.waitpid(first, 0)
        return reader, False

    os.close(reader)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    null = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(null, descriptor)
    os.close(null)

    return writer, True


def _await_start(pipe):
    """Relays the daemon's first line to our own stdout; the exit status says whether it serves."""
    try:
        ready, _, _ = select.select([pipe], [], [], STARTUP_SECONDS)
        line = os.read(pipe, 256).decode(errors="replace").strip() if ready else ""
    finally:
        os.close(pipe)
    print(line or "failed: no answer", flush=True)

    return 0 if line.startswith(("ready", "running")) else 1


def _serve_shared(args, load_scorer, directory, pipe):
    # One daemon per socket directory, whoever launched it: the lock is held for
    # the life of the process, so a second launch loads nothing.
    lock = os.open(f"{directory}/lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.write(pipe, b"running\n")
        return 0

    # The log never holds a prompt: the handler writes class names only.
    log = os.open(f"{directory}/daemon.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.dup2(log, 2)
    os.close(log)
    try:
        if load_scorer is None:
            from .mlx_scorer import load_scorer
        daemon = serve(args.socket, load_scorer(args.model))
    except Exception as error:
        sys.stderr.write(f"pignon-decider: could not start: {type(error).__name__}\n")
        sys.stderr.flush()
        os.write(pipe, f"failed: {type(error).__name__}\n".encode())
        return 1

    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    thread = threading.Thread(target=daemon.serve_forever)
    thread.start()
    os.write(pipe, f"ready {os.getpid()}\n".encode())
    while not stop.wait(PARENT_CHECK_SECONDS):
        if time.monotonic() - daemon.last_activity > args.idle_seconds:
            break
    daemon.shutdown()
    thread.join()
    daemon.server_close()

    return 0
