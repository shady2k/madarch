# A product's own repository is no code input, and its catalogue needs no fill

Change: madarch-64o5.208
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.208
Kind: behavior

## Intent
A product's own checkout was pinned like a code repository and handed to every filesystem-capable plugin and to the fill
agent. The engine's files — plugins, templates, the wiki's own sources — were therefore published as the product's
`code.repository`, `code.directory` and `code.file`, and a fill of a small linked repository spent its turns reading
hundreds of files of the product itself instead of the code it was asked about (ALX-1937; the product's FR-005, FR-006,
UC-003 and UC-004, confirmed by the owner on 2026-11-27).

The pinned checkout stays, because the manifests are read from the commit a run stands on. What changes is who receives
it: a code plugin and the fill agent are given the repositories the manifest links under `repos:` alone, so the code
entities in the graph name connected repositories and never the product's own checkout. A product whose manifest links
none has its catalogue from the manifests and no code entity at all.

The wiki reads published declaration and template content from the graph's stored evidence first. For other files, an
unnamed source reads the product tree at its recorded fill revision; a named linked source uses its graph blob and
published repository revision. A later checkout commit does not replace either revision. REST and GraphQL exercise the
same distinction when the product and its linked repository share a name and path.

## Out of scope
- Generic scaling of large linked repositories: how a run costs a big repository is its own work, and this change does
  not touch the disk plugin's reader, its partitioning or its bounds.
- Standalone folder mode: a folder that holds no product manifest is pinned as `code` and keeps reading its own tree;
  the plain-folder behaviour is preserved and checked.
- The catalogue's publication itself, its contract and its tables: this change keeps them and covers that a fresh start
  publishes the catalogue before a fill.
- Stores written before ALX-1937, which hold the product's own checkout as `code.repository`, `code.directory` and
  `code.file`: there is no automated migration of those rows. Under the owner's greenfield policy (2026-11-28) such a
  store is recreated from scratch, and this change guarantees the fields a new store holds.

## Changes to requirements
- fill-orchestrator/code-inputs (new): a run hands a code plugin and the fill agent the pinned repositories the product's
  manifest links under `repos:`, and no other repository; the product's own checkout is pinned only to read its
  manifests; a folder that is no product keeps reading its own tree; the product's reference to a repository is stated
  for each repository a turn reads and never for its own checkout. Scenarios: `linked-repositories-only`,
  `no-linked-repository`, `plain-folder-keeps-its-tree`, `catalogue-before-the-fill`.

## Preserved contracts
None.

## Coverage
- fill-orchestrator/code-inputs: test.product-catalogue-code-boundary test.plugin-file-facts test.disk-support-ownership

## Where it is seen

Kind: command
Place: `madarch serve` on a product and `madarch fill` of it, whose answers the wiki shows

1. A person starts madarch on a product before any fill and opens the wiki: the catalogue's kinds, their fields, the workflows and the relationship types are there, and the Codesection lists no repository, folder or file of the product itself.
2. The person links a code repository, presses Fill, and opens the code section: it lists that repository, its folders and its files, and none of the product's own files.
3. A product whose manifest links no repository shows its catalogue and no code page at all.

## Blocking questions
None.

## Acceptance evidence
The fill planner recomputes the profile for a product that declares no linked repositories. A marker present only in the
product checkout does not keep the profile's kind or its dependent kind applicable. A declared repository that could
not be pinned is not treated as an empty search. The focused `test/kind-applicability.test.ts` fixture covers this distinction.

The managed fake-agent acceptance now passes: `test/product-catalogue-code-boundary.test.ts` serves a fresh product the
way the reader opens it, presses the fill the wiki's button asks for with an agent, and a hand-written ACP adapter found
by its product name on the PATH reads the session's graph server and madarch's file callback. It records the linked
repository alone — its folder, its files, and their text — and a refused read of the product's own manifest; the same
boundary is exercised for a product whose manifest declares `repos:` with no entry. The five cases are the blocking
coverage of the slow-files matrix of `.github/workflows/ci.yml`.

The retirement of rows a pre-ALX-1937 store already holds is out of scope under the owner's greenfield policy
(2026-11-28): no automated migration removes those rows; the store is recreated from scratch, so the fresh-store
behavior above is the contract this record states.

## DONE WHEN
A clean start of a product publishes its catalogue kinds with their fields, workflows and relationship types before any
manual fill and with no agent; a fill of a product that links a repository publishes code entities of that repository
alone and none of the product's own checkout; a product that links none has its catalogue and zero `code.repository`,
`code.directory` and `code.file`.
