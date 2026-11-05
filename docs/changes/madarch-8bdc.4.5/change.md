# The views, the listing and the places a kind gets follow the kinds manifest, not kind names in the engine and the app

Change: madarch-8bdc.4.5
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.4.5
Kind: behavior

## Intent
The owner's rule for the catalog is that the engine holds no product data (decision 0033, items 7 and 8): what a product
shows follows the kinds its `madarch/kinds.yaml` declares, never a list of kind names written in engine or app code. Four
decisions still named catalog kinds to choose what a page or the app draws, and madarch-8bdc.4.4 recorded them as the
follow-up this task takes:

- the diagram views a subject may draw — `src/knowledge/views.ts` refused a component view of anything but a
  `code.service`, drew the ER view only of a `code.database` or a `code.table`, and read the modules of a service
  (`:476`, `:538-561`, `:1089`, `:1096`), and `src/knowledge/diagrams.ts` chose the chain's entry by a `code.route` and a
  `code.symbol`, the modules graph and the treemap scope by a `code.service`, the system rows by a `code.service` and a
  system element's kind by three more (`:146`, `:149`, `:170`, `:728`, `:871`, `:925`);
- which entities a domain page names as its implementation (`views.ts:881`, a `code.service`);
- whether the definition block is parsed (`src/knowledge/definition.ts`: `DEFINITION_KINDS` at `:20`, and the kinds
  whose entities are a row of a contract at `:36`);
- the form of a kind's listing (`src/knowledge/render.ts:355-356`, `wiki/app/src/knowledge/pages.tsx:179-180`, a
  `code.operation`), and the app's navigation places (`wiki/app/src/knowledge/app.tsx:63` `LOOP_KINDS`, `:124`
  `KINDS_WITH_OWN_PAGE`).

A product that renamed, removed or added a kind could not say which of them draws which view, lists its entities in
which form, or stands where in the navigation without editing the engine.

This change moves every one of those decisions into the kind's own declaration. A kind may say `views` — the views a
page of it may draw of its entities (`c4-component`, `er`, `state`); `sequence` — how the end-to-end chain a page draws
starts at its entities (`route` at the entity itself, `symbol` at the route that reaches it); `system` — the part its
entities play in the system view (`container`, `data-store`, `channel`); `definition-block` — what the definition block
finds in its entities (`contract`, `operation`, `channel`); `listing` — the form of its listing page (`operations`); and
`nav` — where the kind stands in the navigation (`own-page`, `loop`). The starter set declares them for exactly the kinds
that have the behaviour today, so the wiki shows the same pages for the starter set, and the app reads the traits from
the kind summary it already receives.

## Rationale
Each decision is product data in the owner's sense, and each is the kind of data a product changes: a product that
calls its routes `web.endpoint` wants the chain to start at them, and one that gives a table kind of its own wants the ER
view on it. Written in the engine, the choices were fixed for every product and invisible to the manifest's reader,
which refused unknown kind fields. Written in the app, they could not follow a product's manifest at all.

The values are engine vocabulary, not product data, in the same way a history shape, a property format or a block name
is: the engine can draw a component view, an ER view and a state view, its chain can start at a route or at a function,
its system view has containers, data stores and channels, the definition block reads a contract and the two kinds of row
inside it, the listing has two forms and the navigation two places. The product says which kind has which.

The extractors' own vocabulary stays the engine's (decision 0033, item 7): a view reads the facts the extractors publish
— a database's tables by key, a table's columns and foreign keys, the files an entity's code stands in, the lanes of a
chain, the deployment's own elements — and those names never select a view. What moved is which kind draws which view,
not what a fact is.

The fields are checked like every other field of a kind declaration: a value outside its vocabulary, a repeated view,
and any of them on a kind whose template policy is `none` are findings naming the file, the line and the kind; a refused
kind is left out and the other kinds stand. A view the manifest does not give the kind is a refusal naming the manifest's
file and the kind's line, so a product reads what to declare instead of a kind the engine should have known.

