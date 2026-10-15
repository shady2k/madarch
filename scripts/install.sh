#!/bin/sh
# Installs the madarch release binary for this platform (madarch-lfhu).
#
#   curl -fsSL https://raw.githubusercontent.com/shady2k/madarch/main/scripts/install.sh | sh -s -- [version]
#   brew install shady2k/tap/madarch (macOS)
#
# or with a checkout: sh scripts/install.sh [version]
#
# The binary comes from the release the repository carries, is checked
# against the release's own SHA256SUMS.txt, and is laid in /usr/local/bin
# when that is writable (as root or with write access), else in ~/.local/bin.
# Nothing else is installed: the wiki app rides inside the binary.
#
# Exits 0 installed, 2 not applicable (no release artifact for this
# platform), 1 when a step failed (download, checksum, or the write of the
# binary); every refusal names what was wrong.

set -eu

REPO=shady2k/madarch
VERSION=${1:-}
# When no release exists yet (or the walk is offline), MADARCH_RELEASE_BASE points
# at a file:// tree shaped like the release: the artifact and SHA256SUMS.txt.
PREFIX=${MADARCH_INSTALL_PREFIX:-}
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Linux) RELEASE_OS=linux ;;
  Darwin) RELEASE_OS=darwin ;;
  *) echo "madarch publishes binaries for Linux and macOS, amd64 and arm64 (https://github.com/$REPO/releases): this runs $OS" >&2; exit 2 ;;

esac
case "$ARCH" in
  x86_64) RELEASE_ARCH=x64 ;;
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  *) echo "madarch publishes binaries for amd64 and arm64: this machine's architecture is $ARCH" >&2; exit 2 ;;
esac
ARTIFACT=madarch-$RELEASE_OS-$RELEASE_ARCH

if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
  if [ -z "$VERSION" ]; then
    echo "the newest release of $REPO could not be read; name one: $0 vX.Y.Z" >&2
    exit 1
  fi
fi
BASE=${MADARCH_RELEASE_BASE:-https://github.com/$REPO/releases/download/$VERSION}

TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/madarch-install-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

echo "downloading $BASE/$ARTIFACT"
curl -fsSL -o "$TMPDIR/$ARTIFACT" "$BASE/$ARTIFACT"

SUM=$(curl -fsSL "$BASE/SHA256SUMS.txt" | grep -F "$ARTIFACT" | awk '{print $1}')
if [ -z "$SUM" ]; then
  echo "the release's SHA256SUMS.txt carries no line for $ARTIFACT; refusing the download" >&2
  exit 1
fi
GOT=$(sha256sum "$TMPDIR/$ARTIFACT" 2>/dev/null | awk '{print $1}')
if [ -z "$GOT" ]; then
  GOT=$(shasum -a 256 "$TMPDIR/$ARTIFACT" | awk '{print $1}')
fi
if [ "$GOT" != "$SUM" ]; then
  echo "the downloaded $ARTIFACT does not match its checksum: expected $SUM got $GOT; nothing was installed" >&2
  exit 1
fi

if [ -z "$PREFIX" ]; then
  if [ -w /usr/local/bin ] && [ -d /usr/local/bin ]; then
    PREFIX=/usr/local
  else
    PREFIX=$HOME/.local
  fi
fi
TARGET=$PREFIX/bin/madarch
mkdir -p "$PREFIX/bin"
install -m 0755 "$TMPDIR/$ARTIFACT" "$TARGET"

echo "installed madarch $VERSION at $TARGET"
"$TARGET" version || true
if [ "$PREFIX" = "$HOME/.local" ]; then
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) echo "note: $PREFIX/bin is not on this shell's PATH; add it" ;;
  esac
fi
