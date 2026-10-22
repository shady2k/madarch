# The wiki draws a product's pages from the product's own manifest and templates over its graph, and fills the graph while the reader watches

Change: madarch-m38l.1
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-m38l.1
Kind: behavior

## Intent
Decision 0029 makes the wiki a Markdown engine: what cannot be rebuilt is Markdown in the product repository, the graph indexes the code facts, and the pages are the product's templates drawn over both. This change builds that engine, the first vertical's half that renders.

A product repository holds `madarch/kinds.yaml`, which declares the kinds the wiki shows, and one Markdown template per kind. A template is Markdown with `{{attribute}}` substitution and block directives (`body`, `graph`, `related`, `callers`, `callees`, `source`, `er`, `sequence`); the engine owns the block library and holds no page for any kind. `madarch new` seeds a starter manifest and the templates of the service, symbol, file, domain and product kinds, which are the product's own files from the first commit.

The wiki opens, for a product with the manifest, on the product's home page under `/k`, with the product chosen at the top left. An entity's page is its template drawn over the graph and the Markdown: a function shows its source at its lines, its callers and callees with the place of each call, and a call sequence; a service shows its stack, the files below it and its links as a diagram. Every reference to code opens the source at its line. A `madarch:` link and each ground of a footnote is resolved against the graph, the Markdown pages and the repositories' documents, and one that does not resolve is shown as broken, with its reason. A statement with no footnote is named as not shown as fact.

An empty product says what to do: connect a repository, or start the fill. Starting the fill runs the extract driver over the product's repositories into the product's own graph store, commit by commit; the wiki shows its progress and an open page reads again after each commit through the wiki's existing change stream, so the reader watches the pages appear.

## Out of scope
- Writing the product and domain pages: they are Markdown an agent writes (madarch-m38l.2); this change draws them and checks their grounds.
- Other page kinds and kinds that need their own blocks (tables beyond the `er` block, requirements, decisions), the server and federation, and performance work: the epic's left-out list.
- Indexing the Markdown into the graph as rows. The Markdown is read from the product repository on each ask and joins the graph's relations in memory (a page that `relates` a key is listed on that key's page); persisting it as nodes waits for the page kinds that need to query it.
- Replacing the documents app: it stays at `/?documents`, and a product without `madarch/kinds.yaml` opens it as before. Today's fill stages and the graph pages of decision 0026 are untouched.
- Editing text in the wiki: decision 0029 says people edit source entities and the agent rewrites the text.

## Changes to requirements
- product-repository/draft: replace. `madarch new` also writes the wiki's starter set, so the first commit holds `madarch/kinds.yaml` and five templates; the scenario `new-draft` names them. Complete proposed text in `capabilities/product-repository.md`.
- product-repository/kinds (absent on the target): add. The kinds manifest, its fields, the template language, the Markdown entity's front matter, the findings with file and line, and the starter set. Complete proposed text in `capabilities/product-repository.md`, with the scenarios `starter-set`, `manifest-mistakes-are-findings`, `template-mistakes-are-findings` and `markdown-entity-identity`.
- product-wiki/knowledge-pages (absent on the target): add. The front door of a product with the manifest, the product selector, the entity pages and their blocks, the resolution of `madarch:` links and grounds, the empty product's way forward and the watched fill. Complete proposed text in `capabilities/product-wiki.md`, with the scenarios `empty-product-says-what-to-do`, `the-fill-is-watched`, `function-page`, `broken-ground`, `ungrounded-statement`, `product-selector` and `no-manifest-keeps-documents`.

