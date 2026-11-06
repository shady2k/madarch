# The starter set declares the four workflows in madarch/workflows.yaml, and a check refuses a missing stage or an input without a producer

Change: madarch-8bdc.4.6
Base: 8bd7a2973280f7072216c5540090595bb2ba5050
Tasks: madarch-8bdc.4.6
Kind: behavior

## Intent
Decision 0033 makes workflows product data (items 1 and 2): "Workflows are product data in the product
repository (`madarch/workflows.yaml`, beside the kinds and POV). The engine ships a starter set: first
fill, update by commit, branch/worktree, history point. Stages are engine code referenced by id; a
workflow that names a missing stage or leaves a stage's input without a producer fails the manifest
check." Nothing of that data existed: the stage registry held the engine's stages, and a product had no
place to say which of them a workflow runs.

This change declares the four starter workflows, reads them, and checks them. `madarch new` writes
`madarch/workflows.yaml`; the manifest read returns the workflows with the kinds manifest, and the
wiki's own read of a product reports the workflow findings on its Problems page beside the manifest's
other findings. A workflow is a named set of the engine's stage ids, and the capabilities give the order:
the check reuses the derivation a run makes (`deriveStageGraph`), read over the workflow's own stages, so
no edge is declared in the file and no second graph is written. A stage id the registry does not hold is
refused by id, and a stage whose required input no stage of the workflow produces is refused by the
derivation's own path (`modules → symbol → syntax (disabled)`), naming the file, the line, the workflow
and the stage. A cycle of the workflow's stages is refused by its own path, and a workflow the reader
refuses is left out while the others stand.

A workflow's status says what the engine can do with it today, the way a kind's catalog row marks its
implementation status. First fill is `implemented`: every stage it names is one the engine's registry
holds, and every required input has a producer among them. Update by commit, branch/worktree and history
point are `planned`: the engine has no commit hook, no background server that picks a commit up and no
per-file change set (0033, item 25, which stage madarch-8bdc.6 builds), so running the fill at a new
commit is a first fill again; a branch's own base, overlay and publication namespace (0033, item 26) and
a materialised history point (0030) have no stage either. A planned workflow names no stages, and the
stages it names when it names any are checked as an implemented workflow's are: decision 0033, item 2
exempts no planned workflow. The first fill names the stages of the fill as the registry holds them
today — the eight deterministic stages, the seven agent stages a run registers when it names an agent,
and the narrative stage that cites them.

## Rationale
The stages are engine code and the workflows are the product's, so the file holds ids and nothing else a
run would have to interpret: no edge, no order, no budget. The order is what the registry already
derives from the stages' consumes and produces, and a workflow is the one place a product says which of
those stages its fill runs and which of them it does not. Writing an edge or an order into the file
would have been a second source of truth for the same graph, and a hand-written graph that a stage's
declaration contradicts is exactly the defect the registry's derivation refuses.

The producer check is the derivation's own, not a second one: the workflow is read as a configuration
that enables its stages and disables the rest, and the starvation paths a run would refuse are the
findings the check reports. A stage that reads a required input no stage of the workflow produces would
first fail inside the run, far from the file the person edited; the check names it at the stage's line
with the same path.

The status is the catalog's own idea of implementation status applied to a workflow, because the four
starter workflows differ in what the engine can do: a branch's overlay and a materialised history point
have no stage at all yet, and a workflow that named stages for them would either invent ids or claim a
run the engine cannot make. A `planned` workflow may name no stages, so the starter file says what the
engine cannot do yet instead of saying nothing. Its stages, when it names any, are checked as an
implemented workflow's are: every stage it names must exist, and every required input of those stages
must have a producer among them, since decision 0033, item 2 exempts no planned workflow.

The check runs where the catalog's runs: over the starter set in `bun run check` (a temporary product
written exactly as `madarch new` writes it), and in the wiki's own read of a product's manifest, whose
findings a reader sees on the Problems page. One check and one reader, the same findings.

