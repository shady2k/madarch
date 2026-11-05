# The code facts of one file, and the state machines, as stages of the fill

Change: madarch-8bdc.2.4
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.2.4
Kind: behavior

## Intent
Decision 0033 makes the file the unit of static work (items 5 and 14) and makes
every next step read what the earlier ones published (item 15). Two readings of
the code stood outside that shape. The state machines a file writes down were
read at render time by `src/knowledge/views.ts`, so a diagram of an entity's
states was neither a published record nor something the graph could hold a
verification state for. And the operations, contracts and data-model readings of
the extract driver were built from one in-memory object (`CodeFacts`) that a
static stage may not hold (item 5), so nothing could read their values — a port,
a topic, an environment name, a SQL string, a library call's effect — from the
graph.

This change lands both directions of that gap. A **code-facts** stage publishes
what one file's code holds — its expressions with their literal values, the
bindings a declaration makes with their initializers and global names, its call
sites, its Go struct fields and the names it exports — one unit per source file,
through the graph store's one unit publication. The static stage context gains a
**bounded read by property** (`byProperty(kind, field, value, {limit, after})`,
one page of at most `STATIC_READ_ROW_LIMIT` rows, recorded and replayed like the
other reads) so a stage can link across files by a value it knows. And a
**library-effects** reader proves one file's library effects from those facts,
chaining an import by global name through the graph instead of through a tree's
symbol table. The **state-machines** stage publishes the machines, states and
moves of every file that writes a table.

The values the three extract readings publish today are read from the same facts
by the same order of work; porting those three readings onto these facts is what
the task's last step still owes, and the change record's "Out of scope" says
where it stands.

Stories:
- As a reader of a product's wiki, I open an order's state diagram and it is
  drawn from the graph the fill published, not re-read from the source on every
  page view.
- As a person filling a product, a second run of one commit re-reads no file
  the earlier run read, because each unit's own coverage names the blob it read.
- As the engineer who lands the next stages, a static stage's shape is the one
  this stage shows: one file per unit, its bytes from the stage context, and its
  publication through `GraphStore.publishUnit`.

## Out of scope
- The port of the operations, contracts and data-model readings onto the
  code-facts and library-effects readers is not part of this change: their
  stages are not written, and the extract driver still owns those readings.
  What the work needs is settled and measured (the facts, the bounded read, the
  effect reader), and madarch-8bdc.2.5 deletes the driver with them.
- The wiki's diagram rendering is not moved onto the published records here:
  `src/knowledge/views.ts` still reads the source through its render context,
  which the page capability's own change owns.
- The state reader itself (`src/knowledge/state-machines.ts`) is unchanged: the
  stage calls it on one file's bytes, and a reader that is still called is not a
  path to delete (decision 0033, item 6).

## Changes to requirements
`fill-stages` gains one requirement, "static": what a static stage is handed
(including the bounded read by property), how its units are named and published,
what it publishes for a file it could not read, and how its plan names a unit
again. The proposed capability file is `capabilities/fill-stages.md`.

## Preserved contracts
- fill-stages/registry: a stage is still one module plus one registration, its id, version, consumes, produces, schema and defaults unchanged in shape; the state-machines stage is registered once, beside the others.
- fill-stages/graph: the stage graph is still derived from the declarations; the new stage consumes `file` and nothing else, so its edge runs from the snapshot.
- fill-stages/starvation: a run whose graph holds no file facts still reports the new stage as starved by its exact path, as before.
- fill-orchestrator/publish: a static unit's records still land through the one publication transaction, fenced, exactly once, and scoped to the unit.
- fill-orchestrator/plan: a unit is still planned only when what it stands on moved; the stage's own coverage is the record the plan compares, and a second run of one commit plans nothing.
- fill-orchestrator/completion: a run still finishes with what it covered; a file this stage could not read is a named gap of its unit, never a missing unit.

