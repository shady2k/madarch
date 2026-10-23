# Graph kinds connect, contracts render by protocol, and history pages tell the story

Change: madarch-m38l.16
Base: 05af1efa4ccd3b72531c9f0c93fea0dd8d260982
Tasks: madarch-m38l.16
Kind: behavior

## Intent
A reader of the generated product wiki can follow the relationships that give
graph entities their meaning, understand an API contract in its native format,
and see the history behind a task, commit or author. The operations index
groups operations by contract and protocol. Contract pages provide a lazy,
read-only Definition view, and operation pages open at their own contract
operation. Graph relations connect data, operations, processes and history
rather than leaving isolated pages or dangling keys. The graph neighbourhood
must agree with the related block, and history pages must summarize the work
they record. A committed exhaustive audit over the generated training
repository prevents regressions.

## Out of scope
- Task document pages (`task` kind under `docs/tasks`) owned by madarch-m38l.14; this change covers graph kind `code.task` and graph history pages.
- Diagram modeling and other diagram renderers owned by madarch-m38l.15.
- Reader shell and writer changes owned by madarch-m38l.12 and madarch-m38l.13.
- Manifest upgrade, seed mechanism, index refusal and settings owned by madarch-m38l.11; new relation examples may be added only in `src/knowledge/seed.ts` `TEMPLATES` text.
- Changes to graph storage or product data, and tests requiring an outside repository or owner infrastructure.

## Changes to requirements
- product-wiki (extended): graph kinds have their meaning-implied relations and an exhaustive no-isolated-node audit; operations are grouped by contract with protocol-aware, lazy Definition views and operation deep-links; graph neighbourhood and related blocks agree; task, commit and author pages carry history summaries. Complete proposed text is in `capabilities/product-wiki.md`.

## Preserved contracts
None.

## Coverage
- product-wiki/graph-connectivity: test, generated-training-repository-audit
- product-wiki/contract-display: test, browser-walk
- product-wiki/graph-neighborhood: test, generated-training-repository-audit
- product-wiki/history-pages: test, generated-training-repository-audit, browser-walk

## Where it is seen

Kind: screen
Place: the product wiki's operations index, contract and operation pages, and graph pages for data, process and history entities
Mockup: docs/prototypes/madarch-m38l.9/function-pay-1150-light.png

1. A reader opens the operations index and finds operations grouped by contract, with protocol badges and the implemented-by, called-by and place columns.
2. They open a contract's Definition view to read its OpenAPI, AsyncAPI or gRPC definition, or follow an operation page to its contract slice and call chain.
3. They follow graph relations from a contract, table, endpoint, file, task or commit, and see its neighbours in both the graph diagram and relations block.
4. They open a task, commit or author history page and see the commits, changed files, symbols, authors and activity that explain it.

## Blocking questions
None.

## Design and decisions
Connectivity is supplied by the owning fill extractors. The expected relations
are: contract declares operation and message; database holds table; table has
column and index; index covers column; migration creates or alters table,
column and index; channel carries message; entry-point starts process or file;
health and metrics endpoint is served by service or route, with `GET /healthz`
also represented as a route; logger is used by file or service; commit touches
file and is authored by author; task is named by commit; facet describes file.
Existing graph ids must be resolved by their stable keys so these edges reach
real nodes. If an entity kind is truly standalone, the starter template names
it and gives its reason. The generated training-repository audit enumerates
every node, computes depth-one neighbours, compares those with the page's
related-block relations, and prints per-kind before/after totals and isolated
counts. It must never sample or silently cap results.

The contract catalogue groups the indexed operations by contract and protocol.
Definition renderers are loaded only when the reader opens Definition. OpenAPI
uses Redoc, AsyncAPI uses `@asyncapi/react-component`, and gRPC uses a local
service/method/message-field documentation view. Operation pages select their
own operation in the OpenAPI renderer and keep madarch's relationship links
and call chain. Renderer errors identify the contract and cause while leaving
the rest of the page usable. Renderer dependencies and app-owned messages are
kept within the wiki app's conventions and localized in English and Russian.

The neighbourhood query accepts all page-backed relation kinds, including
history relations; the relation parity test compares the same entity and graph
revision. History summaries are read from indexed graph facts only. Task pages
list commits with date, author and message; commit pages list changed files,
added/removed lines and symbols; author pages list commits and the most-touched
files and modules. Missing data is named, and any bounded result exposes its
total rather than implying the list is complete.

## Acceptance evidence
To be filled after implementation. Record the generated training repository's
per-kind isolated-node audit counts before and after, the exhaustive committed
audit result, relation parity, focused SkyPilot tests, contract renderer tests,
English and Russian rendered screenshots in light and dark at 1150 px and
390 px, read-only Codex review, and CI on the PR head.

## DONE WHEN
All listed graph kinds have their meaning-implied relations and stable endpoints;
the exhaustive generated-repository audit has no unjustified isolated nodes
and its before/after counts are recorded. The operations index is grouped by
contract and protocol with the required columns; contract Definition views use
the required lazy, read-only protocol renderers; operation views deep-link to
the operation. The graph neighbourhood and related block agree, and task,
commit and author pages carry the required history. English and Russian reader
screens are inspected in light and dark at desktop and phone widths.
