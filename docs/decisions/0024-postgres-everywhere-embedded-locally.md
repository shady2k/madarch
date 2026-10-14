# 0024. PostgreSQL everywhere: embedded PGlite on the laptop, PostgreSQL on the server

Status: accepted
Date: 2026-10-15

Amends 0009 (LadybugDB as the query engine, SQLite as the fact log's store)
and 0023 (SQLite and sqlite-vec in the local mode, LadybugDB as the derived
query graph in both modes). 0023's four kinds of data and their homes hold;
only the stores behind kinds 3 and 4 change.

## Context and problem

madarch is installed by `npx` on a clean machine (madarch-lfhu.2), and its
graph engine is the part that keeps that from working. LadybugDB 0.20.4's
Windows x64 addon does not load under Bun 1.4.2: "DLL initialization routine
failed", while Node loads the same bytes (hosted run 38636092758, identical
SHA-256). It also needs the system's OpenSSL 3, which made the compiled binary
89 MB and failed `madarch new` on a clean Linux without `libssl.so.3`. Beyond
installation it rests on one main maintainer, leaks its buffer pool unless every
result is closed, and refuses parameters inside list lambdas and recursive
filters. The local mode also runs two stores (SQLite and LadybugDB) and two
vector indexes (sqlite-vec locally, pgvector on the server) against 0023.

## Considered options

- **Keep LadybugDB, run the Windows build on Node.** Fixes Windows only; keeps
  every other cost and two builds.
- **PostgreSQL with Apache AGE.** Cypher on PostgreSQL; 0009 found its path
  queries immature, and it needs a server.
- **SQL/PGQ in PostgreSQL 19.** Standard graph patterns, but no
  variable-length paths or shortest path yet; traversals still need
  `WITH RECURSIVE`, and it needs a server.
- **SQLite in Bun with `WITH RECURSIVE`.** Built into Bun on every platform,
  but the server stays PostgreSQL: two SQL dialects behind one interface.
- **embedded-postgres.** A real PostgreSQL per operating system run as a child
  process: full PostgreSQL, but tens of megabytes per platform and a server
  process with a port to manage — heavy for `npx`.
- **PGlite.** PostgreSQL compiled to WebAssembly, run inside madarch's own
  process under Bun or Node: no server, no port, no native addon, about 3 MB,
  pgvector as an extension package, one connection.

## Decision

PostgreSQL everywhere. The laptop runs **PGlite** in-process; the server runs
**PostgreSQL**. One dialect serves all three of what 0009 and 0023 split
across stores:

- the **bitemporal fact log** (0009's source of truth for facts), behind the
  same storage interface, with the same two time axes and the same
  replace-a-source-in-one-transaction behaviour;
- the **graph queries**: traversals, collapsing to a level, transitive
  dependents with the time filter on every hop, written as `WITH RECURSIVE`
  over the log's current tables. The owner: «with recursive нам вполне
  достаточно»;
- the **vector index**: pgvector in both modes, replacing sqlite-vec. The
  owner: «pgvector очень пригодится».

LadybugDB and the local SQLite store are retired. The query graph was derived
and rebuildable (0009's consequence), so nothing is migrated: a product's
store is rebuilt from the product repository and the fact log's sources.

Performance is not prototyped first, by the owner's decision: «Я думаю со
скоростью проблем не будет, у нас не будет огромных графов, я бы пока не
беспокоился о производительности, если что потом доработаемся». The
measurements of 0009 (a view over 10 000 elements in about 70 ms; transitive
dependents over 30 000 relations in about 60 ms) stay as the reference a
regression is judged against.

The owner's words that started it: «А есть же embedded postgre»; «Ну вот
насчет встроенного pg идея хорошая».

## Consequences

- One storage engine and one query dialect locally and on the server; a query
  written once runs in both modes, which 0023 asked of its two backends.
- `npx madarch` needs no native addon for its store: the Windows, OpenSSL and
  binary-size problems of the graph engine leave with LadybugDB.
- Agents lose Cypher as their ad-hoc query language and write SQL instead;
  SQL/PGQ can return a graph syntax once PostgreSQL supports variable-length
  paths.
- PGlite is single-connection: the local server serialises its queries, which
  one person's laptop accepts. The server's several instances (0023) stay on
  PostgreSQL.
- PGlite's own maturity and speed are now ours to watch. Revisit if a view or
  a traversal at a product's real scale is noticeably slower than 0009's
  reference, or if PGlite stops being maintained.
