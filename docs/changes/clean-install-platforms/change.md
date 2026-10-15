# Clean installs across supported platforms

Change: clean-install-platforms
Base: 195aaff555992397e802e522dc136d592662c088
Tasks: madarch-lfhu.2.8
Kind: behavior

## Intent
A person on a clean supported machine can install madarch with `npx`, Homebrew or the install script and create and serve a product with the graph store open. Release builds cover Linux and macOS x64/arm64 and Windows x64. No release, npm publication, tag or tap push is part of this task.

## Out of scope
Publishing or proving `HOMEBREW_TAP_TOKEN` scope; Windows arm64; changing runtime product-data rules; `madarch repo add`.

## Changes to requirements
- release-binary: the release platforms, supported platform installer behavior, npm/Homebrew/script install commands, and graph-store smoke are revised in the complete proposal `capabilities/release-binary.md`.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- release-binary/version: static, test, mutation, review
- release-binary/upgrade: static, test, mutation, review
- release-binary/installers: static, test, mutation, review
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
