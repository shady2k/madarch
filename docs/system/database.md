# The database as it is (2026-11-09, after decision 0034)

Status: as-is description of a filled product's PostgreSQL 18.6.1 cluster, read from
`pg_catalog` and `count(*)` of the walk store (`madarch new`, `madarch repo add`,
`madarch fill` over madarch's own repository at `0d45283b`). Every product has one such
cluster, database `madarch`, under `<madarch home>/.madarch/knowledge/<product id>/graph`.
The design is decision 0034; this document records what the database holds now. Person names
and emails are redacted, and the repository URLs are neutral examples.

The engine's DDL (`src/graph/one-graph.ts`) holds only the **mechanism** tables. Every kind's
table is generated from the product's contract (decision 0034, items 2, 3, 13 and 14): its
name is generated from the kind and a digest (`k_file_…`, `d_path_…`, `e_touched_…`), never
the kind's display name, and its columns, natural key and indexes come from the contract. A
product that declares no code kind has none of these tables; a tracker-only product opens,
fills and serves with the mechanism tables alone.

## Overview

| Area | Tables | Rows | State |
|---|---:|---:|---|
| [Mechanism (the engine's DDL)](#mechanism) | 9 | 51,392 | written by every fill |
| [Tables generated from the walk product's contracts](#generated) | 12 | 43,217 | built from the manifest's kinds and the git capability's contract |
| [The fill orchestrator (decision 0027)](#orchestrator) | 18 | 102 | written by the fill; foreign keys on `(unit_id, generation)` and `run_id` |
| [The job queue (pg-boss, schema pgboss)](#queue) | 14 | 16 | written by the fill |
| [Schema bookkeeping (schema madarch_meta)](#meta) | 1 | 3 | written at start |

The walk repository has 1 853 files; the generated file table holds 2802 rows
because the product's own repository is filled beside it. The catalogue's `code.file` count is
the filled repository's 1 853.

## The defects the redesign removed

1. **Two graphs.** The fill writes the one graph; the wiki's catalogue, entity pages and
   blocks read the same tables. The temporal tables of decision 0028 are gone.
2. **A vertex repeats its own attribute.** `node` holds its id, its kind and a stable `uid`;
   a file's path, a commit's hash, a signature's email and a repository's name stand once in
   their generated table.
3. **A relation stored twice.** Belonging to a repository is a `contains` edge; `node` has no
   repository column.
4. **An edge that is not an edge.** A commit's change to a file is an edge with its own
   attribute table; a rename is a `renamed-from` edge; a blob is a dictionary with no vertex.
5. **The old fact store survives.** `fill_fact` and `fill_fact_holding` are gone with their
   readers and writers.
6. **No integrity in the orchestrator.** The `fill_*` tables reference each other by foreign
   keys on `(unit_id, generation)` and `run_id`.
7. **Clusters outlive their servers.** The store's server is stopped with its owner.

<a id="mechanism"></a>

## Mechanism

These tables are the engine's own: identity, edges, claims, evidence, layers, the journal and
coverage gaps. No product kind name stands in their DDL.

| Table | Rows | What it holds |
|---|---:|---|
| `kind` | 13 | a declared kind, whether it is a vertex or an edge, and its repeat rule |
| `node` | 6,167 | a vertex's identity: its kind, a local id and a UUIDv5 `uid` over kind and natural key |
| `edge` | 36,927 | one edge: kind, from, to, and the discriminator of a repeating kind |
| `claim` | 1,897 | one attribute of a node, with its producer and version |
| `evidence` | 6,387 | the vertex, edge or claim a claim is grounded in |
| `context` | 1 | a layer over the base context |
| `layer_entry` | 0 | what a layer replaces or removes |
| `operation` | 0 | a person's or the agent's journal entry |
| `gap` | 0 | a known absence the fill states |

<a id="generated"></a>

## Tables generated from the walk product's contracts

The names below are generated from the kind and its sort; the kind's display name stands
apart. `k_` is a vertex, `d_` a dictionary and `e_` an attributed edge. The natural key stands
once on the vertex (`node.key`); every other field value is an opinion in the table, and no
field is authoritative — a manifest no longer states a field's `role`. The git capability's
contract supplies these tables because the manifest binds `capability: git`; a manifest that
binds no code kind gets none.

| Table | Kind | Rows | Natural key |
|---|---|---:|---|
| `k_repository_7edaa2e7` | repository | 2 | `name` |
| `k_directory_3827c86d` | directory | 858 | `(repository_node, path_id)` |
| `k_file_3d6caaab` | file | 2,802 | `(repository_node, path_id)` |
| `k_gitlink_85ee1099` | gitlink | 0 | `(repository_node, path_id)` |
| `k_commit_5beb4971` | commit | 2,491 | `hash` |
| `k_signature_f06259ed` | signature | 14 | `(name, email)` |
| `d_path_fed16136` | path | 3,654 | `text` |
| `d_blob_c9a5c40e` | blob | 1,819 | `hash` |
| `d_language_9f027895` | language | 0 | `name` |
| `e_history_56998345` | history (edge) | 2,491 | the edge's `edge_id` |
| `e_parent_ae611ebe` | parent (edge) | 2,980 | the edge's `edge_id` |
| `e_touched_ca9234b8` | touched (edge) | 26,106 | the edge's `edge_id` |

The edge kinds `contains`, `as-is`, `authored` and `renamed-from` hold no attribute table;
they are rows of the mechanism `edge` table. `touched`, `parent` and `history` add the fields
their edges carry. The walk store has no table named `repository`, `file`, `commit`,
`signature`, `touched`, `path` or `blob`; those display names are the contract's, not the
store's.

<a id="orchestrator"></a>

## The fill orchestrator (decision 0027)

The run, its stages and units, their leases, drafts and publications, and the event log.
Every run-scoped row names its run, and every unit row its unit and generation, by a foreign
key; the constraints are deferred and cascade with their parent.


### `fill_chain` — 1 rows

| Column | Type | Null |
|---|---|---|
| `product` | text |  |
| `state` | text |  |
| `context` | jsonb |  |
| `updated_at` | bigint |  |

Constraints:

- `PRIMARY KEY (product)`


### `fill_run` — 1 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `product` | text |  |
| `state` | text |  |
| `context` | jsonb |  |
| `created_at` | bigint |  |
| `updated_at` | bigint |  |

Constraints:

- `PRIMARY KEY (run_id)`

Sample rows:

| run_id | product | state |
|---|---|---|
| fill-20261109T000000000Z | madarch-demo | succeeded |


### `fill_run_configuration` — 1 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `digest` | text |  |
| `snapshot` | jsonb |  |
| `recorded_at` | bigint |  |

Constraints:

- `PRIMARY KEY (run_id)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_run_stage` — 2 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `stage_id` | text |  |
| `planned_at` | bigint |  |
| `units` | integer |  |
| `publications` | integer |  |

Constraints:

- `PRIMARY KEY (run_id, stage_id)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_unit` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `product` | text |  |
| `stage_id` | text |  |
| `scope_key` | text |  |
| `generation` | integer |  |
| `created_at` | bigint |  |

Constraints:

- `PRIMARY KEY (unit_id)`
- `UNIQUE (product, stage_id, scope_key)`

Sample rows:

| unit_id | product | stage_id | scope_key | generation |
|---|---|---|---|---:|
| repository:madarch-demo | madarch-demo | repository-tree | madarch-demo | 1 |


### `fill_unit_generation` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `run_id` | text |  |
| `state` | text |  |
| `inputs_digest` | text |  |
| `fence` | integer |  |
| `context` | jsonb |  |
| `published_at` | bigint | yes |
| `stale_at` | bigint | yes |
| `updated_at` | bigint |  |

Constraints:

- `PRIMARY KEY (unit_id, generation)`
- `FOREIGN KEY (unit_id) REFERENCES fill_unit(unit_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_unit_lease` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `attempt` | integer |  |
| `fence` | integer |  |
| `holder` | text |  |
| `issued_at` | bigint |  |
| `expires_at` | bigint |  |
| `revoked_at` | bigint | yes |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation, attempt)`


### `fill_unit_plan` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `run_id` | text |  |
| `stage_id` | text |  |
| `stage_unit_id` | text |  |
| `scope` | text |  |
| `stage_position` | integer |  |
| `plan_position` | integer |  |
| `planned_at` | bigint |  |
| `cache_versions` | jsonb | yes |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_unit_read` — 0 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `query_digest` | text |  |
| `query` | text |  |
| `membership` | text |  |
| `members` | integer |  |
| `read_seq` | integer |  |
| `at` | bigint |  |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation, query_digest)`


### `fill_unit_draft` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `digest` | text |  |
| `writes` | jsonb |  |
| `recorded_at` | bigint |  |
| `retracted_at` | bigint | yes |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation)`


### `fill_unit_draft_part` — 0 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `part` | integer |  |
| `writes` | jsonb |  |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation, part)`


### `fill_unit_split` — 0 rows

| Column | Type | Null |
|---|---|---|
| `parent_unit_id` | text |  |
| `parent_generation` | integer |  |
| `child_unit_id` | text |  |
| `child_generation` | integer |  |
| `sealed_at` | bigint |  |

Constraints:

- `FOREIGN KEY (child_unit_id, child_generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `FOREIGN KEY (parent_unit_id, parent_generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (parent_unit_id, parent_generation, child_unit_id)`


### `fill_publication` — 4 rows

| Column | Type | Null |
|---|---|---|
| `unit_id` | text |  |
| `generation` | integer |  |
| `digest` | text |  |
| `facts` | integer |  |
| `published_at` | bigint |  |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (unit_id, generation)`


### `fill_event` — 37 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `seq` | integer |  |
| `at` | bigint |  |
| `stage` | text |  |
| `unit_id` | text |  |
| `generation` | integer | yes |
| `kind` | text |  |
| `summary` | text |  |

Constraints:

- `FOREIGN KEY (unit_id, generation) REFERENCES fill_unit_generation(unit_id, generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`
- `PRIMARY KEY (run_id, seq)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_transition` — 33 rows

| Column | Type | Null |
|---|---|---|
| `seq` | bigint |  |
| `subject_kind` | text |  |
| `subject_id` | text |  |
| `generation` | integer | yes |
| `transition_id` | text |  |
| `from_state` | text |  |
| `to_state` | text |  |
| `event` | text |  |
| `fence` | integer | yes |
| `at` | bigint |  |

Constraints:

- `PRIMARY KEY (seq)`


### `fill_control` — 0 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `action` | text |  |
| `at` | bigint |  |

Constraints:

- `PRIMARY KEY (run_id)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `fill_end` — 1 rows

| Column | Type | Null |
|---|---|---|
| `run_id` | text |  |
| `state` | text |  |
| `message` | text | yes |
| `unread` | jsonb | yes |
| `finished_at` | timestamp with time zone |  |

Constraints:

- `PRIMARY KEY (run_id)`
- `FOREIGN KEY (run_id) REFERENCES fill_run(run_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID`


### `knowledge_fill` — 2 rows

| Column | Type | Null |
|---|---|---|
| `repo` | text |  |
| `scope` | text | yes |
| `head` | text |  |
| `commit_hash` | text |  |
| `effective_time` | text |  |
| `commits` | integer |  |
| `filled_commits` | integer |  |

Constraints:

- `PRIMARY KEY (repo)`


<a id="queue"></a>

## The job queue (pg-boss, schema pgboss)

A library's own schema; madarch adds one table to it.

| Table | Rows |
|---|---:|
| `bam` | 0 |
| `instance` | 4 |
| `job` | 4 |
| `job_common` | 4 |
| `job_dependency` | 0 |
| `madarch_enqueue_stamp` | 1 |
| `queue` | 2 |
| `queue_stats` | 0 |
| `queue_stats_20261109` | 0 |
| `queue_stats_20261110` | 0 |
| `schedule` | 0 |
| `subscription` | 0 |
| `version` | 1 |
| `warning` | 0 |

<a id="meta"></a>

## Schema bookkeeping (schema madarch_meta)

One stamp per module that created its tables.

### `schema_stamp` — 3 rows

| Column | Type | Null |
|---|---|---|
| `name` | text | |
| `stamp` | text | |
| `created_at` | timestamp with time zone | |

Constraints:

- `PRIMARY KEY (name)`

The stamps are `fill-state`, `one-graph` and `orchestrator` (the queue's own schema keeps its `version` table).
