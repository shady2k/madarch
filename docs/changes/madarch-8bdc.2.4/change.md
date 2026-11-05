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
- fill-stages/static: test, fill-code-facts, fill-library-effects
- fill-stages/starvation: test, fill-state-machines
- fill-orchestrator/completion: test, fill-state-machines

## Where it is seen
Kind: command
Place: `MADARCH_SKIP_PERF=1 bun test test/fill-state-machines-stage.test.ts` in a checkout

1. A person runs the test; the product the test writes is filled, and the graph
   holds one `code.state-machine` node for each table the fixture's two source
   files write, its `code.state` nodes and its `code.transitions` edges, each
   naming the state it leaves and the state it enters.
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
