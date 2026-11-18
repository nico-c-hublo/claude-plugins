#!/usr/bin/env bash
# The fetch helpers against hostile inputs, offline: unpack.py on archives that try to write
# outside the dest dir, and fetch-git.sh on a repo that names a filter driver from the user's config.
# Usage: bash plugins/vetting/tests/fetch.test.sh   (exits 1 on a failure)
set -u
SKILL="$(cd "$(dirname "$0")/../skills/vet-plugin" && pwd)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
FAILED=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAILED=1; }
# mk <zip|tar|tgz> <file> <entry>...: build an archive with python3. An entry is name=content,
# name->target (symlink), name=>target (hardlink, tar only) or name|fifo (FIFO, tar only).
mk() { python3 -I - "$@" <<'PY'
import io, sys, tarfile, zipfile
kind, out, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
def parse(s):
    for sep, t in (("=>", "hard"), ("->", "sym"), ("|", "fifo"), ("=", "file")):
        if sep in s:
            n, v = s.split(sep, 1); return t, n, v
    return "dir", s, ""
if kind == "zip":
    with zipfile.ZipFile(out, "w") as z:
        for t, n, v in map(parse, specs):
            zi = zipfile.ZipInfo(n, (2024, 1, 1, 0, 0, 0))
            zi.external_attr = {"sym": 0o120777, "dir": 0o40755}.get(t, 0o100644) << 16
            z.writestr(zi, v)
else:
    with tarfile.open(out, "w:gz" if kind == "tgz" else "w") as tf:
        for t, n, v in map(parse, specs):
            ti = tarfile.TarInfo(n)
            if t == "file":
                data = v.encode(); ti.size = len(data); ti.mode = 0o755 if n.endswith(".sh") else 0o644
                tf.addfile(ti, io.BytesIO(data))
            else:
                ti.type = {"sym": tarfile.SYMTYPE, "hard": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE, "dir": tarfile.DIRTYPE}[t]
                ti.linkname = "" if t == "fifo" else v
                tf.addfile(ti)
PY
}
unpack() { OUT=$(python3 -I "$SKILL/unpack.py" "$1" "$2" 2>&1); RC=$?; }
# refused <what> <archive> <offending entry>: non-zero exit, the entry reported, nothing written.
refused() {
  local d="$WORK/d-$(basename "$2")"; mkdir "$d"; unpack "$2" "$d"
  [ $RC -ne 0 ] && ok "$1: refused" || fail "$1: accepted"
  printf '%s\n' "$OUT" | grep -qF -- "$3" && ok "$1: entry reported" || fail "$1: '$3' not in output: $OUT"
  [ -z "$(ls -A "$d")" ] && ok "$1: nothing written" || fail "$1: wrote $(ls -A "$d")"
}
mkdir -p "$WORK/in" "$WORK/abs"

# --- Hostile zips (wheel, .vsix) and tarballs: each is refused whole.
for k in whl vsix; do
  mk zip "$WORK/in/dotdot.$k" "ok.txt=fine" "../../esc-dotdot-$k=PWNED"
  refused "$k with ../" "$WORK/in/dotdot.$k" "../../esc-dotdot-$k"
  mk zip "$WORK/in/abs.$k" "ok.txt=fine" "$WORK/abs/x-$k=PWNED"
  refused "$k with /abs" "$WORK/in/abs.$k" "$WORK/abs/x-$k"
  # A symlink to a dir outside, then a file written through it.
  mk zip "$WORK/in/link.$k" "lnk->$WORK/abs" "lnk/x-link-$k=PWNED"
  refused "$k symlink then write through" "$WORK/in/link.$k" "symlink: lnk"
  mk zip "$WORK/in/bslash.$k" 'a\..\..\esc-bslash=PWNED'
  refused "$k with ..\\" "$WORK/in/bslash.$k" 'a\\..\\..\\esc-bslash'
done

# --- A benign wheel unpacks in full, keeping its layout and exec bits.
mk zip "$WORK/in/good.whl" "pkg/__init__.py=print(1)" "pkg-1.0.dist-info/METADATA=Name: pkg" "pkg/sub/"
mkdir "$WORK/d-good-whl"; unpack "$WORK/in/good.whl" "$WORK/d-good-whl"
[ $RC -eq 0 ] && ok "benign wheel accepted" || fail "benign wheel refused: $OUT"
[ "$(cat "$WORK/d-good-whl/pkg/__init__.py" 2>/dev/null)" = "print(1)" ] && [ -d "$WORK/d-good-whl/pkg/sub" ] \
  && [ "$(cat "$WORK/d-good-whl/pkg-1.0.dist-info/METADATA" 2>/dev/null)" = "Name: pkg" ] \
  && ok "benign wheel contents intact" || fail "benign wheel contents wrong: $(cd "$WORK/d-good-whl" && find . | sort | tr '\n' ' ')"

# --- Hostile tarballs (npm .tgz, plain .tar).
for k in tgz tar; do
  mk $k "$WORK/in/dotdot.$k" "package/ok.js=1" "package/../../esc-tdotdot-$k=PWNED"
  refused "$k with ../" "$WORK/in/dotdot.$k" "package/../../esc-tdotdot-$k"
  mk $k "$WORK/in/abs.$k" "$WORK/abs/t-$k=PWNED"
  refused "$k with /abs" "$WORK/in/abs.$k" "$WORK/abs/t-$k"
  mk $k "$WORK/in/link.$k" "package/lnk->$WORK/abs" "package/lnk/t-link-$k=PWNED"
  refused "$k symlink then write through" "$WORK/in/link.$k" "symlink: package/lnk"
  mk $k "$WORK/in/hard.$k" "package/h=>$WORK/abs/t-hard-$k"
  refused "$k hardlink" "$WORK/in/hard.$k" "hardlink: package/h"
  mk $k "$WORK/in/fifo.$k" "package/p|fifo"
  refused "$k FIFO" "$WORK/in/fifo.$k" "package/p"
