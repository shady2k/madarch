# Serve rebuilds the wiki app when its sources changed since the dist was built

Change: stale-dist
Base: 36aeb263c60c918c0364f810b0f8a6d63d240867
Tasks: madarch-iuc.7.1.1
Kind: behavior

## Intent
The `madarch serve` (and `wiki:demo`) kept serving the wiki app's dist built from earlier sources: it built only when the dist was absent, so after pulling newer wiki/app sources the served app stayed the old build (the owner saw the pre-landing app at 2026-10-11 10:48). After this change the build records the hash of the app's sources and lockfile into the dist, and the command compares it on every start: unchanged sources stand unrebuilt, changed sources are built again with a one-line notice before it starts, and a dist with no record (built by hand) is served as it stands.

Stories:
- As the owner pulling the checkout and serving the wiki, the app is the one the checkout's sources build, not the one an earlier build left.

## Out of scope
Nothing else in the serve flow: openers, ports, the product read and the demo product stay as they are. A watch mode (rebuilding while the user edits) is not built here.

## Rationale
The finding measured 2026-10-11 10:48 (madarch-iuc.7.1.1): pulling newer wiki/app sources on top of a checkout whose dist was built hours earlier kept serving the old app. Comparing a hash recorded at build time is the cheapest honest fix; the record lives in the dist the command itself built, so a hand-built dist without a record keeps the old trust.

## Changes to requirements
- product-wiki/app: the dist built by the command carries a record of its sources (the hash of the app's own files and lockfile); on start the command compares it: unchanged sources are served unrebuilt, changed sources are rebuilt with a one-line notice first, and a dist with no record is served as it stands.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/result: test

## Coverage
- product-wiki/app: static, test, review
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/result: test
