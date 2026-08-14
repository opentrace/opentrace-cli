#!/usr/bin/env bash
# Install the working tree as a REAL global otx, without touching the one you use.
#
# `npm link` and a plain `npm i -g` both write into your live global prefix,
# which replaces the otx you depend on day to day with an unreleased build. This
# packs the candidate exactly as npm would publish it and installs that tarball
# into a throwaway prefix instead, so the binary under test is real — same
# packaging, same bin shims, same files list — and yours is untouched.
#
# Pair it with a temp HOME to keep config out of it too:
#
#   eval "$(scripts/try-candidate.sh)"        # exports OTX and OTX_PREFIX
#   SANDBOX=$(mktemp -d)
#   HOME=$SANDBOX "$OTX" install --express
#   rm -rf "$SANDBOX" "$OTX_PREFIX"
#
# Note the OS keychain is machine-wide and NOT covered by a temp HOME. Set
# OTX_KEYCHAIN_SERVICE to something disposable if the run might store a key.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# stdout carries the eval-able exports, so build chatter goes to stderr. Errors
# stay visible there: `2>/dev/null` here would silence a real failure (an
# unwritable dist/, say) and leave the script packing a stale build.
npm run --silent clean >&2 || true
npm run --silent build >&2

pack_dir="$(mktemp -d)"
tarball="$(cd "$pack_dir" && npm pack "$repo_root" --silent)"
prefix="$(mktemp -d)"

# --no-save/--no-audit/--no-fund keep this quick and side-effect free.
npm install -g --prefix "$prefix" "$pack_dir/$tarball" --no-audit --no-fund >&2

bin="$prefix/bin/otx"
[ -x "$bin" ] || bin="$prefix/otx" # npm lays out Windows prefixes flat
version="$("$bin" --version)"

rm -rf "$pack_dir"

{
  echo "candidate otx $version installed at $bin" >&2
  echo "your global install is untouched; remove this one with: rm -rf $prefix" >&2
}

echo "export OTX='$bin'"
echo "export OTX_PREFIX='$prefix'"
