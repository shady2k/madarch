# Empty product home getting-started guidance

Change: empty-home-guidance
Base: 0dc263cfe664889590485366fa66144a1038a511
Tasks: madarch-kyi6
Kind: behavior

## Intent
When a person opens the wiki for a folder with no product pages, give them
short next steps instead of leaving them with only an empty-state message.
`madarch serve` shall also serve an existing folder without `workspace.yaml` as
an empty home, so the person can read the guidance there. The fallback is
read-only and temporary: it supplies only the directory's basename as the
home's display name, without a product id, manifest, or sample documents.
Explain what a product repository is. Name only the working steps `madarch new`
and `setup-shady2k-skills`; offer the demo by running
`git clone https://github.com/shady2k/madarch-product` followed by
`madarch serve --product madarch-product`. Keep the instructions in the
reader's English or Russian locale.

The approved task behavior is to show this short, localized guide when a
folder opened for serving has no product pages, including when no manifest is
available; setup writes the workspace manifest and product documents, and the
demo uses the published madarch product repository.

## Out of scope
- Product sample data or manifest-driven completeness behavior (`product-completeness-snapshot`, madarch-d7v3.2).
- Changes to `readProduct`, manifest validation, or product lifecycle commands; they continue to refuse a folder without `workspace.yaml`.

## Changes to requirements
- product-wiki/pages (replaced): an empty home keeps its no-pages message and adds localized, functional getting-started instructions, including when the server opens an existing folder without a manifest.
- product-wiki/serve (replaced): `madarch serve` may serve an existing directory with no `workspace.yaml` using a temporary display name but no product id, without writing files; invalid manifests and non-directories remain refused.
- product-wiki/result (replaced): an existing directory without a manifest is served read-only as an empty home; missing paths and present unreadable or invalid manifests remain refused.

## Preserved contracts
- product-repository/manifest: test — manifest recognition and refusal behavior remain strict for lifecycle commands and the manifest reader.

## Coverage
- product-wiki/pages: test, browser-walk
- product-wiki/serve: test, browser-walk
- product-wiki/result: test
- product-repository/manifest: test

## Blocking questions
None.
