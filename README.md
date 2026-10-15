# madarch

Each product's knowledge — its documents, its intended model, its skills,
its prototypes, the wiki that serves them — is a git repository of its own,
apart from the product's code. The `madarch` command creates it, names it,
joins into it the code repositories it spans, and serves its wiki; the same
repository, cloned by a colleague, comes with its code checked out under
`repos/` already.

## Install

The primary install is npm (Node.js 18 or newer):

    npx madarch new gadgets

On macOS, Homebrew is also supported:

    brew install shady2k/tap/madarch

Or install from the release script: `curl -fsSL https://raw.githubusercontent.com/shady2k/madarch/main/scripts/install.sh | sh` (Linux/macOS), or run `scripts/install.ps1` in PowerShell (Windows x64). Linux needs OpenSSL 3 runtime libraries (`libssl.so.3` and `libcrypto.so.3`). `madarch new` creates and commits a Git repository, so Git and a configured Git author identity are required. Windows arm64 is not supported.

## Existing

- [Start a product from the repositories you already have](docs/guides/start-a-product.md):
  install madarch, create the product's repository, add your existing
  repositories, push, clone as a second engineer, open the wiki, start the
  work with your agent.
- `AGENTS.md`: the way this repository itself is worked — the skill set's
  tracker, gates and checks.
- `madarch demo`: clones or updates the Madarch product repository and serves
  its wiki.
- `docs/system/index.md`: the capability specifications, one file per
  capability. `docs/decisions/`: the decisions the system stands on.
