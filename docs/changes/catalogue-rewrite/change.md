# Say what every kind is, carry the tracker's work and the team's ways of working

Change: catalogue-rewrite
Base: a6382f4dcf4994130186f8a504f69c2b48352856
Tasks: madarch-64o5.68
Kind: behavior

## Intent
The catalogue shall describe the world in plain words: every kind's definition and descriptions say what the thing is, never how madarch obtains, stores or shows it. The same catalogue shall carry the work the tracker holds, the team's ways of working and the value sets its fields take, so one catalogue is the product's whole model. In Russian the product backlog is «бэклог продукта» and its items are «элементы бэклога».

## Rationale
The owner read the Repository kind's description and asked what filling and extractors had to do with it, then asked for the same correction for every kind. The tracker is madarch's own area of entity kinds, not a separate part; its export fields must have a home in the catalogue. Repeated mistakes become practices, code rules become conventions, and agents need skills and one constitution. Closed sets of values need one place and one identity, not repeated text.

## Out of scope
- Engine behavior beyond publishing the declared starter value sets at start.
- New UI components or changes to the wiki app.
- Migrating the tracker's data or changing the take-task and close-out tooling.
- Owner approval, stage acceptance or task closure.

## Changes to requirements
- product-wiki/catalog: the starter catalogue holds the tracker's work kinds, the ways of working and value sets, and every kind's words say what the thing is.
- product-wiki/catalog: the manifest's `values:` declares the starter sets, and the product's start writes them as value-set and value-set-entry entities through the graph writer.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/pages: an entity page reads the graph and its backlinks, never a second interpretation of the product files.

## Coverage
- product-wiki/catalog: test, static, review
- product-wiki/pages: test, static, review

## Where it is seen
Kind: screen
Place: the catalogue and kind pages
Mockup: docs/prototypes/madarch-m38l.6/catalogue-en.png

1. Open the catalogue: the work kinds, the ways of working and the value sets are listed with their names in the interface language.
2. Open a work kind's page: its fields name the tracker's id, title, description, status, priority, issue type, labels, assignee, owner, dates, close reason, dependencies and comments.
3. Open a value set entry's page: its labels, description and order stand there, and its backlinks name the entities that hold it.
4. Read the Russian interface: the backlog is «бэклог продукта», and its items are «элементы бэклога».

## Blocking questions
None.

## Acceptance evidence
- `bun run check:catalog` reads 526 kinds, 83 with a page, and reports no finding; both starter templates are clean.
- `test/catalog-descriptions.test.ts` passes: no kind's definition or description holds a word about how madarch obtains the thing, and every kind has a Russian description.
- `test/work-kinds-cover-tracker.test.ts` passes: every field of a sample tracker issue, its dependency and its comment has a declared field or entity kind, and the starter value sets are declared with labels, descriptions and order.
- `test/starter-value-sets.test.ts` passes: the start publishes five value sets and 27 entries, an entry names its set, and a task holding the closed entry is found from it.
- The GraphQL starter schema is regenerated and its byte-for-byte and buildSchema tests pass.
- `bun run check` and the whole test suite are run on this branch; their outcome and every failure's state on origin/main are recorded in the report that accompanies this change.
