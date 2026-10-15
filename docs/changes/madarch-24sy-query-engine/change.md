# Asynchronous graph-query port

Change: madarch-24sy-query-engine
Base: 1842af52
Tasks: madarch-24sy.4.1
Kind: no-behavior

## Intent
Add an asynchronous query-engine port and snapshot contract beside the existing synchronous implementation. Keep all callers and answers unchanged in this expand step; the follow-on tasks migrate callers and replace the query engine.

## Out of scope
Migrating production callers, replacing LadybugDB with recursive PostgreSQL queries, server PostgreSQL configuration, pgvector, removing native dependencies, and clean-install walks.

## Rationale
This is an additive type and compatibility adapter only. Existing production callers remain on `QueryEngine`, so no query result, error, rendered page, or HTTP response changes in this task.

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
