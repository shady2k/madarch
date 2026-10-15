# Asynchronous graph-query boundary

Status: decision for `madarch-24sy.4.1`
Date: 2026-10-15

## Context and drivers

Decision 0024 selects PGlite locally and PostgreSQL on the server. Both expose asynchronous database operations. The existing `QueryEngine` interface in `src/query/types.ts` is synchronous, and `Graphs`, view preparation, rendering and tests call it synchronously. The owner requires a real async boundary; a sync wrapper must not hide PGlite's API.

The outcome is unchanged graph answers for views, the server and the agent query endpoint. An unknown element or ambiguous default state remains a `QueryError`; a database or lifecycle failure remains a rejected operation. No HTTP response shape changes. A multi-query render must see one coherent graph revision even if an ingest overlaps it. PGlite is one connection, so updates, queries and close must be awaited and serialized by the adapter that owns that connection.

## Inventory

- `QueryEngine` has synchronous query, `rebuild`, `update` and `close` methods.
- There are 331 direct method calls across 18 source and test files. Retyping this shared interface at once is a wide refactor; the project requires expand/migrate/contract rather than a red all-at-once change.
- `Graph.engine()` already returns a promise and lazily builds the engine from `HistoryStore.assertions()`.
- `Graphs.applyStore`, `dropBuilt`, `remove`, and `close`, plus `Graph.close`, are synchronous even though they touch the engine lifecycle.
- `prepareModel` is asynchronous, but `buildViewSet` and rendering call engine methods synchronously. `buildViewSet` and `renderLikeC4Workspace` make multiple queries; once awaited, an ingest could otherwise land between them and mix graph revisions.
- The Ladybug adapter can remain temporarily while callers move; the PGlite query engine will be implemented in the next task.

## Options

1. **Retype the shared `QueryEngine` port at once.** Change every method to return a promise and migrate all 331 call sites in one change. This avoids a temporary interface, but breaks the entire tree at once and has no green integration point between the type change and caller migration. It violates the project's expand/migrate/contract rule for a wide refactor, so it is rejected.
2. **Expand, migrate, contract with a parallel `AsyncQueryEngine` port (chosen).** Add the promise-based port beside the existing synchronous `QueryEngine`, including a query-only snapshot reader and a temporary async adapter for Ladybug. Migrate production callers and test suites in batches; remove the old port only after no caller uses it. This adds a temporary adapter, but each step remains green and PGlite receives a genuinely asynchronous contract.
3. **Keep the synchronous port and hide async work behind a synchronous facade.** This rejects the assumption that callers can change, but cannot honestly return PGlite results without blocking, returning stale values, or introducing fire-and-forget work. It violates the owner’s async-boundary constraint and is rejected.

## Decision

Use option 2. Add `AsyncQueryEngine` and a query-only `QuerySnapshot` beside the synchronous `QueryEngine`. Query methods return `Promise<Result>`; `rebuild`, `update` and `close` return `Promise<void>`. Add `withSnapshot(work)`, which gives the callback a query-only reader and holds one consistent read revision until the callback finishes. A single query remains one statement; a multi-query view or render wraps all of its queries in one snapshot. PostgreSQL uses a read-only repeatable-read transaction; PGlite serializes that transaction with writes on its single connection. The admission gate is fair and writer-preferential: active snapshots may finish, but once a state-changing operation queues, later snapshots cannot pass it; queued writers run in arrival order. Close also prevents a pending build from installing an engine. The temporary Ladybug adapter uses this gate and gives the callback a reader that does not reacquire it. The callback must use only that reader; public engine calls made from inside the callback reject immediately, rather than re-entering the gate and deadlocking. Keep domain query errors in the result object; unexpected database and shutdown errors continue to reject.

Task `.4.1` is the expand step only: add the async contract and a temporary adapter over the existing synchronous Ladybug engine; leave current callers on `QueryEngine`. The next tasks migrate production callers and test suites in batches, then remove the synchronous port as the final contract step. The actual PGlite/PostgreSQL adapter performs asynchronous database operations; no synchronous facade is provided for it.

## Consequences and checks

- The new port is genuinely asynchronous, but the existing synchronous callers remain usable until their migration tasks. The temporary Ladybug bridge proves the contract without pretending that it is the PGlite adapter.
- `withSnapshot` makes a multi-query read stable: an ingest waits for the snapshot or commits after it, never between its queries. Once a writer is queued, later readers wait behind it, so a steady stream of renders cannot starve an update. PostgreSQL and PGlite adapters implement the guarantee with their transaction/connection semantics.
- Task `.4.1` adds the contract and transition adapter only. Its tests verify promise returns, unchanged query results and errors, that update/close wait for a paused snapshot, that a later snapshot cannot overtake a queued update, and that public engine calls from inside a snapshot reject rather than deadlock. Later migration tasks add a regression that pauses a multi-query render, overlaps an ingest, and proves the output is wholly before or wholly after it. The stage runs `bun run check` and the focused query-engine, graph, view, server-view, HTTP and history-source suites after all callers migrate.
- The SQL storage layout is not decided here. A separate owner question covers whether local sources share one PGlite database or retain per-source databases.

## Review finding and disposition

The second independent design review found that repeated new snapshots could starve a queued update. The design now requires a fair writer-preferential gate: active snapshots finish, later snapshots cannot pass a queued writer, and queued writers run in arrival order. The expand task tests that order with a paused snapshot, a waiting update and a later snapshot. The implementation review will verify the same guarantee.
