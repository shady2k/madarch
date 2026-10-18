# One database owner per process for the fact log and the query projection

Change: madarch-tzte-19-1
Base: 82d5edbb
Tasks: madarch-tzte.19.1
Kind: no-behavior

## Intent
Decision 0027 places the fact log, the query database, the queue and the
orchestrator's tables in one database owned by the process. Today
`src/adapters/pglite-history.ts` and `src/adapters/pglite-query-database.ts`
each open their own PGlite, and the PostgreSQL query adapter opens its own
pool, so no caller can write the fact log and the projection in one
transaction — which is exactly what a unit's publication needs.

This change introduces the owner (`src/adapters/database-owner.ts`): one
PGlite, in-process, or one `pg` pool, opened once and lent to both adapters,
and it makes every operation of both adapters accept an outer transaction of
that owner. Nothing a reader of a history or a query can observe changes:
the same answers, the same errors, the same stored rows, and every existing
test passes unchanged. Wiring the server's data folder to one owner across
sources is not part of this change (see Out of scope).

## Out of scope
Wiring production callers onto a shared owner: the server keeps one history
database per source and its own query database per data folder, as
`madarch-24sy.4.4` requires for the PostgreSQL move in flight. Also left
alone: the queue tables and the orchestrator's tables (their own tasks),
the vector index's operations (they stay on the engine's own admission
gate), and the pieces of a unit's publication beyond what one transaction
can now carry.

## Rationale
Kind `no-behavior` because the change decides who opens a database and how
one transaction spans two adapters, not what either adapter stores or
answers: the requirement deltas are none, and the capabilities below are
preserved as they stand. Each adapter keeps a factory that opens its own
database when no owner is lent, so existing callers and tests are untouched.

## Preserved contracts
- model-history/store-version: the same models store the same rows, and a store still creates tables, refuses a clash and reports its opened and closed rows as before.
- model-history/replace: a new version still replaces what its source asserted, now sometimes inside a transaction the caller opened.
- model-history/idempotent: storing the same commit twice still changes nothing, inside an outer transaction too.
- model-history/order-by-commit: the commit order and the bitemporal rows are unchanged by the ownership move.
- model-history/sources: the union read, its discrepancies and its errors are unchanged.
- model-history/lossless: a source-filtered read still returns byte for byte what that source stored.
- graph-queries/as-of: both time axes and the default state answer as before.
- graph-queries/children: an element's children are unchanged, read through an outer transaction or the engine's own snapshot.
- graph-queries/view: a view, its context and its collapsed relations are unchanged.
- graph-queries/dependencies: transitive dependents and dependencies are unchanged.
- graph-queries/rebuild: rebuild and update still replace and extend the projection, now also inside an outer transaction.

## Coverage
- model-history/store-version: test
- model-history/replace: test
- model-history/idempotent: test
- model-history/order-by-commit: test
- model-history/sources: test
- model-history/lossless: test
- graph-queries/as-of: test
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/dependencies: test
- graph-queries/rebuild: test

## Design and decisions
Decided by decision 0027, "Storage ownership"; this change implements it for
the two adapters that exist.

- `src/adapters/database-owner.ts` holds `DatabaseOwner` — `location`,
  `ready`, `allowConcurrentSnapshots`, `transaction(kind, work)`,
  `run(work)` and `close()` — and its two factories,
  `createPGliteDatabaseOwner` and `createPostgresDatabaseOwner`. A PGlite
  owner serializes every transaction and bare run on its one connection; a
  PostgreSQL owner gives each transaction its own pooled client (a read-only
  repeatable-read one for a snapshot) and may overlap them.
- `createPGliteHistory` and `createPGliteQueryDatabase` take a lent `owner`;
  `createPostgresQueryDatabase` takes one too. Without one, each opens and
  owns a database exactly as before, so no existing caller changes.
- Each history operation and the query engine's `withSnapshot`, `rebuild`
  and `update` take an optional `OuterTransaction` (the history's own type;
  a PGlite transaction and a `pg` client both answer it). Given one, the
  operation makes its statements inside it, neither commits nor rolls it
  back, and neither the owner's queue nor the engine's gate is entered —
  entering either while the caller's transaction holds it would deadlock.
- A lent owner is never closed by the adapter that borrowed it; the caller
  that opened it closes it. A history given a truncated legacy database
  still refuses it, naming the database.
- A transaction whose work swallowed a failed statement is refused before its
  commit. PostgreSQL (PGlite's engine included) answers `COMMIT` of an aborted
  transaction with a rollback and no error, so work that caught its own failed
  statement and then resolved would be reported as kept while every row of it
  was thrown away — the silent loss decision 0027's publication cannot afford.
  For a write transaction the owner probes the transaction with one statement
  and throws, naming the owner's database and the database's own message; the
  path that reaches it is any work in the caller's transaction whose failed
  statement was caught and not rethrown. A snapshot transaction is not probed:
  it commits nothing, so nothing can be lost there — and PGlite's snapshot is
  declared `READ ONLY` as PostgreSQL's `BEGIN … READ ONLY` already is, so a
  write inside one fails loudly instead of landing in a transaction this owner
  never probes. `test/database-owner.test.ts` holds the probe.
- A failure of the history inside the caller's transaction is thrown to the
  caller, never reported as an error result: nothing here rolls back a
  transaction the caller owns, so a report the caller could then commit would
  leave the rows already written beside a store that said it failed. A
  refusal (a clash, decided before the first write) still comes back as an
  error result, since it leaves nothing behind.
- The owner refuses a call made from inside its own transaction, naming itself
  and the way out: on PGlite's one connection such a call would wait on the
  transaction that waits on it, and on a pool it would take another client and
  commit outside the caller's transaction. `run`, `transaction` and `close`
  answer that refusal; an adapter operation called without a transaction while
  one is open is the mistake it catches. The refusal stands before the owner's
  own "already closing" shortcut, so a close issued from inside a transaction
  never waits on that transaction.
- The query database refuses a lent PGlite owner opened without `vector: true`,
  naming the owner and the option: the projection creates the pgvector
  extension, and without the refusal the failure would arrive later, inside
  `CREATE EXTENSION`, with the engine's own message and no owner named.
- The owner's `transaction(kind, work)` is the whole database surface the
  fill's state store declares (`FillStateDatabase`, madarch-tzte.19.4), so
  `createFillStateSchema(owner)` and the store's steps run on the same owner
  as the history and the query database, with no adapter between them; a test
  creates its six tables beside the history's. Switching the store onto a
  lent owner is madarch-tzte.19.5's, not this change's.
- The test `test/database-owner.test.ts` proves the two adapters share one
  database: their tables answer from one connection, a history store and its
  projection rebuild in one transaction are readable inside it and present
  after it commits, and a rolled-back transaction leaves neither the history
  nor the projection holding its writes. `test/postgres-query-database.test.ts`
  proves the query adapter on a lent PostgreSQL owner — a write and a read in
  one transaction, and neither after a rollback — where a server is configured.
  The PostgreSQL owner's history leg and its re-entrancy refusal are read by
  the type check but not run in this environment, which has no PostgreSQL
  server: this change's PostgreSQL evidence is that test where a server is
  configured, and nothing more.

## Blocking questions
None.

## DONE WHEN
- One owner (PGlite locally, a PostgreSQL pool on the server) is created once and lent to the history store and the query database; every operation of both accepts an outer transaction.
- The existing history and query tests pass unchanged, and one test proves both adapters see each other's writes in one transaction and none after a rollback.
