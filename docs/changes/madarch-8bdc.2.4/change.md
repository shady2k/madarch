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


## The operations reading as a static stage (this branch)

`src/fill/stages/operations.ts` is the stage and
`src/fill/stages/operations-records.ts` its per-file half; the records that end
at another file's record are made by `src/fill/stages/operations-links.ts`, a
second stage the stage graph orders after the first. The stage plans one unit
per file the reading covers — lock files, manifests, Dockerfiles, compose
files, Kubernetes files, Makefiles, workflows, `.env.example`, the root README,
AsyncAPI documents and code — reads that file's bytes from the static context,
builds the records whose span stands in it with the driver's own keys, kinds,
labels, properties and spans, and publishes them through the store's one
publication.

**The rule.** A record is owned by the file its `span` stands in and a unit
publishes exactly the records it owns, plus the `code.contains` edges from its
file's node. A node another file declared first (a port, an image, a broker) is
named by a later unit and not published again: `byKey` answers whether the node
already stands under another file's `file` property.

**The plan's order is the publication order.** The orchestrator admits one
stage's units in the plan's own order (concurrency one), so a unit's edge ends
exist when it publishes. The rank of a family is lock files, manifests,
Dockerfiles, code, compose, Kubernetes, Makefile, workflow, `.env.example`,
README, AsyncAPI. The code files come before the files that name what they
read: a compose `env:` entry's variable is the one a code file reads, and a
Kubernetes probe claims an endpoint a code file serves. The links stage then
runs after every unit of both, one unit per file, and answers the records that
name another file's record: `code.env-var`, `code.reads-env`, `code.defines`
and `code.connects-to` from the settings that name a broker address, the
`code.service` passport and its `code.manifest-of`, `code.served-by`, the
probes' `code.probes`, the metric links and the `code.uses-logger` edges.

**What is compared.** `test/fill-operations-training.test.ts` generates the
training repository, fills the product with the stages this reading stands on
(it disables the others so the case times what it compares), reads the same tree
with `extractOperations`, and compares both record sets as
`<kind> <key> <canonical record>` lines in code point order. Every difference
names the kind (or relation) and the key it stands at, a missing record, a
record the stage publishes that the driver does not, and a record both carry
with a different answer. `REMAINING` holds the families not ported, and a record
of a listed kind must not stand in the graph, so the list only shrinks.

**Ported and equal on the training repository.** Every family the driver's
operations reading makes now stands in the graph: manifests, their dependencies
and lock files; Dockerfiles and the ports they expose; compose services,
health checks, ports, `depends-on`, `builds` and the environment definitions
they set; Makefile targets and their references; CI workflows and jobs; the
Kubernetes deployment, service, image, probes, ports and their links; code
processes with their `starts`, `listens-on` and `uses-dependency`; the
environment definitions and `defined-in`; the newcomer's prerequisites, steps
and failure with `backed-by` and `references`; brokers, channels and
`hosts-channel`; `configured-by` and `connects-to` from the settings that name
a broker address; the service passports and their `manifest-of`; the loggers
and their uses; the health and metrics endpoints, the metrics, the expositions
and updates, the probes and `served-by`; and the symbols those records cite.
The driver's reading is 151 node records and 406 edge records after the
`code.file` and `code.symbol` nodes are held out, and the comparison finds zero
differences: `REMAINING` is empty.

**The symbol-identity defect: one declaration, two keys.** The operations
reading cites a callable by the driver's own symbol key,
`code.symbol:<path>#<qualified name>` (`src/extract/operations/symbol-sites.ts`,
`functionNode`), while the graph names the same declaration by what the fill
published: the syntax stage's `code.symbol` node, whose `recordKey` is the
syntax fact's digest, or — where no declaration node stands, which is this
repository with the syntax stage disabled — the code-facts stage's
`code.callable` node. Two keys from the training repository's own reading:

| the driver's key | the graph's key |
| --- | --- |
| `code.symbol:services/payments/src/domain/payment-service.ts#PaymentService.pay` | `code.callable:training:services/payments/src/domain/payment-service.ts#PaymentService.pay` |
| `code.symbol:services/orders/internal/logging/logger.go#New` | `code.callable:training:services/orders/internal/logging/logger.go#New` |

The second identity is the driver's alone: publishing it would stand two
`code.symbol` nodes for one declaration, which the syntax stage already names.
The operations stage therefore does not publish it: `withSymbolEnds`
(`src/fill/stages/operations.ts`) ends an edge at the graph's answer and leaves
a named gap where the graph holds neither identity. The comparison maps the
driver's key to the same answer — `graphIdentityOfFact` in the test: the
declaration by `byGlobalName(<repository>:<path>#<name>)` where exactly one
stands, else the `code.callable` by `symbolKey`, else the key unchanged, which
then stands as a named difference.