done

# --- A benign npm tarball unpacks in full; the exec bit survives, nothing else does.
mk tgz "$WORK/in/good.tgz" "package/" "package/package.json={}" "package/bin/run.sh=echo"
mkdir "$WORK/d-good-tgz"; unpack "$WORK/in/good.tgz" "$WORK/d-good-tgz"
[ $RC -eq 0 ] && ok "benign tgz accepted" || fail "benign tgz refused: $OUT"
[ "$(cat "$WORK/d-good-tgz/package/package.json" 2>/dev/null)" = "{}" ] && [ -x "$WORK/d-good-tgz/package/bin/run.sh" ] \
  && [ ! -x "$WORK/d-good-tgz/package/package.json" ] \
  && ok "benign tgz contents intact" || fail "benign tgz contents wrong: $(cd "$WORK/d-good-tgz" && find . | sort | tr '\n' ' ')"

# --- Not an archive at all.
printf 'hello' > "$WORK/in/plain.txt"; mkdir "$WORK/d-plain"; unpack "$WORK/in/plain.txt" "$WORK/d-plain"
[ $RC -eq 2 ] && ok "non-archive refused" || fail "non-archive: exit $RC"
D="$WORK/d-nonempty"; mkdir "$D"; : > "$D/x"; unpack "$WORK/in/good.whl" "$D"
[ $RC -eq 2 ] && ok "non-empty dest refused" || fail "non-empty dest: exit $RC"

# --- git: the target's .gitattributes names a filter driver the user's own config defines
# (as git-lfs does), in ~/.gitconfig, the XDG config and a GIT_CONFIG_GLOBAL file.
FH="$WORK/home"; mkdir -p "$FH/.config/git"
for c in "$FH/.gitconfig" "$FH/.config/git/config" "$WORK/gitglobal"; do
  printf '[filter "evil"]\n\tsmudge = "touch %s/PWN_SMUDGE; cat"\n\trequired = true\n' "$WORK" > "$c"
  printf '[core]\n\tfsmonitor = "touch %s/PWN_FSMON; false"\n' "$WORK" >> "$c"
done
S="$WORK/gitsrc"; mkdir "$S"; git -C "$S" init -q -b main
printf '* filter=evil\n' > "$S/.gitattributes"; printf 'hello\n' > "$S/a.txt"
git -C "$S" add -A; git -C "$S" -c user.name=t -c user.email=t@t commit -qm init; git -C "$S" tag v1
printf 'two\n' > "$S/a.txt"; git -C "$S" -c user.name=t -c user.email=t@t commit -qam two
git -C "$S" branch -- -evil v1 2>/dev/null   # a branch whose name looks like an option
U="file://$S"
userenv() { HOME="$FH" XDG_CONFIG_HOME="$FH/.config" GIT_CONFIG_GLOBAL="$WORK/gitglobal" "$@"; }
# Control: the old SKILL.md command runs the user's filter, so the trap is live.
userenv sh -c 'GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null clone -q --no-checkout -- "$1" "$2" && GIT_LFS_SKIP_SMUDGE=1 git -C "$2" -c core.hooksPath=/dev/null checkout -q v1' _ "$U" "$WORK/git-control" >/dev/null 2>&1
[ -e "$WORK/PWN_SMUDGE" ] && ok "control: old command runs the user's filter" || fail "control: trap did not fire, test proves nothing"
rm -f "$WORK/PWN_SMUDGE" "$WORK/PWN_FSMON"
FG="$SKILL/fetch-git.sh"
userenv bash "$FG" "$U" "$WORK/git-tag" v1 >/dev/null 2>&1
[ $? -eq 0 ] && [ "$(cat "$WORK/git-tag/a.txt" 2>/dev/null)" = hello ] && ok "git: tag checked out" || fail "git: tag not checked out"
userenv bash "$FG" "$U" "$WORK/git-default" >/dev/null 2>&1
[ "$(cat "$WORK/git-default/a.txt" 2>/dev/null)" = two ] && ok "git: default branch checked out" || fail "git: default branch not checked out"
for p in PWN_SMUDGE PWN_FSMON; do [ -e "$WORK/$p" ] && fail "git: user config ran ($p)" || ok "git: user config not run ($p)"; done
userenv bash "$FG" "$U" "$WORK/git-dash" -evil >/dev/null 2>&1 && fail "git: ref starting with - accepted" || ok "git: ref starting with - refused"
[ -e "$WORK/git-dash" ] && fail "git: refused ref still cloned" || ok "git: refused ref cloned nothing"
userenv bash "$FG" "--upload-pack=touch $WORK/PWN_UPLOAD" "$WORK/git-opt" >/dev/null 2>&1
[ -e "$WORK/PWN_UPLOAD" ] && fail "git: URL read as an option" || ok "git: URL not read as an option"

# Nothing from any archive landed outside its dest dir.
ESC=$(find "$WORK" -name 'esc-*' -o -path "$WORK/abs/*" | head -5)
[ -z "$ESC" ] && ok "nothing written outside the dest dirs" || fail "written outside: $ESC"

if [ $FAILED = 0 ]; then echo "all passed"; else exit 1; fi
