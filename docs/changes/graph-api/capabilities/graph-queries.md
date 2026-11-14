# Graph queries

Capability: graph-queries

## Purpose
Answering the questions a page, an agent and an outside system ask of a product's graph (decision 0036): one GraphQL
schema derived from the product's published manifest, one executor behind `/graphql`, and the same executor behind MCP's
`graph_schema` and `graph_query`. Everything the wiki shows comes through it; no server-built page stands beside it.

## Requirement: schema — One schema from one manifest
The schema shall be derived from the product's published manifest alone: every kind of the catalogue is an object type
implementing `Entity`, its type name the kind name split on `.`, `-` and `_` with each part capitalised and joined; every
contract field is a field named in camelCase, answered as the value its open opinions agree on, `null` where they differ
and listed in `contested`, with `the fieldOpinions field` and `the fieldOpinionsCount field` beside it; a reference answers the entity it
names and the referenced type gets the inverse connection; every declared edge kind is a field on its `from` type and,
as `the edgeOf inverse`, on its `to` type, each connection row naming its discriminator and its opinions; every entity answers
`backlinks`. The roots are `entity(id:)`, one `one `all` root per type` list root per type with its `one `all` root per typeAggregate`, `catalogueEntity`
and `allCatalogueEntity`, `home`, `search`, `bootstrap` and `revision`. A manifest whose kind, edge or field name encodes
to a reserved name is encoded with the `Field` suffix rather than refused, and two declarations that encode to one name
refuse the manifest naming both.

### Scenario: golden-sdl
- Given: the starter catalogue's manifest and a fixture manifest covering every scalar, a reference and a repeated edge
- When: the schema is derived from each, twice
- Then: the two derivations of one manifest are identical byte for byte, and the starter's is `src/graphql/starter.graphql`
  Checked by test/graphql-schema.test.ts and test/graphql-starter.test.ts

### Scenario: reserved-and-collision
- Given: a manifest declaring a field and an edge that encode to one field name, and one declaring a kind whose type name the schema reserves
- When: the schema is derived
- Then: each is refused naming both declarations and the name, and a contract field named `id` is encoded as `idField` and the schema stands
  Checked by test/graphql-schema.test.ts and test/graphql-manifest-check.test.ts

## Requirement: entity — A field is its agreed value, and its disagreement is stated
Reading one entity shall answer `id` (its stable uid), `kind`, `label` (the field the manifest's `title:` names, else the
first text of its key), `template`, `opinions` where asked, `contested` and `backlinks`; a field answers its typed value,
not a JSON text; a key field answers the key's own value. Two producers that disagree answer `null`, list the field in
`contested` and keep both opinions, each naming its producer, version, language, time and evidence.

### Scenario: disagreeing-producers
- Given: a plugin and an agent that state different titles for one entity
- When: the entity's title is queried
- Then: the answer is `null`, `contested` holds `title`, and `titleOpinions` holds both opinions with their producers
  Checked by test/graphql-executor.test.ts

### Scenario: typed-values
- Given: an entity whose integer field is stored as a JSON number and whose reference names another entity
- When: the field and the reference are queried
- Then: the field answers an `Int`, and the reference answers the named entity through the inverse connection
  Checked by test/graphql-executor.test.ts

## Requirement: relations — Every edge stands both ways, and no mention is a second store
An edge kind shall answer on its `from` type as a connection whose rows carry the edge's attributes, its discriminator
and its opinions, and on its `to` type as `the edgeOf inverse`; a repeated edge between the same ends stays one row per
discriminator; an `any` end stands on the `Entity` interface and answers from either side. `backlinks` shall be a
connection over every inverse field, each row naming the relation and the entity it comes from. A page's mentions are
edges, published by the producer that states the page, and are read through these fields; no page-level `mentions` field
is read.

### Scenario: edge-both-ways
- Given: an agent's edge `mentions` from a term to a repository at a place
- When: the term is read forwards and the repository backwards
- Then: the forward connection holds the edge with its discriminator and opinions, the inverse holds it too, and the repository's `backlinks` names the term
  Checked by test/graphql-writes.test.ts

## Requirement: lists — Filter, order, page and aggregate on the server
Every list shall be a Relay connection — `edges { cursor node }`, `pageInfo { hasNextPage endCursor }`, `totalCount` —
with `where` (per scalar field `_eq _neq _in _nin _like _is_null`, per numeric and time field also `_gt _gte _lt _lte`,
per reference a nested where, `_and _or _not`, and per relation `_exists` with a nested where and an edge where),
`orderBy` on any scalar field with a direction and nulls placement (the order then `id`, so it is stable), `first`
(default 50, at most 200) and `after`; and an aggregate returning `count`, `groupBy` (with the last `__other` row),
`histogram` over half-open buckets and `topN`, all computed in SQL. A list of fifty entities with one edge each shall cost a
small constant number of statements, not one per row.