## Preserved contracts
- product-repository/manifest: `workspace.yaml` and its reading are unchanged; the constitution `madarch new` writes is byte for byte the contract example's, so the published contract does not move.
- product-wiki/pages: the documents app, its routes and its change stream answer as before; the change stream only gains a second source of revisions (the fill's commits) that adds nothing for a product that never fills.
- product-wiki/shell: the documents app's shell is untouched; the knowledge wiki has its own shell built from the same tokens and parts.

## Coverage
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/kinds: test
- product-wiki/knowledge-pages: test
- product-wiki/pages: test
- product-wiki/shell: test

## Where it is seen

Kind: screen
Place: the wiki of a product made by `madarch new`, at its front door, the address `madarch new` prints
Mockup: docs/prototypes/madarch-m38l.1/function-page.png

1. The person opens the wiki of a product that holds the generated training repository and sees the empty page: it says the wiki is empty, names the repository and offers "Start the fill"; the product is at the top left.
2. They press "Start the fill" and watch a progress bar read the commits while the kinds' counts in the navigation grow and any page they open shows what the graph holds at that commit.
3. They read from the home page to the payment domain, whose grounds open the functions and the requirement section they name, and a ground that is not in the graph is shown as broken.
4. They open the payments service and then `PaymentService.pay`, and see its source lines at their numbers, its callers with the places they call from, its callees and a call sequence; each place opens the source view at that line.

## Blocking questions
None.

## Design and decisions
The design is decision 0029 and the vertical's shared formats. Choices made inside them:
- The engine reads, never writes, the product repository: `madarch/kinds.yaml`, the templates and the Markdown are read fresh on every ask, so an edit shows without a restart. Every problem is a finding with file and line, and the page still draws what it can.
- A graph entity is its logical key (`properties.recordKey`, the driver's own); the nodes that carry one key under several producers are one entity. A kind's `relations` declare edges the graph does not hold (the starter joins a service to the package whose folder holds its manifest, with `{span.path|dirname}`), and the blocks treat them as graph edges.
- The product's graph store is a PGlite database in the products home's `.madarch/knowledge` folder, one folder per product id and `graph` inside it, outside the product repository (decision 0023), opened when the product's wiki is first asked for and closed with the server. `knowledge_fill` beside the graph records, per repository, the commit the graph was read to, so the source view shows the bytes the spans were read from, and a restarted server knows.
- The fill is the extract driver, unchanged but for two optional callbacks (`onStart`, `onCommit`) that tell the wiki which node is the repository and when a commit has landed; a stop is taken at a commit boundary and a refill resumes. Reads at the valid time of the later of now and the last commit read, so pages mid-fill show that commit's state.
- Live updates reuse the wiki's change stream (`GET /api/events`): its revision now also carries a counter the fill moves after each commit, and the app reads the status, which carries the fill's place, when the stream says `change`. No second channel was added. One read at a time, so a fill whose commits come faster than a read does not starve the page.
- The page model is plain JSON of blocks (`src/knowledge/model.ts`); the app draws the blocks with the wiki's shell parts and holds no kind. Tables, cards, badges, alerts, the menu and the input are shadcn components added the shadcn way (`wiki/app/src/components/ui`), re-themed on the tokens; diagrams use the Mermaid renderer the app already has; the source highlighter is a small scanner of this app, with the palette's weight and posture rather than hues, as the reading sheet says "no syntax colours".
- The `callers`, `callees` and `sequence` blocks read the engine's `code.calls`, `related` with a depth and the breadcrumb read `code.contains`, and `er` reads the data-model extractor's keys; a template names other relations with `relation="..."`. The sequence follows calls breadth-first, because the graph aggregates call sites per pair and keeps no execution order.
- The home page is the first markdown kind that names a `file`. A product's folder is the id the selector and the route use under a products home; a product alone offers itself.
- The font faces the built stylesheet names at the root (`/fonts/…`) are now answered at the products home's root, so the app's own faces load under a product's prefix.

## Acceptance evidence
Run on the SkyPilot pod (`madarch-sky-test --avx2`) on 2026-10-22:
- test/knowledge-parse.test.ts, test/knowledge-render.test.ts, test/knowledge-server.test.ts: 45 pass, 0 fail. test/knowledge-vertical.test.ts fills the generated training repository into a product (about 6 minutes) and asserts the answer key's items on the payments service page and the `PaymentService.pay` page (callers `paymentRoutes` and `paymentsHandlers` with their call sites, the source span against git's own lines): passed in the 300-test run that also held product-draft, neutral-repository-names, product-wiki-serve, product-daemon, product-cli, product-serve and extract-driver.
- wiki/app: `bun run check`, `bun test` (259 pass, 0 fail) and `bun run build` exit 0; the knowledge tests alone 24 pass.
- The walk `bun scripts/knowledge-shots.ts` rendered the pages in headless Chromium on the pod and the pictures were read: the empty product, the fill at commit 6 and 9 of 70 with the counts growing, the home, the payment domain with its broken ground and its ungrounded statement, the payments service, `PaymentService.pay` in light, dark and phone width, a file, the kind list, the source at line 46 and the product selector. Four of them are committed under docs/prototypes/madarch-m38l.1.
- A read-only review found twelve defects; fixed with tests: two fills at once while the store opens, the source pin moving backwards on a refill, the store left open on close, reads through links and of the checkouts in the source view, a directory listing served as a file, call sites not summed, the status never loading under StrictMode, unfiltered URL sanitising, paging by code unit, the load-more race.
- Known and not fixed here: a template cannot mark an attribute optional, so the starter's `{{frameworks}}` style lines are findings on an entity that lacks one; sentences under four words are never named as ungrounded; a related block with a `kind` filter counts after its page cut; a depth walk over entities that several producers carry stops at the first node; two repositories that hold the same key are not told apart in the neighbour reads; two product folders that share an id (a copied folder) share one store; and a fill takes the server's event loop between commits, so a request waits for the commit in progress. Mutation testing is not run: the rule is one run per assembled stage.

## DONE WHEN
A person who opens the wiki of a product holding the generated training repository starts the fill, watches the pages appear and reads from the home page to the payments service to a function with its callers and its source, every reference to code opening the source at its line and every ground that does not resolve shown as broken; and `madarch new` leaves the manifest and the templates in the product's own repository.
