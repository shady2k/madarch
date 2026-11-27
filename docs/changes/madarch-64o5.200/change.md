# The packaged wiki's Logs page reads the machine's logs again

Change: madarch-64o5.200
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.200
Kind: no-behavior

## Intent

The owner's acceptance of ALX-1936 walked a fresh packaged product: the «Журналы» screen failed with
`Cannot return null for non-nullable field Query.logs`, while the logs stood on the disk beside the store. The page reads
`Query.logs` through `POST /graphql`, and the api role answers a graph operation in the read worker. The descriptor
`KnowledgeProduct.readDescriptor()` hands the worker the product's graph connection and nothing else, while
`logsReaderOf()` needs two more paths — the product's store folder and the knowledge root its logs stand under — and
answers no logs reader without them, which the non-nullable `logs: JSON!` turns into that refusal.

After this change the descriptor carries both paths, the same pair `product.logs()` already hands the read of
`/api/logs`: the field answers one structured page of every log madarch keeps for the product, keeps the source, level,
run, text and window filters and the paging of that read, and answers an empty page — `entries: []`, `more: false`,
`scanned`, `truncated`, the runs, the sources and the levels — when nothing matches. Nothing else of the page, the route
or the read changes.

## Out of scope

- The page's own drawing, its filters and its live tail: the kit's log viewer and the page's operation are unchanged.
- The `GET /api/logs` route: it reads `product.logs()` in the api process and answered before this change.
- The fill role's own reads, the run page's journal and what the agent units record: madarch-64o5.88 owns them.
- Which logs exist and where each one stands: the sources, their files and their bounds are that change's.

## Rationale

The refusal is one missing pair of paths, and the reader that needs them declares them as its own inputs
(`ReadDescriptor.store` and `ReadDescriptor.knowledgeRoot`, both commented "when the caller reads logs too"). The
product already holds both — its store folder and the knowledge root it was started with — so the smallest complete
change is to state them where the descriptor is built, in the one place that serves both `/graphql` reads of the api
role and the MCP read of the same product. A test reads the page through that production entry point: it failed with the
reported refusal before the change and passes after it, and a second case holds the structured empty page.

## Changes to requirements

None. The change realizes the Logs page's own proposed requirement (`product-wiki/logs`, proposed by change
madarch-64o5.88): one page of every log madarch keeps, read through the product's one read API, with its filters and
paging and an empty state. No requirement text moves.

## Preserved contracts

- product-wiki/serve: a served product still answers its wiki's reads through `POST /graphql` by the api role, one operation in its own read-only snapshot answered by the read worker; the page and the route that was already answered are unchanged (static)

## Coverage

- product-wiki/serve: static, test, mutation, review

## Where it is seen

Kind: screen
Place: the wiki's «Журналы» page of a packaged product, opened from the sidebar
Mockup: docs/changes/madarch-64o5.88/mockups/logs-1440-light.png

1. Make a fresh packaged product with `madarch init` on a new folder and the `everything` template, then run
   `madarch serve` and open its wiki in a browser.
2. Open «Журналы»: the page lists the machine's log rows, the server's own records at least, instead of the
   `Query.logs` refusal.
3. Choose a source, a level and a run, set a window and type a text that no row holds: the page answers its empty
   state, and the filters still name the sources, the levels and the runs they can offer.

## Blocking questions

None.
