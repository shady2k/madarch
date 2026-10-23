#!/bin/sh
# The release smoke of one madarch binary (madarch-m38l.4 left one wiki app):
# version, list, then `new` in a scratch home and the wiki read the way a reader
# reaches it - the root answers (a redirect to the product is followed), the
# product's /api/k/status answers with a manifest that is ok, and the product's
# page is the wiki app's HTML. The home's server is stopped at the end.
# Usage: scripts/smoke-binary.sh <binary>
set -eu
BINARY=$1
TMP=$(mktemp -d)
trap '"$BINARY" stop --home "$TMP/home" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BINARY" version
"$BINARY" list --home "$TMP/home"
PORT=$((10000 + $(od -An -N2 -tu2 /dev/urandom) % 20000))
# `new` returns at once; the products home's background server serves the draft.
"$BINARY" new --home "$TMP/home" --port "$PORT" --json --no-open > "$TMP/new.txt"
cat "$TMP/new.txt"
URL=$(tail -n 1 "$TMP/new.txt" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
case "$URL" in "http://127.0.0.1:$PORT/products/"*) ;; *) echo "madarch new printed no product address on port $PORT: $URL" >&2; exit 1 ;; esac
ROOT="http://127.0.0.1:$PORT/"
n=0
until curl -fsS -L "${URL}api/k/status" > "$TMP/status.json" 2>/dev/null && grep -q '"manifest":"ok"' "$TMP/status.json"; do
  n=$((n + 1))
  [ "$n" -lt 300 ] || { echo "the product's api/k/status never answered a manifest that is ok at $URL" >&2; cat "$TMP/status.json" 2>/dev/null || true; exit 1; }
  sleep 0.1
done
curl -fsS -L "$ROOT" > "$TMP/root.html"
curl -fsS -L "$URL" | grep -q '<div id="root"' || { echo "the product page at $URL is not the wiki app's HTML" >&2; exit 1; }
echo "smoke passed: root, $URL""api/k/status (manifest ok) and the wiki page answered"
