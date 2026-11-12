# The glossary path: a plugin's contract builds a table, and the wiki reads terms from the graph

Change: madarch-8bdc.2.23
Base: f9367571ff2fd7d0aad5499fbc5cdd09806b9a57
Tasks: madarch-8bdc.2.23
Kind: behavior

## Intent

Glossary terms are the first kind to go through the path decisions 0034 and 0035 give every kind, and
the path is built for any kind, not for a glossary. A kind in `madarch/kinds.yaml` declares its fields
as bindings — a plugin's field, named by the plugin, the major version the manifest binds and the
field, or `agent` with a description of what the field is and how to extract it — and its natural key; the engine builds the kind's table from those declarations alone
(0034 item 14, 0035 items 17 and 18). The plugin's own contract, kept beside its code as
`contract.json`, states each field's type, meaning, example and whether it is required, and the
manifest check refuses a binding to a field the plugin does not declare, a type that differs, a
required field the manifest leaves out, and a plugin no lock holds — each with the file and the line.
A manifest with an error is not loaded.

The glossary plugin is a product plugin, not an engine one: version 1.0.0, its contract, its code and
its closure hash. `madarch init` writes it into the product, `madarch/plugins.lock` records the exact
version and the closure hash, and the release carries the closure as its own texts, so the plugin a
product receives is one the release trusts (0035 items 3, 4 and 20). A fill's plugin turn hands the
plugin one unit per kind. Only the files producer — the tree pass — reads the source filesystem and
git; it stores each text file's content in the graph once per blob, so unchanged files share it, and
the catalogue declares that content as a field of the file kind. The glossary plugin reads no folder:
it asks its host, through the protocol's read-only queries, for the file vertices its kind's pattern
names and for their content, and its introduction and contract declare graph reads and no filesystem
right. The host grants what the contract declares: a plugin without the filesystem right is given no
repository at all, and a test holds a plugin that reads one to be refused.

The plugin's answer becomes claims with evidence (repository, file, lines, commit, producer and
version) inside the publication's own transaction, through the graph's one writer; a rerun of the
same bytes writes nothing, and a term the document no longer states is tombstoned on the next fill.
The term listing and the term page read only `GraphReader`: the request-time reader of glossary files
and the block that rendered it are gone, and a document kind's list and count are the graph's.

## Out of scope

- The git reader's own move into a plugin: the tree and history passes stay the engine's files
  producer, and their kinds are declared as today; their contract now carries the file content.
- Edge kinds built from manifest field bindings: the table builder takes vertex kinds, and an edge
  kind's attributes stay the capability's declaration.
- A person's approval of a changed plugin closure as a journal operation: a closure whose hash is not
  the locked one is refused by name, and the approval itself is a later stage's.
- Agent filling of a kind: the manifest accepts an `agent` binding and the check reads it, but no
  agent turn runs one yet.

## Rationale

One rule for every kind — the manifest declares fields and their producers, the plugin declares their
types — keeps the engine free of product kinds and lets a product change a kind without a release. Only
the files producer may read the source: a glossary that opened a repository would be a second reader
of uncommitted bytes, and the graph would not be the one place a reader trusts.

## Changes to requirements

The extraction-plugin path is added as a new capability, `docs/changes/madarch-8bdc.2.23/capabilities/extraction-plugins.md`:

- extraction-plugins/manifest-tables (new): a kind's table is built from its manifest field bindings
  and its key; the plugin's contract states each field's type, meaning, example and required flag; the
  manifest check refuses an undeclared plugin field, a type mismatch, a missing required field and an
  unlocked plugin, naming the file and the line; a kind taken out of the manifest loses its table.
- extraction-plugins/product-plugins (new): a plugin lives in the product repository with its contract
  and code, the lock records its exact version and closure hash, and a release closure runs without
  further approval.
- extraction-plugins/graph-reads (new): a plugin declares the rights it needs; the host answers its
  read-only graph queries for file vertices and their content, and a plugin without the filesystem
  right sees no repository.
- extraction-plugins/publication (new): a plugin turn's answer becomes claims with evidence in the
  publication's transaction; a rerun writes nothing; a removed entity leaves the reads.
- extraction-plugins/glossary-page (new): the term listing and the term page read only the graph, and
  a document kind's list and count are the graph's.

## Preserved contracts

