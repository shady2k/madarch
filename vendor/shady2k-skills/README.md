# Vendored: the shady2k-skills product-repository program, plugin 0.94.0

This folder holds the shady2k-skills set's product-repository program
(`skills/backlog/setup-shady2k-skills/product.mjs`), kept byte-for-byte inside
madarch so `madarch new` creates a draft through the set's pinned program
instead of creation code of its own (decision 0019: the product repository's
lifecycle — layout, `workspace.yaml`, create, rename, bootstrap — is the set's;
madarch is the server and its wiki, and bundles one pinned release of the
program as a person's front door).

- **Source:** https://github.com/shady2k/skills — plugin version 0.94.0,
  main commit `03603ab67c08df1be2640ae1f8ca1ae6c9f54dbe`
  (`skills/backlog/setup-shady2k-skills/product.mjs`; the release is what
  that tree's `.claude-plugin/plugin.json` names 0.94.0).
- **Included** (exactly what the program reads itself, nothing else):
  - `product.mjs` — the whole program, unmodified: a dependency-free Node
    library with named exports and a CLI (`--help`, `--version`,
    `--selftest`).
  - `fixtures/workspace/cases.json` — the manifest cases the program's
    `--selftest` reads from the folder beside it, and these tests read.
  - `fixtures/product/good/` — the set's complete example product folder
    (`docs/product.md`, "The product repository"), the set-made folder the
    consumer tests read and serve.
- **Not included:** the set's backlog, document and commit checks, their
  fixtures, its skills and templates — madarch installs none of them
  (decision 0019); a product repository's gate is what the set's setup
  installs in that repository, never this checkout.
- The type declarations `product.d.mts` are written in this repository
  (madarch's TypeScript reads the program through them); every other file is
  byte-identical to the commit named above, and `test/product-pin.test.ts`
  keeps them so by SHA-256.

Pinned by madarch-4fk, 2026-10-10. Upgrade by replacing this folder with the
newer release's files and updating the hashes here.
