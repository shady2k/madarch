# Purpose sections in the sidebar

Change: madarch-64o5.19
Base: 7655873c08b9cda8f1ed24d229beba077d62b777
Tasks: madarch-64o5.19
Kind: behavior

## Intent
Try a purpose vocabulary in the manifest, with one purpose per starter kind.
The sidebar groups populated kinds by that vocabulary and filters them by audience.
The catalogue keeps its standards groups.

## Rationale
The owner asked to try a separate purpose attribute, not copy another product blindly.
The first five sections are Understand, Structure, Quality, Operations and History.
Their labels and order are manifest data, subject to the owner's visual judgment.

## Out of scope
- Agent conclusions and system prompt.
- Replacing catalogue standards groups or changing aggregate facts.

## Changes to requirements
- product-wiki/purpose-sidebar: purpose vocabulary, kind classification, populated audience-filtered sidebar.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/catalog: test/knowledge-catalog-view.test.ts

## Coverage
- product-wiki/catalog: test
- product-wiki/purpose-sidebar: static, test, mutation, review

## Where it is seen
Kind: screen
Place: Sidebar of a filled product, roles Everything and developer
Mockup: docs/prototypes/madarch-64o5.19/sidebar.html

1. Open a filled product with Everything selected and read the five purpose sections.
2. Select developer; only populated kinds for that audience remain.
3. Rename and reorder purposes in the manifest, publish and refresh.
4. Open Catalogue: its standards groups are unchanged.

## Blocking questions
- The owner judges the proposed classification and sidebar after seeing the screenshots.
