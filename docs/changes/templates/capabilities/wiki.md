# Wiki

Capability: wiki

## Purpose
A product's wiki is its knowledge graph, read through one API (capability graph-queries) and shown as pages composed from
the product's templates in the browser (decision 0036). The server renders no page; the app reads the product's bootstrap
once, composes the page its address names into one GraphQL operation, and draws each section with the component its
template names. The static site the earlier capability built is gone with the model store it read.

## Requirement: pages — A page is a template over the graph
Every entity of the product's graph shall have a page address: `/` for the home, `/e/kind/id` for every entity,
`/p/template` for a template bound to no entity, whose `name=value` query parameters bind the variables the template
declares. A page's sections shall be the sections of the template it is given, composed into one GraphQL operation and run
in the browser; the page's data shall come from that operation alone, and no server module shall name a kind, hold a query
or build a block. The app shall fetch the bootstrap once and keep it; a page view shall then be one `/graphql` request,
and every section's data shall be the value under its own alias. A different `structureRevision`, the event
`structure-changed`, or the error `STALE_STRUCTURE` shall make the app read the bootstrap again and run the page once
more.

### Scenario: entity-addresses
- Given: a served product
- When: `/e/kind/id` and `/kind/kind.md` are asked
- Then: the entity address answers the app shell as HTML, the Markdown kind address answers 404, and the app composes the entity's page from its address
  Checked by test/removed-routes.test.ts and wiki/app/src/address.test.ts

### Scenario: one-request-per-page-view
- Given: a served product and its built app
- When: a page is opened, and then its table's next page is pressed
- Then: the view asks one `bootstrap` and one page operation, and the press asks that same operation with the cursor
  Checked by wiki/app/src/app.test.tsx and test/wiki-templates-e2e.test.ts

## Requirement: templates — The product's templates are its pages
A page's template shall be a file of the product under `templates/`, named by its relative path without its extension and
listed by `bootstrap` with its body. A template shall state `template`, an optional `extends`, optional `records` (the
kinds whose entities open it) and `entities` (the ids that open it), the variables it declares and its sections; a
section shall state `id`, `component`, `on` (`subject` or `root`), its `query`, its parameters, a title per language,
optional roles, and where inheritance places it (`after`, `replace`). Inheritance shall be resolved once, by one module
the server and the app both run: the base's sections first, a placed section after its anchor, a replacing section in its
anchor's place, and a section id unique after inheritance. The template an entity opens with shall be its own, else its
kind's record template, else the base `entity`; a catalogue entity's page shall be the product's catalogue template; the
starter set shall ship `home`, `entity`, `text` and `catalogue-entity`, the catalogue's own page extending `entity` with
its records table. A template naming an unknown component or parameter, a section placed after a section the page does
not hold, or a query a type of the product cannot answer shall be refused at start with its file and line. The Liquid
templates, their compiler and the structured `template` kind are deleted: no server module interprets a page syntax.

### Scenario: templates-listed
- Given: a served product holding a file under `templates/`
- When: `bootstrap` is queried
- Then: the template is listed by its name and its body, with `catalogueTemplate`, `recordTemplates`, `ownTemplates` and the manifest's roles, and an entity's `template` answers the template it opens with
  Checked by test/graphql-executor.test.ts and test/page-contract.test.ts

### Scenario: inheritance
- Given: the starter's `entity`, `text` and `catalogue-entity` templates
- When: the catalogue template is resolved
- Then: the base's sections come first, the catalogue's facts replace the base's, and its records follow them
  Checked by test/page-contract.test.ts and wiki/app/src/compose.test.ts

### Scenario: unknown-component-refused
- Given: a product whose template names a component the app does not draw, or a parameter that component does not take
- When: the server starts
- Then: it refuses the start naming the template's file and line
  Checked by test/server-templates.test.ts

### Scenario: liquid-gone
- Given: the repository's catalogue and starter set
- When: a product is created from the starter set
- Then: no `templates/*.liquid` file is written, no kind declaration names a `template:`, and the starter schema holds no `Template` type
  Checked by test/knowledge-parse.test.ts and test/graphql-starter.test.ts

