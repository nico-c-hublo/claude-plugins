"""Structured checks for scan.sh. Reads the target, never runs or imports anything from it.

Usage: python3 -I inspect.py <command> [args]   (file lists arrive NUL-separated on stdin)
  inventory <file -0 -N output>
  binaries  <file -0 -N --mime output>
  archives  <file -0 -N --mime output>
  hooks | agent-files | images | symlinks <target dir>
  changed   <git ls-tree -r -z HEAD output> <sha1|sha256>
  notinhead <ls-tree output>
  historypaths <ls-tree output> <git log --name-only -z output>
  gitleaks  <report.json>...
  link-objects <target objects dir> <new objects dir>
  copy-refs <target refs dir> <new refs dir>
  copy-files <dest dir> [path to leave out]...
"""
import json, os, re, stat, struct, sys, unicodedata

# Files bigger than this are listed, not read (same limit as textscan.pl).
MAXB = int(os.environ.get("VET_MAX_BYTES") or 20 * 1024 * 1024)

HIDE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e"
                  r"\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0"
                  r"\U000e0000-\U000e007f\U000e0100-\U000e01ef]")


def cut(s, n):
    s = s if isinstance(s, str) else json.dumps(s)
    return esc(s[:n]) + (f" …[cut: {len(s)} chars in all, read the file]" if len(s) > n else "")


def esc(s):
    if isinstance(s, bytes):
        s = s.decode("utf-8", "replace")
    s = HIDE.sub(lambda m: "\\x{%X}" % ord(m.group()), s)
    return "".join(c if unicodedata.category(c) != "Cf" else "\\x{%X}" % ord(c) for c in s)


def show(p):
    p = p.decode("utf-8", "replace") if isinstance(p, bytes) else p
    return esc(p[2:] if p.startswith("./") else p)


def paths():
    return [p for p in sys.stdin.buffer.read().split(b"\0") if p]


def file_records(path):
    """Parse `file -0 -N` output: name NUL ': ' description newline."""
    data = open(path, "rb").read()
    return {m.group(1): m.group(2).decode("utf-8", "replace")
            for m in re.finditer(rb"(.*?)\0: ([^\n]*)\n", data, re.S)}


def inventory(types):
    t = file_records(types)
    for p in paths():
        try:
            size = os.lstat(p).st_size
            if size > MAXB:
                print(f"{'?':>7} {size:9}  {show(p)}  [too large: not read]"); continue
            d = open(p, "rb").read()
        except OSError as e:
            print(f"{show(p)}: unreadable ({e.strerror})"); continue
        lines = d.count(b"\n")
        print(f"{lines:7} {len(d):9}  {show(p)}  [{esc(t.get(p, '?'))[:50]}]")


TEXTUAL = re.compile(r"^(text/|inode/x-empty|application/(json|x-ndjson|javascript|x-javascript|ecmascript|xml|x-sh|"
                     r"x-shellscript|toml|x-yaml|yaml|x-perl|x-php|x-ruby|x-python|x-awk|x-tex|x-wine-extension-ini|"
                     r"x-subrip|x-empty)\b|image/svg\+xml)")


def binaries(mimes):
    """Non-text files, and files whose content is ASCII but whose type is not a text type
    (an ASCII-only GIF is a polyglot)."""
    for p, m in sorted(file_records(mimes).items()):
        textual = TEXTUAL.search(m)
        if textual and re.search(r"charset=(us-ascii|utf-8)", m) or m.startswith("inode/x-empty"):
            continue
        if re.search(rb"(^|/)\.git/", p):
            continue   # git's index and packs; pattern hits inside .git have their own section
        note = "" if textual or "charset=binary" in m else "  (text bytes in a non-text type: read it)"
        print(f"{show(p)}: {esc(m)}{note}")


ARCHIVE = re.compile(r"^application/(zip|gzip|x-gzip|x-tar|x-bzip2|x-xz|x-7z-compressed|java-archive|x-rar|vnd\.rar|"
                     r"zstd|x-zstd|x-lzma|x-lzip|x-compress|x-archive|x-cpio|x-iso9660-image|x-apple-diskimage|"
                     r"vnd\.ms-cab-compressed|x-debian-package|x-rpm|x-xar)\b")


def archives(mimes):
    """Archives by content, whatever their extension: nothing inside them was scanned."""
    for p, m in sorted(file_records(mimes).items()):
        if ARCHIVE.search(m) and not re.search(rb"(^|/)\.git/", p):
            print(f"{show(p)}: {esc(m.split(';')[0])}")


