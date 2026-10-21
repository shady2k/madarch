# 0028. madarch's knowledge is one temporal graph in PostgreSQL, and today's knowledge stores are retired

Status: accepted
Date: 2026-10-21

Builds on 0015 (architecture states as a chain), 0023 (git is the truth for what people write;
derived stores are rebuilt, never transferred) and 0024 (PostgreSQL everywhere: PGlite locally,
PostgreSQL on a server). Supersedes 0009's fact log and query projection as separate stores, and the
fact store under 0026 (`fill_fact`, `fill_fact_holding`, `fill_publication`). 0026's rule that agents
read and write only through the graph, never the repository, stands; this record says what the graph
is. 0027's publication guarantees stand and move onto the graph's version rows (Publication, below).

## Context and problem

On 2026-10-21 the owner called the self-filled wiki a failure and restarted the milestone step by
step. Two measured facts about the store came out of that review:

- A page took about ten seconds to open. Each scoped read rebuilt the set of the fill's ~350 000
  `fill_fact_holding` rows and probed `fill_fact` ~316 000 times; the reads' JSON predicates were
  not served by the one GIN index (`jsonb_path_ops` answers containment, not the field
  comparisons the reads made); statistics were never gathered; one PGlite connection served every
  request in turn.
- The store was 1.8 GB for one repository: 1.1 GB of write-ahead log and 682 MB of data, of which
  `fill_fact` was 302 MB (128 000 occurrence rows carrying ~350 bytes of provenance each) and
  `fill_fact_holding` 203 MB.

Knowledge was kept in three places with three shapes: 0009's assertion log (`assertions`,
`source_commits`, `source_registry`), its query projection (`query_elements`, `query_relations`,
`query_states`), and the fill's facts with their per-unit holdings. The first two carry valid time,
recorded time and architecture states, but only for the authored model; the fill's facts, which are
most of what a page shows, carry none of them, and a page joined all three.

The question: what is madarch's knowledge store, so that every element and relation of a product
reads as it is now, as it was at a date, and as it is planned to be, on any developer's machine?

## Decision drivers

- **The knowledge is a graph.** Owner: «Вся наша база – это, по сути, граф».
- **It is temporal on two axes: dates, and as-is against to-be.** Owner: «темпоральный граф… с
  какого по какого времени… как есть сейчас и то, как будет».
- **Dates, not commits, on the main line.** Owner: «Ну с какого коммита действовало наверное не
  очень интересно. Нужны даты. Ну и видимо только для master ветки?»
- **PostgreSQL, local for every developer.** Owner: «графовая должна быть база… перешли на
  Postgres… чтобы это работало локально у любого разработчика». 0024 stands.
- **Start again; nothing is migrated.** Owner: «Это надо уничтожить и начать заново». 0023 already
  makes every derived store rebuildable from git and the sources.
- **Speed is handled when it bites.** Owner: «С производительностью позже будем работать, когда
  столкнемся». No latency threshold is set here. 0009's measurements stay the reference a regression
  is judged against: a view over 10 000 elements in ~70 ms; transitive dependents over 30 000
  relations in ~60 ms.
- **The engine holds no product data.** Kinds and relation types come from the product's registry
  (0021, 0022).
- **One wiki, many readers.** The developer, architect, security, operations, tester and analyst
  viewpoints read the same graph. Future viewpoints' data is collected now: dependency manifests,
  contracts, DDL, build and deploy files, environment variables, history, test cases, and links from
  documents to code.

## Considered options

1. **Keep the three stores and index them better.** The fact log, the query projection and the fill
   facts stay; the holdings get indexes and the JSON fields get expression indexes. Rejected: three
   copies of one element still disagree; to-be exists for the authored model only, not for
   anything extracted; the owner rejected keeping them.
2. **One temporal graph in PostgreSQL tables (chosen).** Stable node identities, versioned nodes and
   versioned edges, each version carrying its valid dates, its recorded dates and its range of
   architecture states.