**The evidence-naming mapping.** A ported logger record keeps the driver's
`libraryEvidence`: the model, the library, the invocation span, and an `origin`
whose `importId` and `chain` are the *code extraction's* private fact ids
(`<path>:<start>:<end>:import`, `…:binding`, `…:identifier`,
`…:call_expression`, a bare `pino.default`). The fill's library reader builds
the same origin from the code-facts stage, whose ids are the graph's own. The
comparison rewrites every string of a compared record before it compares:

- `<path>:<start>:<end>:import` and `…:binding` →
  `code.binding:<repository>:<path>@<start>:<end>:binding`;
- any other `<path>:<start>:<end>:<what>` →
  `code.expression:<repository>:<path>@<start>:<end>:<what>`;
- `<path>:<start>:<end>:export:<name>` → the `code.export` node's `recordKey`,
  found by its file and name;
- `code.symbol:<path>#<name>` → the declaration or the callable above;
- every other string stays as it stands, so `pino.default` and the spans agree.

A sample from the training repository, the reading's first use: the driver's
`origin.importId` is
`services/checkout/src/logging/logger.ts:7:11:import`, and the mapped record
names `code.binding:training:services/checkout/src/logging/logger.ts@7:11:binding`;
the chain's `services/checkout/src/logging/logger.ts:96:100:identifier` becomes
`code.expression:training:services/checkout/src/logging/logger.ts@96:100:identifier`.
With that mapping the logger and symbol families compare text for text, which
is why they are off `REMAINING`.

**The fixtures the last assumptions rest on.**
`test/fill-operations-fixture.test.ts` writes a repository and reads it twice,
with the fill and with `extractOperations`, comparing the records the two
shapes make:

- a Dockerfile that exposes no port while the service's code listens on 3000.
  The port record stands at the code's listen in both readings, and the
  process the Dockerfile's command starts stands at the code file its command
  names. A second Dockerfile whose command names a source file the tree does
  not hold (`CMD ["/app/worker"]`) starts a process the Dockerfile's own unit
  publishes, at the Dockerfile's bytes, exactly as the driver gives it.
- a compose setting `KAFKA_BROKERS: kafka:9092` with no broker service in the
  tree. The broker stands as `code.broker:address/kafka:9092` with source
  `configuration`, `code.configured-by` joins it to the definition, and
  `code.connects-to` joins it to the service the variable is scoped to.

**Assumptions.**
- The port's span is the first naming in the plan's order: Dockerfile, code,
  compose. The driver's own order is Dockerfile, compose, code, so a compose
  port mapping whose port no Dockerfile exposes would stand at the compose
  service line in the driver and at the code's listen in the fill. The training
  repository exposes every port a compose file maps through its Dockerfile, and
  the fixture above has no compose port mapping, so no comparison covers that
  shape.
- A command a Dockerfile runs is mapped to a source file only through the
  driver's own two shapes: a Go binary built with `-o` for a package, or
  `node dist/<name>.js` beside a `src/<name>.ts`. A command outside those shapes
  starts a process the Dockerfile declares, never a guessed file.
- A setting that names a broker address resolves against the brokers published
  before its unit: on the training repository the compose file's own broker and
  the `.env.example`'s address; in the fixture, the address broker the same
  compose file's definition creates.
- The Kubernetes workload's span is its YAML document's own lines, as the driver
  computes it from the document range.
- The syntax stage's declaration answers the symbol's key where it stands; this
  comparison disables it, so every cited callable is answered by the code-facts
  stage's `code.callable` node.

**Comparison result.** Zero differences for every family on the generated
training repository (151 node records and 406 edge records on both sides), and
`REMAINING` is empty. The test fails first, with the run's own words, when a
unit stands failed: it names each unit, its stage, its attempts and the
reader's refusal.


## The merge with the operations reading (madarch-8bdc.2.4)

The operations worker's branch moved the code extractor's symbol reading into
`src/fill/stages/code-symbols.ts` (`fileSymbolsOf`, the driver's own callback
naming among it) and publishes the callables a file declares as
`code.callable` facts. This branch takes that reading and that fact as the one
of each: the contracts stages publish no callback node of their own, and a
route's handler is the syntax stage's `code.symbol` node for a named
declaration or the code-facts stage's `code.callable` node for an inline one —
never a second symbol node (the coordinator's decision 4).

Three shared readings had to agree once two stages published the same record:

- `code.channel` is the contracts reading's record (the driver's `OWNERS` names
  `code.extract.contracts` for it). The operations stage no longer publishes a
  channel node; its broker links end at the contracts stage's node, and it
  consumes `channel`, so it runs after the stage that publishes it.
