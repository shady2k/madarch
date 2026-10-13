#!/bin/sh
# The tag release's one required side effect: copy its formula to the existing tap.
set -eu
if [ -z "${HOMEBREW_TAP_TOKEN:-}" ]; then
  echo 'HOMEBREW_TAP_TOKEN is required to update shady2k/homebrew-tap' >&2
  exit 2
fi
FORMULA=${1:-release/madarch.rb}
VERSION=${2:-}
if [ ! -f "$FORMULA" ]; then echo "formula not found: $FORMULA" >&2; exit 2; fi
if [ -z "$VERSION" ]; then echo 'release version is required' >&2; exit 2; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# The secret is only used as the HTTPS credential; never print it.
git clone -q "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/shady2k/homebrew-tap.git" "$TMP/tap"
cp "$FORMULA" "$TMP/tap/Formula/madarch.rb"
git -C "$TMP/tap" config user.name 'github-actions[bot]'
git -C "$TMP/tap" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$TMP/tap" add Formula/madarch.rb
git -C "$TMP/tap" commit -m "Update madarch to $VERSION"
git -C "$TMP/tap" push origin HEAD:main
