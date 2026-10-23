# The wiki draws the graph: a clickable neighbourhood on every page, end-to-end chains across services, and system, module, ER and hotspot views

Change: madarch-m38l.9
Base: 232d109d94150c2bd8f6d30eb0916ce6036ae880
Tasks: madarch-m38l.9
Kind: behavior

## Intent
The owner, on the payments domain page, 2026-10-23: the page should draw the part of the graph around it, its inputs and outputs, each opening on a click, and there is no way to see an end-to-end chain; the whole wiki held one diagram. This change adds the diagrams as template blocks (decision 0029: the engine owns the blocks, a template arranges them), every one drawn from the graph, every node a link to its page, in light and dark, readable at 1150 px and on a phone.

Blocks: `:::graph` is the interactive neighbourhood (incoming on the left grouped by relation, outgoing on the right, depth and relation filter, pan, zoom, expand); `:::sequence{scenario=...}` is the end-to-end chain across services with every step a link and the order drawn only where the graph knows it; `:::system` is the C4 container view; `:::modules` the module dependency graph of a service with cycles marked; `:::er` stays the ER diagram of a database; `:::treemap` the files by lines, coloured by churn.

## Out of scope
- Entity pages for kinds that have none today (route, table, database, operation, channel) and the tabs: madarch-m38l.6. The blocks work on those entities; the starter templates of this change carry the block lines for the kinds the starter declares.
- Indexing Markdown into the graph (statements, grounded-by): madarch-m38l.8.

## Changes to requirements
- product-wiki/diagrams (absent on the target): add. The diagram blocks, their links, the order they claim and the notes they owe. Complete proposed text in `capabilities/product-wiki.md`, with the scenarios `neighbourhood-of-a-function`, `open-a-neighbour`, `chain-across-services`, `unordered-steps-are-apart`, `system-view`, `module-cycle` and `hotspot-treemap`.

## Preserved contracts
- product-wiki/serve: the routes of the knowledge wiki keep their addresses and answers; one route is added.

## Coverage
- product-wiki/diagrams: test
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: the wiki of a product that holds the generated training repository, the home page, a service page, a function page and a domain page
Mockup: docs/prototypes/madarch-m38l.9/domain-payment-1150-light.png

1. The person opens the home page and sees the system: the four services, their databases and the broker, with the calls between them.
2. They open the payments domain page and see the end-to-end chain for paying, each step a link, and the part of the graph around the domain with what comes in on the left and what goes out on the right.
3. They click a node and its page opens.

## Blocking questions
None.

## Design and decisions
Decision 0029 (blocks over the graph, templates arrange them). Choices inside it:
- **Own SVG, no graph library.** The neighbourhood is a layered drawing whose layers are given (what comes in on the left, what goes out on the right), the system and module views are small layered graphs, the chain is a table of lanes and rows, the treemap a squarified partition. xyflow needs a layout engine beside it (elkjs, 1.4 MB of the 7.7 MB `dist` is already the mermaid ELK chunk) and Cytoscape is 435 kB (also already a mermaid chunk, loaded only for mermaid); neither gives a fixed in/out column layout without a custom layout, and both bring a worker or wasm question for the compiled binary. The layouts are 300 lines of pure functions (`wiki/app/src/knowledge/diagrams/layout.ts`) that the tests check for overlap. Cost: no automatic routing for large graphs; the neighbourhood caps its nodes (48, per-group 8) and says what it left out. The ER diagram stays on the existing Mermaid renderer (static reads best) and gains a link to each table.
- **What a chain claims.** The graph holds no execution order, but it holds the place (line and byte) of every call, table access, remote call and publication inside the function that makes it. A chain therefore orders steps only by those places inside one function, goes depth first through calls, enters another service through the route or handler that serves the operation (`code.calls-remote` to `code.serves`), and draws what the graph links without an order (consumers of a topic, the readers of a table the chain wrote that go on to publish) under a dashed line that says so. Branches, loops and error paths are not modelled and the diagram says it. A call through an interface drops the interface's step and keeps the implementation's; several functions called at one site are marked as alternatives; same-file helpers that reach nothing are left out and counted.
- **Where a chain starts.** A route page starts at its route; a function page walks the callers upward until a caller stands inside a route's lines; a Markdown page follows its `relates` to those. A function no route reaches starts at itself and says so.
- **Derived neighbours.** A route's `handled-by` (what its registration calls at the route's lines) and a service's links (calls over HTTP/gRPC, databases, topics) are computed from spans and the system view's own reads; they appear in the neighbourhood with those relation names.
- **A click opens the node's page in a new in-wiki tab** (`openInNewTab` of madarch-m38l.6) through `DiagramOpenProvider`/`onOpen`; shift and alt are left to the browser, ctrl and the middle button open a tab as in the wiki's other links. A phone shows the chain as a list of steps (the lanes would scroll sideways under a column of bare numbers); the other diagrams pan.
- **Read cost.** `relationEdges` bounds its rows with a SQL LIMIT and counts the rest; every view that reads a whole relation says when it read part of it.