- The modules stage ranks files and symbols. Its resolved-edge read now walks
  only edges whose two ends are a `code.file` or a `code.symbol` node: another
  reading's own records (a callable, a Makefile target) are not nodes of that
  graph, and the rank would otherwise refuse the file's own records.
- The semantic-resolution stage passes over a file's `code.contains` children
  that are not symbols (another reading's record of the same file).

The contract reading's `code.references` registration is one link the graph
holds once: where the resolution stage already tied the mention, the routes
stage publishes no second edge, and the comparison matches that record by its
two ends (see "The contracts reading as static stages").


## The serving links of a code file (madarch-8bdc.2.4)

`contracts-links` is a stage after the contract documents and the routes: a
serving link joins a route one file registers to an operation a contract
document declares, and neither file can see the other while its own stage runs.
One unit per source file publishes the `code.serves` edges its own routes and
gRPC servers state.

- A route serves an OpenAPI operation when the method is the same and the
  route's path template matches one of the operation's server paths segment by
  segment (a parameter segment matches a parameter). The route's service scopes
  the match, and the driver's own rule is kept: an operation with no single
  serving route in its service is named in no edge.
- A gRPC server that serves a proto method publishes the file-level link
  (`summary: true`) and the handler-level one, as the driver's `interaction`
  rule emits them; the handler is the inline callable at the registration.

The comparison reaches zero for `serves` (11 edges on the training repository:
7 orders routes, the 2 gRPC file links and their 2 handler links).

## Acceptance evidence
Recorded in the branch's report (`/work/out/report-8bdc24-operations.md`): the
training comparison (7 pass, 0 fail, 485 s), the focused tests together and
alone, `bun run check`, the StrykerJS run on the stage's changed lines (71
mutants, 40 killed, 56.34%; `operations-links` 100%), and the fill's peak
memory (1 902 MB with 404 units: snapshot 174, code-facts 66, operations 85,
operations-links 73).

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
differences while it is still named there. The section "The entry point a code
file states" below supersedes this list: `routes` and `containment` are off it.

**Measured.** On this machine the training repository's first fill takes about
470 s (664 units, every stage), the refill 3.4 s and plans nothing, and the
driver's reading 1.8 s.

## The entry point a code file states (madarch-8bdc.2.4)

`contracts-links` now publishes the entry point of every source file that states one. The reading keeps the driver's own keys, labels, properties and whole-file spans: `code.entry-point:<file>#main` for a Go `package main` (label `<service> · <file>`), `code.entry-point:<file>#<symbol>` for a TypeScript entry (label `<service> · <file> · <symbol>`), the `starts` array of the units the entry starts, and the `code.contains` edge from the file.

- **A Go `main`'s starts.** `resolveGoStarts` joins the package's constants, server addresses and functions with the `main` file's `rawStarts`. The package's names are per-file facts: `contracts-code` publishes `code.go-package` for every Go file (its folder, `consts`, `serverAddrs`, `functions` and whether it is a `package main`), and the links stage reads the folder's facts by property, in code point order of their paths, which is the order the driver's walk holds them in. No stage holds a whole-tree object.
- **The edges.** `code.starts` to the entry's own file (`kind: entry-file`), to `code.process:<folder>` for a Go `main` or `code.process:<file>` for a TypeScript entry (`kind: process`, discriminator `process`), and to the file a started job stands in (`kind`, `symbol`, `port` and the discriminator the driver gives it). `code.belongs-to` to `code.service:<name>` where the graph holds that node.
- **An end no node carries claims no edge.** An edge joins nodes that exist (decision 0028), so the stage first asks whether the node stands under the end's key and publishes no edge where it does not. Two ends are missing on the training repository, both owned by the operations reading:

  - `code.service:<name>`. No stage of the fill publishes it: `grep -rn "code.service:" src/fill` answers only a comment, the operations stage's `produces` list has no `service` kind, and `test/fill-operations-training.test.ts` still names `code.service` in its `REMAINING` list. The driver's own `OWNERS` map names the operations producer as its owner. The four `code.belongs-to` links therefore stay a difference and `entry-points` stays on the comparison's `REMAINING` list, with the other four families.
  - `code.process:services/payments/src/index.ts`. The contracts driver emits a `code.starts` to it (`processKeyOf`), and neither the operations driver nor its stage publishes that node: `services/payments/Dockerfile` starts with `CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]`, and `startedProcessOf` (`src/fill/stages/operations-records.ts`, `src/extract/operations/deploy.ts`, one rule) takes `args.find((arg) => /dist\/[A-Za-z0-9_.-]+\.js$/.test(arg))` — the whole `-c` script, which ends in `dist/index.js` — and uses it as the script path, so no candidate file exists and the Dockerfile states no process. That is a driver defect, not a difference of this reading: the contracts driver's entry-point edge names a node its own operations reading never makes.

