# 0025. The vector index shares the PostgreSQL owner and accepts caller-supplied vectors

Status: proposed
Date: 2026-10-15

## Context and problem

Decision 0024 selects pgvector for both local PGlite and server PostgreSQL, but no vector-index adapter exists. The existing SQL query database already owns the one database connection/pool and applies source-scoped transactions. The owner confirmed that this leaf indexes and searches vectors supplied by callers; no model or provider is chosen.

## Decision drivers

- Keep each mode's derived index in its own database; never transfer vectors between laptop and server (0023/0024).
- Use pgvector in both PGlite and PostgreSQL (0024).
- Preserve source isolation and the shared owner's transaction/close lifecycle.
- Do not make external runtime calls; embedding provider selection is deferred.
- Prefer exact, deterministic results over unmeasured approximate-search performance.

## Considered options

1. **GoF Facade plus PoEAA Unit of Work.** A source-scoped vector facade on the shared SQL owner, using the existing transaction driver and operation gate.
2. **PoEAA Repository with separate owner.** A separate vector database/connection beside the graph database, rejecting the shared-resource assumption; rejected because it duplicates connections and conflicts with 0023/0024's one PostgreSQL owner.
3. **Expand the graph query port.** Put vector methods directly on the graph query-engine interface; rejected because it couples graph traversal to an unrelated search and lifecycle contract.
4. **Heterogeneous Adapter implementations.** Use sqlite-vec locally and pgvector on the server; rejected because decision 0024 selects pgvector in both modes.

## Decision

Use option 1. The database owner exposes a distinct source-scoped vector-index facade next to graph-query facades. It uses the same PGlite instance or PostgreSQL pool, schema, transaction gate and lifecycle. The facade is an in-process adapter API on the shared database owner; no user-facing search endpoint is added. Records have the unique identity `(source, space, itemId)`. A database-wide space name binds one immutable dimension from 1 through 2,000; vectors contain finite float32-representable numbers of that dimension. The first API supports exact L2 distance, cosine distance (`1 - cosine similarity`) and negative inner product, all ordered ascending. Cosine search requires nonzero vectors. Search returns `{source, itemId, distance}` and ties sort by code-point `(source, itemId)`. `rebuild(sources, records)` requires the selected sources to be within the facade scope and atomically replaces exactly those sources, including clearing a selected source with no records; duplicate record identities are rejected. The vector adapter receives no text and makes no embedding-provider call.

The owner’s 2026-10-15 scope decision is recorded on `madarch-ptke`. Model/provider work remains in separate deferred task `madarch-24sy.6`; decision 0023 continues to require an in-image model or internal endpoint and no external runtime API.

## Consequences

- There is one database resource and one owner lifecycle; vector writes share transaction serialization with graph writes.
- Source scope prevents a vector facade from crossing source boundaries; the caller-defined vector space prevents comparing incompatible vectors.
- Each deployment mode rebuilds its own index. No vector data is shipped or transferred.
- Exact search is easy to compare across backends but may be slower at scale. Approximate indexes are deferred until measured need exists.
- A PGlite database without the registered vector extension, or a PostgreSQL database without server-side pgvector or permission to create it, fails at initialization with an explicit setup error; startup closes any resources it opened.
- Pin `@electric-sql/pglite@0.5.10` with `@electric-sql/pglite-pgvector@0.0.11` (bundled pgvector 0.8.7) and PostgreSQL 17 integration to `pgvector/pgvector:0.8.7-pg17`; integration tests assert `extversion = '0.8.7'` on both before comparing results.
- No text chunking, model choice, provider protocol or user-facing semantic-search route is introduced.
