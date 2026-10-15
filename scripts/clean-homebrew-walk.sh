#!/bin/sh
# Installs the formula against the locally built artifact; no tap or release is touched.
set -eu
BINARY=${1:?usage: clean-homebrew-walk.sh <macOS artifact>}
BINARY=$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")
TMP=$(mktemp -d)
TAP_NAME="madarch-walk/local-$$"
TAP_CREATED=0
trap 'if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; if [ "$TAP_CREATED" -eq 1 ]; then brew uninstall --formula madarch >/dev/null 2>&1 || true; brew untap "$TAP_NAME" >/dev/null 2>&1 || true; fi; rm -rf "$TMP"' EXIT
SUM=$(shasum -a 256 "$BINARY" | awk '{print $1}')
printf '%s  madarch-linux-x64\n' "$(printf '0%.0s' $(seq 1 64))" > "$TMP/SHA256SUMS.txt"
printf '%s  madarch-linux-arm64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
printf '%s  madarch-darwin-x64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
printf '%s  madarch-darwin-arm64\n' "$SUM" >> "$TMP/SHA256SUMS.txt"
bun scripts/build-formula.ts --version 0.0.1 --sums-file "$TMP/SHA256SUMS.txt" --out "$TMP/formula"
FORMULA="$TMP/formula/Formula/madarch.rb"
sed -i '' "s|^    url .*|    url \"file://$BINARY\"|" "$FORMULA"

brew tap-new --no-git "$TAP_NAME"
TAP_CREATED=1
TAP=$(brew --repo "$TAP_NAME")
cp "$FORMULA" "$TAP/Formula/madarch.rb"
brew install "$TAP_NAME/madarch"
madarch version
export GIT_AUTHOR_NAME='Madarch Homebrew Walk' GIT_AUTHOR_EMAIL='walk@example.invalid' GIT_COMMITTER_NAME='Madarch Homebrew Walk' GIT_COMMITTER_EMAIL='walk@example.invalid'
HOME="$TMP/home"; PORT=$((20000 + RANDOM % 20000)); mkdir -p "$HOME"
madarch new --home "$HOME/products" --port "$PORT" --no-open > "$TMP/new.txt" 2>&1 & PID=$!
SERVED=0
for n in $(seq 1 200); do if curl -fsS "http://127.0.0.1:$PORT/api/product" | grep -q '"id"'; then SERVED=1; break; fi; sleep .1; done
[ "$SERVED" -eq 1 ] || { cat "$TMP/new.txt"; echo 'Homebrew madarch new did not serve the graph-backed product' >&2; exit 1; }
cat "$TMP/new.txt"
PRODUCT=$(sed -n 's/^folder: //p' "$TMP/new.txt" | head -1)
kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=
PORT=$((PORT + 1))
madarch serve --product "$PRODUCT" --port "$PORT" --no-open > "$TMP/serve.txt" 2>&1 & PID=$!
SERVED=0
for n in $(seq 1 200); do if curl -fsS "http://127.0.0.1:$PORT/api/product" | grep -q '"id"'; then SERVED=1; break; fi; sleep .1; done
[ "$SERVED" -eq 1 ] || { cat "$TMP/serve.txt"; echo 'Homebrew madarch serve did not reopen the graph-backed product' >&2; exit 1; }
cat "$TMP/serve.txt"
printf 'Homebrew walk passed: brew install local release formula, madarch new, then madarch serve; graph-backed product API answered.\n'
