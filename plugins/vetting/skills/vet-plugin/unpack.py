"""Unpack an untrusted zip (wheel, .vsix) or tarball into an empty dir, or refuse it whole.

Usage: python3 -I unpack.py [--expect zip|tar] [--max-bytes N] <archive> <empty dest dir>

Every entry is checked before anything is written. The archive is refused (exit 1, nothing
written) if it is both a zip and a tar (a polyglot each tool reads differently), is not the
--expect format, or if any entry:
- is absolute (`/x`, `\\x`, `C:x`), has a `..` component (split on `/` and `\\`), is empty
  or has a NUL in its name;
- is anything but a plain file or directory: symlink, hardlink, device, FIFO;
- repeats another entry's name, or is a file whose name is a directory of another entry.
Each such entry is printed as a finding. It is also refused if the files add up to more than
--max-bytes (default 1 GiB), counted as they are written rather than from the declared sizes,
against zip and gzip bombs. Otherwise only plain files and directories are created,
without following links, in a private dir next to dest that is moved into dest once every entry
is written: a failure part-way leaves dest empty.
Exit codes: 0 unpacked, 1 refused, 2 usage error or not a zip/tar, 3 unexpected error.
"""
import argparse
import collections
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile

USAGE = "python3 -I unpack.py [--expect zip|tar] [--max-bytes N] <archive> <empty dest dir>"
MAX_BYTES = 1 << 30

# kind is "file", "dir" or a refusal reason; open() returns a readable stream of the content.
Entry = collections.namedtuple("Entry", "name kind open mode")


class Refused(Exception):
    pass


def show(name):
    # The name is the target's text: escape control characters so it can't forge output.
    return name.encode("unicode_escape", "backslashreplace").decode("ascii")


def check_parts(name):
    # For the safety check, `\` is a separator too, so `..\` is caught whatever reads it later.
    return name.replace("\\", "/").split("/")


def write_parts(name):
    # What is written: `/` is the only separator, so the tree on disk matches the archive's.
    return [p for p in name.split("/") if p not in ("", ".")]


def path_problem(name):
    if "\0" in name:
        return "NUL in name"
    if name[:1] in ("/", "\\") or re.match(r"[A-Za-z]:", name):
        return "absolute path"
    if not name.strip("/\\"):
        return "empty name"
    if ".." in check_parts(name):
        return "'..' in path"
    return None


def zip_entries(z):
    for zi in z.infolist():
        mode = zi.external_attr >> 16
        fmt = stat.S_IFMT(mode)
        if fmt == stat.S_IFLNK:
            kind = "symlink"
        elif fmt not in (0, stat.S_IFREG, stat.S_IFDIR):
            kind = "special file (mode %o)" % mode
        else:
            kind = "dir" if zi.is_dir() or fmt == stat.S_IFDIR else "file"
        yield Entry(zi.filename, kind, lambda zi=zi: z.open(zi), stat.S_IMODE(mode))


def tar_entries(tf):
    for ti in tf.getmembers():
        if ti.issym():
            kind = "symlink"
        elif ti.islnk():
            kind = "hardlink"
        elif ti.ischr() or ti.isblk():
            kind = "device"
        elif ti.isfifo():
            kind = "FIFO"
        elif ti.isdir():
            kind = "dir"
        elif ti.isfile():
            kind = "file"
        else:
            kind = "unknown entry type %r" % ti.type
        yield Entry(ti.name, kind, lambda ti=ti: tf.extractfile(ti), ti.mode)


def open_archive(path, expect):
    # A zip reader finds the directory at the end and a tar reader starts at the front, so a
    # file can be both and unpack differently depending on the tool: refuse it.
    is_zip, is_tar = zipfile.is_zipfile(path), tarfile.is_tarfile(path)
    if is_zip and is_tar:
        raise Refused("both a zip and a tar archive: " + show(path))
    if expect and not {"zip": is_zip, "tar": is_tar}[expect]:
        raise Refused("not a %s archive (--expect %s): %s" % (expect, expect, show(path)))
    if is_zip:
        z = zipfile.ZipFile(path)
        return z, zip_entries(z)
    if is_tar:
        tf = tarfile.open(path, "r:*")
        return tf, tar_entries(tf)
    return None, None


