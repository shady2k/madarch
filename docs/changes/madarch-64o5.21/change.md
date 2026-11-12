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

## Acceptance evidence
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
- `bun run check`: passed, including architecture, UI, catalogue, workflows and quarantine checks.
- `MADARCH_SKIP_PERF=1 bun test test/server-sources.test.ts`: 82 passed,
  0 failed on isolated rerun after two five-second timeouts in the combined run.
- `MADARCH_SKIP_PERF=1 bun test test/status-work.test.ts`: 3 passed, 0 failed.
- The combined touched-area run passed all seven fill-update-run cases and the
  draft-status case, but timed out in knowledge-server and two source-server cases;
  it was stopped after remaining stuck in knowledge-server. An isolated
  knowledge-server rerun also timed out in its 60-second setup. This is not a
  green result for that suite. A further isolated run reached the catalogue case
  but again hit its 30-second bound; its late assertion expected `manifest: ok`
  and received `not-filled`; that run did not record the fill row at the failing poll.
  The remaining stuck process was stopped. This suite needs follow-up before acceptance.
- Independent same-model review: no remaining blocking findings after fixing
  per-product read failure handling and adding the transition test.
- Document gate parses the proposal and coverage. It still refuses admission
  because this box has no tracker task export for the supplied task and no
  owner approval. Neither is fabricated here.

### Acceptance follow-up: finished fills and idle comparison
- The catalogue fixture at `test/knowledge-server.test.ts` activates the store
  schema, then presses the real HTTP Fill endpoint. It does not seed pins or a
  successful run. During the idle branch run, the catalogue case passed in
  25.27 s, and a read-only query of its store confirmed `fill_run.state = succeeded`.
  No fixture success record or alternate fill path was added.
- The status memo could keep `manifest: not-filled` after a successful run:
  live numbers refreshed `filled`, but not `manifest`. Both fields now derive
  from the same successful-run read. Catalogue publication and pins still do
  not count as a completed fill.
- The catalogue case now requires `fill.state: done`, `filled: true` and
  `manifest: ok` together. Its bound changes from 30 s to 90 s because its
  existing polling loop allows 60 s of sleeps plus HTTP requests. This does
  not change production timing or accept unfinished fills.
- A focused status-memo regression performs a real `fillInProcess`/`runFill`
  and holds the reader's cache key constant, so graph changes cannot hide the
  terminal-state refresh. It requires both fields to move together; no successful
  row is fabricated. Removing the live manifest refresh reproduced `filled: true`
  with `manifest: not-filled` (1 failed, 4 assertions); restoring it passed
  (1 passed, 4 assertions, 14.87 s).
- The suite teardown bound changes from the unnamed 10 s default to 60 s.
  Shutdown drains background work and closes the visited products' database
  pools and PostgreSQL clusters sequentially. Main exhibited this timeout too.
  Production shutdown constants are unchanged.
- Before the isolated branch run: 6377 MiB available, load averages
  0.54/2.32/1.93. Result before the follow-up: 14 passed, 8 skipped, 1 failed
  in 114.56 s; the sole failure was the 10 s teardown hook.
- Unmodified `origin/main` (`9a73405a`) was run in a detached scratch worktree
  on the same box, with the same installed dependency versions. Before it:
  6325 MiB available, load averages 1.11/1.79/1.79. No other Bun suite ran
  concurrently. It failed its 60 s setup and 10 s teardown hooks:
  0 passed, 2 failed, 1 error, 73.39 s. The setup stopped while requesting
  `/products/unconnected/api/status`. Thus setup/teardown timeouts also occur
  without this change; this comparison does not prove every earlier timeout
  had the same cause.

- Final isolated branch suite after the live status fix and coherent test/hook
  bounds: 14 passed, 8 skipped, 0 failed, 1658 assertions, 108.84 s.
  `manifest: ok` remains required together with a completed real fill.
- Follow-up `bun run check`: passed (TypeScript, architecture, UI, catalogue,
  workflows and quarantine checks).
- Final focused run (`test/status-fill-memo.test.ts` and `test/fill-updates.test.ts`):
  14 passed, 0 failed, 63 assertions, 18.52 s.
- Independent read-only follow-up review found no blocking findings in the live
  status fields, real-fill memo regression, catalogue assertion or teardown.

### Comparison commands
Both suites ran as the `box` user with `MADARCH_SKIP_PERF=1`; `free -m`
and `uptime` were checked before starting them. Main used its own detached
worktree with `bun run install:plugins` and the checkout's installed root
packages; no tracked main file changed. Initial worktree starts before its
plugin dependencies were installed were environment setup failures, excluded
from the suite comparison above.

```text
branch (before explicit teardown bound):
  MADARCH_SKIP_PERF=1 bun test test/knowledge-server.test.ts
  14 pass, 8 skip, 1 fail; 159.83 s
  catalogue case: passed, 41.51 s; sole failure: teardown 10002 ms
final branch:
  MADARCH_SKIP_PERF=1 bun test test/knowledge-server.test.ts
  14 pass, 8 skip, 0 fail; 1658 assertions; 108.84 s
main (9a73405a):
  MADARCH_SKIP_PERF=1 bun test test/knowledge-server.test.ts
  0 pass, 2 fail, 1 error; 73.39 s
  setup 60000 ms, teardown 10008 ms
```

## DONE WHEN
The watcher never starts the first fill, persists baseline heads before a successful fill,
and keeps existing post-fill updates; status never treats pins alone as a finished fill.
