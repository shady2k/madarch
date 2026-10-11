# The documents view: forms, links and the check on the page

Change: docs-pages
Tasks: the task this fixture stands for in the demo product
Kind: behavior

## Intent
A reader of the notes home sees, on every page, what the set's forms say
about it: its kind, its fields, what it grew from, who links to it — and
where the set's check refuses it, what and where.

## Out of scope
Writing from the wiki; the model side; several products per server.

## Changes to requirements
- product-wiki (new requirement): the documents view, the header block,
  the link rows and the check findings on the page that fails.

## Preserved contracts
product-wiki/pages: unchanged; the pages are the same files as before.
product-wiki/live: unchanged; a saved file still reaches the page.

## Coverage
- product-wiki/front-matter: test
- product-wiki/findings: test

## Blocking questions
None.

## Design and decisions
See the design record beside this change.
