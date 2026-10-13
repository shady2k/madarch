# Design: clean installs on supported platforms

## Context and drivers
The outcome is an installable CLI for people on clean machines. Current `main` uses PGlite (WebAssembly) for the embedded graph store; it has no LadybugDB native addon, SQLite store, or system-OpenSSL runtime requirement. The release needs a compiled binary, platform packages, local and hosted install walks, checksum validation, upgrade support, and a Homebrew formula. `madarch new` needs Git and a configured author identity because it commits the created product skeleton.

## Decision
Keep the existing one-binary-per-platform distribution and install paths. Build and test Linux x64, macOS arm64, and Windows x64 on their native runners. The compiled binary includes the wiki app and opens PGlite itself; the clean walk installs the built artifact, then exercises `new` and `serve`. The npm walk packs and installs local wrapper/platform packages without publishing. The Homebrew walk uses a disposable local tap and never writes to the public tap. The release's public tap update remains a separate tag-only action; this task does not run it.

## Consequences and assumptions
- No native-addon extraction, native-addon cache repair, or OpenSSL runtime probing is required or retained.
- Windows arm64 is not built by this release and is refused by name; the supported Windows artifact is x64.
- `new` requires Git and an identity. Walks set identity only in their isolated child environment and do not change global settings.
- Branch clean-install walks do not publish a GitHub release, npm package, or Homebrew formula.
