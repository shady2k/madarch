#!/bin/sh
# The release smoke of one madarch binary (madarch-m38l.4 left one wiki app):
# version, list, then `init` in a scratch home and the wiki read the way a reader
# reaches it - the root answers (a redirect to the product is followed), the
# product's /api/status answers with a manifest that is not-filled, and the product's
# page is the wiki app's HTML. The home's server is stopped at the end.
# Usage: scripts/smoke-binary.sh <binary>
set -eu
BINARY=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
TMP=$(mktemp -d)
trap '"$BINARY" stop --home "$TMP/home" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BINARY" version
"$BINARY" list --home "$TMP/home"
PORT=$((10000 + $(od -An -N2 -tu2 /dev/urandom) % 20000))
# `init` returns at once; the products home's background server serves the draft.
cd "$TMP"
"$BINARY" init --template everything --home "$TMP/home" --port "$PORT" --json --no-open > "$TMP/init.txt"
cat "$TMP/init.txt"
URL=$(tail -n 1 "$TMP/init.txt" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
case "$URL" in "http://127.0.0.1:$PORT/products/"*) ;; *) echo "madarch init printed no product address on port $PORT: $URL" >&2; exit 1 ;; esac
ROOT="http://127.0.0.1:$PORT/"
n=0
until curl -fsS -L "${URL}api/status" > "$TMP/status.json" 2>/dev/null && grep -q '"manifest":"not-filled"' "$TMP/status.json"; do
  n=$((n + 1))
  [ "$n" -lt 300 ] || { echo "the product's api/status never answered a manifest that is not-filled at $URL" >&2; cat "$TMP/status.json" 2>/dev/null || true; exit 1; }
  sleep 0.1
done
curl -fsS -L "$ROOT" > "$TMP/root.html"
curl -fsS -L "$URL" | grep -q '<div id="root"' || { echo "the product page at $URL is not the wiki app's HTML" >&2; exit 1; }
echo "smoke passed: root, $URL""api/status (manifest not-filled) and the wiki page answered"
