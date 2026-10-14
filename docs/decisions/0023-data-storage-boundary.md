# 0023. The data storage boundary: four kinds of data, each with one home

Status: accepted; partly amended by 0024
Date: 2026-10-12

Amends 0009: the server's fact log starts on PostgreSQL directly, with SQLite
kept for the local mode. Refines 0017 (the product repository as the one
source, synchronisation by git), 0007 (the server as the target and its
ingest), 0011 (repository access by plain git, read-only) and 0022 (the
architecture's extension points); 0010's closed network holds; 0004's
sources and 0005's layers carry the imported facts' provenance, 0006's
deployment facts arrive among them, and 0003's normalized contract ids stay
the rendezvous point the facts name.

## Context and problem

madarch runs in two modes — a developer's laptop and the company's server
(0007) — and touches several stores: the product repository, the code
repositories it indexes, the bitemporal fact log, the query graph, a vector
index, full-text search, and later operational data. Decision 0017 fixed
where the product's authored content lives, 0009 fixed where the fact log
lives, and 0022 fixed the seams, but no record said which store is the truth
of each kind of data, which is only a copy or a derivative, and what may move
between the laptop and the server. Without that boundary, a server
implementation drifts toward making its database the truth of the product —
which 0017 refuses ("nothing madarch keeps is more authoritative than git") —
or toward shipping derived indexes around as if they were data.

## Considered options

1. **One store for everything.** PostgreSQL on the server holds authored
   content, facts and indexes; locally, SQLite. One engine, one backup, but
   the database becomes more authoritative than git against 0017, and a
   laptop or an outage separates people from their own content.
2. **Git for everything.** The server's indexes are committed somewhere too.
   Rejected outright: indexes are derived; committing or transferring them
   only forks them against their own truth.
3. **Four kinds of data, each with one home** (decided by the owner on
   2026-10-12): the truth of each kind is named once; everything else is a
   clone, a copy of fact data, or a rebuildable index that is never
   transferred.

## Decision

Option 3, decided by the owner on 2026-10-12. Four kinds of data, each with one home:

1. **Authored by people.** Markdown documents, the manifest, the model YAML,
   beads tasks, components, approval and signature records — the signatures
   stay in git (0022's e-signatures record a person, a role and a digest of
   the approved revision). Truth: the product's git repository. Locally: the
   product folder. On the server: a clone of the product repository. Authored
   data moves by git push and pull, and only this way; a wiki write (0017)
   commits into the product repository through the one write path.
2. **Code.** Truth: each repository's own git. Locally: the product's
   `repos/`. On the server: a read-only clone (0011), or none at all.
3. **Facts imported from systems** — the code index, GitOps and IaC, CMDB,
   broker, tracing — each fact with its evidence. Truth: the systems
   themselves; madarch keeps the bitemporal fact log (0009). The log is in
   **SQLite locally and in PostgreSQL on the server**, behind one storage
   interface. A runner in CI or on a developer machine uploads facts to the
   server API (0007's ingest, ready facts) when the server has no repository
   access; 0011's least-privilege consequence named uploading facts from CI
   as a mitigation — this record makes it the runner's only channel. Code
   itself never leaves its network.
4. **Derived indexes.** The query graph is LadybugDB in both modes: 0009
   measured PostgreSQL path queries as weak and chose LadybugDB as the
   rebuildable engine. The vector index is **sqlite-vec locally and pgvector
   on the server**, in the same PostgreSQL as the server's fact log;
   full-text search sits in the same layer. Truth: none. The indexes are
   rebuilt from kinds 1 and 3 wherever they are needed and are **never
   transferred** — not between the laptop and the server, not as files: the
   laptop and the server each build their own, possibly with different
   embedding models.
5. **Later, server-only operational data** — users, role membership,
   sessions — lives in PostgreSQL on the server. It is not authored content
   and never enters the product repository.

The embedding model runs inside the image (0010) or at an internal company
endpoint; no external API: the closed-network constraint (0010: no outbound
calls at runtime) holds for every kind of data.

Lifemodel's own vector memory (LanceDB) is agent memory, separate from all
five homes; Lifemodel searches the product through madarch's agent API
(0022), never through its indexes or files.

## Consequences

- 0009 is amended, not replaced: the log stays append-only behind a storage
  interface, closes a version and opens a new one, and replaces a source's
  assertions in one transaction — the amendment decides only the server's
  starting backend. 0009's own consequence line ("SQLite limits the server to
  one instance; a PostgreSQL adapter is the path to several") is decided:
  the server starts on PostgreSQL and is not capped at one instance by its
  log.
- The storage interface must keep the two backends alike: both time axes,
  the source, and the diff-in-one-transaction replacement of a source's
  assertions behave the same on SQLite and PostgreSQL; a query written once
  reads either.
- The server's fact log and its pgvector index sit in one PostgreSQL, on one
  volume (0010: all data lives on one volume).
- Authored data cannot be moved by any means other than git push and pull:
  a server that edits product content commits it into its clone and pushes;
  nothing exports the product repository into a database or back.
- Different embedding models per mode are allowed and expected, because the
  indexes are never transferred; a vector built on one side is never read on
  the other.
- The runner upload (0007) needs no repository credentials on the runner:
  the runner sees the code, sends facts, and the server never receives code
  from it — only facts and their evidence.

## Record of work

Nothing is implemented in this record. The implementation is filed as
deferred items under the standalone milestone (docs/milestones/standalone.md):

- **madarch-vrcv** — the fact-log storage interface with its two backends,
  SQLite for the local mode and PostgreSQL for the server.
- **madarch-ptke** — the vector index adapter: sqlite-vec locally, pgvector
  on the server, one adapter, the indexes never transferred.
- **madarch-a24w** — the runner that uploads facts to the server API when it
  has no repository access.
