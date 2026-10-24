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
- product-wiki (extended): graph kinds have their meaning-implied relations; an exhaustive audit checks isolation, unique labels and locations; entry points identify service, file, function location and started process; operations are grouped by contract with protocol-aware, lazy Definition views and operation deep-links; graph neighbourhood and related blocks agree; task, commit and author pages carry history summaries. Complete proposed text is in `capabilities/product-wiki.md`.

## Preserved contracts
None.

## Coverage
- product-wiki/graph-connectivity: test, generated-training-repository-audit
- product-wiki/entry-points-and-code-locations: test, generated-training-repository-audit
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
4. They open an entry point and see its service, file, function location and started process; then open task, commit or author history pages and see the commits, changed files, symbols, authors and activity that explain them.

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
Every code-derived node has a path and line span, every kind's labels are
unique, and entry points include service and file in the label, the function's
location, and links to service, file and process.
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

**Isolated nodes, before and after.** The owner's walk of shop on 0.2.2 found,
per kind: contract 3/3, message 2/2, database 4/4, column 40/40, index 6/6,
migration 8/8, entry-point 4/4, facet 40/40, health-endpoint 4/4,
metrics-endpoint 1/1, logger 4/4, commit 40/40, author 3/3, task 40/40 and
newcomer-prerequisites isolated, and file 21/40, input 5/10, operation 1/9,
env-definition 15/26 and make-target 2/7 partly isolated. Part of that was the
neighbourhood query hiding the history relations; part was edges no extractor
made.

After this change `test/extract-driver-suite.ts` walks every node of the
generated training repository at the tip the fill read, and prints
`GRAPH_AUDIT` per kind. CI run 40047024531 (test shard 1, job 120730994820)
printed 46 kinds and **0 isolated nodes in every one**, among them
`code.commit` 72, `code.task` 72, `code.author` 3, `code.contract` 3,
`code.column` 49, `code.index` 6, `code.migration` 8, `code.entry-point` 4,
`code.facet` 182, `code.file` 115, `code.route` 18, `code.env-definition` 26,
`code.input` 10, `code.make-target` 7, `code.service` 4. The audit also
requires a path and a line for every code-derived node (the history kinds and
the repository node are exempted with their reason in the test) and one label
per kind, the kinds whose label is a local name (a column of a table, a
symbol's name, a route's method and path, a service's variables) exempted with
their reason written beside them.

**Relation parity.** `test/knowledge-vertical.test.ts` walks twenty entities of
every kind of the filled product and requires every row every `related` block
of that page shows to stand in the page's depth-one neighbourhood, and a page
that shows relations to have a neighbourhood at all — the owner's «А здесь
почему пусто?». `QUIET_RELATIONS` is empty: the graph block no longer hides the
history relations.

**Entry points.** Each is labelled `<service> · <file>`, carries the file's
span and links to its service (`code.belongs-to`) and the process it starts
(`code.starts` → `code.process`), keyed as the deploy extractor keys it.

**History and definition pages.** Task pages list their commits with the day,
the author and the message; commit pages list the files with the lines added
and removed (a `--numstat` walk) and the symbols each file declares; author
pages list their commits and the files their work touched most, with their
module. Contract pages get a Definition block, lazy like the diagrams: the
OpenAPI operations, the AsyncAPI channels and messages, or the protobuf
services and rpcs, each at an anchor, beside the contract's own text.

**Checks.** GitHub CI on the PR head: run 40047024531 on `babb750c` is green in
all six jobs — `checks` (`bun run check`, the views and contract checks, and the
wiki app's own check, tests and build) and the five test shards. Shard 1
reported 2103 passing cases.

**Screenshots.** Rendered on the SkyPilot pod by `bun scripts/knowledge-shots.ts
--only shop`, which now also walks a task, a commit, an author and the OpenAPI
contract in light, dark and at a phone's width.

## DONE WHEN
All listed graph kinds have their meaning-implied relations and stable endpoints;
the exhaustive generated-repository audit has no unjustified isolated nodes
and its before/after counts are recorded. The operations index is grouped by
contract and protocol with the required columns; contract Definition views use
the required lazy, read-only protocol renderers; operation views deep-link to
the operation. The graph neighbourhood and related block agree, entry points identify their
service, file, function location and process, every code-derived node has a
location, labels are unique within each kind, and task, commit and author pages
carry the required history. English and Russian reader
screens are inspected in light and dark at desktop and phone widths.