**Containment reaches zero.** The driver's 51 `code.contains` edges are the contract documents' (17), the routes' (18), the inputs' and SQL records' (13) and the entry points' (4). The entry points' edges are the four that were missing; the class comes off `REMAINING`.

**The routes' handler span.** The driver positions `code.handled-by` and `code.references` at the registration call's *handler argument* (`authed(http.HandlerFunc(deps.Orders.List))`), not at the handler expression the per-file reader sees. The routes stage read the argument ids from the file's `code.expression` nodes, which carry no `arguments`; it now reads the `code.call` node at the registration's span (which does) and takes its argument expressions, choosing the one whose span holds the reader's handler span. Measured on the training repository: `routes` reaches zero differences, and it is no longer on `REMAINING`.

**Measured on the generated training repository** (the comparison with the stages outside this reading disabled, one fill): `entry-points` falls from 17 differences to 5 (four `code.belongs-to`, one `code.starts` for the missing payments process), `containment` from 4 to 0, and `routes` from 15 to 0. `bun run check` exits 0 with no gained architecture entry (`1235` violations, all listed). The families still on `REMAINING` are `channels`, `entry-points`, `calls-remote`, `consumes` and `publishes`; the reasons for the last four stand in the section above.

**What the remaining four families need, measured.** The consumes, publishes and calls-remote links are not facts of one file's bytes: `structuralGoReaders`, `structuralPublishers` and `httpCallUrl` read a tree's whole `CodeFacts` (every file's expressions, bindings, calls, imports, fields and resolution sites) and the outbox inference reads the SQL relay and the unit index besides. A static unit holds one file's facts and bounded graph queries (decision 0033, item 5), and the graph's per-file facts do not carry what those readers need — notably an external import (`import kafka "github.com/segmentio/kafka-go"`) is published by no stage, because the syntax stage publishes an `code.imports` edge only for a specifier it can tie to a file of the repository. Porting those three families means porting the readers onto per-file facts (their own stage), not wiring this one; the channel fold then follows the same per-file consumption facts, because a `code.consumes` edge cannot end at a channel node before that node exists and a channel node has one publisher.


## The consumed channels, and the two blockers the port fell on

**The process a shell command starts.** `startedProcessOf` and the driver's own
`processOf` read a command one argument at a time; a shell `-c` argument is one
string that runs several words, so its script is split on whitespace and the
last word the existing script test answers is the script.
`CMD ["sh","-c","npx prisma migrate deploy && node dist/index.js"]` now starts
`code.process:services/payments/src/index.ts`, at that file's bytes, in both
readings, and the operations comparison stays at zero differences. The
operations comparisons read only their producers; the AsyncAPI channel and its
containment are the contracts reading's records.

**The Kafka sites of a Go file.** The tree reader of one file now finds the
reader configuration (`<ns>.ReaderConfig{Topic, GroupID}`), decodes the topic
through the file's own constants, and associates the reads through a field the
file declares as `<ns>.Reader`; its answer equals `structuralGoReaders`' on the
training repository's consumer (channel `payments.events`, group `orders`, one
read at `FetchMessage`). `contracts-code` publishes it as `code.kafka-site`,
beside the consumer names of the package (`code.go-consumer`); `contracts`
folds a channel's `consumerFound`/`consumerStatus` from the sites, one stage
after them, and `contracts-links` publishes the `code.consumes` edges from the
same facts. **A bug the fold exposed:** the stage's span reader accepted only a
provenance place's `startByte`/`endByte` and not a record's `byteStart`/
`byteEnd`, so every site read and site span was dropped and every edge came out
`configured` with no span. With both spellings read, the consume family and the
channel fold compare equal on the training repository.

`test/fill-contracts-training.test.ts` names `calls-remote` and `publishes` as
remaining; `entry-points`, `consumes` and `channels` are zero (5 pass, 961 s,
the refill included).

**What still blocks the two families.** `src/fill/stages/contracts-facts.ts`
rebuilds one file's facts from the graph and answers the driver's publisher
reader: expression, binding, call and field rows, the call holder the graph
does not store, the mention fan-out of a `code.inherits` edge, and the type and
class bindings the code-facts walk does not write. With it,
`structuralPublishers` reproduces the driver's site for
`services/payments/src/events/publishers.ts` exactly (channel
`payments.events`, publisher `publishPaymentEvent`, key `payment.orderId`,
span 1688-1752, evidence 1688-1752 and 1011-1068). `inferOutboxPublications`
and `structuralGrpcDeadline` take plain fact shapes, so a static stage can hand
them a service's reconstructed facts. The outbox fold and the HTTP/gRPC call
links are not wired into a stage yet; the change record's report says what each
needs next.
