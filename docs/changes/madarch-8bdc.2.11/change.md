# The one graph: one schema for code, the wiki and the fill

Change: madarch-8bdc.2.11
Base: d77be7d43c0247532f373c4f10d012160dd16b77
Tasks: madarch-8bdc.2.11, madarch-8bdc.2.12, madarch-8bdc.2.14
Kind: behavior

## Intent

Decision 0034 replaces the two graphs with one. `node` is identity only; every kind extracted
from code has a generated table keyed by `node_id`, with its contract's fields and natural key;
an edge stands apart with a per-kind repeat rule; a claim carries its producer and its evidence
names one vertex, one edge or one claim; contexts are layers over the base; the journal records
what people and the agent do; and dictionaries hold each value once. The fill's tree and history
passes write that schema, a deleted path keeps its vertex and history, and a file's language is
a claim whose ambiguous answer is its candidates.

The change deletes 0028's temporal tables and every line over them, the old fact store
(`fill_fact`, `fill_fact_holding`) and its readers, writers and stages. The wiki's catalogue,
the entity pages of repository, directory, file, commit and signature, and the blocks these
facts fill read only the one graph; `/k/file` goes to the file's entity page. The top-bar
search keeps its field, Ctrl/Cmd+K, grouped results and parser-read snippets, and reads the one
graph beside the Markdown pages. The fill's tables get foreign keys on `(unit_id, generation)`
and `run_id`, and pg-boss remains the one dispatcher. The 2.12 fix stops a store's queue before
its owner closes and logs every pg-boss error without ending the process.

Item 14 makes the manifest the one place a kind is declared: a kind states its typed fields,
natural key and filling capability; the manifest may declare edge kinds the same way. A
capability declares its own graph contract, and the engine's DDL holds only mechanism tables.
A product that binds no code kind gets no repository, file, commit, signature, blob or path
table and still opens, fills and serves. The a3 landing generates every table name from the kind
and a digest, gives `node` a UUIDv5 `uid`, and moves the git writer and every wiki/MCP reader
onto the generated names. The review fixes make repeated status reads cheap, bound a fill's
trace, and serialize contract DDL.

Increment a1 of decision 0035: a product starts with madarch's plugins and the contract of every
kind it takes. `madarch new` writes the git reader's closure into `plugins/git/` and the starter
manifest carries, for every code kind, its typed fields with authoritative or claimed roles and
their producers, its natural key, the kinds its discovery depends on, and the plugin declarations
whose inputs and outputs bind those kinds. The manifest is checked before any fill: a field with
no producer, an authoritative field with a second producer, a dependency cycle, a dependency on
an undeclared kind, and a plugin input outside the dependency closure of its earliest output kind
are each refused with the kind, field or plugin named. A valid manifest passes.

Until the plugin host lands (task madarch-8bdc.2.15), the plugin declaration is data: it names
the id, version, inputs, outputs and closure files. Nothing executes it; the in-process git reader
stays the producer of the code kinds.

## Out of scope

- The extractor stages that would add symbols, imports, tables, columns, routes and contracts:
  their kinds and edge kinds come with their own later step.
- Branch and worktree layers beyond the base context the fill writes; the schema stands.
- The statement index's producer; its counts are zero until a stage writes statements.
- The guide writer, the graph-verdict judge and the MCP graph tools: their producers are later
  stages, and they answer nothing rather than a second store's facts.

## Rationale

One graph removes the second surface that made the wiki read tables nothing wrote, and one
contract per kind lets a product choose the kinds it needs without a madarch release.

## Changes to requirements

The one-graph capability is added in `capabilities/one-graph.md`. It replaces the temporal
contract of decision 0028: `schema`, `fill`, `deletions`, `wiki`, `search`, `orchestrator`,
`database-as-is`, `contract`, `generated-tables` and `migration` are the requirements this
change adds or replaces. The temporal graph's requirements are removed there.

## Preserved contracts

None.

## Coverage

- one-graph/schema: static test mutation review root-suite architecture-check
- one-graph/fill: static test mutation review root-suite walk
- one-graph/deletions: static test review root-suite architecture-check
- one-graph/wiki: static test review wiki-app-check wiki-app-test wiki-app-build root-suite
- one-graph/search: test review root-suite wiki-app-test
- one-graph/orchestrator: test review root-suite
- one-graph/database-as-is: review walk
- one-graph/contract: static test mutation review root-suite architecture-check walk
- one-graph/generated-tables: static test mutation review root-suite architecture-check walk
- one-graph/migration: static test mutation review root-suite

## Where it is seen

Kind: screen
Place: the served product wiki and the fill's progress
Mockup: docs/prototypes/madarch-m38l.6/catalogue-en.png
Reason: the catalogue, the entity pages and the search are the reader's screens; the schema, the deletions and the foreign keys are the store under them.

1. Open a filled product's catalogue and see files, directories, commits and signatures
   counted.
2. Open a repository, a directory, a file and a commit; the file's page shows its source, its
   history and the commits that touched it, and the repository page shows the treemap.
3. Press Ctrl/Cmd+K and search for a word; the rows are grouped by kind and a page's excerpt is
   the text the Markdown parser yields.
4. Press the fill button and watch it end; the server still answers after the queue's timer.
5. Open a tracker-only product's catalogue: its two Markdown kinds are counted, and its store
   holds no `repository`, `file`, `commit`, `signature`, `blob` or `path` table.

## Blocking questions

None.

## Design and decisions

