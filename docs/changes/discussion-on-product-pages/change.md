# Comments on a product wiki page

Change: discussion-on-product-pages
Base: 195aaff555992397e802e522dc136d592662c088
Tasks: madarch-y781.2.1, madarch-y781.2.2
Kind: behavior

## Intent
A reader can select text on a served product page, save a discussion message, see it beside the anchored text and find it again after reload. The product repository remains the source of truth; its v1 message file and hidden source markers are committed together and pushed. The first stage implements the first-comment vertical path. Later stages add replies/resolution/page-level and lost-anchor behavior and then derived graph queries.

## Out of scope
Editing or deleting messages, mentions, notifications, server-mode users and permissions, linking discussions to tracker items, and any publication outside this repository.

## Changes to requirements
- product-repository/discussion-writes (added): the server validates and atomically commits/pushes the v1 message file and corresponding source markers.
- product-wiki/discussions (added): the reader can comment on selected text and see the first message and highlight beside it.
- server/discussion-writes (added): the product wiki server safely validates and persists comment actions within the selected product repository.

## Preserved contracts
- product-repository/contract: published registry and generic document-field contracts stay unchanged.
- product-repository/manifest: the manifest remains the product identity and repository-declaration contract.

## Coverage
- product-repository/discussion-writes: test, contract:check
- product-repository/contract: test, contract:check
- product-repository/manifest: test
- product-wiki/discussions: test, browser E2E
- server/discussion-writes: test, real-server E2E, contract:check

## Rationale
This change implements the first discussion path without changing the published v1 message schema. It follows decision 0017: authored Markdown and discussions remain in the product git, with each action an independent commit. The graph remains derived under decision 0023.
