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
