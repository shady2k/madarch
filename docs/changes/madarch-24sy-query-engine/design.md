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
- The Ladybug adapter remains temporary while callers move. Task `.4.2` implements the SQL query projection and its shared database owner; graph facades scope reads and writes by source without changing the existing per-source HistoryStore layout.

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
- The owner resolved the local graph-query storage layout on 2026-10-15: one PGlite query database per local data folder/product, with source-tagged rows and graph source scopes. This does not change `.3.1`'s per-source HistoryStore databases. The follow-on implementation shape is recorded below.

## Review finding and disposition

The second independent design review found that repeated new snapshots could starve a queued update. The design now requires a fair writer-preferential gate: active snapshots finish, later snapshots cannot pass a queued writer, and queued writers run in arrival order. The expand task tests that order with a paused snapshot, a waiting update and a later snapshot. The implementation review will verify the same guarantee.

## Owner decision: graph-query database layout (2026-10-15)

The owner selected one shared graph-query database per local data folder (one product locally), with source provenance stored as a column. On the server, graph queries use the server's shared PostgreSQL database. Both modes use the same PostgreSQL schema and SQL. This is the layout for the derived graph-query projection only; `.3.1`'s existing per-source HistoryStore PGlite directories and their rename/restart behavior remain unchanged.

This follows decision 0003: normalized contract IDs connect sources and must be traversable in one query. PostgreSQL cannot join across separate databases. A source-scoped SQL query over one shared projection supports both local cross-source traversal and the server's already-shared PostgreSQL database. Decision 0024 continues to define the projection as derived and rebuildable from bitemporal history.

Rejected alternatives:

1. **Private database per source (database-per-tenant isolation pattern).** Rejected because a traversal cannot join source databases in one PostgreSQL query; a federated copy would add a second, stale projection and fail the owner's one-database decision.
2. **Graph-private databases (database-per-tenant strategy at the Graph boundary).** Rejected because it duplicates rows and PGlite connections for overlapping graph scopes and still fails the per-data-folder ownership choice.
3. **EIP Shared Database pattern with source-scoped query facades (chosen).** The query database is a CQRS-style, rebuildable read projection; the separate `.3.1` HistoryStore remains the history owner. One owner holds the local PGlite database or server PostgreSQL executor. Each graph facade acts as a scoped query repository, carrying its source set and binding every query to that predicate. This keeps cross-source edges in one query without duplicating each source's projection.

## `.4.2` implementation shape

- A shared query-database owner holds schema initialization, the SQL executor, transaction runner, snapshot admission and connection shutdown. Graph-scoped async query facades borrow it. `AsyncQueryEngine.close()` closes its facade and drains that facade's in-flight work; it releases the connection only when it directly owns it. The database owner's `close()` rejects new facades, drains active facade operations and closes the shared connection exactly once. `.4.2` proves this owner/facade lifecycle. Wiring `Graphs.close()` to the owner belongs to a later caller-migration task, not this engine task.
- The shared schema tags each projected element and relation row with its source identity and includes that source in the row's bitemporal key. Element and relation IDs remain graph-wide model identifiers; the existing overlapping-ID clash check still rejects an invalid union before it is served. Cross-source relations can join endpoints in one statement.
- Every projected element and relation row carries a `source` discriminator, and the facade binds every query to its source set. `rebuild` replaces only those sources' rows and loads full bitemporal history, including closed rows needed for known-time queries. Each rebuild and incremental update is one transaction: on SQL failure it rolls back and leaves the prior projection visible. Updates are source-scoped and serialized; a source shared by several Graph facades remains one set of rows with a stable source-plus-row identity. Tests prove that rebuilding or updating one source cannot delete or alter another source's rows.
- The common engine uses one SQL executor contract. PGlite runs the shared query database at a product-local path and serializes each complete snapshot callback and every write on its single connection; one database-wide writer-preferential queue prevents later snapshots passing a queued write. The server adapter uses `pg` (node-postgres) without `pg-native` and runs the same parameterized SQL. Its snapshots use dedicated clients and read-only repeatable-read transactions; multiple snapshots may overlap, but the shared writer-preferential admission gate waits for active snapshots before a write and blocks later snapshots behind a queued writer, matching `.4.1`'s ordering contract. Rebuild/update transactions commit atomically or roll back. The runtime/server wiring is a later migration leaf; `.4.2` proves the engine through its injected database boundary.
- The shared gate and reentrancy guard belong to the database owner, not an individual Graph facade. Every snapshot reader is bound to one transaction/revision and source scope. Calling any facade backed by that owner from inside a snapshot callback rejects immediately; the callback uses its supplied reader, and the gate is released if the callback succeeds or throws. SQL values, including IDs, states, depths, and source sets, are bound parameters; `COLLATE "C"` retains code-point ordering.
- Domain query errors retain their structured result form. SQL, connection and lifecycle failures reject the async operation, as the `.4.1` port specifies.