## Acceptance evidence
On the SkyPilot pod (`madarch-sky-test --avx2`, 2026-10-23), on the generated training repository, fixtures only:
- `test/knowledge-diagrams.test.ts` (13 tests, fills the training repository): POST /orders reaches handler `Create`, use case `Place`, domain `NewOrder`, `OrderRepository.Create` and the tables orders, order_items and outbox in the answer key's order (flow.orders.*), and the outbox's reader is an unordered step (outbox.chain); POST /payments reaches `PaymentService.pay`, the payments table, the publication to payments.events and its consumer in orders, unordered (flow.payments.chain, interaction.*); POST /checkout calls promotions, then orders over HTTP and payments over gRPC, each entering the serving route or handler (checkout.sequence); a function page reaches its route, a domain page the routes of its functions; the system view has four services, three databases, the topics and the HTTP, gRPC, SQL and event links; the payments service marks the domain-events cycle (payments.cycle.*); the treemap makes order_service.go the hotspot with churn 28 and leaves lock files out (hotspot). Also test/knowledge-render, knowledge-parse and knowledge-server: 61 pass with them; wiki/app: 105 pass, 0 fail (`bun run check`, `bun test`, `bun run build`).
- Bundle: the app's `dist` is 7.7 MB; the diagram code is in the main chunk (`index-*.js`, 690 kB, 210 kB gzip) and adds no dependency; Cytoscape and ELK are mermaid's own lazy chunks, as before.
- Compiled binary: `bun scripts/build-binary.ts` built `madarch-linux-x64` (119 MB, smoke ok), and `bun scripts/diagram-shots.ts --binary` made a product with the binary's own starter set, filled the training repository and drew every diagram through the binary's embedded app: 38 pictures (9 pages at 1150 px and 390 px, light and dark) in `/tmp/claude-1000/-home-dev-repos-madarch/6e4827be-b38f-4d37-915a-ccde034281b8/scratchpad/shots-diagrams/`; two are committed under docs/prototypes/madarch-m38l.9. Every picture was looked at; what was wrong (an unreadable crop of the system view at the right, lock files filling the treemap, the neighbourhood cut at the bottom, a type-reference relation drowning the function's neighbours, the chain on a phone) was fixed and the walk rerun.
- Label sizes (the font size as rendered, after the diagram's scale) and overlaps between the texts of one diagram, measured by the walk in the browser (`measures.json`):
- modules at 1150 px, light and dark: smallest label 8.8 px as rendered, 80 texts, summed over 9 pages and both schemes, 0 overlaps
- modules at 390 px, light and dark: smallest label 8.8 px as rendered, 80 texts, summed over 9 pages and both schemes, 0 overlaps
- neighborhood at 1150 px, light and dark: smallest label 11 px as rendered, 244 texts, summed over 9 pages and both schemes, 0 overlaps
- neighborhood at 390 px, light and dark: smallest label 9.9 px as rendered, 244 texts, summed over 9 pages and both schemes, 0 overlaps
- sequence at 1150 px, light and dark: smallest label 11 px as rendered, 1236 texts, summed over 9 pages and both schemes, 0 overlaps
- system at 1150 px, light and dark: smallest label 8.8 px as rendered, 54 texts, summed over 9 pages and both schemes, 0 overlaps
- system at 390 px, light and dark: smallest label 8.8 px as rendered, 54 texts, summed over 9 pages and both schemes, 0 overlaps
- treemap at 1150 px, light and dark: smallest label 10 px as rendered, 420 texts, summed over 9 pages and both schemes, 0 overlaps
- treemap at 390 px, light and dark: smallest label 10 px as rendered, 180 texts, summed over 9 pages and both schemes, 0 overlaps
- Read-only Codex review: nine findings, eight fixed with tests (alternatives at one call site, folded relation limits counted and propagated, the SQL bound, the more chip's paging, an opened node's opposite side, filters taking their edges, stale blocks reset); the ninth (control-click is intercepted) is the wiki's own convention for its links and is kept.

Limits: a route whose handler is shared by several routes loses it after the first registration (the extractor folds the sites of a pair into one edge; the occurrence records would answer it); the 8.8 px smallest label of the system and module views is the kind line at the view's smallest scale (0.8), and the wider views start at their left edge and are panned; chain consumers are limited to 40 unordered entries; mutation testing is not run (one run per assembled stage).

## DONE WHEN
On the training repository: every service, domain, function, table and route page shows its neighbourhood diagram; the four use cases each have an end-to-end chain matching the answer key's flow items (the order of steps shown only where the graph knows it); the home page shows the system view; each diagram is accepted by screenshots at 1150 px and phone width with label sizes and overlaps recorded.
