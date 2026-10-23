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

## Rationale
`behavior` with no capability file of its own: the knowledge-pages requirement is a proposal of madarch-m38l.1 that has not landed in `docs/system`, so the diagram blocks join it when that stage closes. The choices (libraries, what the graph orders) are in "Design and decisions".

## Preserved contracts
- product-wiki/serve: the routes of the knowledge wiki keep their addresses and answers; one route is added.

## Coverage
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: the wiki of a product that holds the generated training repository, the home page, a service page, a function page and a domain page

1. The person opens the home page and sees the system: the four services, their databases and the broker, with the calls between them.
2. They open the payments domain page and see the end-to-end chain for paying, each step a link, and the part of the graph around the domain with what comes in on the left and what goes out on the right.
3. They click a node and its page opens.

## Blocking questions
None.

## Design and decisions
Filled with the acceptance evidence.

## Acceptance evidence
Filled when the diagrams are accepted.

## DONE WHEN
On the training repository: every service, domain, function, table and route page shows its neighbourhood diagram; the four use cases each have an end-to-end chain matching the answer key's flow items (the order of steps shown only where the graph knows it); the home page shows the system view; each diagram is accepted by screenshots at 1150 px and phone width with label sizes and overlaps recorded.
