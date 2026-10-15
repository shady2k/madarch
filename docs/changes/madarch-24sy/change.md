# PostgreSQL fact log on PGlite

Change: madarch-24sy
Base: 1842af52
Tasks: madarch-24sy.2.1, madarch-24sy.3.1
Kind: no-behavior

## Intent
Implement decision 0024's local persistence path: migrate HistoryStore and its callers to an asynchronous boundary, then use file-backed PGlite in local state outside the product repository. Preserve every model-history result and error behavior across the storage-engine change.

## Out of scope
PostgreSQL server wiring, graph query replacement, pgvector, removing LadybugDB from other product paths, installation workflows, and performance tuning.

## Rationale
The history contract is already specified by model-history and its existing tests. Both leaves preserve that contract: the first makes the boundary awaitable, and the second moves local fact-log persistence to file-backed PGlite. The graph and all model-history results remain unchanged.

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