def findings(entries):
    """(entry index, finding) for each problem."""
    seen, files, dirs = set(), {}, set()
    for i, e in enumerate(entries):
        problem = path_problem(e.name)
        if problem:
            yield i, "%s: %s" % (problem, show(e.name))
        if e.kind not in ("file", "dir"):
            yield i, "%s: %s" % (e.kind, show(e.name))
        parts = tuple(write_parts(e.name))
        if parts in seen:
            yield i, "duplicate name: " + show(e.name)
        seen.add(parts)
        dirs.update(parts[:n] for n in range(1, len(parts)))
        if e.kind == "dir":
            dirs.add(parts)
        else:
            files[parts] = i
    for parts in sorted(dirs & files.keys()):
        yield files[parts], "both a file and dir: " + show("/".join(parts))


class Budget:
    def __init__(self, max_bytes):
        self.max, self.left = max_bytes, max_bytes

    def take(self, n):
        self.left -= n
        if self.left < 0:
            raise Refused("more than %d bytes uncompressed" % self.max)


def write(root, entry, budget):
    """Create entry under root, never following a link that is already there."""
    rel = write_parts(entry.name)
    if not rel:
        return
    *parents, leaf = rel
    if entry.kind == "dir":
        parents, leaf = rel, None
    path = root
    for p in parents:
        path = os.path.join(path, p)
        try:
            os.mkdir(path, 0o755)
        except FileExistsError:
            st = os.lstat(path)
            if not stat.S_ISDIR(st.st_mode):
                raise OSError("not a dir, refusing to write through it: " + show(entry.name))
    if leaf is None:
        return
    perm = 0o755 if entry.mode & 0o111 else 0o644
    fd = os.open(os.path.join(path, leaf), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, perm)
    with os.fdopen(fd, "wb") as out, entry.open() as src:
        while chunk := src.read(1 << 20):
            budget.take(len(chunk))
            out.write(chunk)


def unpack(entries, dest, max_bytes):
    # Write into a private dir next to dest, then move each top-level entry in; on any failure
    # dest is emptied again (it was empty to start with).
    root = os.path.realpath(dest)
    stage = tempfile.mkdtemp(prefix=".unpack-", dir=os.path.dirname(root))
    budget = Budget(max_bytes)
    try:
        for e in entries:
            write(stage, e, budget)
        for name in os.listdir(stage):
            os.rename(os.path.join(stage, name), os.path.join(root, name))
    except BaseException:
        for name in os.listdir(root):
            p = os.path.join(root, name)
            shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.unlink(p)
        raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main(argv):
    ap = argparse.ArgumentParser(prog="unpack.py", usage=USAGE)
    ap.add_argument("--expect", choices=("zip", "tar"))
    ap.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    ap.add_argument("archive")
    ap.add_argument("dest")
    args = ap.parse_args(argv[1:])
    archive, dest = args.archive, args.dest
    if not os.path.isdir(dest) or os.path.islink(dest) or os.listdir(dest):
        print("dest must be an existing, empty directory: " + show(dest), file=sys.stderr)
        return 2
    try:
        handle, listing = open_archive(archive, args.expect)
        if handle is None:
            print("not a zip or tar archive: " + show(archive), file=sys.stderr)
            return 2
        with handle:
            entries = list(listing)
            found = list(findings(entries))
            if found:
                for _, f in found:
                    print("REFUSED " + f)
                raise Refused("%d bad entries" % len({i for i, _ in found}))
            unpack(entries, dest, args.max_bytes)
    except Refused as e:
        print("archive refused: %s, nothing unpacked" % e)
        return 1
    except Exception as e:
        print("unpack failed, nothing unpacked: %s: %s" % (type(e).__name__, show(str(e))), file=sys.stderr)
        return 3
    print("unpacked %d entries into %s" % (len(entries), show(dest)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