3. **A dedicated graph database.**
   - Apache AGE has a PGlite build (`@electric-sql/pglite-age`), not verified against the pinned
     PGlite. It adds Cypher, but its graph lives in AGE's own catalog, beside the relational tables
     that the vector index and the run state already use.
   - Neo4j and other servers add a process every developer must install and run, against 0024's
     single in-process database.
   - LadybugDB was retired by 0024.
   - None of them keeps two time axes natively, so the temporal model would be ours in any case.

   Rejected.
4. **No temporal store: answer a past date by replaying git on demand.** This rejects the
   assumption the others share. Rejected:
   - each historical read would re-extract the repository;
   - as-is against to-be is in git only as the authored model's text, and every read would parse
     it again;
   - claims, evidence and acceptance have no place in it.


## Decision

Option 2.

**Tables.**
- `node_identity`: a stable id per thing; it carries no knowledge.
- `edge_identity`: a stable id per relation, unique on its logical key (below).
- `node_version`: kind, label, properties and content.
- `edge_version`: relation type, its two ends, properties and an optional position.
- `node_kind` and `relation_type`: rebuildable integer encodings of vocabulary keys. An encoding is
  never reused. The vocabulary has two namespaces, as 0026 requires:
  - the deterministic extractors' own code-structure schema (file, directory, symbol, occurrence,
    import, call, inheritance, commit and the like), declared by the engine under its own prefix;
  - the product's kinds and relation types, read from the product registry.

  0026's explicit mappings between the two stay. The engine declares no product kind.

These are the graph tables. Beside them the store holds only:
- operational state, which is not knowledge: `work_item` (this record's proposal for the extraction
  queue) and whatever run tables the extraction rewrite keeps;
- the vector index (`vector_spaces`, `vector_items`), a derived index keyed by node identity;
- pg-boss's own tables, while the queue uses it.

Version rows have no separate tables for claims, occurrences, holdings, publications or snapshots.

**Edge identity.**
- A semantic edge's logical key is its relation type, its two end identities, and a discriminator.
  The registry or extractor schema declares the discriminator when parallel relations of one type
  are meaningful, for example two foreign keys between the same tables. Otherwise the
  discriminator is empty.
- A positioned occurrence's key is its type, the symbol, the content node it points into and its
  starting byte. Content nodes are immutable, so an occurrence edge never changes while its content
  stands. When a file links to new content, the old content's occurrences close and the new
  content's open.
- The key is hashed into `edge_identity`'s unique column. A refill that finds the same key and the
  same payload digest writes nothing.

**Time.**
- Every version carries:
  - `valid_from` and `valid_to`: when it held in the product, half-open;
  - `recorded_from` and `recorded_to`: when madarch knew it, half-open;
  - `states`: a range over the architecture-state chain of 0015.

  None may be null or empty.
- An `EXCLUDE USING gist` constraint, from `btree_gist`, which PGlite documents as shipped, refuses
  two versions of one identity that overlap on all three axes. Its loading in the pinned PGlite is
  the first thing the storage stage proves.
- A correction never edits a version. It closes the old version's `recorded_to` and inserts the
  versions now believed. So "what did we know on October 10" stays answerable, from the moment the
  store was created.
- Valid time is the committer time of the default branch's first-parent commits; pages read it as
  dates.
  - A merge commit makes its branch's changes valid at the merge's time.
  - A fast-forward has no merge commit: the branch's commits are on the first-parent line and are
    valid at their own times.
  - Effective time is strictly increasing along the first-parent line: a commit's effective time
    is its committer time, or its parent's effective time plus one microsecond when the committer
    time is not later. The raw time is kept as a property of the commit node.
  - Two commits therefore never share an instant, and the state at any instant is the latest
    commit at or before it.
  - The graph records the dates its history covers and does not extrapolate before them.
