# Catalogue diagram hang — madarch-64o5.71

Baseline: 18788ee5. The eight cancelled frame/breadcrumb files were inspected and stashed, including untracked src/server/stage.ts, as frame-wip. The stash is retained.

## Evidence

A product filled from this checkout was served on a separate API port. curl -m 30 requesting catalogue 6127449f-e264-5454-afca-898ec7668857 in LikeC4 depth 1 ended with HTTP 000 after 30.000623 seconds. Other pages on that process stopped responding.

pg_stat_activity showed the connection idle in transaction / ClientRead. Its last statement was the neighbourhood WITH around query. EXPLAIN (ANALYZE, BUFFERS) of that exact statement with the same UUID and sample bound 12: execution 0.189 ms, planning 21.641 ms. No query was running during the hang.

Bun inspector was attempted on a fresh baseline server. Debugger.pause did not interrupt the microtask churn, Profiler is not an available protocol domain, and an inserted debugger statement in a scratch baseline crashed Bun 1.4.2. A one-time stack probe in that scratch baseline instead reported:

    Error: undeclared field kind=catalogue
      at flushFields (.../src/graph/graphql-read.ts:607:131)
      at processTicksAndRejections (native:7:39)

The scratch probe only logs once and leaves the original loop intact. The original uninstrumented baseline also hangs.

## Cause

Catalogue vertices are stored as manifest.kind opinions. The read adapter represents them as CatalogueEntity with public kind catalogue and cached declaration data. Normal GraphQL label resolution uses catalogueTitle. diagramNeighbourhood calls labelOf directly; it previously tried storageLabel for the undeclared public kind catalogue. ensureFields retries until a field-cache entry exists. flushFields skipped undeclared kinds without populating the cache, so each retry immediately scheduled another promise. This infinite microtask loop starved timers and the API event loop. It was not a database scan, a derivation cycle, or expensive layout.

A second defect dropped sampled neighbours: the SQL returns kind, but entityFromRow expects entity. The adapter now supplies that name explicitly.

## Fix and server settings

Catalogue labels resolve from catalogue declarations. Undeclared field reads fail instead of retrying forever. Sampled neighbours use the right adapter column.

The complete render read, fold, layout and HTML work runs in a killable Bun worker, not the API event loop. GraphQL uses the same isolation. Each active request owns its worker and timer; idle workers can be reused, but there is no shared active queue to cancel the wrong request. The database snapshot reads the published manifest and graph together. A bounded eight-picture cache uses exact freshly read graph content plus format: a changed label or edge does not reuse stale bytes.

`startServer({ readDeadlineMs: 30000 })` sets the budget of each render and GraphQL request. `MADARCH_READ_DEADLINE_MS` is the environment setting when that option is omitted. The default is 30,000 ms, not 2,000 ms. Invalid/nonpositive values are refused. Each request includes worker startup and preparation in its own budget. A render deadline terminates its worker and any active archify renderer. PostgreSQL statements also use the request budget.

Every handled request writes method, path and request id at start, then status and duration at end, including without trace capture. A request still running after 5,000 ms warns with its own path and stage. AsyncLocalStorage keeps overlapping requests' stages separate. `MADARCH_WATCHDOG_MS` overrides the warning threshold for diagnostics/tests; it does not change cancellation. Render spans include read, fold, layout and whole render.

## Measurements

Same stored product, HTTP GET LikeC4 depth 1, curl timeout 30 s. Folder UUID 695cfba5-2b66-5c0e-a453-78a5eb4cea45 (.architecture); file UUID 70921257-7ff7-5cd7-a996-33341920da45. These are a one-time outside-product acceptance walk, not committed test dependencies.

| Entity | Before | After first picture | After warm picture |
| --- | ---: | ---: | ---: |
| Catalogue (code.file) | >30,000 ms, no answer | 1,440 ms including worker/engine startup | 43 ms |
| Folder | 484 ms | 263 ms | 66 ms |
| File | 435 ms | 222 ms | 110 ms |

Fixture: 80 catalogue kinds and 79 actual any-end mentions edges between manifest.kind vertices. The complete renderDiagram path reads a fresh PostgreSQL snapshot and renders a warm LikeC4 picture in 47.5 ms (Mermaid 30.7 ms), both below the strict 200 ms assertion. The warm cache is included; no part of the measured request is excluded.

## Validation and limitations

- `bun run check` passed, including the shrinking architecture baseline (no new exceptions).
- Final catalogue/render/observability/budget run: 19 passed, 94 assertions. The real looping render logs start, warns at 5 seconds with layout stage, cancels at its 5.8-second budget, and another page answers while it runs.
- Catalogue fixture: 1 passed, 27 assertions (included in the 19). Graph read regressions include translated catalogue labels, bounded 1,324-neighbour sampling and fail-fast unknown kinds.
- Independent review caught missing worker embedding; build-binary now explicitly compiles the worker entry. A compiled scratch binary invoked the worker successfully outside the checkout.
- A start-log mutation was rejected by the no-trace sink test. A timeout-classification mutation was rejected by both cancellation tests. All mutations were restored.
- Targeted manual mutations caught removal of the catalogue label guard, the neighbour adapter fix, and the undeclared-kind fail-fast guard. The last mutation reproduces starvation and required SIGKILL. Fixes were restored.
- GraphQL executor file: 32 passed, 2 failed outside the changed behavior: a stale test expects depth limit 6 while MAX_DEPTH was already 7, and the starter home uses Code/Product names with a demo-only schema. These failures are not claimed fixed. A scratch baseline test attempt failed to load plugin macros, so no successful baseline suite run is claimed.
- Full MADARCH_SKIP_PERF suite was stopped after roughly three minutes with no progress in fill-updates-run.test.ts; an isolated attempt also made no progress. No complete-suite pass is claimed. Memory had 4.3 GiB available, disk 6.2 GiB free.
- The box has no br, take-task skill, tracker store or configured project hooks. Work is linked to the task explicitly assigned by the user; no tracker acceptance/closure is claimed.
- Bun inspector could not supply a paused stack on the uninstrumented microtask hang; the scratch probe and database evidence above are reported instead, without claiming a successful inspector capture.
