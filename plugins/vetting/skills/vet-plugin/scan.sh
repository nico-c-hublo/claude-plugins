#!/usr/bin/env bash
# Mechanical checks for the vet-plugin skill. Read-only on the target:
# - never runs its code, and never follows its symlinks;
# - never runs git under the target's own config, attributes or hooks: history is read
#   from a fresh git directory that only borrows the target's objects and refs;
# - scans every file on disk, ignored and untracked ones included (they run too).
# Usage: scan.sh <dir> [work dir]
#   The work dir (default: a new temp dir; must be outside <dir>) receives full-report.txt,
#   which has every line the capped output below leaves out, and git-safe, a wrapper for
#   reading the target's history without running anything from it.
set -u
export LC_ALL=C
HERE=$(cd "$(dirname "$0")" && pwd -P)
LIB="$HERE/lib"
DIR=$(cd "${1:?usage: scan.sh <dir> [work dir]}" && pwd -P) || exit 1
W=${2:-$(mktemp -d)}; mkdir -p "$W" && W=$(cd "$W" && pwd -P) || exit 1
case "$W/" in "$DIR"/*) echo "scan.sh: the work dir must be outside the target" >&2; exit 1;; esac
FULL="$W/full-report.txt"
CAP=40
cd "$DIR" || exit 1
# A reused work dir must not carry results over from an earlier target.
rm -rf "$W/git" "$W/git-safe" "$W"/gitleaks-*.json "$W/head.tree" "$W/history.txt" "$W/history.paths" "$W/raw" "$FULL"

PY() { python3 -I "$LIB/inspect.py" "$@"; }
# Every regular file on disk, sorted, as ./-prefixed paths (so no path can be read as an
# option), NUL-separated. Files inside .git directories are included, since code can load
# a file planted there; only their compressed object store is left out (history covers it).
NOOBJ=(\( -path '*/.git/objects' -o -path '*/.git/modules/*/objects' \) -prune -o)
find . "${NOOBJ[@]}" -type f -print0 2>/dev/null | sort -z > "$W/files"
FILES() { cat "$W/files"; }
h() { printf '\001%s\n' "$1"; }

# A git directory the target cannot configure: fresh config, no attributes, no hooks, no
# replace refs, no grafts. Only objects (linked) and refs (copied) come from the target.
GD=""
if [ -e .git ]; then
  SRC=""
  if [ -d .git ]; then SRC="$DIR/.git"
  elif [ -f .git ]; then
    g=$(sed -n 's/^gitdir: //p' .git | head -1)
    case "$g" in /*) ;; ?*) g="$DIR/$g";; esac
    [ -n "$g" ] && [ -d "$g" ] && SRC=$(cd "$g" && pwd -P)
  fi
  if [ -n "$SRC" ]; then
    COMMON="$SRC"
    [ -f "$SRC/commondir" ] && COMMON=$(cd "$SRC" && cd "$(head -1 commondir)" 2>/dev/null && pwd -P)
    if [ -d "$COMMON/objects" ]; then
      GD="$W/git"; rm -rf "$GD"
      GIT_DIR="$GD" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init -q --bare "$GD"
      rm -rf "$GD/objects" "$GD/refs" "$GD/hooks" "$GD/info"
      ln -s "$COMMON/objects" "$GD/objects"
      cp -RP "$COMMON/refs" "$GD/refs" 2>/dev/null || mkdir -p "$GD/refs"
      [ -f "$COMMON/packed-refs" ] && cp -P "$COMMON/packed-refs" "$GD/"
      cp -P "$SRC/HEAD" "$GD/HEAD" 2>/dev/null
      [ -f "$COMMON/shallow" ] && cp -P "$COMMON/shallow" "$GD/"
      cat > "$W/git-safe" <<EOF
#!/bin/sh
# Read the target's history with none of its config, attributes, hooks or replace refs.
exec env GIT_DIR='$GD' GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \\
  GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \\
  git -c core.quotePath=false -c diff.external= -c core.pager=cat --no-pager "\$@"
EOF
      chmod +x "$W/git-safe"
    fi
  fi
fi
G() { "$W/git-safe" "$@"; }
LOGP=(log --all -m -p --text --no-color --no-textconv --no-ext-diff)

perl "$LIB/textscan.pl" "$LIB/patterns.re" "$W" < "$W/files"
FILES | xargs -0 file -0 -N -- > "$W/types" 2>/dev/null
FILES | xargs -0 file -0 -N --mime -- > "$W/mimes" 2>/dev/null

{
h "SCOPE"
echo "target: $DIR"
echo "full report (nothing cut): $FULL"
[ -n "$GD" ] && echo "history: read it only with $W/git-safe <git args> (never plain git inside the target)"
[ -e .git ] && [ -z "$GD" ] && echo "WARNING: .git exists but could not be read as a repository; history was not checked"
[ -z "$GD" ] && [ ! -e .git ] && echo "not a git checkout: no history checked"

h "INVENTORY (lines / bytes / type)"
FILES | PY inventory "$W/types"
printf 'files: %s   total size: %s\n' "$(tr -cd '\0' < "$W/files" | wc -c | tr -d ' ')" "$(du -sh . | cut -f1)"

h "SYMLINKS (never followed by this scan)"
find . "${NOOBJ[@]}" -type l -print0 2>/dev/null | sort -z | PY symlinks "$DIR"

h "NESTED GIT REPOSITORIES AND OTHER SPECIAL FILES"
find . -mindepth 2 -name .git -print 2>/dev/null | sed 's/^/nested repo (its files are scanned like any other): /'
find . "${NOOBJ[@]}" \( -type p -o -type s -o -type b -o -type c \) -print 2>/dev/null | sed 's/^/special file (never read): /'

h "BINARIES / NON-TEXT FILES"
PY binaries "$W/mimes"

h "EXTENSION / CONTENT MISMATCH"
cat "$W/mismatch.txt"

h "FILES THAT LOOK BINARY BUT WERE SCANNED AS TEXT (NUL bytes, UTF-16): read them raw"
cat "$W/looks_binary.txt"

h "MINIFIED OR PACKED LINES (> 400 chars)"
cat "$W/minified.txt"

h "INVISIBLE / BIDI / TAG / VARIATION-SELECTOR UNICODE: totals per file"
cat "$W/invisible_counts.txt"

h "INVISIBLE / BIDI / TAG / VARIATION-SELECTOR UNICODE: locations"
cat "$W/invisible.txt"

h "OTHER NON-ASCII (count per file and code point; typography and emoji are normal, look-alike letters in code are not)"
sort -rn "$W/nonascii.txt"

h "INSTALL / LOAD-TIME HOOKS (what runs without you calling it)"
FILES | PY hooks

h "AGENT-CONSUMED FILES (read every one in full)"
FILES | PY agent-files

h "AGENT LOAD-TIME COMMANDS AND GRANTS (!\`cmd\` runs when the prompt loads)"
cat "$W/agent.txt"

h "SENSITIVE PATTERNS IN CURRENT FILES (network, exec, obfuscation, credentials, persistence, agent-steering text)"
cat "$W/patterns.txt" "$W/patterns_docs.txt"

h "SENSITIVE PATTERNS IN BINARY FILES (raw bytes; XMP metadata URLs such as ns.adobe.com are normal)"
cat "$W/patterns_binary.txt"

h "SENSITIVE PATTERNS INSIDE .git DIRECTORIES (git's sample hooks match; anything else was put there)"
cat "$W/patterns_git.txt"

if [ -n "$GD" ]; then
  h "HISTORY"
  printf 'commits: %s   first: %s   last: %s\n' "$(G rev-list --all --count)" \
    "$(G log --all --reverse --format=%ad --date=short | head -1)" "$(G log --all -1 --format=%ad --date=short)"
  echo "authors / committers:"; G log --all --format='  %an <%ae> | %cn <%ce>' | sort | uniq -c | sort -rn
  echo "refs:"; G for-each-ref --format='  %(refname)'
  echo "unsigned vs signed commits:"; G log --all --format='%G?' | sort | uniq -c

  G ls-tree -r -z HEAD > "$W/head.tree" 2>/dev/null
  h "FILES ON DISK BUT NOT IN HEAD (untracked, ignored or built: these run too)"
  FILES | PY notinhead "$W/head.tree"
  h "TRACKED FILES THAT DIFFER FROM HEAD ON DISK"
  PY changed "$W/head.tree" "$(G rev-parse --show-object-format 2>/dev/null || echo sha1)"

  h "PATHS THAT EXISTED IN HISTORY BUT NOT AT HEAD"
  G log --all -m --format= --name-only -z > "$W/history.paths"
  PY historypaths "$W/head.tree" "$W/history.paths"

  h "SENSITIVE LINES ADDED IN HISTORY BUT ABSENT FROM EVERY FILE ON DISK"
  G "${LOGP[@]}" --format='%x00%h %ad %an: %s' --date=short | perl "$LIB/history.pl" "$LIB/patterns.re" "$W/headlines.txt" > "$W/history.txt"
  if [ -s "$W/history.txt" ]; then
    cat "$W/history.txt"
    echo "(inspect each with: $W/git-safe log --all -p --no-textconv -S'<text from the line>')"
  fi
fi

h "DATA AFTER END OF IMAGE / ACTIVE SVG CONTENT / EMBEDDED METADATA"
FILES | PY images

h "GITLEAKS (secrets; the target's own gitleaks config and allow comments are ignored)"
for f in .gitleaks.toml .gitleaksignore; do
  find . -name "$f" -not -path '*/.git/*' 2>/dev/null | sed "s/\$/: the target ships its own $f (could hide its secrets; ignored here)/"
done
if command -v gitleaks >/dev/null; then
  printf '[extend]\nuseDefault = true\n' > "$W/gitleaks.toml"; mkdir -p "$W/gitleaks-ignore"
  GL=(--no-banner --no-color --redact --ignore-gitleaks-allow --exit-code 0 -c "$W/gitleaks.toml" -i "$W/gitleaks-ignore" -f json)
  gitleaks dir . "${GL[@]}" -r "$W/gitleaks-dir.json" >/dev/null 2>&1 || echo "gitleaks dir failed"
  if [ -n "$GD" ]; then
    env GIT_DIR="$GD" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 \
      gitleaks git "$GD" "${GL[@]}" -r "$W/gitleaks-git.json" >/dev/null 2>&1 || echo "gitleaks git failed"
  fi
  PY gitleaks "$W/gitleaks-dir.json" "$W/gitleaks-git.json" | sort -u
  echo "(gitleaks done)"
else echo "not installed (brew install gitleaks)"; fi
} > "$W/raw" 2>&1

# Render: section headers are the \001 lines; nothing from the target can forge one. Control
# characters are escaped. The full report keeps every line; stdout keeps CAP per section.
perl -e '
  my ($full, $cap) = @ARGV; open my $F, ">", $full or die "$full: $!";
  my ($n, $name) = (0, "");
  sub flush { if ($name && !$n) { print "(none)\n"; print $F "(none)\n" } printf "... %d more lines in this section (%d total): read them in %s\n", $n - $cap, $n, $full if $n > $cap }
  while (my $l = <STDIN>) {
    if ($l =~ /^\x01(.*)/) { flush(); ($n, $name) = (0, $1); print $F "\n===== $1\n"; print "\n===== $1\n"; next }
    $l =~ s/([\x00-\x08\x0b-\x1f\x7f])/sprintf("\\x{%X}", ord $1)/ge;
    $l = "  $l" if $l =~ /^=====/;
    print $F $l; $n++; print $l if $n <= $cap;
  }
  flush();
' "$FULL" "$CAP" < "$W/raw"
