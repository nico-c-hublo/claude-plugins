"""Unpack an untrusted zip (wheel, .vsix) or tarball into an empty dir, or refuse it whole.

Usage: python3 -I unpack.py <archive> <empty dest dir>

Every entry is checked before anything is written. An entry that is absolute, has a `..`
component, or is anything but a plain file or directory (symlink, hardlink, device, FIFO) is
printed as a finding, and the archive is refused: exit 1, nothing written. Otherwise only plain
files and directories are created, inside dest, without following links.
Exit codes: 0 unpacked, 1 refused, 2 usage error or not a zip/tar.
"""
import os
import stat
import sys
import tarfile
import zipfile


def show(name):
    # The name is the target's text: escape control characters so it can't forge output.
    return name.encode("unicode_escape", "backslashreplace").decode("ascii")


def path_problem(name):
    parts = name.replace("\\", "/").split("/")
    if name[:1] in ("/", "\\") or (len(name) > 1 and name[1] == ":"):
        return "absolute path"
    if not name.strip("/\\"):
        return "empty name"
    if ".." in parts:
        return "'..' in path"
    return None


def zip_entries(z):
    """(name, kind, info) for each zip entry; kind is file, dir or a refusal reason."""
    for zi in z.infolist():
        mode = zi.external_attr >> 16
        fmt = stat.S_IFMT(mode)
        if fmt == stat.S_IFLNK:
            kind = "symlink"
        elif fmt not in (0, stat.S_IFREG, stat.S_IFDIR):
            kind = "special file (mode %o)" % mode
        else:
            kind = "dir" if zi.is_dir() else "file"
        yield zi.filename, kind, (lambda zi=zi: z.open(zi)), stat.S_IMODE(mode)


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
        yield ti.name, kind, (lambda ti=ti: tf.extractfile(ti)), ti.mode


def open_archive(path):
    if zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        return z, zip_entries(z)
    if tarfile.is_tarfile(path):
        tf = tarfile.open(path, "r:*")
        return tf, tar_entries(tf)
    return None, None


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    archive, dest = argv[1], argv[2]
    if not os.path.isdir(dest) or os.path.islink(dest) or os.listdir(dest):
        print("dest must be an existing, empty directory: " + show(dest), file=sys.stderr)
        return 2
    handle, listing = open_archive(archive)
    if handle is None:
        print("not a zip or tar archive: " + show(archive), file=sys.stderr)
        return 2
    with handle:
        entries = list(listing)
        findings = []
        for name, kind, _, _ in entries:
            problem = path_problem(name)
            if problem:
                findings.append("%s: %s" % (problem, show(name)))
            if kind not in ("file", "dir"):
                findings.append("%s: %s" % (kind, show(name)))
        if findings:
            for f in findings:
                print("REFUSED " + f)
            print("archive refused: %d bad entries, nothing unpacked" % len(findings))
            return 1
        root = os.path.realpath(dest)
        for name, kind, opener, mode in entries:
            write(root, name, kind, opener, mode)
    print("unpacked %d entries into %s" % (len(entries), show(dest)))
    return 0


def write(root, name, kind, opener, mode):
    rel = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
    if not rel:
        return
    target = os.path.join(root, *rel)
    parent = target if kind == "dir" else os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    # Nothing this script creates is a link, but check anyway before writing.
    if os.path.commonpath([os.path.realpath(parent), root]) != root:
        raise SystemExit("refusing to write outside dest: " + show(name))
    if kind == "dir":
        return
    perm = 0o755 if mode & 0o111 else 0o644
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, perm)
    with os.fdopen(fd, "wb") as out, opener() as src:
        while chunk := src.read(1 << 20):
            out.write(chunk)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
