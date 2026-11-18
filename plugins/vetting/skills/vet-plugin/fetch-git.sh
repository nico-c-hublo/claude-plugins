#!/usr/bin/env bash
# Clone an untrusted git repo and check out one ref without running anything from it or
# from the user's git config.
# Usage: bash fetch-git.sh <url> <dest (must not exist)> [ref]   (no ref: the default branch)
#
# - A fresh config (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1): a filter driver the
#   user has set up (git-lfs, say) can't be triggered by the target's .gitattributes, and no
#   user fsmonitor, hook path or pager runs. This also drops credential helpers and insteadOf.
# - No hooks, fsck on transfer, LFS smudge skipped (the target's .lfsconfig names its server).
# - `--` before <url>, a <ref> starting with `-` refused, the checkout ref-only.
set -u
if [ $# -lt 2 ] || [ $# -gt 3 ]; then echo "usage: fetch-git.sh <url> <dest> [ref]" >&2; exit 2; fi
url=$1 dest=$2 ref=${3:-}
case $ref in -*) echo "refusing a ref that starts with '-': $ref" >&2; exit 2 ;; esac
[ -e "$dest" ] && { echo "dest already exists: $dest" >&2; exit 2; }

unset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_EXEC_PATH
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c transfer.fsckObjects=true "$@"; }

g clone -q --no-checkout -- "$url" "$dest" || exit 1
g -C "$dest" checkout -q --detach "${ref:-HEAD}" -- || exit 1
echo "checked out $(g -C "$dest" rev-parse HEAD) into $dest"
