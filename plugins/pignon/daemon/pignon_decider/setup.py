"""Downloads the pinned checkpoint. The one step that uses the network, and it carries no prompt.

Standard library only, so it runs on any Python before the environment exists.
"""

import argparse
import contextlib
import hashlib
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from .checkpoint import REPO, REVISION, SHA256

CHUNK_BYTES = 1024 * 1024


class ChecksumError(ValueError):
    """A downloaded file does not match its pinned SHA-256."""


class DownloadError(OSError):
    """A file could not be fetched: missing, refused or unreachable."""


def fetch_checkpoint(dest, base_url, pins):
    """Writes each file of `pins` ({relative path: sha256}) from `base_url` into `dest`."""
    for relpath, expected in pins.items():
        target = Path(dest) / relpath
        if target.is_file() and _sha256(target) == expected:
            continue
        _download(f"{base_url}/{relpath}", target, relpath, expected)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        while chunk := file.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url, target, relpath, expected):
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    # Beside the target so the final rename stays on one filesystem and is atomic.
    descriptor, partial = tempfile.mkstemp(dir=target.parent, prefix=".part-")
    try:
        try:
            with os.fdopen(descriptor, "wb") as file, urllib.request.urlopen(url) as response:
                while chunk := response.read(CHUNK_BYTES):
                    digest.update(chunk)
                    file.write(chunk)
        except urllib.error.URLError as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()  # it still holds the open response
            raise DownloadError(f"cannot download {relpath}: {error}") from error
        if digest.hexdigest() != expected:
            raise ChecksumError(f"{relpath}: expected sha256 {expected}, got {digest.hexdigest()}")
        os.replace(partial, target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(partial)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pignon_decider.setup", description="Download the pinned conductor checkpoint.")
    parser.add_argument("--dest", required=True, help="directory to write the checkpoint into")
    args = parser.parse_args(argv)

    print(f"fetching {REPO} at {REVISION[:8]} into {args.dest} (about 850 MB the first time)", file=sys.stderr)
    try:
        fetch_checkpoint(args.dest, f"https://huggingface.co/{REPO}/resolve/{REVISION}", SHA256)
    except (ChecksumError, DownloadError) as error:
        print(f"setup failed: {error}", file=sys.stderr)
        return 1
    print(f"ready: {len(SHA256)} files verified in {args.dest}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