HOOK = re.compile(
    r"(^|/)(package\.json|setup\.py|setup\.cfg|pyproject\.toml|[^/]+\.pth|sitecustomize\.py|usercustomize\.py|"
    r"conftest\.py|Makefile|Cargo\.toml|build\.rs|binding\.gyp|install\.sh|postinstall[^/]*|\.npmrc|\.yarnrc(\.yml)?|"
    r"\.mcp\.json|mcp\.json|plugin\.json|marketplace\.json|hooks\.json|settings(\.local)?\.json|mod\.json|"
    r"manifest\.json|Dockerfile|\.envrc|\.gitmodules|\.husky/.*|\.vscode/(tasks|settings|launch|extensions)\.json|"
    r"\.devcontainer(/devcontainer)?\.json|\.devcontainer/.*|\.idea/.*\.xml|"
    r"\.pnpmfile\.c?js|\.cargo/config(\.toml)?|entry_points\.txt|(requirements|constraints)[^/]*\.txt|Pipfile|"
    r"go\.mod|Gemfile|Rakefile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|\.pre-commit-config\.ya?ml|"
    r"noxfile\.py|tox\.ini|justfile|Taskfile\.ya?ml|lefthook\.ya?ml|\.lfsconfig)$")
# Text install files: the lines that run something, fetch from somewhere, or redirect.
SHOW = (
    (re.compile(r"(requirements|constraints)[^/]*\.txt$|^Pipfile$"),
     re.compile(r"^\s*-|://|git\+|@\s*(file|https?):"), "options, URLs and direct references"),
    (re.compile(r"^config(\.toml)?$"), re.compile(r"^\s*(runner|rustc-wrapper|rustc|linker|rustdoc|ar)\s*="), "commands cargo runs"),
    (re.compile(r"^entry_points\.txt$"), re.compile(r"\S"), "entry points other programs load"),
    (re.compile(r"^go\.mod$"), re.compile(r"^\s*(replace|toolchain|tool)\b"), "replacements and toolchains"),
    (re.compile(r"^\.lfsconfig$"), re.compile(r"url\s*="), "where git-lfs downloads from on checkout"),
)
# JSON keys whose values are commands, sources or endpoints.
RUNKEY = re.compile(r"command|helper|^args$|^url$|^source$|^repo$|^runOn$|refresh|export|^main$|^bin$|"
                    r"^activationEvents$|^entrypoint$|^module$|^exec|^env$|^permissions$|^enableAllProjectMcpServers$|"
                    r"^enabledMcpjsonServers$|^disableAllHooks$", re.I)


def loose_json(text):
    try:
        return json.loads(text)
    except ValueError:
        # JSON with comments and trailing commas (VS Code, devcontainer).
        text = re.sub(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*.*?\*/', lambda m: m.group(1) or "", text, flags=re.S)
        return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))


def walk(node, path=(), under=False):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, path + (str(k),), under or bool(RUNKEY.search(str(k))) or k in ("hooks", "mcpServers", "scripts"))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, path + (str(i),), under)
    elif under:
        yield ".".join(path), node


def hooks():
    ps = [p for p in paths() if HOOK.search(p.decode("utf-8", "replace"))]
    for p in ps:
        print(show(p))
    for p in ps:
        name = os.path.basename(p.decode("utf-8", "replace"))
        try:
            text = open(p, "rb").read().decode("utf-8", "replace")
        except OSError:
            continue
        if name.endswith(".pth"):
            print(f"--- {show(p)}: Python runs every line starting with 'import' at interpreter start-up")
            for line in text.splitlines():
                print("  " + cut(line, 200))
        elif name == ".gitmodules":
            print(f"--- {show(p)}: submodules (each is separate code to vet)")
            for line in text.splitlines():
                if re.match(r"\s*(url|path|branch)\s*=", line):
                    print("  " + esc(line.strip()))
        elif any(n.search(name) for n, _, _ in SHOW):
            for n, line_re, what in SHOW:
                if n.search(name):
                    hits = [l for l in text.splitlines() if line_re.search(l)]
                    if hits:
                        print(f"--- {show(p)}: {what}")
                        for line in hits:
                            print("  " + cut(line.strip(), 200))
        elif name.endswith(".json"):
            try:
                d = loose_json(text)
            except ValueError:
                print(f"--- {show(p)}: not parseable as JSON; read it by hand"); continue
            items = list(walk(d))
            if name == "package.json" and isinstance(d, dict):
                deps = {}
                for k in ("dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"):
                    if isinstance(d.get(k), dict):
                        deps.update(d[k])
                items.append(("deps", ", ".join(deps) or "none"))
                ranges = []
                for k, v in deps.items():
                    if isinstance(v, str) and re.search(r"[:/]", v):
                        items.append((f"NON-REGISTRY DEPENDENCY {k}", v))
                    elif not (isinstance(v, str) and re.fullmatch(r"=?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?", v)):
                        ranges.append(k)
                if ranges:
                    items.append(("UNPINNED DEPENDENCIES (ranges or tags, resolved at install time)", ", ".join(ranges)))
            if name == "marketplace.json" and isinstance(d, dict):
                for pl in d.get("plugins") or []:
                    src = pl.get("source") if isinstance(pl, dict) else None
                    if src is not None and not (isinstance(src, str) and src.startswith("./")):
                        items.append((f"EXTERNAL SOURCE, vet it separately: plugin {pl.get('name')}", json.dumps(src)))
            if items:
                print(f"--- {show(p)}:")
                for k, v in items:
                    print(f"  {esc(k)}: {cut(v, 300)}")


