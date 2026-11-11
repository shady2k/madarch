# The database as it is (2026-11-11, after stage 3 of madarch-64o5.2)

Status: as-is description of a filled product's PostgreSQL cluster, read from `pg_catalog` and
`count(*)` of a fill of madarch's own repository (1 909 files, 2 532 commits). Every product has
one such cluster, database `madarch`, under
`<madarch home>/.madarch/knowledge/<product id>/graph`; the design is decision 0034 and this
document records what the store holds now. Repository URLs are neutral examples.

The engine's DDL (`src/graph/one-graph.ts`) holds only the **mechanism** tables — the graph's own
identity, its journal and its records of what a publication could not resolve. Every kind's table
is generated from the product's contract (decision 0034, items 2, 3, 13 and 14): its name is
generated from the kind and a digest (`k_file_…`, `d_path_…`, `e_touched_…`), never the kind's
display name, and its columns, natural key and indexes come from the contract. A product that
declares no code kind has none of these tables; a tracker-only product opens, fills and serves
with the mechanism tables alone.

## Overview

| Area | Tables | What writes it |
|---|---:|---|
| The graph's mechanism (`public`, the engine's DDL) | 6 | every publication |
| Tables generated from the product's contracts | 15 here | the git capability's contract, through the one writer |
| The fill's own tables (decision 0027) | 17 | the run, its stages and units |
| The agent's spend (`agent_usage`, its schema) | 1 | every metered model call of a plugin's agent part |
| The job queue (`pgboss`) | 14 | the fill's queue |
| Store metadata (`madarch_meta`) | 1 | the store's open |

## The graph's mechanism

| Table | Rows here | What it holds |
|---|---:|---|
| `entity` | 13 | a kind the contract declares: its name, whether it sorts vertices or edges, and a repeating edge kind's discriminator rule |
| `node` | 6 271 | a vertex's identity only: its entity, a local id, a stable `uid`, its natural key (`key`), its context and whether it is removed |
| `edge` | 38 511 | one edge: its entity, its two ends, the discriminator a repeating kind needs, and its context |
| `context` | 1 | a layer over the base context; the base is the row with no parent and every read is of context 1 |
| `operation` | 27 | the journal: one row a publication, with its author (`producer@version`, `agent`, `person:<uid>`), its words, its durable order (`seq`) and the change it made — the vertices, edges and opinions it declared, removed, opened, closed or re-evidenced, with the values and evidence a replay needs |
| `unresolved_reference` | 0 | a reference a publication named and no vertex held: the referrer, the field, the target entity and key, the producer and the context — read by the consistency plugin (madarch-stm0.7) and deleted when the reference resolves |

The journal is the history (decision 0034, A6): `node`, `edge` and the opinion tables hold the
present, and every change is a row of `operation`. An opinion's row carries its own evidence, its
language, the opinion it was translated from, its source's digest and the moment it was said; a
field's value is never authoritative — every value is one producer's opinion, and a disagreement is
read as the list of values with each value's opinion beside it.

## Tables generated from the product's contracts

The names below are generated from the kind and its sort; the kind's display name stands apart.
`k_` is a vertex, `d_` a dictionary and `e_` an edge's own table. The natural key stands once on
the vertex (`node.key`); every other field value is an opinion in the table, one row per producer,
version, language and context. The git capability's contract supplies these tables because the
manifest binds `capability: git`; a manifest that binds no code kind gets none.

| Table | Kind | Rows here | Natural key |
|---|---|---:|---|
| `k_repository_7edaa2e7` | repository | 2 | `name` |
| `k_directory_3827c86d` | directory | 864 | `(repository, path)` |
| `k_file_3d6caaab` | file | 6 661 | `(repository, path)` |
| `k_gitlink_85ee1099` | gitlink | 0 | `(repository, path)` |
| `k_commit_5beb4971` | commit | 2 554 | `hash` |
| `k_signature_f06259ed` | signature | 15 | `(name, email)` |
| `d_path_fed16136` | path | 0 | `text` |
| `d_blob_c9a5c40e` | blob | 1 842 | `hash` |
| `d_language_9f027895` | language | 0 | `name` |
| `e_history_56998345` | history (edge) | 5 108 | the edge's `edge_id` |
| `e_parent_ae611ebe` | parent (edge) | 6 122 | the edge's `edge_id` |
| `e_touched_ca9234b8` | touched (edge) | 27 461 | the edge's `edge_id` |
| `e_authored_6a1502b8` | authored (edge) | 2 554 | the edge's `edge_id` |
| `e_contains_81e7830c` | contains (edge) | 2 776 | the edge's `edge_id` |
| `e_as_is_6edec57a` | as-is (edge) | 1 | the edge's `edge_id` |
| `e_renamed_from_65b54afa` | renamed-from (edge) | 104 | the edge's `edge_id` |

Every edge kind has a table, attribute-free kinds included: it is where that edge's evidence and
existence opinion live. A file's programming language is the ordinary field `language` (with the
candidate list in `languages`), never the opinion's `lang`, which is the natural language of a text
value; the tree pass's lines, bytes and form come from the `blob` dictionary a file's opinion names.
A shallow clone is the history pass's own opinion of its repository (`history_shallow`), so it needs
no table of its own. The store has no table named `repository`, `file`, `commit`, `signature`,
`touched`, `path` or `blob`; those are the contract's display names, not the store's.