- product-wiki/pages: a term's page still shows its definition, its other names and where it is stated, now from the graph
- server/serves-wiki: `/api/k/glossary` and `/api/k/page` keep their shapes and addresses
- release-binary/installers: `madarch init` writes the same layout, with the plugin and its lock beside the manifest

## Coverage

- extraction-plugins/manifest-tables: test
- extraction-plugins/product-plugins: test root-suite
- extraction-plugins/graph-reads: test root-suite
- extraction-plugins/publication: test root-suite
- extraction-plugins/glossary-page: test root-suite wiki-app-check wiki-app-test wiki-app-build walk
- product-wiki/pages: test root-suite
- server/serves-wiki: test root-suite
- release-binary/installers: test root-suite

## Where it is seen

Kind: command
Place: `madarch fill`, then the product wiki's glossary page
Reason: the fill runs the product's glossary plugin, and the glossary page then lists the terms it published.

1. Run `madarch init` and connect this repository as its code repository.
2. Run `madarch fill`.
3. Open the glossary: every term of the glossary document is listed with its definition.
4. Open a term's page: the definition, its other names and a link to the lines it is stated at.

## Blocking questions

None.

## Design and decisions

**The table comes from the manifest, the types from the plugin.** `manifestContractOf` reads each
kind whose fields name a producer, resolves every field's type and claim through the plugin's
contract, and builds a vertex contract: key and authoritative fields are columns, a claimed field is
a claim, and the path dictionary is created when a content's path is interned. The git contract and
the manifest contract are merged, and `createContractTables` now drops a kind's table and its rows
when the new contract no longer declares it.

**The plugin turn is one unit per kind.** A unit is not a path: the plugin asks for the files its
pattern names. The host answers `graph.files` and `graph.value` from the graph, and the answer's
evidence names the file and the lines the term stands on. The producer's entities are compared by key
across the kind, so a term no longer in any document is removed.

**Only the files producer reads the source.** The plan reads the graph for the file vertices; the
host reads a file's content from the blob dictionary, once per blob. The sandbox binds `/repo` only
when the plugin's contract declares the filesystem right, and the introduction must repeat the
contract's rights.

**A compiled release runs its plugins itself.** A compiled madarch binary has no separate interpreter:
the sandbox starts the binary with `--plugin-entry <entry>` and the binary runs that module, and a
`bun` checkout starts the entry as its script.

**Before and after, measured on a product over this repository (arm64 release of this commit, filled from a fresh store):**

| Reading | Before | After |
|---|---:|---:|
| the plugin turn's unit | — | 1 unit, 66 vertices, 41 847 bytes, 19 ms |
| the glossary listing | 0 terms (the reader was deleted) | 59 terms of `docs/glossary.md`, all shown |
| the plugin's sandbox | the repository bound at `/repo` | no repository: graph reads only |

## Acceptance evidence

- `test/glossary-path.test.ts`: a two-term fixture fills, the listing shows both, each page states its
  definition and links the lines, an edited definition is the new one after a fill, a deleted term is
  gone, and a kind taken out of the manifest has no table.
- `test/plugin-contract.test.ts`: the columns a kind's table gets (key and authoritative fields, no
  claimed or agent field), the types a reader reads, and no table for a kind with no key or no
  producer.
- `test/manifest-contract.test.ts`: a valid manifest, and one refusal each for an undeclared plugin
  field, a type mismatch, a missing required field and an undeclared plugin, with file and line.
- `test/plugin-host.test.ts`: a plugin that declared the filesystem right reads its repository, and a
  plugin that declared none is refused with ENOENT.
- The product walk and its JSON are in the task report (`/work/out/report-gloss.md`): 66 terms over
  the starter pattern, 59 after the product narrowed it to `docs/glossary*.md`, two term pages with
  their definitions and the lines they stand on.
- Root suite: 1933 pass, 92 skip, 4 failing cases (2036 tests, 167 files). The four are
  `test/own-wiki.test.ts`'s refresh cases, which fail the same way on `origin/main` in this
  environment (the machine's git prints an unreadable `git/attributes` warning into the message).
- Wiki app: check, 365 tests and build pass. The CI wiki walk passes with every finding class at its
  baseline. Mutation (Stryker 9, changed ranges): `claims.ts` 95.65 %, `lock.ts` 66.07 %,
  `plugin-contract.ts` 64.80 %, `write.ts` 48.20 %, the parser ranges of `kinds.ts` 41.35 %; the
  survivors are regex and message variants and branches the fast test files do not take.
