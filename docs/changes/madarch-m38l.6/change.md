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

## Coverage
- product-wiki/serve: test
- product-wiki/entity-pages: test
- product-wiki/statement-view: test

## Where it is seen

Kind: screen
Place: the wiki of the generated training repository's product, its navigation, a use case page, the catalogue and a statement tab
Mockup: docs/prototypes/madarch-m38l.6/uc-2-en.png

1. The person opens the navigation and sees the kinds in groups with counts, and the catalogue page listing each kind with its description, count and origin.
2. They follow a ground on UC-2 and land on the use case's page with its text, where it is stated, what implements it and what links to it.
3. They open several pages, which stand as tabs; they click a sentence and a tab opens with its grounds and excerpts.

## Blocking questions
None.

## Acceptance evidence
Run on the SkyPilot pod (`madarch-sky-test --avx2`) on 2026-10-23, fixtures only (the generated training repository, the fake ACP agent).
- `bun run check` and wiki/app `bun run check` exit 0; wiki/app `bun test` 83 pass; the knowledge and product-wiki test files (395 tests, among them knowledge-vertical, which fills the training repository and reads every graph kind's first three entities with no problem block and no finding, the answer-key items UC-1..UC-4, BR-1..BR-5, ADR-0001/0002, seven glossary terms, compose services, Dockerfiles, CI jobs, DATABASE_URL, the lodash pin, migration order) pass.
- Screenshots in ru and en of the catalogue, every document kind, one page of each family of graph kinds, the use-case list, an agent page plain and with grounds, the statement tab among three tabs, a statement without ground, a phone width and the documents list (`bun scripts/knowledge-shots.ts --only entities --lang ru|en`); looked at, two defects fixed after the first look (the statement paragraph showed its own sentence as ungrounded; the navigation and the catalogue counted a group differently).
- The index of madarch-m38l.8 is read for the backlinks of a document entity, the other statements that rely on a statement's grounds, and the statement counts of the catalogue; `webLink` fills "Open in GitHub" beside every code place when the repository has a remote. A snapshot is now made after the index publishes, because without an agent no later snapshot carried it.
- A read-only Codex review found nine defects (a `docs` link out of the product was read for entities, sentence cutting differed between the app and the engine for formatted text, a nested list after a blank line was lost, links in a document entity showed as broken, repeated sentences got the first one's grounds, implementation lookup ignored the document's repository, document reading was not memory-bounded, a tab forgot a section anchor, a test could not fail): all fixed with tests.
- Known limits: a module page has no "purpose" (the graph holds none); the code comments that name a rule by id (BR-1 in pricing.go) are not read; the statement id is its text and turn, not the footnote name.

## DONE WHEN
On the training repository every kind in the graph is reachable from the navigation, a UC/BR/ADR ground opens its entity page, and the answer key's items whose `mustShow` names these kinds are visible on their pages; screenshots in ru and en.