## Requirement: frontend — The app draws every page from its sections
The app shall route `/`, `/e/kind/id` and `/p/template`, read the bootstrap once, compose one operation per page
view and draw each section with the component its template names. The components shall be generic and take only their
section's data and parameters: `header`, `facts`, `text`, `relations`, `table`, `bars`, `diagram`, `source`, `tabs` and
`search`. A `table` shall page through `the section's `_first` paging variable` and `the section's `_after` paging variable`, and filter and sort through
`the section's `_where` variable` and `the section's `_orderBy` variable` when its section's query declares them; a `diagram` shall draw the
entity's relations both ways at depth 1, merge an edge with its inverse into one line, draw more than `aggregateAbove`
neighbours of one kind as one box with their count — and the diagram itself is rendered on the server and served to
clients, so the app lays nothing out: its three tabs show the server's LikeC4 view in LikeC4's runtime, the server's
Mermaid source drawn by Mermaid, and the server's interactive archify page, and a press on a node in any of them opens the
entity's page; `search` shall ask the `search` root for the reader's own
terms; `tabs` shall draw the sections it names. A section shall be shown to the role its template names and to every role
when it names none, and its texts shall be read in the reader's language. The app shall name no kind, hold no product
data and import no API function other than the GraphQL client.

### Scenario: components-draw-their-own-data
- Given: a page whose section answered a connection or a value
- When: the component is drawn
- Then: it shows only that section's data at the paths its parameters name, and a missing value is an empty row, never a placeholder
  Checked by wiki/app/src/page.test.tsx

### Scenario: table-pages-and-sorts
- Given: a catalogue page whose records long outnumber one page
- When: the reader presses its next page, or sorts by a column
- Then: the app asks the same operation with the connection's cursor, or with the section's order variable, and shows the answer in place
  Checked by wiki/app/src/page.test.tsx, wiki/app/src/app.test.tsx and test/wiki-templates-e2e.test.ts

### Scenario: diagram-both-ways
- Given: an entity page whose entity is reached by one kind and leads to another
- When: its diagram is drawn
- Then: the relations stand on both sides of the entity, an edge and its inverse are one line, neighbours of one kind above the bound are one box with their count, and the server's three answers are the page's tabs
  Checked by test/diagram-route.test.ts, wiki/app/src/page.test.tsx and test/wiki-templates-e2e.test.ts

### Scenario: no-kind-in-the-app
- Given: the app's source
- When: the architecture check runs
- Then: no module of `wiki/app/src` names a kind, and the app imports no API function other than the GraphQL client
  Checked by scripts/check-architecture.ts (`no-kind-names`) and scripts/check-ui-architecture.ts

## Requirement: export — No server answers a page file
The server shall answer no page file, no kind file, no `/llms.txt` and no Markdown rendering of a page: each of those
addresses answers 404. The Markdown export of a drawn page is the frontend's and is not built yet.

### Scenario: no-server-export
- Given: a served product
- When: a page's `.md` and `.json` addresses and `/llms.txt` are asked
- Then: each answers 404
  Checked by test/removed-routes.test.ts

## Requirement: result — Served or refused, and why
A wiki shall be served by the server a local madarch runs (capability product-wiki), from the app's built files; when the
app's files cannot be built the command shall exit 2 printing what the builder said and serve nothing. A request the
server cannot answer shall name what was asked for.

### Scenario: build-failure-refuses
- Given: an app folder whose build fails
- When: madarch serves a product
- Then: it exits 2 with the builder's words and serves nothing
  Checked by test/product-serve.test.ts

## Quality requirements
- A page answers in under 1 s warm on madarch's own product; one request per page view.

## Context
Decision 0036, sections 6 and 7; decisions 0018 (madarch's own app) and 0031 (one page in layers).

## Coverage limits
Not built by this change, and stated here so a reader knows what a person cannot do yet: the offline cache and service
worker (a page opens only while the product is served), the Markdown export of a page, the command components (`fill`,
`run`, `settings-form`, `problem-actions`), and the linking of glossary terms inside a text section. The diagram is the
server's picture in three formats (capability views, `diagram`); the page only shows it.
