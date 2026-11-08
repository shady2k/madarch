# 0024. PostgreSQL everywhere: a server madarch installs, on the laptop and on the server

Status: accepted, amended 2026-11-07
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

## Amendment, 2026-11-07: PGlite is retired, the laptop runs a real server

The owner's decision, binding: «To hell with this PGlite, nothing but problems
from it.» The local mode runs **PostgreSQL, the same engine as the server**, in
a server madarch installs for itself; there is no in-process database and no
fallback to one. The owner's two conditions on the delivery: «The delivery need
not carry it, it can be downloaded at install.» and «Pin the version and the
hash, always.»

What that decided in the code:

- **One owner.** `createDatabaseOwner` opens a database on a server: the
  store's own cluster (`<store>/pgdata`, its Unix socket in `<store>/pgsock`,
  listening on no TCP address), a server a caller names by socket folder, or a
  private cluster in the temporary folder that is removed with the owner. The
  `MADARCH_DATABASE` setting, its choice of two engines and the second owner are
  gone; `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` leave the
  manifest and the lockfile.
- **The install** (`src/adapters/postgres-builds.ts`,
  `src/adapters/postgres-install.ts`): the official 18.6.1 build of
  theseus-rs/postgresql-binaries, pinned by version and by the sha256 of each
  platform's archive (linux-x64, linux-arm64, darwin-x64, darwin-arm64), into
  `<madarch home>/tools/postgresql/18.6.1/`. The archive is verified before it
  is unpacked, a cut-short download continues where it stopped, and a folder
  without the `install.json` marker the installer writes last is never taken for
  an install. Measured here, on this box's link: the aarch64 archive (38.0 MB)
  downloaded in 273 s, unpacked to 130 MB, and the first store opened 14 ms
  after it; a later run reads the marker in 2 ms.
- **A store of the old kind is not migrated.** A store folder holding the
  in-process database's files (`graph/`, `state.db/`) and no `pgdata/` is
  refused, and the message says the fill must run again.
- **The test run and a product's server** hold one cluster and open a database
  per case, per source history or per snapshot on it, so a case pays for a
  database rather than a server boot.

### Measured, one fill of `/work/madarch` at `972a6cd1` (39 621 106 bytes, 2 126
files, 791 folders, 2 177 commits)

| | in-process PGlite, new store | PostgreSQL server, new store |
|---|---|---|
| wall clock | 5.22 s | 4.51 s |
| peak RSS of the process (`/usr/bin/time -v`) | 1 153 632 kB | 217 840 kB |
| peak PSS, process + server, sampled every 20 ms | 1 127 136 kB + 0 | 144 147 kB + 12 284 kB |
| tree pass | 356 ms | 265 ms |
| history pass | 2 452 ms | 2 340 ms |
| files / folders / commits, against git | 2 126 / 791 / 2 177 | 2 126 / 791 / 2 177 |
| store folder | 63 MB | 65 MB (64 MB `pgdata`) |

Opening an existing store: PGlite 181-184 ms, PostgreSQL 118 ms, to the first
row 213 ms and 125 ms. A store that does not exist yet: 860 ms against 374 ms.
(The full tables, with the command lines, are in
`/work/out/report-nopglite.md`.)

### What this amendment does not settle: pgvector

The pinned build carries PostgreSQL's own contrib extensions (btree_gist among
them) and **no pgvector**: the 18.6.1 release publishes 24 platform archives and
no extension archive, none of the four platforms' file manifests names a
`vector` file, and the installed build answers `CREATE EXTENSION vector` with
`extension "vector" is not available`. The query projection (`sql-vector-index.ts`,
`sql-query-database.ts`) creates the extension and requires 0.8.7, so it cannot
open on a store's server and refuses by name. What carries vector search today
is a server a caller names by connection string (CI's `pgvector/pgvector:0.8.7-pg17`
service). Deciding where pgvector comes from for the installed build — a pinned
extension archive if one is ever published for all four platforms, or a build of
ours — is open, and 0025 is amended to say so.

## Consequences

- One storage engine and one query dialect locally and on the server; a query
  written once runs in both modes, which 0023 asked of its two backends.
- `npx madarch` needs no native addon for its store: the Windows, OpenSSL and
  binary-size problems of the graph engine leave with LadybugDB.
- Agents lose Cypher as their ad-hoc query language and write SQL instead;
  SQL/PGQ can return a graph syntax once PostgreSQL supports variable-length
  paths.
- ~~PGlite is single-connection: the local server serialises its queries, which
  one person's laptop accepts.~~ Amended 2026-11-07: one server serves the
  laptop, and its pool overlaps snapshots and writes; the owner no longer
  serialises (measured: a fill's `db.SELECT` time fell from 165 ms to 65 ms and
  its `db.INSERT` from 440 ms to 281 ms).
- ~~PGlite's own maturity and speed are now ours to watch.~~ Amended
  2026-11-07: the engine is PostgreSQL 18.6.1 itself, in every mode. What is
  ours to watch is the pinned build's downloads and its missing pgvector (see
  above).