# Keep in step with $agentish in textscan.pl. Everything under skills/ counts: an agent reads
# a skill's supporting files on demand.
AGENT = re.compile(r"(^|/)(SKILL\.md|CLAUDE\.md|AGENTS\.md|GEMINI\.md|CONVENTIONS\.md|\.cursorrules|\.windsurfrules|"
                   r"\.clinerules.*|\.goosehints|copilot-instructions\.md|skills/.+|(commands|agents|output-styles|prompts)/.+\.md|"
                   r"\.claude/.*|\.claude-plugin/[^/]+\.json|\.cursor/.*|\.windsurf/.*|\.roo/.*|\.kiro/.*|\.amazonq/.*|"
                   r"\.junie/.*|\.github/(instructions|prompts)/.*)$")


def agent_files():
    for p in paths():
        if AGENT.search(p.decode("utf-8", "replace")):
            print(show(p))


def png(d):
    i, chunks, note = 8, [], []
    while i + 8 <= len(d):
        n, = struct.unpack(">I", d[i:i + 4]); t = d[i + 4:i + 8].decode("latin1"); chunks.append((t, n))
        if t == "IEND":
            if n:
                note.append(f"IEND DECLARES {n} BYTES OF DATA (must be 0: data hidden inside the end chunk)")
            i += 12   # IEND is empty: whatever follows its type and CRC is appended data
            break
        i += 12 + n
    else:
        return ["no IEND chunk (truncated, malformed, or a chunk length runs past the end)"]
    std = {"IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "pHYs", "sPLT", "tIME", "bKGD", "hIST", "acTL", "fcTL", "fdAT", "cICP"}
    note.insert(0, "chunks: " + ", ".join(sorted({esc(t) for t, _ in chunks})))
    odd = [(t, n) for t, n in chunks if t in ("tEXt", "zTXt", "iTXt", "eXIf") or t not in std]
    if odd:
        note.append("metadata or non-standard chunks: " + ", ".join(f"{esc(t)}({n}B)" for t, n in odd))
    return note + [f"bytes after IEND: {max(len(d) - i, 0)}"]


def jpeg(d):
    """Walk the marker segments; inside scan data, FF is followed by 00 or a restart marker."""
    i, note = 2, []
    while i + 4 <= len(d):
        if d[i] != 0xFF:
            return note + [f"bad marker at byte {i}; cannot find the real end"]
        m = d[i + 1]
        if m == 0xFF:
            i += 1; continue
        if m == 0xD9:
            return note + [f"bytes after EOI: {len(d) - i - 2}"]
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            i += 2; continue
        n, = struct.unpack(">H", d[i + 2:i + 4])
        if m == 0xE1 and d[i + 4:i + 8] == b"Exif":
            note.append("has EXIF (check for GPS / device / user info)")
        if m == 0xFE:
            note.append(f"comment segment ({n - 2}B)")
        i += 2 + n
        if m == 0xDA:
            while i + 1 < len(d) and not (d[i] == 0xFF and d[i + 1] not in (0x00, 0xFF) and not 0xD0 <= d[i + 1] <= 0xD7):
                i += 1
    return note + ["no EOI marker (truncated or malformed)"]


def gif(d):
    if len(d) < 13:
        return ["truncated"]
    i, note = 13, []
    if d[10] & 0x80:
        i += 3 << ((d[10] & 7) + 1)
    def blocks(i):
        while i < len(d) and d[i]:
            i += d[i] + 1
        return i + 1
    while i < len(d):
        b = d[i]
        if b == 0x3B:
            return note + [f"bytes after trailer: {len(d) - i - 1}"]
        if b == 0x21 and i + 1 < len(d):
            label = d[i + 1]
            if label == 0xFE:
                note.append("comment extension")
            elif label == 0xFF:
                note.append("application extension " + esc(d[i + 3:i + 14]))
            i = blocks(i + 2)
        elif b == 0x2C and i + 10 <= len(d):
            packed = d[i + 9]; i += 10
            if packed & 0x80:
                i += 3 << ((packed & 7) + 1)
            i = blocks(i + 1)
        else:
            return note + [f"unexpected byte at {i}; cannot find the real end"]
    return note + ["no trailer (truncated or malformed)"]


def webp(d):
    size, = struct.unpack("<I", d[4:8])
    end = 8 + size + (size & 1)
    i, chunks = 12, []
    while i + 8 <= min(end, len(d)):
        t = d[i:i + 4].decode("latin1"); n, = struct.unpack("<I", d[i + 4:i + 8]); chunks.append(f"{esc(t)}({n}B)"); i += 8 + n + (n & 1)
    return ["chunks: " + ", ".join(chunks), f"bytes after RIFF end: {len(d) - end}"]


def svg(d):
    t = d.decode("utf-8", "replace")
    hits = [w for w, r in (("<script", r"<script"), ("event handler", r"\son[a-z]+\s*="), ("javascript: URL", r"javascript:"),
                           ("<foreignObject", r"<foreignObject"), ("external href", r"href\s*=\s*[\"']\s*(https?:|//|data:)"))
            if re.search(r, t, re.I)]
    return ["ACTIVE CONTENT: " + ", ".join(hits) if hits else "no script, handler or external reference"]


def images():
    for p in paths():
        ext = p.rsplit(b".", 1)[-1].lower()
        try:
            if os.lstat(p).st_size > MAXB:
                continue
            d = open(p, "rb").read()
        except OSError:
            continue
        if ext == b"png" and d[:8] == b"\x89PNG\r\n\x1a\n":
            note = png(d)
        elif ext in (b"jpg", b"jpeg") and d[:2] == b"\xff\xd8":
            note = jpeg(d)
        elif ext == b"gif" and d[:4] == b"GIF8":
            note = gif(d)
        elif ext == b"webp" and d[:4] == b"RIFF" and d[8:12] == b"WEBP":
            note = webp(d)
        elif ext == b"svg":
            note = svg(d)
        elif ext in (b"png", b"jpg", b"jpeg", b"gif", b"webp"):
            note = ["content is not this image format (see EXTENSION / CONTENT MISMATCH)"]
        else:
            continue
        print(f"{show(p)}: " + "; ".join(note))


def symlinks(root):
    root = os.path.realpath(root)
    for p in paths():
        p = p.decode("utf-8", "surrogateescape")
        target = os.readlink(p)
        real = os.path.realpath(p)
        where = ("dangling" if not os.path.exists(p) else
                 "inside" if real == root or real.startswith(root + os.sep) else "POINTS OUTSIDE THE TARGET")
        print(f"{show(p)} -> {esc(target)}  [{where}]")


def tree(lstree):
    """Parse `git ls-tree -r -z HEAD`: (mode, type, oid, path) records."""
    for rec in open(lstree, "rb").read().split(b"\0"):
        if b"\t" in rec:
            meta, path = rec.split(b"\t", 1)
            yield (*meta.split(), path)


def kind(st):
    for test, name in ((stat.S_ISREG, "a file"), (stat.S_ISDIR, "a directory"), (stat.S_ISLNK, "a symlink"),
                       (stat.S_ISFIFO, "a FIFO"), (stat.S_ISSOCK, "a socket"), (stat.S_ISCHR, "a device"), (stat.S_ISBLK, "a device")):
        if test(st.st_mode):
            return name
    return "a special file"


def changed(lstree, algo):
    """Tracked files whose bytes on disk differ from HEAD: the disk copy is what runs.
    Never follows a symlink and never opens anything but a regular file."""
    import hashlib
    for mode, typ, oid, path in tree(lstree):
        if typ != b"blob":
            continue
        parts, at, bad = path.split(b"/"), b".", None
        for d in parts[:-1]:
            at += b"/" + d
            try:
                st = os.lstat(at)
            except OSError:
                bad = "missing on disk"; break
            if not stat.S_ISDIR(st.st_mode):
                bad = f"its parent {show(at)} is {kind(st)} on disk"; break
        if bad:
            print(f"{show(path)}: in HEAD, {bad}"); continue
        disk = b"./" + path
        try:
            st = os.lstat(disk)
        except OSError:
            print(f"{show(path)}: in HEAD, missing on disk"); continue
        want = "a symlink" if mode == b"120000" else "a file"
        if kind(st) != want:
            print(f"{show(path)}: {want} in HEAD, {kind(st)} on disk"); continue
        if st.st_size > MAXB:
            print(f"{show(path)}: too large to compare with HEAD ({st.st_size} bytes)"); continue
        if want == "a symlink":
            data = os.readlink(disk)
        else:
            fd = os.open(disk, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as f:
                data = f.read()
        h = hashlib.new(algo, b"blob %d\0" % len(data) + data).hexdigest()
        if h != oid.decode():
            print(f"{show(path)}: differs from HEAD")


def notinhead(lstree):
    head = {path for *_, path in tree(lstree)}
    ingit = 0
    for p in paths():
        rel = p[2:] if p.startswith(b"./") else p
        if rel in head:
            continue
        if re.search(rb"(^|/)\.git/", rel):
            ingit += 1
        else:
            print(show(rel))
    if ingit:
        print(f"(+ {ingit} files inside .git directories, not listed here; they are scanned like any other)")


def historypaths(lstree, log):
    """Paths some commit touched that HEAD doesn't have (from `git log --name-only -z`)."""
    head = {path for *_, path in tree(lstree)}
    seen = {p.strip(b"\n") for p in open(log, "rb").read().split(b"\0")}
    for p in sorted(seen - head - {b""}):
        print(show(p))


def link_objects(src, dest):
    """A git object store at dest made of symlinks to src's regular files. Leaves out
    objects/info (alternates would pull in another repo's objects; a FIFO there or anywhere
    else would hang git) and never descends a symlinked directory."""
    os.mkdir(dest)
    for root, dirs, files in os.walk(src, followlinks=False):
        rel = os.path.relpath(root, src)
        if rel == ".":
            dirs[:] = [d for d in dirs if d != "info"]
        else:
            os.makedirs(os.path.join(dest, rel), exist_ok=True)
        for f in files:
            at = os.path.join(root, f)
            if stat.S_ISREG(os.lstat(at).st_mode):
                os.symlink(at, os.path.join(dest, rel, f))


def copy_refs(src, dest):
    """Copy the regular files of a refs tree. Never descends a symlinked directory, and
    skips symlinks, FIFOs and devices: git would walk a link to / or block on a FIFO."""
    os.makedirs(dest, exist_ok=True)
    for root, dirs, files in os.walk(src, followlinks=False):
        rel = os.path.relpath(root, src)
        os.makedirs(os.path.join(dest, rel), exist_ok=True)
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for f in files:
            at = os.path.join(root, f)
            try:
                fd = os.open(at, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
            except OSError:
                continue
            with os.fdopen(fd, "rb") as fh:
                if stat.S_ISREG(os.fstat(fh.fileno()).st_mode) and os.fstat(fh.fileno()).st_size < 4096:
                    with open(os.path.join(dest, rel, f), "wb") as o:
                        o.write(fh.read())


def copy_files(dest, *skip):
    """Copy the listed regular files into dest, minus the paths in skip. Opens nothing but a
    regular file and never follows a symlink."""
    leave = {s.encode() for s in skip}
    for p in paths():
        if p in leave:
            continue
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            continue
        with os.fdopen(fd, "rb") as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAXB:
                continue
            out = os.path.join(dest.encode(), p)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as o:
                o.write(f.read())


def gitleaks(*reports):
    for r in reports:
        try:
            items = json.load(open(r))
        except (OSError, ValueError):
            continue
        for f in items or []:
            where = f"{f.get('File')}:{f.get('StartLine')}"
            commit = f" commit {f['Commit'][:10]}" if f.get("Commit") else ""
            print(f"{esc(where)}{commit}: {esc(f.get('RuleID', ''))}: {esc(str(f.get('Match', ''))[:120])}")


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"inventory": inventory, "binaries": binaries, "archives": archives, "hooks": hooks, "agent-files": agent_files, "images": images,
     "symlinks": symlinks, "changed": changed, "historypaths": historypaths, "notinhead": notinhead, "gitleaks": gitleaks,
     "link-objects": link_objects, "copy-refs": copy_refs, "copy-files": copy_files}[cmd](*args)