The DDL is in `src/graph/one-graph.ts`; a capability's contract is `src/graph/contract.ts`,
the git one `src/fill/stages/git-contract.ts`, and the manifest's fields are
`src/product/schema.ts` and `src/knowledge/kinds.ts`; the fill's writes and reads are in
`src/graph/records.ts`. The wiki's reader is `src/knowledge/graph-read.ts`; the entity pages and
blocks are in `src/knowledge/{render,repository-view,diagrams,history}.ts`; the search is
`src/knowledge/render.ts` and `wiki/app/src/knowledge/search.tsx`. The orchestrator's foreign
keys are in `src/fill/{state-store,orchestrator-store}.ts`, and a step takes the run's row
before its unit's generation. The deleted surfaces are not kept: the old code comes back from
git history if a later step needs it.

### The noUnused and knip cleanup

Both tsconfigs set `noUnusedLocals` and `noUnusedParameters`. The cleanup deleted the dead
model, writer, fact-vocabulary and product-registry code the flags and knip reported, and the
test files whose only subject was that code. The live server and history tests keep their
cases through a trimmed `test/api.ts`; no test of live code was deleted. The deleted test files
are listed in `/work/out/review-test-cases.md`; each imported a deleted module or export.

### The live tests and the history contract

The deleted test files were restored from `origin/main`. A case was kept when the function or
module it tests is still exported, and adapted to the generated tables; a case was deleted only
when its subject was deleted. No assertion was weakened. The file and commit history readers
name the changed-file fields and the `authored`, `touched`, `parent` and `renamed-to` relations
through the git contract data, not engine literals. On the walk store the file page's 16 history
rows all carry change and author, the commit page's 15 Files rows all carry
change/added/removed, and its 1 Parents row carries the parent's figures and author. The
Problems sidebar's 130 rows are all the real `large-file` rule; no class reads a deleted surface.

### The api role's first answer and the contract race

The status answer parsed the store's whole trace through an O(n^2) step report: on 150 130
spans the report took 127 s and the answer 303 s. `stepReportsOf` now assigns each span to its
nearest step once, `runViewOf` is cached by the trace generation, the server opens a trace under
the knowledge root, and the trace flushes while it runs. The first status answer is 0.9 s; later
answers are 5-13 ms. `createContractTables` takes a transaction-level advisory lock keyed by the
store before generated DDL; two concurrent first fills create every table once.

### Cheap repeated status and bounded traces

The trace no longer writes one span per statement: a transaction states `db.statements`,
`db.rows`, `db.selects`, `db.inserts`, `db.updates`, `db.deletes` and `db.other`, and the fill's
spans are per unit, batch, pass and step. A fill of the walk repository is 293 spans and 308 KB.
`settings.json`'s `traceRuns` (default 20) keeps only the newest traces; older files and logs are
deleted. The status cache is keyed by run id and trace size, so a second poll is under 50 ms.


### Mutation

StrykerJS 9 with the command runner, TypeScript 5 beside it, run from `/work/out/stryker-run`
under `timeout 600`: the generated-table builder `src/graph/contract.ts:100-230` against
`test/graph-one-schema.test.ts` produced 263 mutants: 97 killed, 166 survived, score 36.88%
(3 min 15 s). The status cache `src/knowledge/product.ts:2140-2180` against
`test/api-role-first-page.test.ts` produced 53 mutants: 2 killed, 51 survived, score 3.77%
(1 min 24 s). The survivors are listed in `/work/out/stryker-run/contract.json` and
`/work/out/stryker-run/status.json`; mutation never blocks.
## Acceptance evidence

- `test/graph-one-schema.test.ts`: the DDL, the normal form, the natural keys, the edge repeat
  rule, the evidence CHECK and the hash algorithms.
- `test/graph-records.test.ts`, `test/mcp-records.test.ts`, `test/repository-wiki.test.ts`: the
  fill's two passes and the pages that read them.
- `test/knowledge-render.test.ts`, `test/knowledge-m38l21.test.ts`,
  `test/knowledge-chain-boundaries.test.ts`, `test/knowledge-page-snapshot.test.ts`: the wiki's
  rendering, details, chain and page transaction over the one graph's reader.
- `test/knowledge-search.test.ts`: the search over the Markdown pages and the graph.
- `test/fill-orchestrator.test.ts`: the fill tables' foreign keys and the one queue.
- `test/knowledge-tracker-only.test.ts`: a tracker-only product opens, fills and serves; its
  catalogue counts its Markdown kinds and its store has the mechanism tables and no code table.
- `test/graph-contract-lock.test.ts`, `test/trace-retention.test.ts`,
  `test/api-role-first-page.test.ts`: the contract lock, the one-span statement counts and
  retention, and the 2 s first / 50 ms second status bounds.
- The walk: `madarch new`, `madarch repo add` with `/work/out/walk-repo`, `madarch fill`
  (4 units, succeeded), then the JSON API's catalogue, entity pages, file history and treemap.
  The fresh walk product's counts are repository 2, file 1 853, commit 2 491, signature 14 and
  directory 856; the file page's 16 history rows and the commit page's 15 Files / 1 Parents row
  carry their figures and author. The walk shots are in `/work/out/onegraph-shots/`
  (`catalogue-*`, `file-*`, `commit-*`, `tracker-catalogue-*`).

## DONE WHEN

A product created by `madarch new` fills through the generated tables, its catalogue, file and
commit pages answer from the one graph with change figures and authors, a tracker-only product
fills and serves without code tables, and the walk's counts and shots stand.
