# The product's documents in the set's forms, linked both ways, with the check's findings on the page

Change: docs-pages
Base: 36aeb263c60c918c0364f810b0f8a6d63d240867
Tasks: madarch-fe1.1
Kind: behavior

## Intent
The wiki reads each of the set's document kinds from the product's docs
folder: a page carries its kind, its form's fields and links in a calm
header block, the pages it grew from, and a "Linked from" section computed
across the product's documents. The set's own product check runs at serve
time, once per product revision, and its findings — rule, file, line, the
words — stand on the page that fails them. The sidebar groups the
documents by the set's kinds in the set's life-cycle order. A page the set
names not at all keeps the plain page behaviour it had.

## Out of scope
Writing from the wiki; the editor; the model's pages; several products per
server; the static Starlight export; validating any form of the set's own
(the check belongs to the set; the wiki only runs it).

## Changes to requirements
- product-wiki/front-matter (new requirement): the documents view — the set's document kinds read from the pages' forms, the header block with the form's fields, the grown-from and "Linked from" rows, the set's check's findings on the failing page, and the navigation's kind groups in the set's life-cycle order (the shell's grouping wording and the reading blocks this requirement carries are part of it).

## Preserved contracts
- product-wiki/pages: the pages are the same files as before
- product-wiki/serve: the command's surface and refusals are as before
- product-wiki/app: the app still reads only the API
- product-wiki/result: served, opened or refused, and why
- server/serves-wiki: the page answer carries the new fields beside the old ones
- product-wiki/internationalization: the new labels ride the existing catalogues in both languages

## Coverage
- product-wiki/front-matter: test
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- server/serves-wiki: test
- product-wiki/internationalization: test

## Blocking questions
None.

## Design and decisions
The set's kinds, their order and the fields each carries are read from the
set at its HEAD (the set's references and its check 0.44.0): the chain —
vision, source, hypothesis, user story, use case, product requirement,
open question, prototype, result — the practice kind (active first, retired
apart), and the project documents the set's templates write (roadmap,
milestone, change and design records, decision records, the architecture,
capability documents, the exploration note). The check runs as one child
per product revision through the checkout's installed check (the set's own
script, refreshed to the set's HEAD text in this change); where the check
cannot run the wiki names that on the page instead of passing the product
as checked. Backlinks match link fields first, then ids the body names,
then the wiki addresses the body spells — conservative, per line.
