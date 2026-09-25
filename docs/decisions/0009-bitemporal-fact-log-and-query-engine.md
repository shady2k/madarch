# 0009. A bitemporal fact log in SQLite; LadybugDB as a rebuildable query engine

Status: accepted
Date: 2026-09-24

## Context and problem
The graph needs history on two axes (when something was true, when we knew it),
multi-hop queries with a time filter on every hop, an ad-hoc query language for
agents, cheap what-if overlays, a redistributable licence, and TypeScript on Bun.

## Considered options
Researched against primary sources on 2026-09-23:
- XTDB v2: the only native bitemporal store, but no recursive queries; JVM.
- TerminusDB: branches suit what-if; recorded time only.
- CozoDB: dormant since 2024; segfaults under Bun.
- Raphtory: valid time only; GPL; no durable storage in the open build.
- Neo4j Community: filtered paths in Cypher; GPL, no Bun support in its driver.
- Memgraph, FalkorDB: BSL and SSPL licences.
- PostgreSQL + Apache AGE: good licence and operations; immature path queries.
- DuckDB + duckpgq: a research extension.
- LadybugDB (the maintained continuation of Kùzu): embedded, MIT, Cypher; a
  per-hop bitemporal filter over 1–6 hops returned correct results under Bun.
- Our own traversal over SQLite (graphology): no query language.

## Decision
Two parts with different roles:
1. **The fact log is the server's source of truth.** Append-only; every
   assertion has `valid_from`, `valid_to`, `recorded_from`, `recorded_to`
   and its source; SQLite behind a storage interface. Nothing is updated in
   place: a change closes a version and opens a new one; replacing a source is a
   diff against its current assertions applied in one transaction.
2. **LadybugDB is the query engine**, built from the log and updated after each
   ingest: Cypher with the time filter on every hop serves paths, impact and
   agents' ad-hoc questions; a what-if runs as a rolled-back transaction or a
   source filter.

Both time axes are part of every interface from the start: queries take
`asOf: { valid, known }`. Each fact states the basis of its valid time
(commit time, deployment time, observation window).

Amended 2026-09-24 by the revised MVP charter (madarch-tid): in the first
milestone the log holds the intended model's versions read from git (valid
time: the commit's time; recorded time: when it was read); extracted facts join
it in `live-graph`. LadybugDB is part of the first milestone: it answers the
views' traversals (collapsing relations to the visible level, drilling in,
transitive dependencies), so the open question of its speed under Bun is
answered early.

Measured 2026-09-24 (graph-foundation, LadybugDB 0.20.4 under Bun 1.4.2, a
developer's laptop): a view over 10 000 elements with history in about 70 ms;
transitive dependents over 10 000 elements and 30 000 relations in about
60 ms, filtered by time on every hop. Memory, rechecked 2026-09-25: it is set
by LadybugDB's execution threads (one per core by default, each holding path
results) and by a statement prepared for every distinct query time, not by the
time filter; both are ours to bound (madarch-ti6.2), and whether the server
also needs a restartable engine process waits on that (madarch-ti6.1).

## Consequences
- Two stores must stay in step; the query engine is derived and can be rebuilt
  from the log at any time.
- LadybugDB depends mostly on one maintainer; replacing it (Neo4j, AGE, an
  in-memory engine) needs no data migration.
- SQLite limits the server to one instance; a PostgreSQL adapter is the path to
  several.
- Revisit if the query engine is abandoned, or if as-of traversals at 10^5
  elements with history are too slow (measured 2026-09-24: well under a second; see the amendment above).
