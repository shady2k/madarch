# Graph API: one read API over the one graph, and the server's page layer deleted

Change: graph-api
Base: e1635110280605c1725d6310bbff2e84102f2140
Tasks: madarch-64o5.71, madarch-gzaz, madarch-64o5.65, madarch-64o5.64, madarch-64o5.66
Kind: behavior

## Intent
The owner decided that a page is a template of the product, run in the browser
over one read API (decision 0036): the wiki, MCP and outside systems ask the
graph through a GraphQL schema derived from the product's published manifest,
and the server keeps no page layer. Before this change the wiki was built by
the server from 32 hand-written blocks, each with its own graph reads, the
app's pages were hard-coded per kind, and MCP read through a record layer of
its own; the same product was known to three code paths and a page could not
be changed without an engine release.

After it, one schema answers every read: `entity`, one `all` root per type with
filters, ordering, paging and aggregates, the catalogue, `home`, `search`,
`bootstrap` and `revision`; every value is the agreement of its open opinions
and a disagreement is answered as `null` and named in `contested`; every edge
stands both ways with its discriminator and opinions, and a page's mentions are
edges. Agents read through the same executor over MCP (`graph_schema`,
`graph_query`) and write their opinions with their evidence (`put_entity`,
`put_edge`, `retract`). The server's page layer — the blocks, the renderers, the
Liquid templates and their compiler, the read routes, the Markdown page files
and the GraphReader reads only they used — is deleted in the same change, the
app is a shell until the template frontend lands, and `/api/status` states the
product and its kinds rather than a page's counts. The retained command routes
are the ones section 8 names because they are not graph data: the product
identity and status, the source text of the filled commit, the fill and its
runs, the agents and settings, the journal, the kind usage, the refresh plan,
the resets, the verdicts and the authored and problem and task writes.

## Out of scope
The template frontend itself (components, the browser's composition and cache,
the Markdown export and offline reopening) lands as the next change; the
catalogue's page keys (`card`, `history`, `views`, `er`, `sequence`, `system`,
`definition-block`, `listing`, `nav`) stay declared data and no page draws them
until that frontend reads them; the model store the `server` capability
describes beyond serving a wiki; and nothing a person's authored write does is
removed.

## Where it is seen

Kind: request
Place: POST /graphql, GET /graphql/schema, madarch mcp

1. A person opens the wiki on a served product and a page asks `POST /graphql` once, reading the entity, its relations and the bootstrap by `GET /graphql/schema`'s schema.
2. A client sends a query deeper than six levels, with more than fifty aliases, or above the cost ceiling, and is refused with `LIMIT_DEPTH`, `LIMIT_ALIASES` or `LIMIT_NODES`, naming the limit and the value, with no data.
3. An agent opens `madarch mcp` for the product, asks `graph_schema` for the SDL, writes a term with `put_entity` and its evidence, and reads it back with `graph_query`.
4. A person asks a page, block, catalogue, search, statement, glossary, document or view route the page layer had, and it answers 404; the app shell answers the app's own addresses.
5. A client polls `GET /api/status` and reads the product, its manifest, its groups, purposes, roles, repositories, the fill and the writer, the chosen agent, the publication state and each kind's count, with no page, block or unit list.

## Blocking questions
None.

## Preserved contracts
None.

## Coverage
- graph-queries/schema: test
- graph-queries/entity: test
- graph-queries/relations: test
- graph-queries/lists: test
- graph-queries/limits: test
- graph-queries/bootstrap: test
- graph-queries/read-api: test
- graph-queries/agent-read: test
- graph-queries/as-of: test
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/dependencies: test
- graph-queries/rebuild: test
- agent-writes/tools: test
- agent-writes/entity: test
- agent-writes/edge: test
- agent-writes/retract: test
- agent-writes/producer: test
- code-records/language: test
- code-records/class: test
- code-records/periods: test
- code-records/counts: test
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/live: test
- product-wiki/status: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/overview: test
- product-wiki/reading-typography: test
- product-wiki/front-matter: test
- product-wiki/architecture: test
- product-wiki/repositories: test
- product-wiki/stages: test
- product-wiki/questions-and-overview: test
- product-wiki/internationalization: test
- product-wiki/empty-home-guidance: test
- product-wiki/discussions: test
- product-wiki/presentation: test
- product-wiki/views: test
- wiki/pages: test
- wiki/templates: test
- wiki/export: test
- wiki/result: test
- wiki/diagrams: test
- wiki/engine: test
- wiki/documents: test
- wiki/links: test
- server/serves-wiki: test

## Design and decisions
The contract of decision 0036, sections 1–8, is the design: one schema from one
manifest, every value an opinion, edges both ways, Relay connections with
filters, ordering, paging and aggregates, admission limits and one snapshot per
operation, the product's templates, the one read API and the deletion of the
page layer. Section 8 is the deletion list this change executes, and the two
architecture checks of section 8 (`graphql-only-reads`, `no-kind-names`) hold
the result.

## Acceptance evidence
The reviews of the GraphQL layer and of the deletion, the shard runs of the
test suite, and the acceptance records of the stage in the tracker.