### Scenario: filter-order-page
- Given: a kind with more entities than one page holds
- When: a filtered, ordered query asks its first page and then the page after its end cursor
- Then: the rows are filtered and ordered by the asked field, the cursor continues where the first page ended, and `totalCount` is the filtered total
  Checked by test/graphql-executor.test.ts

### Scenario: aggregates
- Given: entities whose fields hold groups, times and values
- When: `groupBy`, `histogram` and `topN` are asked
- Then: the groups are ordered by count, the buckets are half-open, and the top values name their entities
  Checked by test/graphql-executor.test.ts

## Requirement: limits — Every query has a stated ceiling
Admission shall refuse a query deeper than six levels with `LIMIT_DEPTH`, one whose cost passes 5 000 with
`LIMIT_NODES`, one with more than fifty aliases with `LIMIT_ALIASES`, a `groupBy` limit above 20, more than 64 histogram
bounds and a `topN` above 50, each naming the limit and the value; a query shall run in one read-only snapshot
transaction under a two-second deadline that cancels it (`TIMEOUT`) and whose response over 2 MB is stopped
(`TOO_LARGE`); no refusal answers partial data.

### Scenario: depth-and-aliases
- Given: a query seven levels deep, and one with fifty-one aliases
- When: each is sent
- Then: each is refused with `LIMIT_DEPTH` and `LIMIT_ALIASES` respectively, naming the limit and the value, and no data
  Checked by test/graphql-admission.test.ts and test/graphql-schema-route.test.ts

### Scenario: cost-and-deadline
- Given: a query whose connections multiply past 5 000 nodes, and one that runs past the deadline
- When: each is sent
- Then: the first is refused with `LIMIT_NODES`, the second answers `TIMEOUT` with its transaction rolled back, and neither carries data
  Checked by test/graphql-admission.test.ts

## Requirement: bootstrap — The page's structure is known before its query
`bootstrap` shall answer the structure revision, the home entity's id, kind and template, and the product's page
templates — every file under the product's `templates/`, named by its relative path without its extension; `revision`
shall answer the structure and the data revisions, read inside the query's own snapshot. A different structure makes a
client fetch the bootstrap again.

### Scenario: bootstrap-and-revision
- Given: a served product with a template file under `templates/`
- When: `bootstrap` and `revision` are queried
- Then: the bootstrap names the home's template and the template file, and the revision's structure changes when the template changes
  Checked by test/graphql-schema-route.test.ts

## Requirement: read-api — One route serves the graph, and no other route reads it
`POST /graphql` shall answer one operation and `GET /graphql/schema` the SDL of the published manifest; every other read
route the page layer had is deleted and answers 404. The product's `catalogueEntity` and `allCatalogueEntity` roots shall
answer every entry of the published catalogue, taken or not.

### Scenario: one-read-route
- Given: a served product
- When: `POST /graphql` and `GET /graphql/schema` are asked, and the deleted page and catalogue routes are asked
- Then: the two routes answer, the deleted routes answer 404, and a query deeper than six levels is refused through the route
  Checked by test/graphql-schema-route.test.ts and test/removed-routes.test.ts

### Scenario: catalogue-entities
- Given: the starter catalogue's manifest
- When: `allCatalogueEntity` is queried
- Then: every entry is answered, with its declaration and whether the product takes it
  Checked by test/graphql-schema-route.test.ts

## Requirement: agent-read — Agents read through the same executor
The MCP surface shall offer `graph_schema`, answering the product's SDL, and `graph_query`, answering one operation
through the executor `/graphql` uses, in one product session; an unknown tool and an operation outside the admitted
limits shall be refused with the executor's own answer.

### Scenario: one-executor
- Given: one product MCP session
- When: `graph_schema`, then `graph_query` for an entity, then a write, are asked
- Then: the schema is the SDL, the query answers from the same executor, the write is published, and the next query reads it
  Checked by test/graphql-writes.test.ts

### Scenario: unknown-tool
- Given: the product MCP session
- When: a tool it does not offer is called
- Then: it is refused naming the tool, and nothing is published
  Checked by test/graphql-writes.test.ts

## Quality requirements
- Performance: a page's operation answers in under 1 s on madarch's own product (about 3 700 files, 3 000 commits) warm;
  a list of fifty entities with one edge each costs a small constant number of statements.
- Reliability: every operation reads one snapshot and no partial answer is returned; a cancelled query rolls back.
- Resources: the executor's response is bounded at 2 MB and its work at 2 s per operation.
- Compatibility: runs under Bun 1.4.2 with graphql 17.

## Context
Decision 0036, sections 1–5; decisions 0034 (one graph schema) and 0035 (every value is an opinion).

## Coverage limits
Historical reads, write mutations and subscriptions are not offered here; the MCP writes are capability agent-writes.
