#!/bin/sh
# Installs the formula against the locally built artifact; no tap or release is touched.
set -eu
BINARY=${1:?usage: clean-homebrew-walk.sh <platform artifact>}
BINARY=$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")
TMP=$(mktemp -d)
TAP_NAME="madarch-walk/local-$$"
TAP_CREATED=0
trap 'if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; if [ "$TAP_CREATED" -eq 1 ]; then brew uninstall --formula madarch >/dev/null 2>&1 || true; brew untap "$TAP_NAME" >/dev/null 2>&1 || true; fi; if [ -n "${ORIGINAL_PATH:-}" ]; then PATH=$ORIGINAL_PATH; export PATH; fi; rm -rf "$TMP"' EXIT
ORIGINAL_PATH=$PATH
case "$(uname -s)" in
  Linux) SUM=$(sha256sum "$BINARY" | awk '{print $1}') ;;
  Darwin) SUM=$(shasum -a 256 "$BINARY" | awk '{print $1}') ;;
  *) echo "unsupported Homebrew walk OS: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -s)" in
  Linux)
    printf '%s  madarch-linux-x64\n' "$SUM" > "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-linux-arm64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-darwin-x64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-darwin-arm64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
    ;;
  Darwin)
    printf '%s  madarch-linux-x64\n' "$(printf '0%.0s' $(seq 1 64))" > "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-linux-arm64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-darwin-x64\n' "$(printf '0%.0s' $(seq 1 64))" >> "$TMP/SHA256SUMS.txt"
    printf '%s  madarch-darwin-arm64\n' "$SUM" >> "$TMP/SHA256SUMS.txt"
    ;;
esac
bun scripts/build-formula.ts --version 0.0.1 --sums-file "$TMP/SHA256SUMS.txt" --out "$TMP/formula"
FORMULA="$TMP/formula/Formula/madarch.rb"
python3 - "$FORMULA" "$BINARY" <<'PY'
from pathlib import Path
import sys
formula = Path(sys.argv[1])
binary = Path(sys.argv[2]).resolve()
text = formula.read_text()
lines = text.splitlines()
for index, line in enumerate(lines):
    if line.startswith('  url '):
        lines[index] = f'    url "file://{binary}"'
        break
else:
    raise SystemExit('generated formula has no platform url line')
formula.write_text('\n'.join(lines) + '\n')
PY

brew tap-new --no-git "$TAP_NAME"
TAP_CREATED=1
TAP=$(brew --repo "$TAP_NAME")
cp "$FORMULA" "$TAP/Formula/madarch.rb"
brew install "$TAP_NAME/madarch"
PREFIX=$(brew --prefix madarch)
MADARCH="$PREFIX/bin/madarch"
[ -x "$MADARCH" ] || { echo "Homebrew did not link an executable at $MADARCH" >&2; exit 1; }
"$MADARCH" version
madarch() { "$MADARCH" "$@"; }
export GIT_AUTHOR_NAME='Madarch Homebrew Walk' GIT_AUTHOR_EMAIL='walk@example.invalid' GIT_COMMITTER_NAME='Madarch Homebrew Walk' GIT_COMMITTER_EMAIL='walk@example.invalid'
export HOME="$TMP/home"; mkdir -p "$HOME"
# new returns at once: the products home's background server serves the draft,
# so the walk reads the address the command printed instead of waiting on a
# foreground that no longer exists.
PORT=$(($(od -An -N2 -tu2 /dev/urandom) % 20000 + 20000))
madarch new --json --home "$HOME/products" --port "$PORT" --no-open > "$TMP/new.txt" 2>&1
cat "$TMP/new.txt"
URL=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read().splitlines()[-1])["url"])' < "$TMP/new.txt")
PRODUCT=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read().splitlines()[-1])["folder"])' < "$TMP/new.txt")
case "$URL" in *":$PORT/"*) ;; *) echo "Homebrew madarch new served at $URL, not on the port $PORT it was given" >&2; exit 1 ;; esac
SERVED=0
for n in $(seq 1 200); do if curl -fsS "${URL}api/product" | grep -q '"id"'; then SERVED=1; break; fi; sleep .1; done
[ "$SERVED" -eq 1 ] || { cat "$TMP/new.txt"; echo "Homebrew madarch new did not serve the graph-backed product at $URL" >&2; exit 1; }
# The server stays up until it is stopped: the walk stops it, then serves the
# product again in the foreground.
madarch stop --home "$HOME/products"
madarch serve --product "$PRODUCT" --port 0 --no-open > "$TMP/serve.txt" 2>&1 & PID=$!
ADDRESS=
for n in $(seq 1 200); do
  ADDRESS=$(sed -n 's/^\(The wiki is running at\|Wiki:\) \(http[^ ]*\).*/\2/p' "$TMP/serve.txt" | head -1)
  [ -n "$ADDRESS" ] && break
  sleep .1
done
[ -n "$ADDRESS" ] || { cat "$TMP/serve.txt"; echo 'Homebrew madarch serve printed no address for the product it serves' >&2; exit 1; }
case "$ADDRESS" in */) ;; *) ADDRESS="$ADDRESS/" ;; esac
SERVED=0
for n in $(seq 1 200); do if curl -fsS "${ADDRESS}api/product" | grep -q '"id"'; then SERVED=1; break; fi; sleep .1; done
[ "$SERVED" -eq 1 ] || { cat "$TMP/serve.txt"; echo "Homebrew madarch serve did not reopen the graph-backed product at $ADDRESS" >&2; exit 1; }
cat "$TMP/serve.txt"
printf 'Homebrew walk passed: brew install local release formula, madarch new (served by the background server on the port it chose), madarch stop, then madarch serve; graph-backed product API answered.\n'