- Architecture states are nodes chained by `after`, as 0015 says, and are versioned like every
  other node. Each state carries a stable integer key, allocated with gaps; `states` ranges are over
  those keys.
  - A key is never renumbered.
  - A new transition state takes a key in a gap.
  - Within one version of the chain, key order is chain order, so a range of keys is a span of
    the chain.
  - Reordering existing states never reuses their keys. It creates new state nodes with new keys
    in the new order, and closes the old chain's recorded time.
  - The extraction re-expresses every current version's `states` over the new keys, closing and
    reopening versions like any correction.
  - A read at an earlier known time uses the chain and the ranges recorded then, so a past to-be
    reads as it was.
- To-be is a state, not a future date.

**Reads.**
- Every read takes `{valid, known, state}`, which keeps 0009's `asOf: {valid, known}` and adds
  the state. The defaults are now, now and as-is.
- The filter applies to every edge and to both end nodes on every hop.
- The write path refuses an edge whose ends do not exist for the whole of its valid time, known
  time and states. Reads can then trust an edge's ends without re-checking them.
- Current reads use partial indexes `WHERE recorded_to = 'infinity'`. Historical reads use a GiST
  index over the two time ranges and the states.
- Traversals are `WITH RECURSIVE`, as 0024 decided.
- Recurring analyses are computed at extraction, in the same transaction as the changes they
  derive from, and written as dated nodes and edges: module dependencies, cycles, hotspots and
  change coupling. They are never recomputed per page and never lag their inputs.

**Identity.** A node's id is not a hash of its path or name.
- A move or rename matched with confidence keeps the id and opens new versions of its name and
  place. Matching order:
  1. authored ids;
  2. unchanged files;
  3. git's rename detection;
  4. structural match.
- An ambiguous match is recorded as a proposed correspondence, never chosen silently.
- A split or a merge makes new identities linked to their predecessors.
- Matching is replayed in the same order on a rebuild, so a rebuild gives the same identities for
  the same history.

**Source and positions.**
- File content is stored as immutable content nodes: the bytes and their SHA-256 digest. A file
  links to its content over time. The core serves agents files from these nodes (0026).
- An occurrence is a positioned edge, as keyed above, with half-open byte offsets into the content.
  Every use site is kept.
- Semantic relations such as calls and imports are separate edges that aggregate the sites.

**Claims, evidence, questions, acceptance.** These are nodes and edges like the rest:
- a claim with its statement and origin;
- evidence spans on content nodes;
- support and contradiction edges;
- questions and answers.

A claim's revision digest is the SHA-256 of its canonical form:
- its statement and kind;
- its subjects' identities;
- its evidence spans, each as a content digest and offsets.

Field names and arrays are sorted by code point. Acceptance is what 0022 records: a person, a role
and the digest, authored in the product's git (0023). The graph holds the acceptance as read from
git. A claim version reads as accepted exactly when an acceptance names its digest. A changed
statement is a new claim version with a new digest and reads as proposed. The earlier version stays
accepted for the known times it held.

An agent's claim never becomes a deterministic relation. It stays visible as a proposed
interpretation.

**Publication.** 0027's guarantees are kept and move onto version rows.
- Every version carries its producer: the extraction recipe and the scope node it ran for.
- A unit's result is published in one transaction:
  - it checks the unit's lease token, so the result is fenced;
  - it checks the input digest of what the unit read, so its reads are revalidated;
  - it closes and opens only versions of its own producer and scope, so it replaces only what it
    owns;
  - it is visible to every read at once, or not at all.
- Each publication is identified by its producer, scope and generation. `work_item` records the
  generation it published in the same transaction.
  - A second publication of a generation already published is refused, whatever its content.
  - A producer that runs again on the same input publishes nothing.

  So publication is exactly once per unit generation, as 0027 requires.
- Ends and ownership: when a publication ends a node's valid time, the write path closes, in the
  same transaction, every edge of any producer that touches that node beyond its new end. Each
  closure is recorded as a cascade naming the publication that caused it. This is the one write a
  producer makes to versions it does not own, and it is what keeps endpoint integrity. When the
  edge's own producer runs again, it does not reopen the edge while the end is gone.

