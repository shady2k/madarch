# One graph

Capability: one-graph

## Purpose

One graph for the code, the wiki and the fill (decision 0034): identity is a node, every kind's
attributes stand in a table generated from its contract, edges stand apart, claims carry their
producers, layers stand over a parent, and one journal records what people and the agent do.
The fill's tree and history passes write it, and every wiki and MCP reader reads it.

## Requirement: schema — A vertex is identity; a kind's table comes from its contract

A vertex shall be a `node` with its kind and a stable `uid` (UUIDv5 of the kind and natural key,
random when the kind has no key); no attribute of a kind shall repeat in `node`. Each declared
vertex kind shall have a generated attribute table whose name is generated from the kind and a
digest, never the display name, with its contract fields and a unique natural key. An edge kind
shall have an edge row with its ends and discriminator; an attributed edge kind shall have its
own generated table. A claim shall name its node, attribute, producer, version and value, and
an evidence row shall name exactly one vertex, edge or claim.

### Scenario: generated-table
- Given: a manifest kind `file` with contract fields `repository_node` and `path_id` and key `[repository_node, path_id]`
- When: the store's schema is created
- Then: a table named from the kind and a digest stands, with those columns, a unique key on them and a `context_id` and `tombstone`, and no table named `file`

### Scenario: identity
- Given: the same kind and natural key on two machines
- When: each fills its store
- Then: the two nodes carry the same `uid`, and a keyless kind gets a random uuid

### Scenario: evidence-one-thing
- Given: an evidence row naming a node and an edge
- When: it is written
- Then: the database refuses it, naming the evidence check

## Requirement: fill — The tree and history passes write the one graph

The tree and history passes shall write the declared generated tables, dictionaries and edges:
a file's plain fields are authoritative columns with one evidence row; its language is a claim
whose ambiguous answer is its candidates; a deleted path keeps its vertex and its history; a
second run at one commit writes nothing; a touched edge carries change, added and removed.

### Scenario: second-run
- Given: a repository filled at one commit
- When: the same fill runs again at that commit
- Then: it writes nothing and the counts stand

### Scenario: deleted-path
- Given: a file in the tree
- When: a later commit deletes it
- Then: its vertex and history stand, and it no longer has a current-tree `contains` edge

### Scenario: language-claim
- Given: a file whose extension is ambiguous
- When: the language dataset answers candidates
- Then: the language is a claim holding the candidates, never the word `ambiguous` as a value

## Requirement: deletions — The replaced surfaces are gone

The change shall delete 0028's temporal tables and every line over them, the old fact store and
its readers, writers and stages; no replaced surface shall remain beside the one graph.

### Scenario: deleted-names
- Given: the repository after the change
- When: it is searched for the temporal and old-fact-store names
- Then: only decisions and change records name them

## Requirement: wiki — The catalogue and entity pages read the one graph

The wiki's catalogue shall count every declared kind from the graph and the Markdown pages; the
repository, directory, file, commit and signature entity pages and their blocks shall read the
generated tables; `/k/file` shall open the file's entity page; a block whose facts are absent
shall render nothing.

### Scenario: catalogue-counts
- Given: a filled walk product
- When: its catalogue is opened
- Then: repository, file, commit, signature and directory counts are the graph's counts

### Scenario: file-page
- Given: a filled product
- When: a file's entity page is opened
- Then: its source, history and touching commits stand, and every history row carries the change and the author

## Requirement: search — The top bar searches the Markdown pages and the graph

The top bar's search shall keep its field, Ctrl/Cmd+K, grouped results and parser-read snippets,
and shall read the one graph's entities beside the Markdown pages.

### Scenario: grouped-search
- Given: a filled product
- When: a word is searched
- Then: rows are grouped by kind and a page's excerpt is the Markdown parser's text

## Requirement: orchestrator — The fill's tables reference their run and unit

Every run-scoped fill row shall name its run and every unit row its unit and generation by a
foreign key; pg-boss alone shall hand out work; a store's queue shall stop before its owner closes
and a pg-boss error shall be logged without ending the process.

### Scenario: foreign-keys
- Given: the fill's tables
- When: a row names a missing run or generation
- Then: the database refuses it

### Scenario: queue-stop
- Given: a store with its queue
- When: the owner closes
- Then: the queue is stopped first, and the server still answers after its timer

## Requirement: database-as-is — The database document is the walk store

`docs/system/database.md` shall describe the walk store's `pg_catalog`, marking mechanism tables
apart from tables generated from the walk product's contracts, with people redacted and neutral
repository URLs.

### Scenario: mechanism-versus-generated
- Given: the walk store after a fill
- When: the document is regenerated
- Then: it lists the nine mechanism tables and the generated tables by their generated names and counts

## Requirement: contract — A manifest kind states its contract and capability

A manifest kind shall state its typed fields, each field's authoritative or claimed role and
producer, its natural key and its filling capability; the manifest may declare edge kinds the
same way. A capability shall publish the contract of what it produces; the engine's DDL shall hold
only mechanism tables and no product kind name. A product that binds no code kind shall get no
repository, file, commit, signature, blob or path table, and shall still open, fill and serve.

### Scenario: preflight
- Given: a manifest with a field with no producer
- When: it is read
- Then: the check names the kind and field, and no fill starts

### Scenario: tracker-only
- Given: a tracker product whose kinds bind no capability
- When: it is filled and its catalogue opened
- Then: it serves its Markdown kinds and its store has no code table and no git reader ran

## Requirement: generated-tables — Names, identity and readers use the generated names

A kind's table name shall be generated from the kind and a digest, its columns and natural key
from the contract, and `node.uid` shall be the UUIDv5 of the kind and key; the git writer and
every wiki and MCP reader shall use the generated names. A contract change shall add columns and
keys, refuse a removed or retyped field while rows hold it, and name the kind and field.

### Scenario: readers
- Given: a filled walk store with generated tables
- When: the catalogue, a file page and a commit page are read
- Then: they answer from the generated tables and their counts match the fill

### Scenario: migration-refusal
- Given: a generated table holding rows
- When: the contract removes a field
- Then: the migration is refused, naming the kind, field and rows

## Requirement: migration — Contract DDL is serialized and fenced

A contract migration shall run in one transaction under the store's contract lock before any
generated-table DDL, held to commit, so two concurrent first fills create every table once; a
fill shall carry the contract version it started with and its publication shall be fenced
against an older version.

### Scenario: concurrent-first-fills
- Given: one fresh store and two first fills
- When: both create the contract tables concurrently
- Then: both finish without error and every generated table exists once

### Scenario: stale-publication
- Given: a fill started under one contract version
- When: the store's contract has moved and the fill publishes
- Then: the publication is refused and the unit runs again
