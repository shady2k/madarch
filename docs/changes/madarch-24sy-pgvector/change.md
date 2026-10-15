# Caller-supplied pgvector index

Change: madarch-24sy-pgvector
Base: abdd5ef262ddbfd7e69b1537b9a268689a12e47e
Tasks: madarch-ptke
Kind: no-behavior

## Intent
Add `AsyncQueryDatabase.vectorIndexForSources`, a shared asynchronous facade that stores and searches caller-supplied vectors with pgvector in local PGlite and server PostgreSQL. The facade is programmatic only; this change adds no semantic-search endpoint, UI, model, provider or runtime network call. The owner’s 2026-10-15 decision A is recorded on `madarch-ptke`: this leaf does not generate embeddings or call a provider. Provider/model selection stays in separate deferred task `madarch-24sy.6`.

## Out of scope
Embedding generation or provider protocol, text chunking, full-text search, semantic-search HTTP/UI, approximate-index tuning, production caller migration, Ladybug/SQLite removal and clean-install walks.

## Rationale
Decision 0024 chooses pgvector in both modes. Reusing the existing shared SQL database owner keeps each vector index in its mode’s own PGlite/PostgreSQL database and avoids a second store or connection. The adapter accepts caller vectors only, so this change makes no runtime network call.

## Preserved contracts
- graph-queries/children: adding a vector facade does not change graph query answers.
- graph-queries/view: adding a vector facade does not change graph query answers.
- graph-queries/dependencies: adding a vector facade does not change graph query answers.
- graph-queries/as-of: vector operations do not alter graph temporal queries.
- graph-queries/rebuild: vector rebuild is source-scoped and does not replace graph projection rows.

## Coverage
- graph-queries/children: test.
- graph-queries/view: test.
- graph-queries/dependencies: test.
- graph-queries/as-of: test.
- graph-queries/rebuild: test.