## Coverage
- fill-stages/registry: test, fill-state-machines
- fill-stages/graph: test, fill-state-machines
- fill-orchestrator/publish: test, fill-state-machines
- fill-orchestrator/plan: test, fill-state-machines, fill-static-property-read
- fill-stages/static: test, fill-code-facts, fill-library-effects, fill-service-membership, fill-listener-ports, fill-code-facts-training
- fill-stages/starvation: test, fill-state-machines
- fill-orchestrator/completion: test, fill-state-machines

## Where it is seen
Kind: command
Place: `MADARCH_SKIP_PERF=1 bun test test/fill-state-machines-stage.test.ts` in a checkout

1. A person runs the test; the product the test writes is filled, and the graph
   holds one `code.state-machine` node for each table the fixture's two source
   files write, its `code.state` nodes and its `code.transitions` edges, each
   naming the state it leaves and the state it enters.
   `MADARCH_SKIP_PERF=1 bun test test/fill-service-membership.test.ts
   test/fill-listener-ports.test.ts test/fill-code-facts-training.test.ts` runs
   the two per-file facts' acceptance and the training repository's comparison.
2. The same run plans one unit per source file and none for the document or the
   data file, and each machine is declared by its file's node and holds its own states by `code.contains`, and no machine stands among a file's `code.contains` children.
3. A second run of the same commit plans no unit of the stage.

## Blocking questions
None.

## Design and decisions
`src/fill/stages/state-machines.ts` is the stage. Its plan reads this stage's
own coverage (one additive read case in `src/fill/stages/static-reads.ts`,
recorded, rechecked and replayed like every other static read), compares each
source file's blob with the pinned commit, and names a unit for a file whose
blob moved and for a published path the commit no longer holds. Its unit reads
one file's bytes from the static context, decodes them fatally, runs the
existing reader, and writes the machine, state and transition drafts and one
coverage node carrying the blob. `static-stage-boundaries.json` covers the
stage with no exception; `CODE_GRAPH_VOCABULARY` gains the two kinds and the one
relation it publishes.

A file's `code.contains` children are its symbols to the resolution stage, and a machine written there made that stage refuse the file (measured: both of the fixture's files failed their resolution unit before the relation moved to `code.declares`). Writing the plan's read as its own case keeps the shared read reader additive:
no other read changed, and the case names the reader it answers
(`madarch-state-machines`) so no other stage's coverage of the same file is
taken for this one's.

## The two per-file facts the port reads by property
The port's step 1 (madarch-8bdc.2.4's design, "The three graph reads the port
needs beyond what exists", items 2 and 3) lands in the code-facts stage:

- **The unit a file belongs to.** `src/fill/stages/service-membership.ts` walks
  a file's folder up to the repository root and reads the `go.mod` and
  `package.json` it finds there, one path at a time and never by listing the
  tree. It applies `serviceUnits`' own rules: a `go.mod` declares the last
  segment of its module path, a `package.json` its `name` and a nameless one its
  folder, a manifest that declares nothing is passed over, a folder the
  repository conventions call another project's is passed over, and the smaller
  declared name answers where one folder holds both manifests. The unit is
  published as a `code.service-unit` node carrying the file, the name, the root,
  the manifest path, the ecosystem and the whole declared identity.
- **The ports a file's code listens on.** `src/extract/contracts/listening-ports.ts`
  now holds the one rule the contracts extractor's `portsByService` map and the
  fill share — a Go `http.Server`'s Addr through its constants, a TypeScript
  app's `listen` port and the ports a top-level listen starts with — and
  `portsByService` calls it. The code-facts unit parses its own file's tree once
  and publishes one `code.listener-port` node per port, carrying the unit it
  serves where one declares it, so an operation's service and a route's ports
  are reads by property.

The membership's manifest chain (each `<path>@<blob>` above the file, nearest
first) is pinned in the file's coverage, and the product's wiring names it among
the unit's inputs (`src/product/fill-stages.ts`, `inputsOf`): a manifest that
moved re-reads every file whose unit it declares, although the files' own blobs
did not move. The plan compares the chain as well as the file's blob, so a file
the commit did not touch is still planned when its unit's declaration moved.

