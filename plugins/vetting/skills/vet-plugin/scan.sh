#!/usr/bin/env bash
# Mechanical checks for the vet-plugin skill. Read-only: never runs anything from the target.
# Usage: scan.sh <dir>   (a git checkout or an unpacked package)
set -u
export LC_ALL=C
DIR="${1:?usage: scan.sh <dir>}"
cd "$DIR" || exit 1
CAP=40   # max lines per section; a hit count is printed when cut

section() { printf '\n===== %s\n' "$1"; }
capped() { awk -v cap="$CAP" 'NR<=cap{print} END{if(NR>cap) printf "... %d more (%d total)\n", NR-cap, NR}'; }

IS_GIT=0; git rev-parse --git-dir >/dev/null 2>&1 && IS_GIT=1
if [ $IS_GIT = 1 ]; then FILES() { git ls-files -z --cached --others --exclude-standard -- .; }; else FILES() { find . -type f -not -path './.git/*' -print0; }; fi
# Text files only, NUL-separated (by encoding: grep -I calls UTF-8 binary under LC_ALL=C).
TEXT() { FILES | while IFS= read -r -d '' f; do case "$(file -b --mime-encoding "$f")" in *binary*) ;; *) printf '%s\0' "$f";; esac; done; }

section "INVENTORY (lines / bytes / type)"
FILES | xargs -0 -I{} sh -c 'printf "%7s %9s  %s  [%s]\n" "$(wc -l < "$1" | tr -d " ")" "$(wc -c < "$1" | tr -d " ")" "$1" "$(file -b "$1" | cut -c1-50)"' _ {} | capped
printf 'files: %s   total size: %s\n' "$(FILES | tr -cd '\0' | wc -c | tr -d ' ')" "$(du -sh . | cut -f1)"

section "BINARIES / NON-TEXT FILES"
FILES | xargs -0 file --mime | grep -v -E 'charset=(us-ascii|utf-8)|inode/x-empty' | capped

section "MINIFIED OR PACKED LINES (> 400 chars)"
TEXT | xargs -0 grep -n -E '^.{400,}' 2>/dev/null | cut -c1-160 | capped

section "INVISIBLE / BIDI / TAG UNICODE (zero-width, RTL overrides, tag chars)"
TEXT | xargs -0 perl -CSD -ne 'while(/([\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{FEFF}\x{E0000}-\x{E007F}\x{00AD}])/g){printf "%s:%d U+%04X\n",$ARGV,$.,ord $1} close ARGV if eof' 2>/dev/null | capped

section "OTHER NON-ASCII (count per file and code point; usually harmless)"
TEXT | xargs -0 perl -CSD -ne 'while(/([^\x00-\x7f])/g){printf "%s U+%04X\n",$ARGV,ord $1}' 2>/dev/null | sort | uniq -c | sort -rn | capped

section "INSTALL / LOAD-TIME HOOKS (what runs without you calling it)"
FILES | tr '\0' '\n' | grep -E '(^|/)(package\.json|setup\.py|setup\.cfg|pyproject\.toml|Makefile|Cargo\.toml|build\.rs|binding\.gyp|install\.sh|postinstall[^/]*|\.npmrc|\.mcp\.json|mcp\.json|plugin\.json|marketplace\.json|hooks\.json|settings(\.local)?\.json|mod\.json|manifest\.json|Dockerfile|\.husky/.*|\.envrc)$' | capped
for f in $(FILES | tr '\0' '\n' | grep -E '(^|/)package\.json$'); do
  printf -- '--- %s scripts:\n' "$f"
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); [print(f"  {k}: {v}") for k,v in (d.get("scripts") or {}).items()]; print("  deps:", ", ".join({**(d.get("dependencies") or {}), **(d.get("optionalDependencies") or {})}) or "none")' "$f" 2>/dev/null
done

PATTERNS='https?://|fetch\(|XMLHttpRequest|WebSocket|axios|requests\.(get|post)|urllib|http\.client|\bsocket\b|net\.connect|\bcurl\b|\bwget\b|/dev/tcp|\bnc -|child_process|execSync|spawnSync|subprocess|os\.system|os\.popen|\beval\(|new Function|Function\(|\bexec\(|atob\(|btoa\(|fromCharCode|base64|(\\x[0-9a-fA-F]{2}){8,}|\.ssh\b|id_rsa|\.aws\b|\.npmrc|\.netrc|\.kube|keychain|find-generic-password|process\.env|os\.environ|getenv|\btoken\b|secret|passw|api[_-]?key|cookies?\.sqlite|Login Data|crontab|LaunchAgents|LaunchDaemons|launchctl|systemd|\.bashrc|\.zshrc|\.profile|chmod \+x|ignore (all |any )?(previous|prior|above) instructions|do not (tell|inform|mention)|without (asking|telling)|\| *(ba)?sh\b'

