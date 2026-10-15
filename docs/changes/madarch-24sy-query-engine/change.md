# Asynchronous PostgreSQL graph-query engine

Change: madarch-24sy-query-engine
Base: 1842af52
Tasks: madarch-24sy.4.1, madarch-24sy.4.2
Kind: no-behavior

## Intent
Establish the asynchronous query port and implement its shared SQL backend while preserving existing graph-query answers. `.4.1` adds the port and transition adapter; `.4.2` implements the source-scoped PGlite/PostgreSQL query database. Production callers stay on the synchronous path until later migration tasks.

## Out of scope
Migrating production callers, removing the synchronous port and LadybugDB dependency, moving server HistoryStore persistence to PostgreSQL, pgvector, removing native dependencies, and clean-install walks.

## Rationale
The SQL engine is built beside the existing production query path. Until callers migrate, no query result, domain error, rendered page, or HTTP response changes. One shared SQL query database with source-tagged rows supports cross-source traversal while preserving `.3.1`'s per-source HistoryStore layout.

## Preserved contracts
- graph-queries/children: the production query path stays unchanged until migration
- graph-queries/view: the production query path stays unchanged until migration
- graph-queries/dependencies: the production query path stays unchanged until migration
- graph-queries/as-of: the production query path stays unchanged until migration
- graph-queries/rebuild: the existing rebuild/update path remains in use until migration

## Coverage
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/dependencies: test
- graph-queries/as-of: test
- graph-queries/rebuild: test


## Acceptance evidence

- Added `AsyncQueryDatabase` as the shared SQL owner and source-scoped async facades. A borrowed facade drains only its own work; the owner drains all work and closes the connection once.
- Added one parameterized PostgreSQL schema and query implementation, with a file-backed PGlite driver for local data folders and a `pg` pool driver for server mode. PostgreSQL snapshots use read-only repeatable-read transactions; PGlite serializes complete snapshots and writes on its single connection. Rebuilds and incremental updates are transactional and source-scoped.
- Query behavior covers bitemporal and state-chain resolution, children, collapsed/context views, and recursive dependency paths with shortest-distance and code-point tie handling. `dependents` preserves the legacy dependent-to-start chain direction. Production callers remain unchanged for later migration tasks.
- Added a dedicated PostgreSQL 17 service and integration-test step to CI. The normal test run skips the PostgreSQL integration test unless `MADARCH_TEST_POSTGRES_URL` is set.
- `.3.1`'s per-source HistoryStore databases were not changed. No production server/Graph wiring or Ladybug/SQLite retirement is part of `.4.2`.

### Verification receipts

- `bun run check`: exit 0.
- `bun test test/async-query-engine.test.ts`: exit 0, 5 pass.
- `bun test test/sql-query-database.test.ts`: exit 0, 3 pass; includes source-scoped update and file-backed close/reopen persistence.
- `bun test test/sql-query-engine-conformance.test.ts`: exit 0, 7 pass; compares temporal updates, state chains, view semantics, invalid ids, and cyclic traversal with the retained engine, with a separate SQL tie-break regression.
- `bun test test/postgres-query-database.test.ts` with `MADARCH_TEST_POSTGRES_URL` set to a disposable PostgreSQL 17 fixture: exit 0, 1 pass; includes rollback, snapshot/write ordering, owner close, and cleanup.
- `git diff --check`: exit 0.
- Feature document gate (`node .shady2k/documents.mjs check --phase feature --change madarch-24sy-query-engine`): exit 0.
- Independent implementation review found no engine defects. It identified test-fixture cleanup and paused-snapshot failure cleanup gaps; both were fixed and reviewed; final delta review found no new issues.
