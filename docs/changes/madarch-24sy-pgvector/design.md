# Caller-supplied pgvector index

Status: proposed
Date: 2026-10-15

## Outcome frame
Owners and engineers need a rebuildable vector index in both madarch modes. The index stores and searches vectors supplied by its caller; this leaf does not choose a model or make an embedding call. Correctness and rebuildability matter more than approximate-search speed. Local and server indexes remain separate and are never transferred.

## Drivers

- **Functional:** Decision 0024 selects pgvector for local PGlite and server PostgreSQL. The existing deferred task `madarch-ptke` calls for one interface, rebuildable answers and no index transfer.
- **Owner scope:** On 2026-10-15 the owner chose A: callers supply vectors; model/provider work stays separate in deferred task `madarch-24sy.6`. Decision 0023 still limits a future provider to the image or an internal endpoint, with no external runtime API.
- **Portability and consistency:** Equivalent inputs must return the same ranked matches on PGlite and PostgreSQL 17; equal distances need a stable code-point tie order.
- **Persistence:** Closing and reopening file-backed PGlite must preserve the index; a transactional rebuild must replace only the selected sources and reproduce search results.
- **Failure visibility:** A server without pgvector installed must fail clearly during database initialization, rather than silently disable vector search.
- **Security:** The vector adapter must not make network calls or store source text; it sees only vectors and caller identifiers.
- **Performance:** Decision 0024 says not to prototype performance first. Start with exact nearest-neighbor queries; do not add approximate-index tuning without measurements.

## Inventory

