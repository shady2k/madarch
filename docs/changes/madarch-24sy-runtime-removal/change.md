# Retire the synchronous graph-query runtime

Change: madarch-24sy-runtime-removal
Base: 9bb85e5ae2c98c88ef33c1a0acdcea2adf3c90e7
Tasks: madarch-24sy.4.5
Kind: behavior

## Intent
Complete the accepted async SQL migration contract phase for task `madarch-24sy.4.5`. Remove the public synchronous query port and Ladybug adapters, native package/install assumptions, and legacy-only test oracle. Local query projection remains PGlite; server query projection remains injected PostgreSQL; HistoryStore remains one PGlite database per source. Keep graph, render, model-check and server-view results unchanged, including refusal and error shapes. Keep the deliberate legacy `.sqlite` refusal and rebuild-by-resend guidance. Retain the under-one-second, 10,000-element latency target with PGlite/PostgreSQL verification pending separate tracked measurement work. Defer a replacement SQL long-run memory bound to that performance work.

## Rationale
The accepted `.4.2` design chose expand, migrate, contract, and specifies removal of the synchronous port after caller migration. `.4.4` completed production caller migration; this task removes the temporary public API. This is a contract change for code importing the synchronous exports, though graph-query behavior for supported callers does not change. Historical decision records remain historical.

### Retired test coverage map

| Retired path | Why it is retired | Replacement or limit |
| --- | --- | --- |
| `test/async-query-engine.test.ts` | It tested the temporary synchronous-to-asynchronous Ladybug bridge and the Ladybug factory. | `test/sql-query-database.test.ts`, `test/postgres-query-database.test.ts`, and the focused PGlite query suites cover the real asynchronous database APIs, snapshots, scope and close behavior. |
| `test/query-engine-stability.test.ts` | It asserted Ladybug-specific execution threads, native buffer-pool cleanup and prepared-statement-cache behavior. | Query semantics and closure are covered by `test/query-engine.test.ts` and `test/sql-query-database.test.ts`; Ladybug native resource internals have no replacement because the adapter is removed. |
| `test/query-engine-performance.test.ts` | It measured Ladybug performance and used Ladybug as a test oracle. Performance measurement is outside this leaf. | Fixed expected SQL paths and cycles are covered by `test/sql-query-engine-conformance.test.ts` and `test/query-engine.test.ts`. The under-one-second target is retained, with SQL verification pending separate tracked measurement work. |
| `test/query-engine-long-run.test.ts`, `test/query-engine-long-run-probe.ts` | They measured the Ladybug engine's long-run RSS and statement-cache bounds. | Long-run engine-specific measurements are retired with the native runtime; SQL correctness, close and snapshot lifecycle remain in the focused SQL suites. The SQL long-run bound is not measured in this leaf. |
| `test/views-performance.test.ts` | It benchmarked rendering through the synchronous Ladybug engine. | Renderer behavior remains covered by `test/views.test.ts`, `test/views-likec4.test.ts`, `test/views-one-view.test.ts`, `test/server-views.test.ts`, and `test/model-check-views.test.ts`; no renderer performance tuning is claimed. |

The 40-owner PGlite close stress remains in `test/query-engine.test.ts` and is
skipped only when `MADARCH_SKIP_PERF` is set. Its explicit 30s run timed out;
that is not counted as a pass. The SQL long-run memory bound is explicitly
deferred in the proposed capability; the under-one-second latency target is
retained but its SQL verification is pending separate tracked measurement.
This task does not claim the old Ladybug resource guarantee holds for SQL.

The removal of synchronous exports is checked by
`test/public-async-query-api.test.ts`; graph-answer behavior remains checked by
the SQL and renderer suites named under Coverage.

## Out of scope
- Provider/model work, PostgreSQL deployment wiring, and publishing.
- Linux, macOS and Windows clean-install walks.
- Measuring PGlite/PostgreSQL latency against the retained target or establishing the replacement long-run memory bound; the proposed capability records both follow-ups.
- Changes to user-visible graph, rendering, model-check or server behavior.

## Preserved contracts
- graph-queries/children: async SQL answers preserve child ordering, shape, and missing-element errors; SQL and server tests
- graph-queries/view: async SQL answers preserve scope, collapse, context and refinement behavior; SQL and render tests
- graph-queries/dependencies: async SQL answers preserve paths, chain direction, and code-point tie order; SQL tests
- graph-queries/as-of: async SQL answers preserve bitemporal and state-chain behavior; SQL tests
- model-check/views: generated views retain deterministic output and cleanup behavior; model-check view tests

## Coverage
- graph-queries/rebuild: test
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/dependencies: test
- graph-queries/as-of: test
- model-check/views: test
