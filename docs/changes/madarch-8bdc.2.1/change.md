# The fill's static stages publish into the 0028 graph

Change: madarch-8bdc.2.1
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.2.1
Kind: behavior

## Intent
Decision 0033's "The file is the unit of static work" makes the fill's facts land
in the product's one temporal graph (0028) and bounds a static stage by one
file's bytes and bounded graph queries (items 5 and 14). This change lands that
for the fill's three first stages: the snapshot (stage 0), the inventory (stage
1) and the syntax (stage 3) run as per-file units under the orchestrator, read
their bytes through a static stage context that hands out one repository pinned
at one commit, one path's entry and one file's bytes below a cap, and three
bounded graph reads (by key, by global name and one neighbourhood page), and
publish the nodes and edges they read into the 0028 graph through the
orchestrator's one publication.

The benefit is the one decision 0033 measured: the old surface rebuilt the whole
tree's symbol table for every file and took a 12 GB worker down. A unit here
holds its own file's bytes and its own bounded answers, its facts are the
extractors' `code.*` vocabulary (item 7), and a second run of an unchanged
commit plans no unit: the plans read what the stages published back through the
graph.

## Out of scope
- The stages after the syntax stage: the resolution stage (madarch-8bdc.2.2) and
  the build and configuration, modules, document index and history stages
  (madarch-8bdc.2.3) still read and write the fill's fact store here.
- The agent stages of 0026 (8–13) and the pages stage: they are madarch-8bdc.2.4's
  and later.
- Deleting the extract driver and the `fill_fact` store: decision 0033's item 6
  gives that work to the tasks that port the last readers, madarch-8bdc.2.5
  among them.

## Changes to requirements
- fill-stages/static: add. A static stage's contract: one file's bytes below a
  cap, three bounded graph reads each answering at most a fixed number of rows
  and naming the cursor of the next page, the unit's recorded reads replayed by
  its publication, the `code.*` vocabulary, and the boundary check with no
  per-stage exception.
- fill-orchestrator/publish: replace. A unit whose stage declares a static
  reading publishes its nodes and edges through the graph store's own unit
  publication — the stable scope from the unit's key, the publication lock, the
  generation, the work item and `complete: true` — inside the one publication
  transaction, instead of applying a fact set to the fill's fact store.

The complete proposed capability files are `capabilities/fill-stages.md` and
`capabilities/fill-orchestrator.md`.

## Preserved contracts
- fill-stages/registry: unchanged — a stage is still one registration, refused twice under one id, and listed in code point order.
- fill-stages/graph: unchanged — the graph is still derived from the declared capabilities, with the same order, edges, starvation and cycle rules.
- fill-orchestrator/plan: unchanged — a run still plans its units from the declared stages, and a unit whose inputs did not move is inherited.
- fill-orchestrator/staleness: unchanged — what a unit read is still rechecked, and a read that moved still refuses its publication.
- graph-queries/as-of: unchanged — the graph's answers are still read at a valid and a known time on both axes.

## Coverage
- fill-stages/static: test, static
- fill-orchestrator/publish: test, static
- fill-stages/registry: test
- fill-stages/graph: test
- fill-orchestrator/plan: test
- fill-orchestrator/staleness: test
- graph-queries/as-of: test

## Where it is seen
Kind: command
Place: the `madarch fill-stages` command of the product CLI, and the run's own events in the product's fill state

1. A person runs `madarch fill-stages` on a product whose code repository is
   a git checkout; the run plans one unit per file and per folder,
   and each of the three static stages publishes into the product's graph.
2. A person reads the product's graph (the wiki, or `madarch serve`) and finds
   the files, folders, symbols, imports, comments and coverage the run read, and
   no row of the old `fill_fact` store for them.
3. A person runs the same command again on an unchanged commit: the run plans no
   unit of the three stages and writes nothing to the graph.

## Blocking questions
None.

## Design and decisions
`src/fill/stages/static-context.ts` is the unit's context (one pinned
repository, one path's entry, one file's bytes below `STATIC_FILE_BYTE_LIMIT`,
and the three reads capped at `STATIC_READ_ROW_LIMIT`); the orchestrator records
each read as the unit's dependency. `src/fill/stages/static-graph.ts` maps the
fill's draft writes to the graph store's unit draft and registers the extractor
vocabulary; the host applies it with `GraphStore.publishUnit`. The plans read
`src/fill/stages/tree-rows.ts`'s tree read and their own coverage back from the
graph. `static-stage-boundaries.json` names the stages the type-aware check
covers, with no exception. Decision 0033's item 7 keeps the two vocabularies: the
fill's facts are written as the extractors' `code.*` nodes and edges.

## Acceptance evidence
The task's acceptance record on the stage (epic) names the revision and the
checks: `bun run check` with the architecture check and the static stage boundary
check, the focused suites, and the impact suite over the training repository.

## DONE WHEN
The three static stages publish their files, folders, symbols, imports, mentions
and coverage into the 0028 graph through the orchestrator's one publication, a
second run of an unchanged commit writes nothing, and `bun run check` passes with
the stages covered by the boundary check and no exception listed.
