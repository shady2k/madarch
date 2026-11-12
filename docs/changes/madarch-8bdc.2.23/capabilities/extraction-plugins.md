# Extraction plugins

Capability: extraction-plugins

## Purpose

A kind's facts come from a producer (decision 0035): a plugin kept in the product repository, or an
agent. The engine builds each kind's table from the manifest's field bindings and the plugin's own
contract, runs the plugin in the sandbox with the rights its contract declares, and publishes its
answer through the graph's one writer. Only the files producer reads the source filesystem and git.

## Requirement: manifest-tables — The manifest's bindings make a kind's table

The engine shall build a vertex table from a manifest kind's fields and key alone: the key's fields
and every authoritative field are columns, and a claimed field has none. The plugin's contract shall
state, for each field it produces, its type, its meaning, an example and whether it is required. The
manifest check shall refuse a binding to a field the plugin does not declare, a type that differs from
the plugin's, a required field the manifest leaves out, a plugin whose major version the manifest does
not bind, and a plugin the lock does not hold — each naming the file and the line, and loading no
manifest with an error. A kind the manifest no longer declares shall lose its table and its rows.

### Scenario: generated-from-manifest
- Given: a manifest kind `doc.term` with fields `name` and `definition` bound to `glossary@1.name` and `glossary@1.definition`, key `[name]`
- When: the store's schema is created
- Then: a table stands with a `name` column and no `definition` column, unique by `name`

### Scenario: undeclared-field
- Given: a manifest binding a field to `glossary@1.definiton`
- When: the manifest is read
- Then: a finding names the file, the line and the fields the plugin declares

### Scenario: type-mismatch
- Given: a manifest field of type `integer` bound to a plugin field of type `text`
- When: the manifest is read
- Then: a finding names both types

### Scenario: missing-required
- Given: a plugin field it declares required that the manifest does not bind
- When: the manifest is read
- Then: a finding names the field and the binding to add

### Scenario: kind-removed
- Given: a filled product whose manifest no longer declares the term kind
- When: the next fill runs
- Then: the kind's table does not stand

## Requirement: product-plugins — A plugin lives in the product, and the lock names it

A plugin shall live in the product repository with its contract, its code and its version; the
manifest shall name its folder and the major version it binds; and `madarch/plugins.lock` shall record
its exact version and its closure hash. A closure a madarch release carries shall run without further
approval; any other shall be refused by name until a person approves its hash.

### Scenario: release-closure
- Given: a product made by `madarch init`
- When: its fill runs the glossary plugin
- Then: the plugin runs, because its closure hash is one the release carries

### Scenario: changed-closure
- Given: a product whose plugin folder no longer hashes to the locked value
- When: the fill reaches its turn
- Then: it is refused, naming both hashes

## Requirement: graph-reads — A plugin reads the graph through its host

A plugin shall declare in its contract and its introduction the rights it needs: the network profile,
graph reads, and the repository snapshot. The host shall answer the plugin's `graph.files` query with
the file vertices whose path matches a pattern, and its `graph.value` query with one field of one
vertex — a file's content as the files producer stored it, once per blob. A plugin that declares no
filesystem right shall see no repository, and the host shall refuse its `graph.*` queries when its
contract declares no graph right.

### Scenario: content-by-blob
- Given: two files with the same bytes in a repository
- When: the tree pass publishes it
- Then: one blob row holds the content, and both files read it

### Scenario: no-filesystem
- Given: a plugin whose contract declares graph reads and no filesystem right
- When: it tries to read `/repo/plugin.json`
- Then: the read fails, because no repository is bound

## Requirement: publication — A plugin turn publishes claims with evidence

The fill shall give a plugin one unit per kind it fills, after the files producer has published the
file vertices. The plugin's answer shall become claims with their producer, version and evidence
(repository, path, lines, commit or digest), applied by the graph's one writer inside the
publication's transaction. A rerun of the same answer shall write nothing, and an entity the producer
no longer holds shall be removed on the next fill, a partial unit publishing no removal.

### Scenario: rerun
- Given: a filled glossary
- When: the same fill runs again
- Then: it writes no claim and the terms stand

### Scenario: removed-term
- Given: a term of a filled product's glossary
- When: the document no longer states it and the fill runs again
- Then: its page no longer opens and the listing does not hold it

## Requirement: glossary-page — The glossary and a term's page read the graph

The glossary listing and a term's page shall read the graph through `GraphReader` and nothing else: a
term is the entity a plugin published, its definition and other names are its claims, and the lines
it is stated at are its evidence. A document kind's list and count shall be the graph's. No
request-time reader of a glossary file shall stand beside the graph.

### Scenario: listing
- Given: a filled product whose glossary names two terms
- When: the glossary is opened
- Then: both terms are listed with their definitions

### Scenario: stated-at
- Given: a term with evidence in a document at lines 3 to 6
- When: its page is opened
- Then: it links to that document at line 3

### Scenario: no-file-reader
- Given: the repository after the change
- When: it is searched for the request-time glossary reader
- Then: only the plugin and the change records name a glossary file
