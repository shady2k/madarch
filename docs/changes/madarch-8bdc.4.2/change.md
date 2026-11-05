# The extractors' vocabulary is tied to the catalog by a versioned mapping, and an unmapped key is refused

Change: madarch-8bdc.4.2
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.4.2
Kind: behavior

## Intent
Decision 0033 (item 7) keeps two vocabularies: the extractors' code-structure schema and the product's catalog.
A versioned mapping ties one to the other. The starter set `madarch new` writes now holds that mapping: every
node kind and relation type the extractors emit is tied to a catalog kind or to the catalog's relation names,
or is declared internal to extraction with the reason. A mechanical check — run by `bun run check` over the
starter set and by the wiki's own read of a product's manifest — refuses an emitted key with no row, a row that
names a kind or relation the catalog does not hold, a row for a key no extractor emits, and a row that is
neither a tie nor an internal declaration with a reason. The starter set passes it.

The extractors declare their vocabulary as data their code uses (`src/extract/vocabulary.ts` reads those
declarations), so a new kind or relation an extractor emits appears to the check without anyone editing a list
in the check: the mapping must tie it before the check passes.

## Rationale
The catalog of madarch-8bdc.4.1 names 489 kinds, and the extractors emit 56 kinds and 64 relation types of
their own. Until now nothing tied the two: a reader of the wiki could not tell which of the extracted keys the
product shows, and a product that removed a kind could not say what extraction keeps of it. The mapping is the
tie, and making it checked is what keeps it complete.

The emitted keys are not typed into the check. Each extractor declares what it emits beside the code that
emits it (`CODE_NODE_KINDS` and `CODE_EDGE_TYPES`, `CONTRACTS_NODE_KINDS` and `CONTRACTS_EDGE_TYPES`,
`DATA_MODEL_NODE_KINDS` and `DATA_MODEL_EDGE_TYPES`, and the new vocabulary modules of the operations, history
and driver extractors), and `src/extract/vocabulary.ts` gathers the declarations. The mapping check reads that
union, so a kind an extractor starts emitting is refused until its row is written, and no list in the check can
fall behind the extractors.

The mapping is versioned because its shape will change: `mapping.version` names the shape a product's manifest
was written for, and the engine reads the versions it knows (1 today). A product that removes a kind changes
what it shows and walks, never what extraction keeps: the mapping keeps the extractor's key tied to whatever
the product declares, and a row is never removed by a kind's page disappearing.

## Out of scope
- The POV roles (madarch-8bdc.4.3): the roles stay the six the wiki declares until that task.
- A mapping of the *values* extraction stores (properties, attributes): this ties kinds and relation types only.
- A page that shows the mapping to a reader: the mapping is read, checked and kept; the wiki shows no new page.
- Re-pointing every emit site of the data-model extractor at its declared vocabulary: that extractor already
  declares its kinds and relations as data, and its emit sites name them literally; the declaration is what the
  check reads. The other extractors' emit sites now name the constants their vocabulary declares.

## Changes to requirements
- product-wiki/extractor-mapping (new at Base): the starter set holds a versioned mapping of every extractor
  kind and relation type to a catalog kind or relation, or internal with a reason, and a check — run by `bun
  run check` and by the wiki's read of a product's manifest — refuses an emitted key with no row, a row naming a
  kind or relation the catalog does not hold, a row for a key no extractor emits, and a row that is neither,
  naming both sides, the file and the line. Scenarios: `mapping-ties-extractors`, `mapping-refusals`,
  `mapping-notices-new-keys`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted requirement is retained verbatim
from Base; `catalog` (madarch-8bdc.4.1) and the new `extractor-mapping` stand at the file's end.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages; the mapping adds findings and no page.
- product-wiki/live: a saved manifest still changes the pages at the next read; the mapping is read with it.
- fill-stages/registry: the extractors' records and the stages that write them are unchanged; a vocabulary declaration changes no extraction.
- product-repository/draft: `madarch new` still writes the starter set as the product's own files; what it writes now includes the mapping.

## Coverage
- product-wiki/catalog: test
- product-wiki/extractor-mapping: test, static
- product-wiki/pages: test
- product-wiki/live: test
- fill-stages/registry: test
- product-repository/draft: test

## Where it is seen

Kind: command
Place: the starter set's `madarch/kinds.yaml` and `bun run check`

1. Open a product made by `madarch new`: `madarch/kinds.yaml` ends with `mapping:` — its version, then a row for every extractor kind and relation, each tied to a catalog kind or relation or declared internal with the reason.
2. Run `bun run check`: the catalog check prints `mapping: version 1; 56 extractor kinds (55 tied to a catalog kind, 1 internal); 64 extractor relations (39 tied to a catalog relation, 25 internal)` and exits 0.
3. Delete a row, or tie one to a kind the catalog does not hold, and run it again: it prints the file, the line and both names (the key and the kind or relation it names) and exits 1.

## Blocking questions
None.

## Design and decisions
- `src/extract/vocabulary.ts` gathers the extractors' declared vocabularies; it is the only place the check
  learns what the extractors emit.
- `src/knowledge/mapping.ts` reads `mapping:` from the manifest, ties each row to the catalog (kinds by name,
  relations by `catalog.relations`), and makes the findings.
- `src/knowledge/starter-mapping.ts` is the starter data: 56 kind rows (55 ties, `code.facet` internal) and 64
  relation rows (39 ties, 25 internal), in code point order.
- `scripts/check-catalog.ts` prints the mapping's counts beside the catalog's, so a run says what is tied and
  what extraction keeps as its own.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-05:

- `bun run check` exit 0: types clean, the architecture check at its 1 244 listed violations (two entries left
  the list: the data-model vocabulary arrays are now reached through `src/extract/vocabulary.ts`), and
  `mapping: version 1; 56 extractor kinds (55 tied to a catalog kind, 1 internal); 64 extractor relations
  (39 tied to a catalog relation, 25 internal)`.
- `MADARCH_SKIP_PERF=1 bun test test/mapping-check.test.ts`: 13 pass, 0 fail; the focused set of the files this
  change touches or that read the starter data (the catalog's, the knowledge manifest and settings suites,
  `loop-entities`, `neutral-repository-names`, `writer`, `writer-graph`, `knowledge-enrichment-units`) is green.
- The extractors' own suites (`test/extract-*.test.ts`) are green over the vocabulary refactor: 97 pass.
- StrykerJS 9 (command runner `bun test test/mapping-check.test.ts`, `coverageAnalysis: off`, from a scratch
  folder outside the repository with `typescript@5` beside it) on the committed `src/knowledge/mapping.ts`:
  309 mutants, 228 killed, 0 timed out, 81 survived — 73.79%. The survivors are the words of the refusal
  messages (23), redundant guards in `||` chains where the YAML reader already fixes the type (40), and finding
  paths inside a section whose line is the section's own (8); the breakdown is in the report.
- The full suite is CI's: it does not fit this VM's memory (exit 137 in one process, as recorded for
  madarch-8bdc.4.1), and every file this change touches was run alone.
- The independent review is the acceptance record's: it is not run by this change.

## DONE WHEN
The starter set holds a versioned mapping tying every kind and relation the extractors emit to a catalog kind
or relation, or declaring it internal with a reason, read from the extractors' declared vocabulary rather than a
list in the check; the check refuses an emitted key with no row and a row naming a kind or relation the catalog
does not hold, naming both, the file and the line; the starter set passes; and a test plants each refusal and
the pass.
