# PostgreSQL fact log on PGlite

Change: madarch-24sy
Base: 1842af52
Tasks: madarch-24sy.2.1
Kind: no-behavior

## Intent
Implement decision 0024's prefactor: migrate HistoryStore and its callers to an asynchronous persistence boundary while retaining the existing SQLite implementation. Preserve all result and error behavior so the next leaf can use PGlite's asynchronous API without changing the public contract again.

## Out of scope
PostgreSQL server wiring, graph query replacement, pgvector, removing LadybugDB or SQLite from other product paths, installation workflows, and performance tuning.

## Rationale
The history contract is already specified by model-history and its existing tests. This leaf changes no behavior or storage engine: it makes the existing boundary awaitable before PGlite is introduced in madarch-24sy.3.1.

## Preserved contracts
- model-history/store-version: test
- model-history/replace: test
- model-history/idempotent: test
- model-history/order-by-commit: test
- model-history/sources: test
- model-history/lossless: test

## Coverage
- model-history/store-version: test
- model-history/replace: test
- model-history/idempotent: test
- model-history/order-by-commit: test
- model-history/sources: test
- model-history/lossless: test
