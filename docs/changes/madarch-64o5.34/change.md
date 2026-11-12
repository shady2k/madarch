# One honest pre-fill home and action controls

Change: madarch-64o5.34
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.34
Kind: behavior

## Intent
One home card explains the actual empty product state and offers a real Fill… button. Navigation remains destination-labelled; action controls use kit Buttons throughout the wiki app.

## Out of scope
Changing fill execution, splitting plugins by code/agent, real model calls, a natural-language imperative word list.

## Changes to requirements
- product-wiki/shell: one pre-fill card, kit action button and persistent Fill navigation; actions are not links.

## Preserved contracts
None.

## Coverage
- product-wiki/shell: static test review

## Where it is seen
Kind: request
Place: home before a fill, sidebar, and wiki app page controls

1. Open a scripted fixture product before filling, in English and Russian.
2. Read one card describing creation, connected code and empty graph.
3. Press Fill…: the Fill page opens without running a model or a fill.
4. Read the sidebar Fill entry next to catalogue/glossary.
5. Review every app page's controls; actions are kit Buttons and links name destinations.

## Blocking questions
None.

## Acceptance evidence
Red proofs `/tmp/q34-home-red.log` and `/tmp/q34-pages-red.log`; regression coverage `wiki/app/src/knowledge/layout.test.tsx`, `action-navigation.test.tsx`, and `repository.test.tsx`. Full page-source audit: `/tmp/q34-page-audit.md`; independent inventory: `/tmp/q34-review-links.md`. Focused tests and native checks are recorded in `/tmp/madarch-64o5.34-report.md`. Mutation: not-made. No owner approval is recorded here. A semantic imperative-label checker without a vocabulary is not reliable; this limitation is explicit rather than a word-list heuristic.
