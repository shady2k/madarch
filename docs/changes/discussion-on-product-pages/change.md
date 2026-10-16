# Comments on a product wiki page

Change: discussion-on-product-pages
Base: e2ba086e73f60727033aad180468f319f5f0353d
Tasks: madarch-y781.2.1, madarch-y781.2.2, madarch-y781.3.1
Kind: behavior

## Intent
A reader can open a discussion on a served product page, reply in the thread, resolve it and show resolved threads again, add a page-level comment, and recover a lost selection anchor. Discussions remain in the product repository as v1 message files; each action is one commit and push. At narrow widths, discussions are available in a panel. This change carries the first-comment path and the y781.3 thread-action and recovery behavior; derived graph queries are a later stage.

## Out of scope
Editing or deleting messages, mentions, notifications, server-mode users or permissions, linking discussions to tracker items, and any publication outside this repository.

## Changes to requirements
- product-repository/discussion-writes (added): the server validates and commits/pushes the v1 message file and, for a first selection comment, its corresponding source markers. Replies and status changes append message files without changing the document; each action is one commit.
- product-wiki/discussions (added): a reader can comment on selected text or at page level, reply, resolve and show resolved discussions, see a lost selection with its saved quote, restore its end by the saved quote or place it again, and use the responsive discussions panel.
- server/discussion-writes (added): the product wiki server safely validates and persists first comments, page comments, replies, and resolve actions within the selected product repository; reads distinguish page anchors and lost selection anchors.

## Preserved contracts
- product-repository/contract: published registry and generic document-field contracts stay unchanged.
- product-repository/manifest: the manifest remains the product identity and repository-declaration contract.
- product-repository/discussions: the published v1 message schema, paths and marker syntax stay unchanged.

## Coverage
- product-repository/discussion-writes: test, contract:check
- product-repository/contract: test, contract:check
- product-repository/manifest: test
- product-repository/discussions: test, contract:check
- product-wiki/discussions: test, browser E2E, real-server
- server/discussion-writes: test, real-server E2E, contract:check

## Rationale
The stage extends the first-comment path without changing the published v1 message schema. Replies and state changes are separate message-file actions; page comments have a page anchor and no source markers. Selection markers remain on the document only for selected-text anchors, so removing both markers can be represented and recovered without treating a page comment as lost. The authored discussion remains in product git under decision 0017; the graph remains derived under decision 0023.
