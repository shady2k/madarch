# Pages are the product's templates: the contract as code, templates as files, and the app that composes and draws them

Change: templates
Base: 1fc72ca3cb13b9612cf77f85f29486d75e4cd1e7
Tasks: madarch-64o5.71
Kind: behavior

## Intent
Decision 0036, sections 6 and 7. A page is no longer anything the server builds: it is a template of the product, and the
app composes the template its address opens into one GraphQL operation and draws each section with a component of its
own. This change builds that frontend, and the contract both sides run.

The contract is code first (section 9): `src/page-contract/` holds the JSON Schema of a template file and of every
component's parameters, the one reader of a product's template files, and the composer that turns a bootstrap, an address
and the product's templates into one operation, its variables and the split of the answer. The server validates a
product's templates with it before it binds an address; the app composes each page with it.

The starter set ships four page templates — `home`, `entity`, `text` and `catalogue-entity` — written into a product's
`templates/` folder by `madarch init`, and the bootstrap names them, the template a catalogue entity's page opens, each
kind's record template, each entity's own template and the manifest's roles. The GraphQL layer answers what the
templates need and did not have: `Entity.outgoing` beside `backlinks`, `CatalogueEntity.instances` for the records of a
kind, and the bootstrap's page names.

The app routes `/`, `/e/kind/id` and `/p/template`, reads the bootstrap once, and draws a page's sections with ten
generic components: `header`, `facts`, `text`, `relations`, `table`, `bars`, `diagram`, `source`, `tabs` and `search`. A
table pages, filters and sorts through its connection's variables; the diagram draws the entity's relations both ways,
one line for an edge and its inverse, one box for more than `aggregateAbove` neighbours of a kind, fitted to its frame,
and walks to a neighbour a reader presses, with Mermaid as the text form. No kind is named anywhere in `wiki/app/src`.

## Rationale
The owner's words (madarch-64o5.71): one page mechanism, every page a template, components generic, the wiki knows no
data, the template asks the graph, one read API. Until now the app was a shell and no page could be read in a browser;
the server's page layer was already deleted, so the wiki had no page at all. This change gives the wiki its pages back
without giving the server a page model: a product changes a page by editing a template.

## Out of scope
- The offline cache, the service worker and the banner an offline page shows (section 7's cache): a page opens only while
  the product is served.
- The Markdown export of a drawn page.
- The command components — `fill`, `run`, `settings-form`, `problem-actions` — and every command read they would use.
- Linking glossary terms inside a text section.
- The LikeC4 positions and the archify renderer for the drawn diagram: the app's bundle holds neither a layout engine nor
  the archify renderer, so the diagram is drawn by the app's own layered layout and Mermaid is offered as its text form.
  The vendored archify, `likec4` and `mermaid` stay in `wiki/app`'s dependencies for the component that will use them.
- Aggregates (`listRoot` `Aggregate` roots), which the schema does not answer yet: `bars` groups the page of a list it read.

## Changes to requirements
- wiki/pages: one operation per page view after one bootstrap; the app's own addresses.
- wiki/templates: a template file's sections, inheritance, `records`/`entities`, the bootstrap's page names, the starter's
  four templates, the start refusal, Liquid gone.
- wiki/frontend: add. The app's router and components, the table's connection variables, the diagram's depth-1 drawing,
  search, tabs, roles and languages, and no kind in the app.
- wiki/export: the server answers no page file; the frontend's export is not built.
- wiki/result and wiki/quality requirements: unchanged except as the frontend states them.
- product-wiki/pages: the app's addresses and the bootstrap's page names.
- product-wiki/shell: add the reader's controls and the page's column in place of the shell's note.
- product-wiki/app: the served app is the template frontend.
- product-wiki/templates-at-start: add. A template the app cannot run refuses the start with file and line.


## Preserved contracts
None.

## Coverage
- wiki/pages: test
- wiki/templates: test
- wiki/frontend: test
- wiki/export: test
- wiki/result: test
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/app: test
- product-wiki/templates-at-start: test
- product-wiki/overview: test
- product-wiki/reading-typography: test
- product-wiki/front-matter: test
- product-wiki/architecture: test
- product-wiki/repositories: test
- product-wiki/stages: test
- product-wiki/questions-and-overview: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/internationalization: test
- product-wiki/empty-home-guidance: test
- product-wiki/discussions: test
- product-wiki/presentation: test
- product-wiki/views: test
- product-wiki/status: test
- wiki/diagrams: test
- wiki/engine: test
- wiki/documents: test
- wiki/links: test

## Where it is seen

Kind: screen
Place: a served product's wiki, at `/`, `/e/kind/id` and `/p/template`
Mockup: docs/prototypes/templates-home.html

1. A person opens the wiki on a filled product and reads the home page: the product's kinds as a table, with the count and the page's own search.
2. They press a kind and read its page: what the kind is, its records as a table, and the page's next button turns the records to the next page.
3. They press a file of the records and read its page: its title, its facts, the diagram of its directory and repository, the relations it is reached by, and its text or source.
4. A product's author edits `templates/entity.yaml` in the product's repository, reloads the page, and the page changes without a release; a template that names a component the app does not draw stops `madarch serve` with the template's file and line.

## Blocking questions
None.

## Design and decisions
The contract as code is `src/page-contract/index.ts`: `schema.ts` (the template file and the components' parameters as
JSON Schema), `template.ts` (the one reader: YAML nodes against the schemas, every finding carrying file and line, and
inheritance resolved once), `compose.ts` (bootstrap + address + templates -> one operation, its variables and each
section's data). `src/graph/template-check.ts` validates a product at start: it composes every bound template against the
schema the product's manifest derives and refuses a page a type cannot answer.

A template says which pages it draws in its own file: `records` (a list of kinds) makes it that kind's record template, and
`entities` (a list of entity ids) makes it those entities' own template; the bootstrap's `recordTemplates` and `ownTemplates` are read
from them. The catalogue template is the file named `catalogue-entity` when the product holds one, else `entity`.

The app keeps the reader's language and role in the browser, composes with them, and passes them as `$lang` and `$role`.
A table's spot in the data and its paging cursor live in the page's state, so a press re-asks the same operation and the
rest of the page stays still.

## Acceptance evidence
`bun run check` (tsc, the architecture check, the UI check, the catalog, workflow and quarantine checks) is clean; the
app's own `bun run check`, `bun test` (23 cases) and `bun run build` are clean. The whole suite was run once
(`MADARCH_PLUGIN_SANDBOX=off MADARCH_SKIP_PERF=1 bun test test/`): every failure it reported was a fixture holding the
old page routes or the starter's file list, and each is fixed by this change; the one failure that is not the change's
is `product-cli.test.ts`'s stderr assertion, which the sandbox warning this box adds with `MADARCH_PLUGIN_SANDBOX=off`
makes. The walk on madarch's own filled product (`MADARCH_WIKI_E2E=1 bun test test/wiki-templates-e2e.test.ts`, one
fill of the checkout with the disk and git plugins, about 3 700 files and 3 000 commits) reads its home, the kind
`code.file`'s page with its records paged, `src/graph/write.ts`'s page with its facts, backlinks and diagram, and the
repository's page; each page is one `/graphql` operation after one bootstrap, and its DOM is saved as the mockups under
`docs/prototypes/templates-*.html`.

## DONE WHEN
A served product's wiki draws every page from the product's templates: `/`, `/e/kind/id` and `/p/template` compose
one operation each, the components draw only what their sections answered, a template the app cannot run refuses the
start with file and line, and the walk on madarch's own filled product reads its home, a kind's page with its records,
and a file's and a repository's pages with their facts, relations and diagrams.