## Out of scope
- The kind names left in `src/knowledge` and `wiki/app/src` are the extractors' fact vocabulary and the workflow's own
  words; the report lists every one with its reason. Of them, the notable ones: `views.ts`'s reads of the tables,
  columns and foreign keys an entity holds, the files its code stands in and the lanes of a chain; `diagrams.ts`'s
  prefixes and element kinds of the graph and the diagram model; `definition.ts`'s row shapes and the contract's key
  prefix; `src/knowledge/blocks.ts:346/350` (a file's renamed successor is read only between files);
  `src/knowledge/operation-catalogue.ts` (an operation's channels and contract), `src/knowledge/doc-blocks.ts` (the
  fact kinds a document's mention is looked up in) and `src/knowledge/graph-read.ts`'s operations listing.
- The writer's and the loop's workflow vocabulary (`src/writer`, `src/loop`, `src/knowledge/product.ts`, the app's
  plan-reason, problem-kind and guide unions in `wiki/app/src/knowledge/types.ts`): they decide which pages the agent
  writes and which unit's digest changes, not what an entity's page shows.
- The fill card's onboarding check for a kind with no entities (`pages.tsx:333`), which asks whether the writer has
  written any page yet, not how a kind is drawn.
- A product made before this change is offered the new fields by the starter upgrade (`starterOffers`), and 4.4's
  `card` and `history` with them; the offer is added, the manifest is not rewritten.

## Changes to requirements
- product-wiki/views (new at Base): a kind's declaration chooses the views a page of it may draw, how its chain starts,
  its part in the system view, what the definition block finds in it, the form of its listing and its place in the
  navigation; no module under `src/knowledge` or `wiki/app/src` names a kind to choose one; the reader refuses a value
  outside each vocabulary; the starter set declares exactly the kinds that had each behaviour before. Scenarios:
  `views-follow-the-declaration`, `er-follows-the-declaration`, `system-part-follows-the-declaration`,
  `definition-follows-the-declaration`, `listing-follows-the-declaration`, `navigation-follows-the-declaration`,
  `view-traits-refused`, `starter-set-keeps-its-views`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted requirement is retained verbatim from Base;
`catalog` (madarch-8bdc.4.1), `extractor-mapping` (madarch-8bdc.4.2), `pov` (madarch-8bdc.4.3) and `presentation`
(madarch-8bdc.4.4) are the sibling changes' additions and stand before the new requirement, which is at the file's end.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages, and the kinds the wiki shows today keep their templates, labels, details and descriptions; the starter set declares the six new fields for exactly the kinds that had the behaviour, so every page it shows is the page it showed.
- product-wiki/live: a saved manifest still changes the pages at the next read; a `views`, `sequence`, `system`, `definition-block`, `listing` or `nav` line saved into a kind's declaration takes effect with it.
- product-wiki/serve: serving a product is still one read of its working tree; the six fields add no route.
- product-repository/draft: `madarch new` still writes the starter set as the product's own files; what it writes now declares the six fields.

## Coverage
- product-wiki/views: test, static
- product-wiki/catalog: test
- product-wiki/extractor-mapping: test
- product-wiki/pov: test, static
- product-wiki/presentation: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-repository/draft: test

## Blocking questions
None.

## Design and decisions
- `src/knowledge/kinds.ts` reads the six fields beside the kind's other page fields, keeps them in `KindDecl`, and
  refuses what it cannot read: `KIND_VIEWS`, `SEQUENCE_FORMS`, `SYSTEM_PARTS`, `DEFINITION_FORMS`, `LISTING_FORMS` and
  `NAV_TRAITS` are the vocabularies, beside `HISTORY_SHAPES`, the block names and the property formats. The declarative
  property is named `definitionBlock` in TypeScript, because `definition` is the catalog's sentence about the kind.
- The readers ask the manifest and never a kind's name: `kindDraws`, `sequenceFormOf`, `systemPartOf`,
  `systemKindsOf`/`systemKindOf`, `definitionBlockFormOf`, `definitionBlockMemberOf` and `listingFormOf`, and a
  `declarationMissing` sentence that names the manifest's file and the kind's line for every refusal.
- `src/knowledge/views.ts` draws a component view, an ER view and a state view for the kinds whose declaration gives
  them. The ER view no longer branches on the subject's kind: an entity the graph holds tables under is drawn with them,
  and any other is drawn as one table with the tables its foreign keys reach — the data model extractor's containment and
  the same facts as before. The system container's folder is what a treemap covers, and a domain's implementation is the
  containers its related entities are (`system: container`).
- `src/knowledge/diagrams.ts` reads the system's containers from the kinds that declare `system: container` (the
  system model and the service locator), adds a container's system rows and a route's handler row by the same
  declarations, reads the modules graph and the treemap scope by them, and maps a system element the graph holds no
  entity for to the kind the manifest gives its part.
- `src/knowledge/definition.ts` reads the subject's form and the member forms from the manifest; the row shapes (an
  operation's method and path, a channel's messages) and the contract's key prefix stay, as the contract reader's own
  vocabulary.
