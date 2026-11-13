# 0036. One page mechanism: templates in the product, run in the browser over one GraphQL read API

Status: proposed
Date: 2026-11-13

Builds on 0001 (the graph is the product; frontends are replaceable), 0031 (one page in layers;
roles choose what opens; every term links to the glossary), 0033 (one of everything; greenfield:
what is replaced is deleted in the same work), 0034 (one graph schema) as amended by madarch-64o5.2 (every value is an opinion) and 0035.
Agreed with the owner on 2026-11-13; his words are on madarch-64o5.71. Task: madarch-64o5.71.

## Context and problem

A page today is built by the server. An entity page is a Liquid template of the product whose
blocks the server renders: 32 block names (src/knowledge/template.ts:5), 30 with a builder in
src/knowledge/render.ts and the modules it calls, each with its own graph reads; `stated` and
`implementedby` have none and show a problem. The kind page, the catalogue, the home page, the
fill page, statements, documents, glossary and search are hard-coded in the app
(wiki/app/src/knowledge/pages.tsx and the components it renders). 17 HTTP routes read the graph,
each with a query of its own (/api/page, /api/block, /api/entities, /api/catalog, /api/search,
/api/facts, /api/statement, /api/neighborhood, /api/view, /api/view-frame, /api/glossary,
/api/documents, /api/document, /e/<id>.md|.json, /kind/<kind>.md|.json, /llms.txt, /sources).
The server's page layer names kinds (code.file, code.repository, code.directory, code.commit,
code.author) in blocks, diagrams, file-page, files-map, history-evidence, render, views. Backlinks
are computed per request by scanning every Markdown entity in memory; the index behind half of
them is a stub that returns nothing (src/knowledge/index/queries.ts:23).

So a page cannot be rearranged or made without server code or an app release, the wiki knows the
data, and MCP and the wiki read through different code.

## Decision drivers (the owner's words, madarch-64o5.71)

- P-one-system: one page mechanism, no second surface, nothing hard-coded.
- P-every-page-a-template: home, catalogue entities, records, free text alike.
- P-components-generic: components live in the app and only display what they are given.
- P-wiki-knows-no-data: neither the app nor the server's page layer names a kind or holds a query.
- P-template-asks-the-graph: a template states what to ask; all a page shows comes from the graph.
- One read API, GraphQL, for the wiki, MCP and outside systems; filter, sort, page and aggregate on
  the server.
- The template runs in the browser; one composed query per page; answers cached for offline
  reopening; agents query the graph, never pages; page Markdown is a frontend export.
- For every participant of the product's life cycle; the role chosen at entry decides what a page
  shows and opens (0031).
- Delete first, write anew, land once; no compatibility, no dead code (0033 item 6).
- Base templates: home, entity, free text. Everything shown is a graph entity; a catalogue entity
  is an entity too, and its page lists its records through its instances relation.
- Quality: a page answers in under 1 s on madarch's own product (about 3 700 files, 3 000
  commits); every query has a hard cost ceiling; MCP and the wiki read through the same executor.

## Considered options

