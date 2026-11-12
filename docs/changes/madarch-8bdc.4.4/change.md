# Entity cards and history pages follow the kinds manifest, not kind names in the engine

Change: madarch-8bdc.4.4
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.4.4
Kind: behavior

## Intent
The owner's rule for the catalog is that the engine holds no product data (decision 0033, items 7 and 8): what a product
shows follows the kinds its `madarch/kinds.yaml` declares, never a list of kind names written in the engine. Two
presentation decisions still named catalog kinds in engine code: `src/knowledge/statement.ts` held eight kind names in
`CARD_KINDS`, and chose between an entity card and a code excerpt through them, and `src/knowledge/history.ts` held
`HISTORY_KINDS`, the eight kinds whose pages the history block tells the story of. A product that renamed, removed or
added a kind could not say which of them shows a card or a history page without editing the engine.

This change moves both decisions into the kind's own declaration. A kind may say `card: true` — a ground on one of its
entities shows the entity's card rather than the code it was read from — and `history` with one of the shapes `repositories`,
`author`, `path`, `membership`, `commit` and `task`, which is the shape of the story the history block tells of the
kind's entities. The starter set `madarch init` writes declares both fields for exactly the kinds that had a card and a
history page before, so the wiki shows the same pages for the starter set.

## Rationale
The two decisions are product data by the owner's own rule, and they are the kind of data a product changes: a product
that declares its own kind (a "tenant", say) wants its card, and one that gives a repository kind a page wants its
history. Written in the engine, the choices were fixed for every product and invisible to the manifest's reader, which
refused unknown kind fields.

The history shapes are engine vocabulary, not product data, in the same way a property format or a block name is: the
block can project a story about one path, about what a container holds, about one author, about one commit, about a
task's commits, or about the product's repositories, and the product says which of them its kind's page tells. The
extractor's own vocabulary stays the engine's: the projection still reads the history extractor's kinds (a commit, a
file, an author, a snapshot) as facts (decision 0033, item 7), and the kind name of an evidence entity is that
vocabulary, never the product's kind.

The fields are checked like every other field of a kind declaration: a `card` that is not a boolean, a `history` that is
not one of the shapes, and either field on a kind whose template policy is `none` are findings naming the file, the line
and the kind, and the refused kind is left out while the other kinds stand.

## Out of scope
- The other places that decide presentation by a kind name: the views a subject may draw (`src/knowledge/views.ts`, the
  ER view of a database or a table, the component view of a service), the definition block's contract kinds
  (`src/knowledge/definition.ts`), and the wiki app's navigation traits (`LOOP_KINDS`, `KINDS_WITH_OWN_PAGE`). Each one
  needs a field and a vocabulary of its own, and they are listed in the report with the reason each stays and the task
  that should take them.
- A page that lists the new fields for a reader: the manifest holds them, the catalogue shows the kind as before.
- The history block's sections (`summary`, `commits`, `coupling` ...), which a template already chooses with `sections=`.
- The writer's unit kinds and the loop's two kinds (`question`, `correction`): the writer and the loop decide which pages
  they write, not what an entity's page shows, and their vocabulary is the workflow's.

## Changes to requirements
- product-wiki/presentation (new at Base): a kind's declaration chooses whether a ground shows the entity's card and
  which shape its history page tells; the engine names no kind to decide either; the reader refuses a `card` that is not
  a boolean, an unknown `history` shape and either field on a catalogue-only kind; the starter set declares exactly the
  kinds that showed a card and a history page before. Scenarios: `card-follows-the-declaration`,
  `history-follows-the-declaration`, `presentation-fields-refused`, `starter-set-keeps-its-pages`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted requirement is retained verbatim from Base;
`catalog` (madarch-8bdc.4.1), `extractor-mapping` (madarch-8bdc.4.2) and `pov` (madarch-8bdc.4.3) are the sibling
changes' additions and stand before the new requirement, which is at the file's end.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages, and the kinds the wiki shows today keep their templates, labels, details and descriptions; the starter set declares the two fields for exactly the kinds that had a card and a history page, so every page it shows is the page it showed.
- product-wiki/live: a saved manifest still changes the pages at the next read; a `card` or `history` line saved into a kind's declaration takes effect with it.
- product-wiki/serve: serving a product is still one read of its working tree; the two fields add no route.
- product-repository/draft: `madarch init` still writes the starter set as the product's own files; what it writes now declares the two fields.

## Coverage
- product-wiki/presentation: test, static
- product-wiki/catalog: test
- product-wiki/extractor-mapping: test
- product-wiki/pov: test, static
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-repository/draft: test

## Blocking questions
None.

## Design and decisions
- `src/knowledge/kinds.ts` reads `card` and `history` beside the kind's other page fields, keeps them in `KindDecl`, and
  refuses what it cannot read; `HISTORY_SHAPES` is the vocabulary the block tells a story in, beside the block names and
  the property formats.
- `src/knowledge/statement.ts` asks the manifest whether the entity's kind shows a card, and nothing else; the card's
  facts, neighbours and page are drawn as before.