## Out of scope
- Which stages a run enables from a workflow, and how a run starts from a commit, a branch or a history
  point: the orchestrator does not read `madarch/workflows.yaml` yet, and this change does not wire it
  in. It belongs to madarch-8bdc.2.5 and later; the stage registry's `deriveStageGraphOver` is the only
  seam it needs.
- The stages the branch/worktree and history-point workflows will name: the engine holds none, and
  inventing an id is what the check exists to refuse.
- The agent stages a run without an agent does not register: the first fill names every stage the
  engine knows, since the workflow is the product's data and the run's wiring is the orchestrator's. A
  product whose run names no agent registers six agent stages fewer; which stages a workflow's run
  enables is the orchestrator's decision, later.
- An offer in the starter upgrade for a product made before this change: the upgrade's existing "writes
  the starter files that are absent" gives such a product `madarch/workflows.yaml` at its next run
  (`upgradeStarterSet` walks `STARTER_FILES`), and no new offer, prompt or template entry is added here.
- The kinds manifest: workflows live in their own file, beside the kinds and the POV, and are not a
  section of `madarch/kinds.yaml`.

## Changes to requirements
- product-wiki/workflows (new at Base): the starter set declares the four workflows in
  `madarch/workflows.yaml`; a workflow is a named set of the engine's stage ids and the capabilities give
  the order; a check run by `bun run check` over the starter set and by the wiki's own read of a
  product's manifest refuses a stage the registry does not hold and a stage whose required input no
  stage of the workflow produces, naming the file, the line, the workflow and the stage (a refusal of the
  file or of a workflow's own fields names the file, the line and the workflow); a planned workflow may
  name no stages; the starter set passes and a valid workflow reads without a finding.
  Scenarios: `starter-set-workflows`, `workflow-refusals`, `workflow-reads`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted requirement is retained
verbatim from Base; `catalog` (madarch-8bdc.4.1), `extractor-mapping` (madarch-8bdc.4.2), `pov`
(madarch-8bdc.4.3), `presentation` (madarch-8bdc.4.4) and `views` (madarch-8bdc.4.5) are the sibling
changes' additions and stand before the new requirement, which is at the file's end.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages; a product without `madarch/workflows.yaml` reads exactly as it did, and the starter set's pages are unchanged.
- product-wiki/live: a saved workflows file changes the findings at the next read; no page gains or loses a block.
- product-wiki/serve: serving a product is still one read of its working tree; the workflows file adds no route.
- product-repository/draft: `madarch new` still writes the starter set as the product's own files; what it writes now includes `madarch/workflows.yaml`, committed with the draft.
- fill-stages/registry: a stage is still registered once by its module, and a plan is still derived from the declarations; the workflow check adds one derivation over a set of the registry's stages and changes no stage.

## Coverage
- product-wiki/workflows: test, static
- product-wiki/views: test, static
- product-wiki/catalog: test
- product-wiki/extractor-mapping: test
- product-wiki/pov: test, static
- product-wiki/presentation: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- fill-stages/registry: test
- product-repository/draft: test

## Blocking questions
None.

## Design and decisions
- `src/knowledge/workflows.ts` is the reader and the check: `WORKFLOWS_FILE` is `madarch/workflows.yaml`,
  the two statuses are engine vocabulary (`implemented`, `planned`), and `parseWorkflows` reads the text
  with YAML positions the manifest code already uses (`LineCounter`, `lineForPath`). A workflow's name
  follows the stage id's own shape (`STAGE_ID_PATTERN`), and so does each stage id it names.
- `src/fill/registry.ts` gains `deriveStageGraphOver(registry, stages)`: the same `deriveStageGraph` a run
  calls, with the named stages enabled and every other stage disabled. A starved consumer comes back by
  the derivation's own path (`modules → symbol → syntax (disabled)`, or `… → no producer`), and a cycle by
  its own path. No second graph walk and no edge in the product's file.
- `src/fill/stages/index.ts` gains `createEngineStageRegistry()`: every stage this madarch knows, over a
  snapshot source that reads no repository and a named agent nothing runs, since the agent stages are
  registered only where a run names an agent. It is read, never driven.
- `src/knowledge/starter-workflows.ts` holds the four workflows as data, and `src/knowledge/seed.ts`
  writes them into `madarch/workflows.yaml` with the manifest's own comment block. The file joins
  `STARTER_FILES`, so `madarch new` writes and commits it, and a product's starter set holds it.
- `src/knowledge/kinds.ts` reads the workflows beside the kinds manifest: `KindsManifest.workflows`
  holds the workflows and their findings, and the findings stand with the manifest's own, so the
  Problems page shows them once. A product without the file reads as before.
- `src/knowledge/product.ts`: the stamp that decides whether the Problems page is read again includes
  the workflows file's content beside the kinds manifest's, so a saved workflow's finding appears, or
  goes, at the next read like every other manifest finding.
- `scripts/check-workflows.ts` is the command (`bun run check:workflows`), wired into `bun run check`
  after the catalog check: the starter set in a temporary product, or `--folder`, prints
  `workflows: 4 workflows (1 implemented, 3 planned)` and the manifest it read, prints every finding as
  `<full path>:<line>: <the words>` and exits 1, and exits 2 on an argument it does not know.
- The architecture list does not grow: no new entry was needed, and the list still holds 1 240.

- Assumptions and constants of the change:
  - The workflow names are the owner's words: `first-fill`, `update-by-commit`, `branch-worktree`,
    `history-point`. The statuses are `implemented` and `planned`, the catalog's own idea of an
    implementation status; `partial` is not used, because a workflow either has the stages it names or
    is planned.
  - Only the first fill names stages. Update by commit is planned and names none: the engine has no
    commit hook, no background server that picks a commit up and no per-file change set (0033, item 25;
    madarch-8bdc.6 builds them), so running the fill at a new commit is a first fill again, and a reader
    who saw `implemented` would be told the engine can do something it cannot. When those stages land,
    update by commit names them in the product's own file.
  - A planned workflow is refused for the stages it names exactly as an implemented one is: a stage id
    the registry does not hold, a stage whose required input no stage of the workflow produces, and a
    cycle. Decision 0033, item 2 names no exception for a planned workflow, and the check is the place
    to refuse stages that could not feed each other at a run; the status still lets a workflow name no
    stages at all, which is how the starter set's three planned workflows say the engine cannot run
    them yet.
  - A stage named twice in one workflow is refused as one defect: a workflow's stages are a set.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-05, on the change:

- `bun run check` exit 0: `tsc --noEmit` clean (TypeScript 7.0.2), the architecture check at its 1 240
  listed violations, unchanged and grown by none, `catalog: 26 areas, 100 subgroups, 490 kinds (67 with
  a page of their own or a member's row)` with `mapping: version 1; 56 extractor kinds (55 tied, 1
  internal); 64 extractor relations (36 tied, 28 internal)`, and `workflows: 4 workflows (1 implemented,
  3 planned)` naming the temporary product's `madarch/workflows.yaml`.
- `MADARCH_SKIP_PERF=1 bun test test/workflows-read.test.ts`: 22 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/workflows-check.test.ts`: 6 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-parse.test.ts test/wiki-readers.test.ts
  test/starter-set-upgrade.test.ts test/catalog-check.test.ts test/mapping-check.test.ts
  test/roles-check.test.ts test/knowledge-manifest-views.test.ts test/knowledge-manifest-presentation.test.ts`:
  129 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/product-draft.test.ts test/knowledge-parse.test.ts`: 50 pass, 0 fail;
  `test/workflows-read.test.ts test/workflows-check.test.ts test/catalog-read.test.ts
  test/mapping-check.test.ts` together: 107 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-server.test.ts`: 18 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-*.test.ts test/product-wiki-pages.test.ts
  test/product-wiki-serve.test.ts test/product-manifest.test.ts test/starter-set-upgrade.test.ts`: 730 pass,
  1 skip, 6 fail — the five `chmod 000` cases of `product-wiki-pages` and `product-wiki-serve`, which this
  root run reads, and the writer's second press; all six fail identically at the base in a clean worktree of
  `8bd7a297` (`/work/w46base`, its own run).
- StrykerJS 9 (command runner, `coverageAnalysis: off`, `inPlace`, `typescript@5` beside it, from
  `/work/scratch46/stryker` outside the repository) on the changed line ranges of
  `src/knowledge/workflows.ts`, `src/knowledge/starter-workflows.ts`, `src/knowledge/seed.ts`,
  `src/knowledge/kinds.ts`, `src/fill/registry.ts` and `src/fill/stages/index.ts` against
  `bun test test/workflows-read.test.ts`: 334 mutants, 289 killed, 0 timed out, 45 survived — 86.53%
  (workflows.ts 97.40%, starter-workflows.ts 100%, kinds.ts 100%, registry.ts 85.71%, seed.ts 38.30%,
  stages/index.ts 18.18%). The survivors are: 29 of the starter file's comment sentences and the four
  per-workflow comment conditions (comments only, the YAML reads the same); 10 of the engine registry's
  read-nothing snapshot source and named agent, which no read calls; the synthetic configuration's empty
  file name, which no problem names; and six guards of the reader that no reading distinguishes (an
  optional chain YAML always fills, the map's own start line, an `||` path-length guard true only when the
  path is empty, and the `typeof status !== 'string'` guard of a status list no non-string matches).
- The catalog and mapping checks' refusal branches, mutated as the stage's own run:
  `src/knowledge/catalog.ts:102-313` against `bun test test/catalog-read.test.ts`: 493 mutants, 403
  killed, 0 timed out, 90 survived — 81.74%, the score madarch-8bdc.4.1 recorded on the same file and the
  same test, reproduced here; and `src/knowledge/mapping.ts:67-190` against
  `bun test test/mapping-check.test.ts`: 345 mutants, 261 killed, 0 timed out, 84 survived — 75.65%.
  Their survivors are the refusal messages' own words, finding paths whose line is the same field's, and
  the redundant `||` guards of the declaration type checks, the character 4.1 recorded; no test in the
  fast file observes an outcome they change.
- The review's three fixes (2026-11-05). A planned workflow's stages are checked as an implemented
  workflow's are, since 0033, item 2 exempts none; the Problems key names the workflows manifest, so an
  edit of the file moves the listing; and a stage list reached through a YAML alias is refused at the
  line that uses the alias, not the document's first. After them `bun run check` is exit 0 with the
  architecture list still at 1 240, `MADARCH_SKIP_PERF=1 bun test test/workflows-read.test.ts` is 24
  pass, `test/workflows-check.test.ts` 7 pass, the two files together 31 pass, and
  `test/problems-listing-cache.test.ts` 4 pass. StrykerJS on the changed lines only (the alias line of
  `src/model/yaml-position.ts` and the status gate of `src/knowledge/workflows.ts`; the stamp's added
  statement has no mutable operator) killed 4 of 4 mutants, 100.00%.

## Where it is seen
Kind: command
Place: `madarch new`'s starter set, `bun run check` in a checkout, and a product's Problems page

1. Make a product with `madarch new` and open `madarch/workflows.yaml`: four workflows stand under
   `workflows:`, first fill names the stages the registry holds, and update by commit, branch/worktree
   and history point are `planned` with `stages: []`.
2. Run `bun run check`: the workflow check prints `workflows: 4 workflows (1 implemented, 3 planned)` and
   the file it read, and exits 0.
3. Delete `- syntax` from the first fill's stages and run it again: it prints the file's full path, the
   line of `modules`, and `workflow "first-fill" stage "modules": modules → symbol → syntax (disabled):
   the workflow names no stage that produces the input "symbol"`, and exits 1; open the product's wiki
   and the Problems page lists the same finding with its file and line.
4. Change a stage id to one the engine has no stage for: the check names the id, the registry's stages,
   the file, the line and the workflow, and exits 1.

## DONE WHEN
`madarch new` writes `madarch/workflows.yaml` with the four starter workflows, the manifest read returns
them, and a workflow's stages are ids of the engine's stage registry; the manifest check, run by the
product-wiki check and `bun run check` over the starter set, refuses a workflow naming a stage the
registry does not hold and a stage whose input no earlier stage produces, naming the file, line, workflow
and stage; the starter set passes, and a valid workflow is read without a finding.