- `AsyncQueryDatabase` owns one SQL driver and source-scoped graph facades. `SqlQueryDriver` already owns read/write transactions; the operation gate serializes writes and protects PGlite's single connection.
- `createPGliteQueryDatabase` creates PGlite without extensions; `createPostgresQueryDatabase` creates the server pool. `createSqlQueryDatabase` initializes the shared SQL schema.
- The SQL query database currently exposes only graph-query facades. There is no vector type, schema, index or search API.
- Official PGlite package `@electric-sql/pglite-pgvector` 0.0.11 registers the `vector` extension at startup; its bundled `vector.control` sets `default_version = '0.8.7'`. It is paired with PGlite 0.5.10. Each database then runs `CREATE EXTENSION IF NOT EXISTS vector` and checks `extversion = '0.8.7'`.
- PostgreSQL 17 needs server-side pgvector files. The official `pgvector/pgvector:0.8.7-pg17` image tag supplies the matching extension; the standard `postgres:17` image does not. CI and integration tests use that version-pinned fixture and assert `extversion = '0.8.7'`. Primary-source evidence: [PGlite pgvector 0.0.11 tarball](https://registry.npmjs.org/@electric-sql/pglite-pgvector/-/pglite-pgvector-0.0.11.tgz) (`vector.control`, `default_version = '0.8.7'`) and the [official PostgreSQL 17 image tag](https://hub.docker.com/r/pgvector/pgvector/tags?name=0.8.7-pg17).
- Decisions 0023 and 0024 require derived indexes to stay local to each mode and to be rebuilt, not transferred. No user-facing semantic-search endpoint exists.

## Options

1. **Facade (GoF) on the shared SQL owner, using the existing Unit of Work/transaction boundary (PoEAA; chosen).** Add an internal `AsyncVectorIndex` facade alongside graph scopes, backed by the same driver, operation gate, schema and lifecycle. This follows the existing source-scoped facade pattern while keeping graph queries and vector operations as separate interfaces.
2. **Separate Repository/owner and connection (PoEAA).** Give vectors their own PGlite file or PostgreSQL pool. This rejects the shared-resource assumption, but duplicates connections and lifecycle and conflicts with the decision that the server fact log and pgvector live in one PostgreSQL database.
3. **Expand the graph query port.** Put vector methods directly on `AsyncQueryEngine`. This uses one API surface, but mixes graph traversal with nearest-neighbor retrieval and makes the graph engine's query contract carry unrelated vector lifecycle and vector-space rules.
4. **Heterogeneous Adapter implementations.** Keep sqlite-vec locally and pgvector on the server. Rejected by decision 0024, which selects pgvector in both modes.

## Decision
Use option 1. The shared SQL database owner exposes a separate source-scoped vector-index facade. It uses the existing transaction driver, owner gate and snapshot reentrancy guard. A vector operation attempted inside a graph `withSnapshot` callback rejects rather than opening a nested transaction. Facade close drains its own operations; owner close drains vector and graph operations and closes the shared resource once. The vector schema is initialized with the graph schema after `CREATE EXTENSION IF NOT EXISTS vector`. PGlite registers the extension before database startup; PostgreSQL 17 must have the server-side extension files installed. Both backends verify the pinned `extversion`; initialization fails visibly and closes the driver if registration, activation or version validation fails.

The vector facade is an in-process adapter API on the shared database owner; it adds no user-facing search endpoint or UI. It stores caller-supplied vectors under `(source, space, itemId)`; that composite key is unique. A search is restricted to the facade's source set and one space, and returns `{source, itemId, distance}` so matches remain identifiable when the facade spans sources. Results sort by distance, then source and item id in code-point order. A `vector_spaces(space, dimensions)` table records a database-wide space name and its immutable dimension; `vectors(source, space, item_id, embedding)` uses the unique key `(source, space, item_id)`. Dimensions range from 1 through 2,000, and every stored or query vector has finite components representable as pgvector float32 values, matching the registered dimension; inputs normalize to float32 before binding. A dimension change uses a new space name. Support only L2 distance, cosine distance (`1 - cosine similarity`), and negative inner product; all rank in ascending order. Rebuild rejects zero vectors so cosine searches cannot encounter undefined distances. `rebuild(sources, records)` requires `sources` to be a subset of the facade scope and explicitly replaces every selected source, including selected sources with no records, in one transaction; every record must belong to both the facade scope and selected set, and duplicate `(source, space, itemId)` keys are rejected. The adapter binds vector values as parameters and accepts no text or provider choice.

## Consequences

- One PGlite database or PostgreSQL pool owns both graph projections and vectors; a second database and connection are avoided.
- Source-scoped vector facades can read and write only their assigned sources, matching the graph facade boundary. NUL-containing identifiers are refused because PostgreSQL text values cannot contain zero bytes.
- The caller names a vector space so vectors from incompatible models are not compared. Different modes may use different spaces and models because their indexes are never transferred.
- Exact search is simpler and deterministic but may cost more as the index grows. Performance and approximate indexing can be revisited only with measurements.
- Startup now requires the pgvector extension in server PostgreSQL. The extension must be preinstalled or the app role must be able to create it; a missing extension or insufficient permission is a visible setup error.
- Model selection, embedding generation, provider configuration/authentication and its protocol remain outside this leaf in `madarch-24sy.6`.

## Scenarios and checks

- With the same pinned pgvector extension version, caller-supplied records and query on file-backed PGlite and PostgreSQL 17 return the same ordered `(source, itemId)` matches for each supported metric. Distances compare within `1e-6 * max(1, abs(referenceDistance))` to allow small float32 rounding differences across the WASM and native builds; ordered match identities and exact-tie order must still agree. Exact ties use code-point `(source, itemId)` order.
- A facade scoped to source A cannot retrieve or delete source B's vectors. A multi-source search returns `source` with each item, including when item ids repeat across sources; a rebuild for A leaves B unchanged.
- `rebuild(sources, records)` replaces exactly the selected sources. Selected sources with no records are cleared, unselected sources remain unchanged, duplicate keys are rejected, and any failure rolls back the whole replacement.
- After file-backed PGlite closes and reopens, the same query returns the same ordered matches and distances within the stated tolerance. Rebuilding from the same inputs reproduces those results.
- Non-finite or out-of-float32-range values, NUL-containing identifiers, empty vectors, dimensions above 2,000, mismatched dimensions, zero stored vectors, zero query vectors for cosine, non-positive or non-safe-integer limits, and duplicate keys are rejected with a clear error; any write-side rejection leaves the prior index unchanged.
- PGlite without the vector extension registered and PostgreSQL 17 without server-side pgvector both fail database creation, close resources, and report the cause; initialization checks the installed extension version against the pinned version.
- Calls made from inside a graph `withSnapshot` callback reject with the existing reentrancy error. Closing one vector facade drains only its work; owner close drains all graph and vector work and closes the shared driver once.
- The vector adapter accepts no text and makes no provider or runtime network call; vector values and identifiers use bound SQL parameters.

## Review

Three independent alternate-model design-review sessions were attempted; all ended without a report. Per the `to-design` fallback, the design review is a self-review, not independent approval. I checked caller-supplied scope, PGlite/PostgreSQL parity, rebuild atomicity, source isolation, extension setup and failure, persistence, lifecycle/reentrancy, and offline security against the existing SQL owner and driver. That review found and resolved underspecified match identity, float32 normalization, vector-space dimensions and metrics, extension-version parity, and the local-extension failure scenario. The package tarball and PostgreSQL image tag identify pgvector 0.8.7. Implementation checks now pass: `bun run check`; 13 focused PGlite/SQL tests across `test/sql-vector-index.test.ts`, `test/sql-query-database.test.ts` and `test/sql-query-engine-conformance.test.ts`; and 2 PostgreSQL 17 tests in `test/postgres-query-database.test.ts`, including the live `extversion = '0.8.7'` assertion and rollback check. The feature-document gate is clean. An independent read-only implementation review by GPT-6 Luna reported no findings after reviewing the complete working-tree diff, including input/float32 handling, vector operators and ordering, SQL binding, scope and transaction behavior, rollback, extension setup/version, lifecycle/reentrancy, CI and dependency changes. This does not turn the earlier design self-review into independent design approval.
