# madarch demo clones and serves the Madarch product repository

Change: madarch-n5ip
Base: 4fcd04fd9d790bb0983377bdafe4670ee8022850
Tasks: madarch-n5ip
Kind: behavior

## Intent
Let a reader or engineer open Madarch's own product wiki with one command. Keep the product's content in its upstream repository, not in the engine checkout. The reader's empty-home offer shall use the command in their selected language.

## Out of scope
Shipping product content in the engine; changing the generic `madarch clone` lifecycle; translating product documents; changing how the wiki serves a product.

## Changes to requirements
- `product-repository`: add the `demo` requirement and the `demo-clone`, `demo-update`, `demo-offline` and `demo-conflict` scenarios in `capabilities/product-repository.md`.
- `product-wiki`: change `pages` so it only promises the empty-state message, replacing its old clone-and-serve guide; add `empty-home-guidance` to offer `madarch demo` in English or Russian for products with no pages, with or without a manifest.

## Preserved contracts
- product-repository/manifest: the upstream product remains a normal product repository read by the existing manifest reader.
- product-wiki/serve: the existing server serves the clone without changing its read-only behavior.

## Coverage
- product-repository/demo: product-demo
- product-wiki/pages: app-demo-guide
- product-wiki/empty-home-guidance: app-demo-guide
- product-repository/manifest: product-lifecycle
- product-wiki/serve: product-cli, server-wiki

## Blocking questions
None.

## Design and decisions
`madarch demo` owns the fixed upstream and the existing products-home resolution. An absent clone is made in a per-run temporary folder, checked as a product, then installed only after an exclusive destination reservation; a failed clone removes only its own temporary folder. An existing clone is accepted only when it is a repository of its own with the expected `origin`, and updated with `git pull --ff-only`. The wiki is then served through the existing command path. Tests use a local bare repository; only the acceptance walk contacts GitHub.

## Acceptance evidence
To be recorded on the task after checks and independent review.

## DONE WHEN
`madarch demo` clones and serves the upstream product when absent, fast-forwards and serves it on a later run, and on network failure names the network and offers `madarch new`; the embedded Fieldnote product and its command are removed; the reader's empty-home instruction is `madarch demo` in English or Russian.