0027's tables for runs and units are run state, and the extraction rewrite decides which of them
remain. 0027's holdings and publications as knowledge tables are superseded by this record.

**What a rebuild keeps.** Destroying the store loses madarch's own recorded history: what it
believed before the rebuild, and when.
- A rebuilt graph says where its knowledge history starts, and reads before that answer "not
  recorded", never a guess.
- Valid-time history is not lost. It is replayed from git, back to the dates the replay covers.
- Authored knowledge is read again from the product's git: answers, decisions, acceptances and
  their signatures (0022, 0023).
- Agent claims live only in the graph, so a rebuild runs the agent stages again.
  - A re-derived claim with the same digest regains its acceptance from git.
  - A claim that comes out different is proposed until someone accepts it.

**Retired.** These tables are dropped, and nothing is migrated:
- `fill_fact`, `fill_fact_holding`, `fill_publication`;
- `assertions`, `source_commits`, `source_registry`;
- `query_elements`, `query_relations`, `query_states`.

A product's graph is rebuilt as above.

The run state stays until the extraction rewrite decides on it:
- 0027's run tables: `fill_run_configuration`, `fill_run_stage`, `fill_unit_plan`, `fill_event`,
  `fill_unit_read`, `fill_unit_draft`, `fill_unit_draft_part`, `fill_unit_split`;
- the state-store tables: `fill_chain`, `fill_run`, `fill_unit`, `fill_unit_generation`,
  `fill_unit_lease`, `fill_transition`;
- `fill_page_change`;
- pg-boss's `madarch_enqueue_stamp`.

## Constraints

Each is carried as a check by the stage that builds it.

- **graph-only.** A new store holds exactly the graph tables, the operational tables, the vector
  tables and pg-boss's tables named above, and no other table. Check: the schema test compares the
  store's table list with that list.
- **no-overlap.** Two versions of one node or edge identity that overlap on valid time, recorded
  time and state are refused by the database. Null and empty ranges are refused too. Check: insert
  tests expect each refusal.
- **append-only.** A version is never updated, except to close its `recorded_to`, and never
  deleted. Check: a sequence of corrections, renames and removals, with every row's other columns
  compared before and after each step.
- **known-then.** After a correction learned on day 2 about day 1, a read at known time day 1 gives
  the old belief and a read at day 2 gives the new one. Check: a test on a hand-verifiable graph.
- **every-hop.** A traversal at a date, known time and state never passes through an edge or a node
  outside them. Check: hand-verifiable graphs where the only path runs through an expired edge, an
  expired end node, a version recorded later, and an edge of another state, each returning nothing.
- **endpoint-integrity.** An edge whose end does not exist for the edge's whole valid time, known
  time and states is refused. Ending a node closes the other producers' edges that touch it, as
  recorded cascades. Check: an insert test, and a test where producer A removes a node that
  producer B's edge points to.
- **idempotent refill.** Refilling an unchanged repository writes no version. Check: on the training
  repository (madarch-9uop, 72 commits, 110 files), a second fill writes no row. Every table's
  version count and the digest of all its rows are unchanged.
- **rename-keeps-identity.** On the training repository, `services/orders/src/order.go` →
  `services/orders/internal/domain/order.go` (git R100) keeps one node id across the rename. Check:
  an extraction test on the generated repository.
- **dates-on-main.**
  - The feature branch `feature/checkout-observability` becomes valid at its merge's time.
  - The date-anomaly commit ("Pin the Go toolchain in the Dockerfiles") gets its parent's effective
    time plus one microsecond and keeps its raw time.
  - A read at the anomaly's instant sees the anomaly commit's state.

  Check: an extraction test on the training repository, with the dates from its answer key.
- **states-stable.** Inserting a transition state between as-is and to-be leaves every existing
  version's `states` unchanged, and a read of to-be at an earlier known time follows the earlier
  chain. Reordering two states gives new keys and leaves the earlier known time's reading unchanged.
  Check: tests on a hand-verifiable graph with the training repository's loyalty plan.
