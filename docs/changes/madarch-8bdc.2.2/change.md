# A file's names are resolved by global name from the graph

Change: madarch-8bdc.2.2
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.2.2
Kind: behavior

## Intent
Decision 0033's "Cross-file links are resolved per file by querying the graph by
global name" (item 14) is this change: the file pass writes the symbols with
global names, the mentions and the imports as written, and the resolution stage
resolves each mention against the graph by bounded queries, never against a
symbol table of the tree. The change also bounds the fill's memory per file —
the quadratic path decision 0033's context measured — and makes the resolution
incremental: a second run of one commit plans no unit.

The benefit is measurable: a resolution unit reads no bytes, its memory is one
file's symbols and mentions, and the fill's peak per 100 files no longer grows
with the tree.

## Out of scope
- Deleting the extract driver (`src/extract/driver`), `src/extract/code/resolve.ts`
  and the `fill_fact` store: the driver still resolves names that way until
  madarch-8bdc.2.5 deletes it (decision 0033, item 6).
- The stages the resolution reads beside its own file (the modules stage) and the
  agent stages: they are madarch-8bdc.2.3's and 2.4's.
- A compiler index (SCIP): no indexer is wired in this build; the syntactic
  resolution is the one madarch runs.

## Changes to requirements
- fill-stages/resolution: add. A file's names are resolved from the graph: the
  mentions and imports as written are read back from the file's nodes, a local
  name resolves against the file's own declarations, an imported name against the
  target file's symbol by its global name, an unresolved name is a coverage gap
  with its own place, and the resolved mentions fold into one edge per pair of
  symbols and relation plus one positioned occurrence per place.

The complete proposed capability file is `capabilities/fill-stages.md`.

## Preserved contracts
- fill-stages/registry: unchanged — the stage is one registration and the graph is derived from its declarations, including the new `mention` capability it consumes.
- fill-stages/graph: unchanged — the graph is still derived from the declared capabilities, with the same order, edges, starvation and cycle rules.
- fill-orchestrator/publish: unchanged — the resolution publishes through the same graph-store unit publication.

## Coverage
- fill-stages/resolution: test, mutation, static
- fill-stages/registry: test
- fill-stages/graph: test
- fill-orchestrator/publish: test

## Where it is seen
Kind: command
Place: the `madarch fill-stages` command of the product CLI, and the resolved edges in the product's graph

1. A person runs `madarch fill-stages` on a product with a TypeScript or Go
   code repository, and opens the product's graph: the call, reference and
   inheritance edges join a symbol of the file that writes the name to the symbol
   of the file that declares it, each resolved mention carrying its own place.
2. A person reads a name the resolution could not tie to a symbol in the file's
   coverage: the gap names the name, the file, the line and the column.
3. A person runs the same command again on an unchanged commit: the resolution
   plans no unit and writes nothing to the graph.

## Blocking questions
None.

## Design and decisions
The file pass publishes one `code.mention` node per place (name, use, access,
namespace, parameter binding, byte span, and the import each name is bound by as
written with the file it answers); `src/fill/stages/mention-graph.ts` states the
node, its key and its reader. The resolution stage
(`src/fill/stages/semantic-resolution.ts`) reads its file's node by key, its
mentions and symbols page by page, and each bound name by the graph's
`byGlobalName`; the scope rule it applies is `resolution-facts.ts`'s, shared with
the extract driver until 2.5. Its publication is the graph store's unit
publication, and its plan reads its own coverage back to know what it resolved at
which blob.

## Acceptance evidence
The task's acceptance record on the stage (epic) names the revision and the
checks: `bun run check`, the expected-set cases at 100, 200 and 400 generated
files, the measured peak per 100 files, and the Stryker run on the resolution
stage.

## DONE WHEN
On a repository the test generates, the resolved calls, references and
inheritance edges equal the generator's expected set, read back through the
graph; a second run writes nothing; the peak heap per 100 files does not grow
with the size; and `bun run check` passes with the resolution stage covered by
the boundary check and no exception listed.
