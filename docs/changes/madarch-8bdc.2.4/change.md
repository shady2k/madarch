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
- The port of the operations and data-model readings onto the code-facts and
  library-effects readers is not part of this change: their stages are not
  written, and the extract driver still owns those readings. The contracts
  reading's documents and per-file code sites are ported (see "The contracts
  reading as static stages"); its cross-file links, its routes and entry
  points, and the channel consumer fold remain, and the change record says what
  each still needs. madarch-8bdc.2.5 deletes the driver with them.
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


## The contracts reading as static stages (madarch-8bdc.2.4, the contracts worker)

**What lands.** The extract driver's contracts reading is split where the file
is the unit (decision 0033, items 5, 7 and 14): a `contracts` stage publishes
what one contract document writes down, and a `contracts-code` stage publishes
what one source file's code states. Both are static stages — one unit per file,
the file's bytes from the static context, the publication through
`GraphStore.publishUnit` — and both call the driver's own per-file readers
(`readOpenApi`, `readAsyncApi`, `readProto`, `openApiNodes`, `asyncApiNodes`,
`protoNodes`, `readTsFile`), so the two readings cannot disagree about a
document or a file.

- `contracts` (`src/fill/stages/contracts.ts`) publishes one `code.contract`,
  one `code.operation` per declared operation, one `code.channel` per AsyncAPI
  channel and one `code.message` per message, with the `code.declares` edges a
  contract's members hang from it, the `code.carries` edges a channel carries
  its messages by, and the `code.contains` edge that reaches each record from
  the contract file. An OpenAPI operation's `service` is read from the
  `code.listener-port` facts the code-facts stage publishes, by the driver's own
  server rule (`servicesOfServers`), through bounded `byProperty` reads.
- `contracts-code` (`src/fill/stages/contracts-code.ts`) publishes one
  `code.input` per `req.query` read, one `code.sql-build` per builder on the
  path to a sink, one `code.sql-sink` per SQL execution call, the
  `code.flows-into` edges between them, and the `code.contains` edges that
  reach them from the source file. Every record is a fact of the file's own
  bytes; no read crosses files.

**One shared change the port needed.** A file's `code.contains` children are its
symbols to the semantic-resolution stage, which refused a file whose children
were not all `code.symbol` nodes (measured: the training repository's
`services/payments/src/api/legacy-report.ts` failed its resolution unit once the
contracts reading hung a `code.input` from the file). The resolution stage now
reads its own symbols out of that neighbourhood and passes over a record another
reading hung there, which is what the relation means once two readings share a
file. `test/fill-contracts-code-stage.test.ts` runs the whole fill on a fixture
whose file holds an input and a sink, so the case is pinned.

**What the wiring needed.** `src/fill/stages/index.ts` registers the two
stages; `src/fill/stages/static-reads.ts` answers the contracts-code plan's own
coverage read (recorded and replayed like every other static read);
`src/extract/code/stage-vocabulary.ts` declares the kinds and relations the
stages emit; `static-stage-boundaries.json` lists both files with no exception;
`src/knowledge/starter-workflows.ts` names both stages in the first fill.

**The comparison.** `test/fill-contracts-training.test.ts` generates the
training repository, runs the fill twice (the second is the refill of one
commit, which plans nothing) and compares the graph's records of this reading
with `extractContracts` over the same bytes, family by family, sorted by code
point and named by kind and key: the record's label, every property, the span
and the edge discriminator, in both directions. The stage's own envelope
(`recordKey`, `factKind`, `layer`, `provenance`, `repository`) is read away, and
only records whose provenance names one of the two stages are compared, so
another stage's nodes of the same kind are not mistaken for this reading's.

Zero differences for `contracts`, `operations`, `inputs` and `sql`. The
families still listed as remaining are `channels`, `routes`, `entry-points`,
`containment`, `serves`, `calls-remote`, `consumes` and `publishes`:

- **`channels`.** The channel's `consumerFound`/`consumerStatus` fold is a fact
  of the consumes edges a code file publishes. The driver emits a consumes edge
  only for a topic a contract declares a channel for, so the code site's stage
  must run after the contract documents' stage, while the channel's fold must
  run after the consumes edges: the port needs a third stage (or a per-file
  consumption fact) to close that order. On the training repository
  `payments.events` reads `found-in-product` in the driver and
  `not-found-in-product` in the graph.
- **`routes`, `entry-points`.** The route's `handlerKey` is the driver's
  resolved symbol (`code.symbol:<path>#<qualified name>`, including the
  `callback@<line>:<byte>` names the code extractor gives inline handlers), and
  its `middleware`/`authGroup` chain is the set of mounts another file of the
  same service declares (`app.use('/checkout', checkoutRoutes(...))`). The fill
  publishes neither the code extractor's symbol set nor a per-file mount fact
  yet; the per-file readers exist, and the port is the next family.
- **`serves`, `calls-remote`, `consumes`, `publishes`.** These are the links
  between a code site and a record another file published; they need the routes
  and entry points first.
- **`belongs-to`, `starts` into `code.service`/`code.process`.** Those ends are
  the operations reading's nodes (`code.service:<name>`, `code.process:<path>`),
  which no stage on this branch publishes: an edge joins nodes that exist, so
  the entry-points family cannot close before the operations stage lands.
- **`containment`.** The driver's contains edges cover every node of its
  reading; the ones for routes and entry points are missing until those
  families are ported.

The remaining list may only shrink: the test refuses a family that reaches zero
differences while it is still named there.

**Measured.** On this machine the training repository's first fill takes about
470 s (664 units, every stage), the refill 3.4 s and plans nothing, and the
driver's reading 1.8 s.