- **acceptance-bound.** An accepted claim whose statement then changes reads as proposed, and its
  earlier version still reads as accepted at the earlier known time. Check: a test.
- **content-immutable.** A content node's bytes and digest never change. An evidence span keeps
  resolving to the bytes it cited after the file changes. Check: a test.
- **agents-propose.** An agent-written claim never appears among the deterministic relations a page
  traverses. Check: a test writes a claimed call and reads the call graph.
- **fenced-publication.** A unit whose lease has passed to another worker publishes nothing. A
  second publication of one producer, scope and generation is refused. A unit publishes only
  versions of its own producer and scope, apart from the recorded cascade closures. Check: tests on concurrent writers,
  PGlite and server PostgreSQL both.
- **registry-kinds.** The engine declares no product kind or relation type; its own vocabulary is
  only the extractor schema's prefixed keys. Check: the existing engine-holds-no-data guard,
  extended to the graph's vocabulary.

## Consequences

- A product's existing store is discarded at upgrade and refilled. The PGlite files of a home are
  deleted by the upgrade, and a product's first open after it says so and says that the knowledge
  history starts then.
- The wiki's page reads, the query database and the history interfaces are rewritten over the graph.
  `src/history`, `src/adapters/pglite-history.ts` and `src/adapters/{pglite,postgres}-query-database.ts`
  lose their tables.
- Occurrences still cost space as edges. The saving is in the holdings and the duplicated
  provenance, not in the occurrences.
- Expected size and speed are not promised here. The storage acceptance fixture measures them with
  `EXPLAIN (ANALYZE, BUFFERS)` and `pg_total_relation_size`, and they are reported to the owner
  when he takes up performance.
- PGlite's one connection still serialises reads behind a write. The extraction writes in bounded
  transactions.
- Assumptions, each with what would invalidate it:
  - `btree_gist` loads in the pinned PGlite. If it does not, the exclusion moves to a write-path
    check serialised by an advisory lock, with the same tests.
  - First-parent committer dates are what the owner means by dates. If he names deployment dates
    instead, valid time gains a second basis per 0009.
  - Re-running the agent stages after a rebuild is affordable. If it is not, agent claims gain a
    durable export, a decision of its own.

## Next

1. The storage layer and its constraint checks on a hand-verifiable graph, with the old tables
   dropped.
2. The deterministic extraction rewritten to write the graph, run on the training repository.
3. Pages read the graph, and the owner reads the wiki of the training repository; his account is
   checked against the answer key (madarch-5zsd).

## Review

Reviewed before any code by a different model (Codex, read-only), in two rounds on 2026-10-21. The
first round found three blocking gaps: the rebuild boundary, 0027's publication guarantees, and
edge identity. It also found that tied dates, the history of the state chain, acceptance digests,
read defaults, the two vocabularies, the strength of the checks, the table inventory and the
Apache AGE claim were underspecified. The second round confirmed those resolved. It found that
publication per generation, reordering states, and endpoint integrity across producers were still
open; all three are answered above (Publication, Time, Constraints).

## Sources

- Codex's schema proposal, consulted read-only on 2026-10-21. Its tables, indexes, bitemporal
  correction rule, identity matching order and date-anomaly policy are taken here. Its latency
  figures are not; they were unmeasured.
- The measurement of the old store on 2026-10-21: row counts and sizes as above, read with
  `pg_total_relation_size` on a scratch copy of the store of madarch's own fill. The copy and the
  query plans were not kept as a reproducible artifact. The storage acceptance fixture is where
  size and speed are measured again, with the revision, the queries, their plans and the size per
  table and index recorded.
- PostgreSQL 18 exclusion constraints and `WITHOUT OVERLAPS`. `WITHOUT OVERLAPS` covers one range,
  and this record needs three, hence the exclusion.
- PGlite's extension list (`btree_gist`).