The implementation check must prove that two Graph facades can share one PGlite query database while retaining source isolation, that a union Graph can traverse a cross-source contract relation, and that snapshots/writes from different facades share one serialization boundary. It must also keep the existing per-source HistoryStore tests unchanged.

## Review before implementation (self-review, 2026-10-15)

Three attempts to obtain an independent model review ended without a review report. Following the `to-design` review fallback, I checked the design against the confirmed outcome and the task scenarios before writing code.

- **Outcome and ownership:** the shared query projection enables one-query cross-source traversal and source-scoped graphs; `.3.1`'s per-source HistoryStore files and lifecycle remain outside this change. Production server/`Graphs` wiring remains a later task.
- **Snapshot and update behavior:** PGlite must hold its one connection exclusively for a complete snapshot callback or write. PostgreSQL may run repeatable-read snapshots concurrently on separate clients, but the database-wide writer-preferential gate must preserve `.4.1` ordering: active snapshots finish, queued writers run in order, and later snapshots cannot pass a queued writer.
- **Source isolation and failure:** every facade binds reads and writes to its source set; rebuild/update are atomic per transaction and roll back on SQL failure. Tests must show one source's rebuild/update leaves other sources intact, and failed operations leave the previous projection queryable.
- **Lifecycle:** closing a borrowed facade drains only that facade and leaves siblings usable; closing the owner refuses new work, drains active work and closes the shared connection once. Reentrant calls through any facade from inside a shared snapshot reject; the supplied reader remains usable only for the callback lifetime.
- **Evidence limit:** this self-review is not independent approval and cannot establish the `pg` driver's behavior against a live PostgreSQL server by inspection. The implementation must exercise the PostgreSQL adapter against a real PostgreSQL fixture, or record why that check cannot run; production caller wiring remains out of scope for `.4.2`.


## Post-implementation compatibility note (2026-10-15)

The focused differential suite now compares SQL answers with the retained Ladybug engine for bitemporal updates, state-chain selection, collapsed/context views, and cyclic dependency paths. It also pins a code-point tie case where the relation-ID order intentionally differs from intermediate-node order. The existing query-engine test names the code-point-least chain as the contract, but Ladybug's `SHORTEST` pattern can return one route before its JavaScript tie-fold sees another. The SQL CTE computes shortest-hop edges, then chooses the code-point-least relation-ID sequence; this completes the stated contract rather than treating the old adapter's first route as authoritative for that case. For `dependents`, result chains remain ordered from the dependent back to the queried start, matching the retained engine. `view` also retains the legacy refusal when raw `rebuild` input contains a displayed element id outside the model id pattern; SQL parameterization removes the injection need for that guard, but the structured refusal is part of the existing engine behavior.

The PostgreSQL adapter was also exercised against PostgreSQL 17 in a disposable Docker fixture. CI is configured to run the PostgreSQL integration test against a PostgreSQL 17 service, while the ordinary root test run keeps that integration test skipped unless `MADARCH_TEST_POSTGRES_URL` is set.
