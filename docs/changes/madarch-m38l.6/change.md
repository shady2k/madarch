# Every entity has a page: use cases, rules and decisions of the documents, every kind the extractors read, a catalogue of kinds, tabs and a statement view

Change: madarch-m38l.6
Base: 232d109d94150c2bd8f6d30eb0916ce6036ae880
Tasks: madarch-m38l.6
Kind: behavior

## Intent
The owner walked the wiki on 2026-10-23: a use case ground opened bare Markdown, the pages did not show all the entities the product has, the footnote numbers made every line unreadable, and the first version's tabs were missed. This change gives the documents' identified items (use cases, rules, decisions, glossary terms) pages of their own, declares every kind the extractors read in the starter manifest with a template and a group, adds the catalogue of kinds with counts and origins, brings in-wiki tabs, and presents a statement plainly with a statement view that shows each ground's excerpt.

## Out of scope
- Recording a correction (madarch-m38l.8's neighbour madarch-m38l.7): the statement view shows the place, disabled.
- Reading the Markdown through the graph's index (madarch-m38l.8) and the links to the code host (its web-link module): this change reads the Markdown as the engine does today and leaves the slot for the host link.
- Diagram blocks (`:::graph`, `:::sequence`; madarch-m38l.9).
- Real agent runs.

## Rationale
The kinds manifest is the product's data (decision 0029), so the new `document` source, the `group` of a kind, and the `documents.exclude` list are manifest fields, and the engine names no kind, folder or file. Document entities are read on request from the documents (deterministic: headings, leading bold identifiers, list-item terms) and are not stored in the graph, so a rebuild loses nothing and the index of madarch-m38l.8 can replace the reading later.

## Changes to requirements
- product-wiki/entity-pages (absent on the target): add. Complete proposed text in `capabilities/product-wiki.md`.
- product-wiki/statement-view (absent on the target): add. Same file.

## Preserved contracts
- product-wiki/serve: the routes keep their addresses; routes are added.
- product-wiki/documents: a document ground to a section that is no entity still opens the document at its anchor.

## Coverage
- product-wiki/serve: test
- product-wiki/documents: test
- product-wiki/entity-pages: test
- product-wiki/statement-view: test

## Where it is seen

Kind: screen
Place: the wiki of the generated training repository's product, its navigation, a use case page, the catalogue and a statement tab
Mockup: none; the pictures are the evidence

1. The person opens the navigation and sees the kinds in groups with counts, and the catalogue page listing each kind with its description, count and origin.
2. They follow a ground on UC-2 and land on the use case's page with its text, where it is stated, what implements it and what links to it.
3. They open several pages, which stand as tabs; they click a sentence and a tab opens with its grounds and excerpts.

## Blocking questions
None.

## DONE WHEN
On the training repository every kind in the graph is reachable from the navigation, a UC/BR/ADR ground opens its entity page, and the answer key's items whose `mustShow` names these kinds are visible on their pages; screenshots in ru and en.
