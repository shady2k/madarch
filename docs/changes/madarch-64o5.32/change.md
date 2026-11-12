# Show the latest actual fill run

Change: madarch-64o5.32
Base: 9cb594bf2b72b9610f811413d934aeba05f209f1
Tasks: madarch-64o5.32
Kind: behavior

## Intent
The Fill page states the latest actual run, including a completed selective fill with no agent writer work. The writer is not the source of truth for whether filling has run.

## Out of scope
Real model calls, new kind readers, changing fill scheduling or result semantics.

## Changes to requirements
- fill-orchestrator/completion: expose the latest actual run with when, selection, outcome and destination link. `/api/run` defaults to the latest persisted product run, and `?run=` reads that exact persisted run. A persisted run without a trace remains available with empty trace statistics; a trace-only ID is not a persisted run and returns 404.

## Preserved contracts
- product-wiki/serve: status remains available with HTTP 200 while catalogue publication is pending (madarch-64o5.9).

## Coverage
- fill-orchestrator/completion: static test review
- product-wiki/serve: static test review

## Where it is seen
Kind: request
Place: /fill after a selective fixture fill

1. Run a scripted fixture selective fill, without calling a real model.
2. Open Fill: its actual start/end, requested kinds and result are visible with a link naming the run.
3. Reopen the product: the same persisted last run is shown even though writer state is idle.
4. Before any run, the honest never-started message remains.
5. For a run that failed before recording its configuration, selection is explicitly not recorded, not invented as a whole fill.
6. A running run has no claimed finish time; its named page states that it is ongoing.

## Blocking questions
None.

## Acceptance evidence
Red proofs: `/tmp/q32-backend-red.log` (actual selective fixture run missing persisted result/selection), `/tmp/q32-ui-red.log` (idle writer hides actual run). Backend coverage: `test/fill-selection.test.ts`. Frontend coverage: `wiki/app/src/knowledge/knowledge.test.tsx`; run-page compatibility fixtures: `wiki/app/src/knowledge/repository.test.tsx`. Final native checks and independent review are recorded in `/tmp/madarch-64o5.32-report.md`. Mutation: not-made. No owner approval is recorded here. PR #279 follow-up covers publication-pending status, init/start, clean-install and the unchanged 150 000-span status budget; follow-up logs are `/tmp/q32r-*.log` and independent review is `/tmp/q32r-review.md`.
