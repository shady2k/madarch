# `madarch init` starts a product around an existing checkout

Change: madarch-init
Base: e2ba086e73f60727033aad180468f319f5f0353d
Tasks: madarch-74k4.2.1, madarch-74k4.2.2, madarch-74k4.2.3, madarch-74k4.2.5
Kind: behavior

## Intent
Make the approved existing-checkout path one simple command and make the product wiki show the code it connects. The source checkout remains where the person works. Product data stays in the manifest and linked checkout. Product folder collisions refuse; init inside an existing product or previously linked checkout is a no-op. Version flags and both start paths are discoverable.

## Out of scope
- Moving code into the product repository or writing Madarch files into the code checkout.
- Storing repository facts in the engine.
- Changing `madarch repo add` source-selection rules.

## Preserved contracts
- product-repository/manifest: test — the manifest remains the product's source of repository declarations; URL may be absent only when `linked: true` marks an existing checkout with no origin.
- product-wiki/pages: test — product docs remain the wiki's document pages.

## Coverage
- product-repository/manifest: test
- product-repository/init: test
- product-wiki/pages: test
- product-wiki/connected-repositories: test
- product-wiki/getting-started: test

## Blocking questions
None.

## Design and decisions
- Product-folder name collisions refuse; no suffix is chosen. This avoids silently making a product whose name differs from its checkout.
- A checkout already linked is found by scanning the configured products home and comparing real paths; no engine state is added.
- Repository pages reuse the existing repo read API and renderer.