1. Server-side rendering of templates (today's shape, generalised). Fast first paint; the server
   stays the presentation layer and interaction needs a second path in the browser — two systems.
2. Templates run in the browser over one GraphQL API (Backstage entity pages over the catalog
   API; Grafana panels: query plus visualisation; Relay fragment composition). The server only
   answers queries; the same API serves MCP and outside systems.
3. A hybrid that renders the same components on the server for the first paint. Heaviest build;
   little gain for a local wiki. Reachable later from option 2 without changing templates.

## Decision

Option 2. Sections 1–7 are the contract the backend and the frontend are built against in
parallel; a change to it is a change to this record.

### 1. Names in the schema

- **Types.** Every kind of the published manifest (catalogue entity) is an object type implementing
  `Entity`. Its type name is the kind name split on `.`, `-` and `_`, each part capitalised and
  joined: `code.file` → `CodeFile`, `doc.use-case` → `DocUseCase`. Its list root is `all` and the
  type name (`allCodeFile`), its aggregate root `all<Type>Aggregate`. There is no fallback: two
  kinds, fields or edges that encode to one name refuse the manifest (below).
- **Fields.** A contract field's name in camelCase (`commit_count` → `commitCount`). An edge kind's
  name in camelCase (`links-to` → `linksTo`, `code.contains` → `codeContains`).
- **Reserved**: field names `id`, `kind`, `label`, `template`, `opinions`, `contested`, `backlinks`,
  names starting `__` or ending `Of`, `Aggregate`, `Opinions`; type names `Query`, `Entity`,
  `CatalogueEntity`, `PageTemplate`, `Bootstrap`, `Revision`, `Opinion`, `Evidence`, `Group`, `Bucket`,
  `Ranked`, the scalars, and any ending `Connection`, `Edge`, `Where`, `Order`, `OrderField`,
  `Aggregate`.
  - A **contract field** (or edge kind) whose encoded name is a reserved field name is **encoded, never
    refused**, so an existing product keeps opening: it takes the `Field` suffix (`id` → `idField`, `label` →
    `labelField`, `backlinks` → `backlinksField`, `xOf` → `xOfField`), and a name starting `__` takes the `field`
    prefix (`__x` → `field__x`). Two declarations that encode to one field name of one type still refuse the
    manifest, naming both.
  - A **type name** that is reserved refuses the manifest naming the declaration (the manifest check of
    madarch-64o5.9). A manifest whose names collide after encoding also refuses, naming both declarations, so two
    machines always derive one schema.
- **Scalars**: text → `String`, integer → `Int`, bigint → `BigInt` (decimal string), boolean →
  `Boolean`, timestamp → `DateTime` (ISO 8601 with offset), json → `JSON`. A nullable contract
  field is nullable; every value is nullable on read (see 2).
- **Interface** `Entity { id: ID!  kind: String!  label: String!  template: String!  contested:
  [String!]!  backlinks(first: Int, after: String): BacklinkConnection! }`. `id` is the stable
  uid of 0034 item 2.
- **Roots**: `entity(id: ID!): Entity`, one list root per type, `catalogueEntity(name: String!):
  CatalogueEntity`, `home: Entity` (the product entity), `search(text: String!, kinds: [String!],
  first: Int, after: String): EntityConnection!` (labels and text fields), `bootstrap: Bootstrap!`,
  `revision: Revision!`. Every root takes `lang: String` (default the reader's language).
- **Bootstrap** `{ structureRevision: String!  home: { id: ID!  kind: String!  template: String! }
  catalogueTemplate: String!  templates: [PageTemplate!]!  recordTemplates: [{ kind: String!  template:
  String! }]!  ownTemplates: [{ id: ID!  template: String! }]!  roles: [String!]! }`;
  `PageTemplate { name: String!  body: String! }` (not `Template`: that name is the type of the catalogue entity `template`). `Revision { structure: String!  data: String! }`:
  `structure` changes with the schema or any template, `data` with every publication or authored
  write.

### 2. Values are opinions (the model after madarch-64o5.2)

0034 item 7's authoritative and claimed fields were removed by madarch-64o5.2: every value a
producer states is an opinion (src/product/manifest/kinds.ts:1728), and a read gives the value
where the open opinions agree and marks it contested where they differ (src/graph/records.ts:102).
The API keeps exactly that:
- `<field>` returns the agreed value; `null` where no open opinion states one or where they differ.
- `<field>Opinions: [Opinion!]!` with `Opinion { value: JSON, producer: String!, version: String,
  lang: String, statedAt: DateTime!, evidence: [Evidence!]! }` and `Evidence { repository: String,
  path: String, lineStart: Int, lineEnd: Int, revision: String }`.
- `contested` lists the fields whose opinions differ.
- A text field held in several languages returns the opinion in `lang`, else the product's default
  language.
- Filters, sorts and aggregates use the agreed value; a contested value counts as `null`.

### 3. Relations and backlinks

- **Edges.** Every declared edge kind is a field on its `from` type (`<edge>`) and on its `to` type
  (`<edge>Of`), each an `EdgeConnection` whose edge record is `{ id: ID!  discriminator: String!
  opinions: [Opinion!]!  <edge attribute fields>  node: Entity! }`, so repeated edges between the
  same ends (0034 item 5) stay apart.
- **References.** A reference field returns the referenced `Entity`; the referenced type gets the
  inverse `<field>Of<SourceType>` connection (`CodeRepository.repositoryOfCodeFile`), because a
  reference is a relation too (0034 item 3).
- **Backlinks** on every entity: `backlinks` is a connection over every inverse field above, each
  row `{ relation: String!  from: Entity! }`.
- **Mentions are edges.** The producer that publishes a Markdown page also publishes, for each
  occurrence, an edge `mentions` (page → entity), `linksTo` (page → page) or `grounds` (statement →
  entity), discriminated by the occurrence's place (`path:line:column`) with that place as
  evidence, resolved by the same resolver the page uses today. It republishes them with the page,
  so an edited or deleted mention is retracted by producer-scoped retraction (madarch-64o5.47). The
  in-memory scan of linked-from.ts and the stub index (src/knowledge/index/queries.ts) are deleted.

### 4. Lists and aggregates

- **Connections** (Relay): `{ edges { cursor node } pageInfo { hasNextPage endCursor } totalCount }`.
  Every list in the schema is a connection; there is no unpaginated list. Arguments
  `where: <Type>Where`, `orderBy: [<Type>Order!]`, `first: Int` (default 50, at most 200),
  `after: String`. `<Type>Order { field: <Type>OrderField!  direction: ASC | DESC = ASC  nulls:
  FIRST | LAST = LAST }`, where `<Type>OrderField` is the enum of its scalar fields' names. The
  order is `orderBy` then `id`, so it is stable; a cursor is an opaque string of the order key and
  the id.
- **Filters**: `<Type>Where` has, per scalar field, the operators its scalar allows — `String`:
  `_eq _neq _in _nin _like _is_null`; `Int`, `BigInt`, `DateTime`: `_eq _neq _in _nin _gt _gte _lt
  _lte _is_null`; `Boolean`: `_eq _neq _is_null`; `JSON`: `_is_null` — with `_in _nin` taking a
  list of the scalar; per reference field a nested `<Other>Where`; `_and _or: [<Type>Where!]`,
  `_not: <Type>Where`; and per relation (edge or inverse) `{ _exists: Boolean  where: <Other>Where
  edgeWhere: <Edge>Where }`: `_exists: true` (the default) means some edge satisfies both `edgeWhere`
  and, at its other end, `where`; `_exists: false` means none does.
- **Opinions** lists are bounded, not connections: at most 50 per field, the newest first, with
  `<field>OpinionsCount: Int!` beside them.
- **Aggregates**: `<listRoot>Aggregate(where)` and `<relation>Aggregate(where)` return
  `{ count: Int!  groupBy(field: String!, limit: Int = 20): [Group!]!  histogram(field: String!,
  bounds: [JSON!]!): [Bucket!]!  topN(field: String!, n: Int = 10): [Ranked!]! }`. `Group { key:
  JSON  count: Int! }` ordered by count descending then key, with a last `{ key: "__other" }` row
  when more groups exist; `Bucket { from: JSON  to: JSON  count: Int! }`, half-open `[from, to)`,
  one before the first bound and one after the last; `Ranked { node: Entity!  value: JSON! }`
  descending, ties by id; `n` at most 50. Computed in SQL.

### 5. Limits and errors

- **Admission**, on the query after fragments are inlined and defaults applied, before any read:
  depth ≤ 6; cost ≤ 5 000, where every field's cost is the product of the `first`s of the
  connections on its path from the root (the default where absent) times its own weight — 1 for a
  connection's nodes, 50 for an opinions list, 100 for an aggregate — and the query's cost is the
  sum; aliases ≤ 50; `groupBy` limit ≤ 20; `histogram` bounds ≤ 64; `topN` n ≤ 50.
- **At run time**: the whole operation runs in one read-only snapshot transaction under a 2 s
  deadline that cancels it (statement timeout set for the transaction, and the executor's own
  deadline across statements); a response over 2 MB is stopped.
- **Errors**: a refused or stopped query returns no data and one error whose `extensions.code`
  names it (`LIMIT_DEPTH`, `LIMIT_NODES`, `LIMIT_ALIASES`, `LIMIT_GROUPS`, `LIMIT_BUCKETS`,
  `LIMIT_TOPN`, `TIMEOUT`, `TOO_LARGE`) and whose message says the limit and the value. No partial
  answers.
- **Executor**: one resolver layer over the storage interface (0033 item 3); relations batched per
  level; only requested columns read.

### 6. Templates

Templates are entities of the graph (kind `template`, written at start with the catalogue,
madarch-64o5.29), authored as YAML files in the product's `templates/`. The Liquid templates and
their compiler go.

```yaml
template: repository          # unique name
extends: entity               # optional; the base's sections come first
sections:
  - id: facts                 # unique within the page after inheritance
    after: header             # optional; where an inherited page inserts it
    replace: false            # true replaces the inherited section with the same id
    component: facts          # one of the app's components
    title: { en: Facts, ru: Факты }
    roles: { show: [all], open: [all] }   # role names of the manifest (0031), or all
    on: subject               # subject (the page's entity) or root
    query: |                  # a GraphQL selection on the subject's type, or on Query for root
      name url defaultBranch
    params:                   # the component's parameters; paths point into this section's data
      rows:
        - { label: { en: Name, ru: Имя }, path: name }
        - { label: { en: Default branch, ru: Основная ветка }, path: defaultBranch }
```

- **Variables** a query may use: `$id` (the subject), `$lang`, `$role`, and the paging variables
  `$<sectionId>_first` / `$<sectionId>_after` that the runtime supplies.
- **Composition**: the runtime builds one operation per page, one aliased root field per section:
  a subject section becomes `s_<id>: entity(id: $id) { ... on <Type> { <its selection> } }`; a root
  section's query is exactly one root field with its arguments and selection, aliased `s_<id>`. A
  section's data is the value under its alias. The operation declares `$id`, `$lang`, `$role`, the
  template's declared variables and the paging variables that sections use, and no other. One
  request, one transaction (section 5).
- **Variables** a template declares: `variables: { <name>: { type: <GraphQL input type>, required:
  bool, default: <value> } }`. An address's query parameters bind only to declared variables,
  coerced to their type; a missing required one shows the page's error. The `table` component binds
  its filter and sort to `$<sectionId>_where` and `$<sectionId>_orderBy`.
- **Which template**, known before the page's query from the bootstrap and the address (which
  names the kind): `/` is the bootstrap's `home`; a catalogue entity's page is
  `catalogueTemplate`; any other entity uses its own template (`ownTemplates`), else its kind's
  record template (`recordTemplates`), else `entity`. The same value is the entity's `template`
  field. A catalogue entity's page uses its catalogue template, which
  extends `entity` and adds the records section. The home is `home`; a page whose body is stored
  text uses `text`.
- **One request per page view**: the app fetches `bootstrap` once at start and keeps it; a page
  view is then one `/graphql` request. Every response carries `extensions.revision { structure data
  }`, read inside the query's snapshot, so both are the revisions the data was read at. A different
  `structure`, the event `structure-changed`, or an error `STALE_STRUCTURE` (a query naming a field
  the schema no longer has) makes the app fetch the bootstrap and run the page once more.
- **Base templates** shipped by the starter: `home`, `entity`, `text`.

### 7. The app

- **Addresses**: `/` (home); `/e/<kind>/<id>` for every entity — a record, a catalogue entity, a
  document page, a glossary term, a statement, a problem, a task; `/p/<template>?<name>=<value>` for
  a template bound to no entity (product settings, fill runs, one fill run `?run=<id>`), whose query
  parameters become the operation's variables of the same name. Search is the `search` component in
  the base templates' header; the glossary is the page of its catalogue entity.
- **Components**, generic, taking only their section's data and parameters: `header` (title, kind
  badge, provenance), `facts` (label/path rows), `text` (Markdown from the graph; glossary terms
  linked), `relations` (a relation's rows both ways), `table` (columns by path; filter, sort,
  paging through the connection's variables), `bars` (groups), `timeseries` (buckets), `treemap`,
  `diagram` (depth 1; an edge and its inverse merged; more than `aggregateAbove` entities of a kind
  drawn as one node with the count; fitted to the frame; click to refocus), `source` (a citation
  with its line range), `tabs` (sections as tabs). Command components: `fill` (choose and run;
  the catalogue page's choose-for-fill mode), `run` (a fill run's progress), `settings-form`,
  `problem-actions`; they call the command API and read what they show from the graph or the
  retained command reads. The app names no kind.
- **Component parameters** (all optional unless marked; `path` is a dot path into the section's
  data; texts are `{ en, ru }`): `header { titlePath*, kindPath, provenancePath }`;
  `facts { rows*: [{ label*, path*, format: text|number|date|bytes|link }] }`;
  `text { path* }`; `relations { path*, labelPath, emptyText }`;
  `table { path* (a connection), columns*: [{ label*, path*, format, sortField }], filterFields,
  pageSize }`; `bars { path* (groups), labelPath, valuePath }`; `timeseries { path* (buckets) }`;
  `treemap { path*, areaPath*, colourPath, groupPath }`; `diagram { path*, aggregateAbove = 12 }`;
  `source { path* (evidence) }`; `tabs { sections*: [section ids] }`; `search { kinds }`;
  `fill { mode: choose|run }`; `run { runVariable* }`; `settings-form { group* }`;
  `problem-actions { path* }`. A template naming an unknown component or parameter is refused at
  start with the file and line.
- **Cache**: answers are cached normalised by `Entity.id`, keyed by product, `structure` revision,
  language, role, operation and variables, each stamped with the `data` revision it was read at,
  and persisted with the bootstrap in IndexedDB; the app shell by a service worker. The event
  stream's `graph-changed { data }` (sent after a publication or an authored write) marks answers
  of an older `data` stale and refetches the visible page; after a disconnect the app reads
  `revision` once and does the same, so a missed event costs nothing. Offline, a cached page
  opens with a banner saying offline and as of when; a page never fetched says it is not
  available offline.
- **Markdown export** of a rendered page is the frontend's, from the components' text forms.

### 8. Reads, commands and what is deleted

- **Through GraphQL** (their routes deleted): /api/page, /api/block, /api/entities, /api/catalog,
  /api/search (a `search(text, kinds, first)` root over labels and text fields), /api/facts,
  /api/statement, /api/neighborhood, /api/view, /api/glossary, /api/documents, /api/document,
  /api/authored and /api/authored-schema (authored entities are entities; the schema is the
  GraphQL schema), /api/problems and /api/questions/question and /api/tasks/task (problems,
  questions and tasks are entities), /e/<id>.md|.json, /kind/<kind>.md|.json, /llms.txt, and the
  MCP tools of src/mcp/records.ts and `read_entity` (replaced by `graph_schema` and `graph_query`).
- **Retained, because they are not graph data**: /api/source (a file's text at the filled commit,
  from git), /api/events (the event stream), /api/status and /api/products and /api/product, the
  fill commands and /api/fill-runs and /api/run (workflow state), /api/agents and /api/agent-choices
  and /api/model-role, /api/settings and /api/product-settings, /api/journal, /api/kind-usage (agent
  metering), /api/refresh-plan, /api/reset, /api/graph-verdicts, /api/rewrite-pages,
  /api/start-fresh, the authored and problem and task writes, and GET and POST /sources, POST
  /models and /views of the model mode (not the wiki).
- **Deleted with them**: the 32 blocks and their builders (render.ts, blocks.ts, the block
  functions of diagrams.ts and views.ts, history.ts, definition.ts, linked-from.ts, overview.ts,
  file-page.ts, the files-map read paths), DEFERRED_BLOCKS and the defer/only handling,
  blockIdentity, trailOf, kindSummaries, listEntities, searchWiki, /api/view-frame (an HTML render of
  a view), page-files.ts, the Liquid TEMPLATES of src/knowledge/seed.ts and
  src/plugin/template-declarations.ts, the app's hard-coded pages and their API functions, the
  GraphReader methods only they use, and the scripts and tests that exercise them (rewritten against
  the new API where the behaviour stays).
- **Architecture checks** (0033 item 4): the mechanism code (src/server, the new src/graphql,
  src/knowledge's remaining modules, wiki/app/src) names no kind; starter data (catalog/, the
  starter templates) is data and may; a read route outside `/graphql`, `/graphql/schema` and the
  retained list above is refused; the app imports no API function other than the GraphQL client
  and the command client.

### 9. The contract as code, first

Before either side is built, the first deliverable makes sections 1–7 executable, and it is the
source of truth where it and this prose differ (the record is then corrected): the schema
generator with a golden SDL for a fixture manifest covering every scalar, a reference, a repeated
edge with attributes, an inverse, a reserved-name refusal and a collision refusal; JSON Schemas for
a template file and for every component's parameters; and the one page-composition module used by
both the server (validating templates at start) and the app (building the page's operation), whose
tests compose every base template and validate the result against the golden schema with
graphql-js `validate`.

## Constraints

| Id | Requirement | Check |
|---|---|---|
| C1 | A page's graph data comes only through /graphql; command reads only through command components | an architecture rule refuses any app import of an API function other than the GraphQL client, and the command client outside the command components |
| C2 | No kind name in the app or the server's page and API layer | an architecture rule over src/knowledge, src/server, wiki/app/src |
| C3 | A page is changed by a template edit only | a test edits a section of the repository template in a fixture product and sees the page change with no code change |
| C4 | One request per page view | a browser test counts /graphql requests per page load: 1 |
| C5 | A page answers in under 1 s | in headless Chromium on the CI runner, warm (bootstrap cached), the 95th percentile of 20 loads of the repository page and of a file page — query, response and render to the last section — is under 1 s on a fixture of 3 700 files and 3 000 commits (declared size) |
| C6 | Query limits are enforced | tests exceed each limit and see the refusal naming it |
| C7 | Backlinks on every entity | a test: an edge A→B and a page mention of B both appear on B's page as inverse fields |
| C8 | MCP and the wiki read through one executor | the MCP graph_query test and the wiki query test go through the same executor module |
| C9 | Offline reopen | a browser test opens a page, goes offline, reopens it |
| C10 | Values are opinions | a test: two producers agreeing give the value; disagreeing give null, the field in `contested` and both in `<field>Opinions` |
| C11 | Nothing deleted by section 8 remains | the unreachable-code check (knip), and a test that each removed route answers 404 |
| C12 | One schema from one manifest | a test derives the schema twice from one manifest and compares the SDL; a manifest with a name collision or a reserved name is refused naming both |
| C13 | Template precedence | a test: an entity with its own template, one with only a catalogue record template, and one with neither each render with the expected template |

## Consequences

- Every page is data; a page is changed in the product repository, not in madarch.
- The server grows a GraphQL layer and its limits; the page layer it had goes.
- Interaction (filters, sorting, switches) re-queries the graph instead of a second code path.
- Agents lose the Markdown page routes and gain the graph itself over MCP.
- Historical reads, write mutations and subscriptions are not in this version.