## The fill's own tables (decision 0027)

The run, its stages and units, their leases, drafts and publications, the event log and the
publication's end. Every run-scoped row names its run, and every unit row its unit and generation,
by a foreign key; the constraints are deferred and cascade with their parent. They are the fill's
working record, not product data: what a page states of a repository is read from the graph.

| Table | Rows here | What it holds |
|---|---:|---|
| `fill_run` | 1 | one run of one product: its state, its context, its creation and update moments |
| `fill_run_configuration` | 1 | the settings a run judged with |
| `fill_run_stage` | 2 | one stage of a run |
| `fill_chain` | 1 | the order the run's stages stand in |
| `fill_unit` | 2 | one unit of one stage |
| `fill_unit_generation` | 2 | a unit's current generation, and the one that was superseded |
| `fill_unit_lease` | 2 | the lease that holds a unit's generation |
| `fill_unit_plan` | 2 | the units a stage planned |
| `fill_unit_read` | 0 | what a unit read, so a rerun's membership is known |
| `fill_unit_draft` | 2 | a unit's draft of the rows it publishes |
| `fill_unit_draft_part` | 0 | a large draft's parts |
| `fill_unit_split` | 0 | a unit the run split |
| `fill_publication` | 2 | one publication: the snapshot a reader opens and when it stood |
| `fill_event` | 21 | the run's progress events, in order |
| `fill_transition` | 19 | a unit's state changes |
| `fill_control` | 0 | a person's pause or stop of a run another process owns |
| `fill_end` | 0 | the answer a finished run states to the process that pressed it |

## The agent's spend (`agent_usage`)

What the model calls of a plugin's agent part cost (madarch-stm0.4, decision 0035, item 22): one row per fill run,
plugin run (unit), kind, field and model, holding the tokens in and out and the cost the agent itself reported, the
number of prompt turns, whether it reported anything at all, and the bound that ended the run when one did. The meter
counts each cumulative report once (`src/fill/agent-meter.ts`), so a row is a sum of what the agent said, never a
guess. The table is a schema of its own (`agent-usage` in `madarch_meta.schema_stamp`), beside the run's tables and
never in the graph's: the graph's revision does not move for it, and the kind's page reads it through the server
(`/api/kind-usage`).

| Table | Rows here | What it holds |
|---|---:|---|
| `agent_usage` | 0 | one plugin run's spend in one kind, field and model: tokens in, out and total, the cost and its currency, the turns, `reported`, and the bound it stopped at (`tokens` or `cost`), with the run and its time |

## The job queue (`pgboss`)

The fill's queue is pg-boss's own schema: `queue`, `job`, `job_common`, `job_dependency`,
`schedule`, `subscription`, `version`, `warning`, `instance`, `bam`, `queue_stats` and its
per-day partitions, and `madarch_enqueue_stamp` (the enqueue high-water mark the fill keeps so a
second press does not enqueue the same unit twice). Nothing of the product reads it.

## Store metadata (`madarch_meta`)

| Table | Rows here | What it holds |
|---|---:|---|
| `schema_stamp` | 5 | the digest of the DDL and contract the store was made with (`one-graph`), the revision of its rows' meaning (`one-graph-revision`), the mark that says a reset left it needing a fill (`graph-reset`), and the record tables' own stamp |

A store whose stamp and revision stand is opened with one statement and no catalog walk; one whose
revision differs is reset as a whole — the journal is kept — and asks for a fill.

## What this store no longer holds, and where those facts are

| Removed | Where the fact is now |
|---|---|
| `kind` | `entity`: one table of names and sort rules, the row every node and edge names |
| `claim`, `evidence` | the opinion tables: every value is an opinion with its evidence in the same row |
| `layer_entry` | a branch context is `context_id` on the rows plus `removed`, which an opinion row already carries |
| `gap` | a problem, not a row of the graph: an unreadable file is stated by its own opinion (the tree pass files it with no blob), a non-UTF-8 path and a shallow clone by the run that met them (its log and trace); a shallow clone is also the history pass's own opinion of its repository |
| `knowledge_fill` | the graph's own repository entity and its `as-is` edge, with the counts of its rows |
| `node_identity`, `node_version`, `edge_identity`, `edge_version`, `node_kind`, `relation_type`, `publication_scope`, `work_item` (decision 0028) | the one graph; the temporal tables are gone |
| `fill_fact`, `fill_fact_holding` | the one graph's opinion tables |

## The mechanism tables of the stages after this one

The store gains no other surface as the fill grows. Three changes add mechanism tables of their
own, each a working record and never product data: `file_entry` and the `path`/`blob` tables
(madarch-hsqs stage C) for the files a fill reads, `fill_selection` (madarch-stm0.6.1) for the
selection a run asked for, and `plugin_state`/`plugin_problem` (madarch-8bdc.2.22) for a plugin's
own state and what it reports. None of them is in this tree yet.
