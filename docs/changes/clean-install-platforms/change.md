# Clean installs across supported platforms

Change: clean-install-platforms
Base: f2f30afb9e5f36a8dc5fa7f53dc3be86ceb5f91d
Tasks: madarch-lfhu.2.2, madarch-lfhu.2.3, madarch-lfhu.2.5, madarch-lfhu.2.6
Kind: behavior

## Intent
A person on a clean supported machine can install madarch with `npx`, Homebrew or the install script and create and serve a product with the LadybugDB graph store open. Release builds cover Linux and macOS x64/arm64 and Windows x64. No release, npm publication, tag or tap push is part of this task.

## Out of scope
Publishing or proving `HOMEBREW_TAP_TOKEN` scope; Windows arm64; changing runtime product-data rules; `madarch repo add`.

## Changes to requirements
- release-binary: the release platforms, supported Linux OpenSSL runtime requirement and installer behavior, npm/Homebrew/script install commands, positional `npx madarch new <name>` install walk, and graph-store smoke are revised in the complete proposal `capabilities/release-binary.md`.
- product-repository/draft: optional portable folder name for `madarch new`, exact-name creation, and refusal on invalid or occupied names are revised in the complete proposal `capabilities/product-repository.md`.

## Preserved contracts
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- release-binary/version: static, test, mutation, review
- release-binary/upgrade: static, test, mutation, review
- release-binary/installers: static, test, mutation, review
- product-repository/draft: static, test, mutation, review
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