- `src/knowledge/history.ts` asks the manifest for the kind's shape and serves the story in it; a kind with no shape gets
  the block's problem naming the manifest and the kind. A Markdown page's story is `repositories` — the product's
  repositories read across — and a graph kind's story is its own shape.
- `src/knowledge/history-evidence.ts` takes the shape and branches on it, not on the subject's kind. The evidence's own
  kinds (a commit, a file, an author, a snapshot) and the containment rules of the files extractor stay in the engine:
  they are the extractor's vocabulary, which decision 0033 item 7 keeps apart from the product's kinds.
- `src/knowledge/starter-catalog.ts` carries the two fields in its rows and `src/knowledge/seed.ts` writes them into the
  manifest it gives a product, with the manifest's own comment block explaining both.
- `test/knowledge-manifest-presentation.test.ts` proves the round trip the task asks for: the line is removed from a
  fixture manifest and the presentation goes, and restored and it comes back.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-05:

- `bun run check` exit 0: `tsc --noEmit` clean (TypeScript 7.0.2), the architecture check at its 1 242 listed
  violations (the `HISTORY_KINDS` entry it listed before is gone with the symbol), and
  `catalog: 26 areas, 100 subgroups, 490 kinds (67 with a page of their own or a member's row)` with
  `mapping: version 1; 56 extractor kinds (55 tied, 1 internal); 64 extractor relations (36 tied, 28 internal)`.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-manifest-presentation.test.ts`: 8 pass, 0 fail — the card round trip
  (card, removed, restored), the history round trip (path, removed, restored), a kind the manifest does not declare,
  a task's story, a Markdown page's repositories story and its refusal, the two reader findings, and the starter
  set's declarations.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-history-evidence.test.ts test/knowledge-history-product.test.ts
  test/knowledge-history-reader.test.ts`: 16 pass, 0 fail, including the new author story.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-*.test.ts`: 573 pass, 1 skip, 5 fail. Four are `knowledge-liquid` and
  `knowledge-server` cases that a Stryker run in place beside the suite broke while it rewrote `src/knowledge`, and
  both files pass alone (46 pass, 0 fail). The fifth, `knowledge-agent`'s "a second press with the pages in place
  runs no unit", fails identically at 4730a814 (10 pass, 1 fail).
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-vertical.test.ts test/product-wiki-pages.test.ts
  test/knowledge-page-snapshot.test.ts test/knowledge-history-landmarks.test.ts
  test/knowledge-history-snapshot-cache.test.ts`: 128 pass, 5 fail — `product-wiki-pages`' five `chmod 000` cases,
  which fail the same way at 4730a814 on this machine (72 pass, 5 fail), because the run is root and root reads a
  mode-000 folder.
- `MADARCH_SKIP_PERF=1 bun test test/starter-set-upgrade.test.ts test/product-draft.test.ts test/product-wiki-pages.test.ts
  test/product-wiki-serve.test.ts test/product-manifest.test.ts test/madarch-init-e2e.test.ts test/catalog-check.test.ts
  test/mapping-check.test.ts test/roles-check.test.ts`: 192 pass, 6 fail — the same five `chmod 000` cases, and
  `madarch-init-e2e`'s agent offer, which reads `prime-agent` as installed because this machine has it on `PATH`.
- `wiki/app`: `bun install --frozen-lockfile && bun run check` exit 0; `bun test` 311 pass, 1 fail (shiki's
  `.tok-keyword` in `knowledge.test.tsx`, the flake the sibling records name; the file alone is 57 pass, 0 fail here
  and at 4730a814); `bun run build` exit 0.
- StrykerJS 9 (command runner, `coverageAnalysis: off`, `inPlace`, `typescript@5` beside it, from
  `/work/scratch/stryker` outside the repository) on the changed line ranges of `statement.ts`, `history.ts`,
  `history-evidence.ts` and `kinds.ts` against `bun test test/knowledge-manifest-presentation.test.ts
  test/knowledge-history-evidence.test.ts`: 96 mutants, 77 killed, 0 timed out, 19 survived — 80.21%
  (statement.ts 100%, kinds.ts 97.22%, history-evidence.ts 75%, history.ts 65.22%). The survivors are the written
  messages, `join(' | ')` against `join('')`, object literals whose sections the data leaves empty anyway, and the
  guard that a non-`repositories` story is never asked for without its entity.

## Where it is seen
Kind: internal
Place: A page's ground on a graph entity, and a page's history block
Reason: the starter set shows the pages it showed before, and no screen is added or altered; what changes is which declaration a product writes to get a card or a history page on a kind of its own.

1. Open a product whose manifest declares `card: true` on a kind, read a page's statement grounded on an entity of that
   kind, and the ground shows the entity's card; remove the line from `madarch/kinds.yaml`, save, and the same ground
   shows the entity's code instead.
2. Open a page whose kind's declaration names `history: path`, and the history block tells the file's story; remove the
   line and the block says the manifest declares no history for the kind; restore it and the story is back.

## DONE WHEN
No module under `src/` or `wiki/app/src` names a catalog kind to choose an entity card or a history page; a test removes
`card: true` from one kind of a fixture manifest and the kind loses its card, and restoring it brings the card back, and
the same holds for a `history` shape; the wiki shows the pages it showed for the starter set, and its tests are green.
