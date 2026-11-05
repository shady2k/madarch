# Build and configuration, modules, document index and history publish into the graph

Change: madarch-8bdc.2.3
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.2.3
Kind: behavior

## Intent
Decision 0033's "Steps build on each other" and "The file is the unit of static work" (items 14 and
15) make every deterministic stage of the fill read the graph its producers published and write its
own nodes and edges into it. This change ports the last four stages onto the static stage context of
madarch-8bdc.2.1: the build and configuration stage (its manifest's bytes), the modules stage (the
repository's packages, files, symbols and resolved edges, in bounded pages), the document index (one
document's bytes) and the history stage (decision 0030's commit range, read from Git).

The benefit is the one decision 0033 measured: no stage rebuilds a whole-tree object, every stage's
unit is bounded by its own file or by bounded pages, and a node's facts stay with the stage that
published them — a node another stage owns is joined by an edge, never rewritten. The training
repository's answer key's manifest, module, document and history items are all read back from the
graph after one fill, and a second fill of the same commit plans no unit.

## Out of scope
- Deleting the extract driver, `src/extract/code/resolve.ts` and the `fill_fact` store: that is
  madarch-8bdc.2.5 (decision 0033, item 6).
- The agent stages of 0026 (8–13) and the pages stage: they are the later tasks of the stage.
- A compiler index (SCIP), a renderer's read of the graph, and the wiki's pages: unchanged.

## Changes to requirements
- fill-stages/stage-publication: add. What each stage writes into the graph, in the extractors'
  `code.*` vocabulary: a stage's own nodes only, a declared dependency as a `code.dependency` node
  with its `code.uses-dependency` edge, an environment variable as the node of the file that
  declares it, a link or a task key whose target names no node as a node of its own, and the history
  stage's commit range as `code.commit` nodes with `code.tasks` edges.

The complete proposed capability file is `capabilities/fill-stages.md`.

## Preserved contracts
- fill-stages/registry: unchanged — each stage is one registration, refused twice under one id.
- fill-stages/graph: unchanged — the graph is derived from the declared capabilities, with the new `rank` and `mention` capabilities and the same order, starvation and cycle rules.
- fill-orchestrator/publish: unchanged — every ported stage publishes through the graph store's one unit publication.

## Coverage
- fill-stages/stage-publication: test, static
- fill-stages/static: test
- fill-stages/resolution: test
- fill-stages/registry: test
- fill-stages/graph: test
- fill-orchestrator/publish: test

## Where it is seen
Kind: command
Place: the `madarch fill-stages` command of the product CLI, and the product's graph

1. A person runs `madarch fill-stages` on a product whose code repository is a git checkout, and
   opens the product's graph: the packages, dependencies, deploy units, modules, documents,
   sections, links, commits and task keys the repository holds are there, each published by the
   stage that read it.
2. A person reads the training repository's answer key items against the graph: every manifest's
   declared dependency with the version it pins, every compose service and Dockerfile, every
   document with its sections, every module with its member files, and every commit of the history
   stands.
3. A person runs the same command again on an unchanged commit: the run plans no unit and writes
   nothing to the graph.

## Blocking questions
None.

## Design and decisions
`src/fill/stages/static-context.ts` gains `byProperty` and `edgesByProperty`, two bounded page
reads a stage uses to read a producer's nodes and relations (the modules stage's repository and the
history stage's held commits); the read text records the kind, field and value, and the publication
replays them. The four stages write through `graphWritesOf` and their own draft builders:
`dependencyDrafts` and `variableDrafts` (build and configuration), `linkDrafts` and `keyDrafts`
(document index), `taskNodeDrafts` (history), and `code.rank` nodes (modules). `static-reads.ts`
answers the plans' reads from the graph — the tree, each stage's own coverage, the history stage's
commits and coverage — and the syntax plan's coverage read now filters by its own reader.

## Acceptance evidence
The task's acceptance record on the stage (epic) names the revision and the checks: `bun run check`
with the architecture and static stage boundary checks, the four stages' suites, the training
repository's answer-key cases and the Stryker run on the ported stages.

## DONE WHEN
On the generated training repository the four stages publish the answer key's manifest, module,
document and history items into the graph, read back through `src/graph` reads; a second fill
writes nothing; and `bun run check` passes with every ported stage covered by the boundary check and
no exception listed.