**A defect this exposed and fixed.** `collectFileFacts` recorded an expression's
field links in a plain object; a grammar names a `new_expression`'s field
`constructor`, which reached `Object.prototype.constructor`, and the walk threw
`(fieldLinks[fieldName] ??= []).push is not a function` for every TypeScript file
holding a `new` expression (measured on the training repository's
`services/checkout/src/index.ts` before the fix: no facts and a gap). The record
is built without a prototype now, and `test/fill-listener-ports.test.ts` pins a
file with a `new` expression keeping both its port and its expression.

**Assumptions.**
- The declaration is read from the manifest's own bytes through the static
  context's path-scoped `file`, not from the graph: on this branch the
  build-configuration stage writes `package` facts to the fill's fact store, and
  the 0028 graph holds no manifest declaration for a static unit to read. The
  read is one path at a time and below the cap; no listing of the tree is made.
- The fact covers the units `go.mod` and `package.json` declare, which is what
  the task names. A unit a compose build context or a Dockerfile declares is not
  part of it; on the generated training repository every file's unit comes from
  a manifest (the comparison asserts it), so the two answers agree there.
- The facts are published for the files this stage reads — a repository's source
  code. A manifest's own unit is the unit its reader already has.

**Comparison on the generated training repository.**
`test/fill-code-facts-training.test.ts` generates the repository
(`examples/training-repository/generate.mjs`) and compares, for every file, the
membership with `serviceUnits(tree)` and, for every source file, the ports with
`portsByServiceOf` (the driver's own map): zero differences, the four services
and their ports (orders 8080, payments 8081, promotions 8082, checkout 8083 and
the test file's 0) included.

## The data model of the code, as two static stages
`src/fill/stages/data-model.ts` ports the extract driver's data-model reading
onto the code facts (madarch-8bdc.2.4; decision 0033, items 5, 14 and 15). Two
stages publish it:

- **`data-model`**, one unit per file, publishes the records whose span stands in
  that file: a migration's node and the tables, indexes and columns its
  statements declare; a Prisma schema's tables, columns, indexes, foreign keys
  and schema readings; a code file's table accesses (its SQL literals' sites and
  the Go package's call roll-up), the tables its own `CREATE TABLE` literals
  declare where the database's migrations do not, and the storage evidence the
  file gives (a storage driver's import, a manifest dependency, an environment
  file's connection setting, a compose service's, a code file's environment
  read). Each record is owned by the file its span stands in.
- **`data-model-aggregate`**, one unit per database (the name the driver gives
  it: the unit that declares it), publishes the records one file cannot own: the
  database node with the evidence that declares it and the file its place stands
  in, what it contains and holds, the logical references its `_id` columns make
  into another database, and the service that uses it. It stands on the per-file
  stage's published records through the bounded reads it declares, and on
  nothing wider.

**What a unit reads of its group.** A migration unit rebuilds its database's
merge from the files of its own group — the migrations and the schema, read one
at a time through the static context's `filesUnder` listing and `file` bytes —
with the driver's own pure readers (`parseSqlScript`, `applyStatements`,
`parsePrismaSchema`, `applyPrismaModel`). The records it writes are the ones the
merge gives a span in its own file; `scanScriptWrites`, `extractFileAccess`,
`indexGoPackage` and `resolveGoCalls` are the driver's own readers for seeds,
accesses and the Go roll-up.

**A second stage is a dependency, not an order.** The logical reference joins a
table of one database to a table of another, so no single file can own it
without reading another unit's publication: it is assembled by the aggregate
stage from the published tables and columns of the repository, by
`byProperty('code.table', 'name', …)` and `byProperty('code.column', 'table', …)`.
The registry derives that order from `consumes`/`produces` (the aggregate
requires `migration` and `storage-evidence`, which the per-file stage produces),
and `starter-workflows.ts` names both stages of the first fill.

**The service a database is used by is not this reading's node.** The driver's
data-model reading opened a stub `code.service` node where the operations
reading owns one; `src/extract/driver/extractors.ts` records that as
madarch-m38l.16. The aggregate therefore publishes no service node: it reads the
unit's own per-file record — the code-facts stage's `code.service-unit` node, by
the unit's name — and names it as the edge's source. The comparison maps the
driver's `code.service:<name>` to that node's key through one named function
(`fillServiceOf`), and the two keys are the driver's defect.

**A closure's owner is the enclosing method here.** The driver's code extractor
publishes a symbol for a Go closure named `X.callback@<line>:<byte>` and cites
it as the owner of the SQL inside it; the fill's syntax stage publishes the
enclosing method as the innermost callable of the same bytes. The two node
records and the two `code.writes-table` edges they would own are the differences
that remain (below); the table each access names is the same.

**Comparison on the generated training repository.**
`test/fill-data-model-training.test.ts` generates the repository
(`examples/training-repository/generate.mjs`), runs the whole fill, and compares
the driver's `extractDataModel` records with the fill's, one record per kind,
key, discriminator and property set, sorted by code point. It names every
difference by family and key and holds the families it expects to differ in
`EXPECTED_REMAINING`, a list that may only shrink.

**A defect this exposed and fixed.** The code-facts stage's `importDeclarationsOf`
recorded a Go `import_spec` as a *named* import of one symbol; a Go import binds
the package's whole namespace (`os.Getenv`), and the library models match a Go
package's exported function by the namespace form. With the wrong form no
Go library effect was proved at all: the promotions database's `evidence` list
lost the `connection-setting` that `services/promotions/cmd/promotions/main.go:19`
(`url := os.Getenv("DATABASE_URL")`, bytes 337-362) gives, and its
`code.uses-database` origins lost the same reading. `src/fill/stages/code-facts.ts`
records the namespace form now, and the two records match the driver's.

**Remaining, with evidence.** One family pair differs, and it is the code
reading's own symbol set, not a record of the data-model reading: a Go closure.
The driver's code extractor publishes a symbol for a Go closure named
`X.callback@<line>:<byte>` — a key synthesized from a line and a byte offset,
not a declared name — and cites it as the owner of the SQL written inside it.
The fill's syntax stage publishes only declared names, so the same access is
attributed to the enclosing method:

| Driver's record | The fill's record of the same bytes |
| --- | --- |
| `code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Save.callback@57:1448` (lines 57-67) | `code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Save` |
| `code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Delete.callback@237:7918` (lines 237-249) | `code.symbol:services/orders/internal/store/order_repository.go#OrderRepository.Delete` |

and the `code.writes-table` edge the closure owns
(`… -> code.table:orders/public.orders`, sites at bytes 1490-1677 and 7958-8033)
is published from the method in the fill. No table record differs: the sites,
the table and the verb are the same. The families are
`node:code.symbol` and `edge:code.writes-table` in the comparison's
`EXPECTED_REMAINING`.

What turns this into a zero-difference reading instead is a decision about the
syntax stage's symbol set (whether it publishes function literals as symbols and
under which names), which is that stage's change and not this port's: a data-model
stage that published a `code.symbol` node of its own would be the second node for
one declaration that madarch-m38l.16 closed.

## Acceptance evidence
Recorded beside the branch's report (`/work/out/report-8bdc24.md`): the focused
tests, `bun run check`, the StrykerJS run on the stage's lines, and the peak
memory of the new test.

## DONE WHEN
The stage publishes the machines, states and moves of every source file that
writes a table, one unit per file, through the graph store's one publication;
the boundary check covers it with no exception; a second run of one commit plans
no unit; and the focused tests and `bun run check` pass. The three extract
stages the task also names are not ported: the report says what was measured and
why, and what of the old path remains for madarch-8bdc.2.5.
