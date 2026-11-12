# Do not update a product before its first finished fill

Change: madarch-64o5.21
Base: 9a73405a7aed53b52a28a55a81e3edefcf7288e7
Tasks: madarch-64o5.21
Kind: behavior

## Intent
Automatic updates presuppose a successful fill. Before it, repository commits only
advance the watcher's baseline. Repository pins are not evidence of a finished fill.

## Rationale
Owner approval is required before acceptance; no approval is recorded here.
The owner ruled on 2026-11-11 that no repository content enters the graph before
a person presses Fill. Startup publishes the catalogue only (madarch-64o5.9).
A repo-add commit previously started a partial update that left pages without templates.

## Out of scope
- Repairing stores already populated by an unintended update.
- Changing page workflows, producers, or the one fill entry point.

## Changes to requirements
- product-wiki/updates-after-fill: gate updates on a successful fill and persist pre-fill baselines; do not infer filled status from pins.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/catalog: startup catalogue declarations remain available.
- product-wiki/pages: no repository pages are imported before Fill.

## Coverage
- product-wiki/updates-after-fill: static, test, mutation, review
- product-wiki/catalog: test
- product-wiki/pages: test

## Where it is seen
Kind: command
Place: `madarch init`, `madarch repo add`, and the running wiki's status and pages

1. Initialize a clean product and run its server.
2. Add a repository without pressing Fill and wait for the watcher.
3. Read status and pages: fill remains idle and not-filled; only catalogue declarations exist.
4. Restart the server: the recorded heads do not start updates.
5. After a successful Fill, a default-branch commit starts the normal update.

## Blocking questions
None.

## Validation evidence
- Red: `test/fill-updates-before-fill.test.ts` failed because `repo add` started
  `update-shop-<commit>` before Fill (1 failed, 3 assertions).
- Green: the same scenario passed with 14 assertions, including idle/not-filled
  status, catalogue-only graph rows, no fill run, a page refusal rather than a
  template 500, and no update after watcher restart.
- Focused watcher suite: 13 passed, 0 failed. Covers false-to-true fill state,
  persisted pre-fill baselines, unreadable store refusal and recovery, and the
  existing debounce, active-fill deferral and restart contracts.
- Bounded manual mutation: removing the pre-fill gate made the focused watcher
  suite fail (12 passed, 1 failed); restoring it gave 13 passed, 0 failed.
- Independent same-model review: no remaining blocking findings after fixing
  per-product read failure handling and adding the transition test.
- Document gate parses the proposal and coverage. It still refuses admission
  because this box has no tracker task export for the supplied task and no
  owner approval. Neither is fabricated here.

## DONE WHEN
The watcher never starts the first fill, persists baseline heads before a successful fill,
and keeps existing post-fill updates; status never treats pins alone as a finished fill.