- `src/knowledge/render.ts` asks the manifest for the listing's form, and carries the two traits the app draws by
  (`listing` and `nav`) into the kind summary it receives (`src/knowledge/model.ts`); the other four are the engine's own
  reads and do not travel. `wiki/app/src/knowledge/app.tsx` reads `nav` from that summary for its navigation and
  `wiki/app/src/knowledge/pages.tsx` reads `listing` for the operations table.
- `src/knowledge/starter-catalog.ts` carries the six fields in its rows, `src/knowledge/seed.ts` writes them into the
  manifest it gives a product with the manifest's own comment block explaining them, and `starter-upgrade.ts` offers them
  (and 4.4's `card` and `history`) to a product made before them.
- `.architecture/violations.json` loses the `DEFINITION_KINDS` entry (the list only shrinks; removing an entry needs no
  owner decision).
- madarch-8bdc.4.4's presentation fields (`card`, `history`) are untouched: a ground still shows the card its kind
  declares and a history block still tells the story its kind's shape names, and the tests of that change stay green.
- `test/knowledge-manifest-views.test.ts` proves the round trip the task asks for, field by field, and the starter set's
  exact declarations; `test/knowledge-manifest-fixture.ts` holds the fixture manifest the other checks declare their
  kinds with.

- Assumptions and constants of the change:
  - The field names are mine: `views`, `sequence`, `system`, `definition-block`, `listing`, `nav`, beside `card`, `history`,
    `details` and `member` in a kind's declaration. The task fixed the behaviour, not the spelling; the manifest's comment
    block, the reader's findings, the capability and this record name them, so a rename is one search away.
  - The vocabularies are engine vocabulary: `['c4-component', 'er', 'state']`, `['route', 'symbol']`,
    `['container', 'data-store', 'channel']`, `['contract', 'operation', 'channel']`, `['operations']`,
    `['own-page', 'loop']`. No view, part, form or place was added or removed: they are the behaviours the engine had.
  - The kind summary carries `definition` (the form) where the manifest's field is `definition-block`, because the catalog
    row's `definition` is a sentence the summary does not carry.
  - A database whose tables the graph holds none of is now drawn as one table (an empty box) where it was the ER block's
    "no table here" before; with tables the view is the same. The branch is the data model extractor's containment, so a
    product's own database kind gets the same view without naming it in the engine.
  - The starter set declares `system: channel` on `code.channel` and `system: data-store` on `code.database`; today the
    part only names the kind a system element of that part falls back to when the graph holds no entity for it, which is
    what the three names in `diagrams.ts:170` did.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-05:

- `bun run check` exit 0: `tsc --noEmit` clean (TypeScript 7.0.2), the architecture check at its 1 240 listed violations
  (the `DEFINITION_KINDS` entry and the `collectNeighbors` entry are gone with the change), and
  `catalog: 26 areas, 100 subgroups, 490 kinds (67 with a page of their own or a member's row)` with
  `mapping: version 1; 56 extractor kinds (55 tied, 1 internal); 64 extractor relations (36 tied, 28 internal)`.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-manifest-views.test.ts`: 22 pass, 0 fail — the six round trips (component,
  ER, state, chain, system part, definition, listing, navigation), the system model rows and the treemap folder, the
  chain's lane grouping, the fallback kind of a system element, the modules block and the domain map, the reader's six
  refusals and the three views-list refusals, and the starter set's exact declarations.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-*.test.ts`: 604 pass, 1 skip, 1 fail (606 cases over 49 files). The failure is
  `knowledge-agent`'s «a second press with the pages in place runs no unit», which fails identically at the base
  (madarch-8bdc.4.4 recorded 10 pass, 1 fail at 4730a814 and this machine reproduces it).
- `MADARCH_SKIP_PERF=1 bun test test/product-wiki-pages.test.ts test/product-wiki-serve.test.ts
  test/madarch-init-e2e.test.ts test/product-manifest.test.ts test/catalog-check.test.ts test/mapping-check.test.ts
  test/roles-check.test.ts test/starter-set-upgrade.test.ts`: 159 pass, 6 fail; a seventh, `madarch-init-e2e`'s «the one
  press …», failed on load in the batch run and passes alone (82 s, 2 pass 1 fail in that file, the offer case below) —
  `product-wiki-pages`' five `chmod 000`
  cases (the run is root, and root reads a mode-000 folder; 4.4 proved them failing at 4730a814) and
  `madarch-init-e2e`'s agent offer, which reads `prime-agent` as installed because this machine has it on `PATH`.
- `wiki/app`: `bun run check` exit 0; `bun test` 312 pass, 1 fail — shiki's `.tok-keyword` flake in
  `knowledge.test.tsx`, which passes alone (57 pass at 4.4, 58 now); `bun run build` exit 0.
- StrykerJS 9 (command runner, `coverageAnalysis: off`, `inPlace`, `typescript@5` beside it, from
  `/work/scratch45/stryker` outside the repository) on the changed line ranges of `kinds.ts`, `views.ts`, `diagrams.ts`,
  `definition.ts` and `render.ts` against `bun test test/knowledge-manifest-views.test.ts
  test/knowledge-view-completeness.test.ts test/knowledge-contract-selection.test.ts`: 319 mutants, 235 killed, 0 timed
  out, 84 survived — **73.67%** (kinds.ts 85.16%, views.ts 69.81%, definition.ts 69.57%, render.ts 68.18%,
  diagrams.ts 62.37%). The survivors are of three kinds, each read off the report: a branch turned `true` where the
  fixture's graph yields no row anyway (the route's handler row on a service, a container's rows on a table); a key
  written as `{ field: undefined }` where the declaration omits it (`toStrictEqual` would tell them apart, and nothing a
  page draws does); and the sentences of the refusals.

## Where it is seen
Kind: internal
Place: A page's diagrams, a kind's listing page and the wiki's navigation
Reason: the starter set shows the pages it showed before, and no screen is added or altered; what changes is which declaration a product writes to get a view, a listing form or a navigation place on a kind of its own.

1. Open a product whose manifest declares `views: [er]` on a kind, open the page of one of its entities with an ER
   block, and the block draws the tables; remove the line, save, and the block says the manifest gives the kind no such
   view.
2. Open a product whose manifest declares `listing: operations` on a kind and open that kind's page: the operation
   table is drawn with what declares, serves and calls each row; remove the line and the page draws the plain table.

## DONE WHEN
No module under `src/knowledge` or `wiki/app/src` names a kind to choose a view, a listing or a navigation trait; a
fixture manifest that removes one such field loses that view, listing or trait for that kind and restoring it brings it
back; the wiki shows the same pages for the starter set as before, and its tests and the wiki app's tests are green.