section "SENSITIVE PATTERNS IN CURRENT FILES (network, exec, obfuscation, credentials, persistence, agent-steering text)"
TEXT | xargs -0 grep -n -i -E "$PATTERNS" 2>/dev/null | cut -c1-200 | grep -v 'www\.w3\.org/2000/svg' | capped

if [ $IS_GIT = 1 ]; then
  section "HISTORY"
  printf 'commits: %s   first: %s   last: %s\n' "$(git rev-list --all --count)" "$(git log --reverse --format=%ad --date=short | head -1)" "$(git log -1 --format=%ad --date=short)"
  echo "authors / committers:"; git log --all --format='  %an <%ae> | %cn <%ce>' | sort | uniq -c | sort -rn | capped
  echo "branches / tags:"; git branch -a --format='  %(refname:short)'; git tag | sed 's/^/  tag /' | capped
  echo "unsigned vs signed commits:"; git log --all --format='%G?' | sort | uniq -c
  section "PATHS THAT EXISTED IN HISTORY BUT NOT AT HEAD"
  comm -23 <(git log --all --pretty=format: --name-only | sort -u | sed '/^$/d') <(git ls-files --cached --others --exclude-standard | sort) | capped
  section "SENSITIVE PATTERNS ADDED IN HISTORY BUT ABSENT AT HEAD"
  # Pattern hits (normalized token) in lines ever added, minus those still at HEAD.
  T=$(mktemp -d)
  git log --all -p --no-color | grep -E '^\+[^+]' | grep -o -i -E "$PATTERNS" | tr 'A-Z' 'a-z' | sort -u > "$T/hist"
  TEXT | xargs -0 grep -o -h -i -E "$PATTERNS" 2>/dev/null | tr 'A-Z' 'a-z' | sort -u > "$T/head"
  comm -23 "$T/hist" "$T/head" | while IFS= read -r tok; do
    c=$(git log --all -i -G"$(printf '%s' "$tok" | sed 's/[][\.*^$()+?{}|]/\\&/g')" --format='%h %ad %s' --date=short | tail -1)
    printf '%-28s first in: %s\n' "$tok" "$c"
  done | capped
  echo "(inspect each with: git log --all -p -S'<token>')"
  rm -rf "$T"
fi

section "DATA AFTER END OF IMAGE / EMBEDDED METADATA"
FILES | tr '\0' '\n' | grep -i -E '\.(png|jpe?g|gif|webp)$' | while IFS= read -r img; do
  python3 -I - "$img" <<'PY'
import struct, sys
p = sys.argv[1]; d = open(p, "rb").read(); note = []
if d[:8] == b"\x89PNG\r\n\x1a\n":
    i = 8; chunks = []
    while i + 8 <= len(d):
        n, = struct.unpack(">I", d[i:i+4]); t = d[i+4:i+8].decode("latin1"); chunks.append((t, n)); i += 12 + n
        if t == "IEND": break
    note.append("chunks: " + ", ".join(sorted({t for t, _ in chunks})))
    text = [(t, n) for t, n in chunks if t in ("tEXt", "zTXt", "iTXt", "eXIf")]
    if text: note.append("metadata chunks: " + ", ".join(f"{t}({n}B)" for t, n in text))
    note.append(f"bytes after IEND: {len(d) - i}")
elif d[:2] == b"\xff\xd8":
    end = d.rfind(b"\xff\xd9"); note.append(f"bytes after last EOI: {len(d) - end - 2 if end >= 0 else '?'}")
    if b"Exif" in d[:65536]: note.append("has EXIF (check for GPS / device / user info)")
print(f"{p}: " + "; ".join(note))
PY
done

section "GITLEAKS (secrets)"
if command -v gitleaks >/dev/null; then
  if [ $IS_GIT = 1 ]; then gitleaks git . --no-banner --no-color --redact 2>&1 | tail -5; else gitleaks dir . --no-banner --no-color --redact 2>&1 | tail -5; fi
else echo "not installed (brew install gitleaks)"; fi
