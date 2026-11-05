# The starter set holds the whole entity catalog in two levels, and a check validates it

Change: madarch-8bdc.4.1
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.4.1
Kind: behavior

## Intent
Decision 0033 (items 8, 9, 10 and 12) puts the whole entity catalog in now, with
the unimplemented kinds marked: every area of the product's life cycle, two
levels — an area, a subgroup of about twelve kinds — and, for every kind, its
concept id, its definition, the standard or document it was taken from as an
address a person can read, the ways it can be acquired (an extractor's mark, a
document, a conversation, an agent from the graph, a live system, or not
implemented), its implementation status, the relation constraints it may carry
and its template policy. The catalog is product data: `madarch new` writes it
into `madarch/kinds.yaml`, and the engine reads it and holds none of it.

A mechanical check validates whatever catalog a product holds, and the starter
set passes it. It refuses a kind that leaves a field out, a subgroup above its
bound, two kinds for one concept id, a value the catalog marks as an attribute
declared as a kind, and an area, a subgroup or an origin mark the manifest does
not declare. The wiki's own read of a product's manifest runs the same check,
so a product sees the refusals on its Problems page; `bun run check` runs it
over the starter set, written into a temporary product exactly as `madarch new`
writes it.

## Rationale
The starter set of the wiki declared the kinds the wiki shows today, 67 of
them, and nothing of the life cycle the decision's item 9 names. The catalog
of `docs/explorations/entity-catalog-2026-11-01.md` — 17 sections, about 220
rows, each with the standard it was taken from — was research, not data. A
kind the engine cannot make had nowhere to stand, and a product had no way to
say what it knows nothing about yet.

The catalog is written as data because the owner's rule is that the engine
holds no kind: the areas, the subgroups, the ids, the definitions, the sources,
the acquisition marks, the statuses, the relation names and the attributes are
all in the product's own `madarch/kinds.yaml`. The check reads the schema the
manifest declares about itself — the bound of a subgroup, the origin marks, the
statuses, the template policies, the attribute names and the relation names —
and refuses a row that does not meet it. An engine-side list of kinds would have
made the check a spell-check of itself.

The catalog is one list of kinds, not a second one beside the wiki's: the
manifest's `kinds:` mapping holds every kind, and a kind's catalog row stands in
its declaration. A kind whose template policy is `none` is catalogue data only;
it is read into the catalog, it shows no page, and no template is written for
it, which is what "a kind marked not-implemented shows nothing new yet" means
in the wiki. The kinds the wiki shows today keep their templates, their
labels and their descriptions, and the test suite of the wiki is green.

The areas are also the navigation's groups: an area is a group without a parent
and a subgroup is a group with one, the two levels the manifest already had
(`groups:` and a kind's `group`). One hierarchy serves both purposes, so a
kind's place has one source of truth. The roles' lead lists name the areas
instead of the groups of the old starter set.

The bound is data, not a constant of the check: `catalog.subgroup-kind-bound`.
So is the origin-mark vocabulary, the status vocabulary, the template policies,
the attribute names and the relation names; the only forms the check itself
knows are the shape of a row and the shape of an extractor's mark, "extractor
<id>".

The extractor vocabulary mapping (madarch-8bdc.4.2) and the POV roles
(madarch-8bdc.4.3) are later tasks. The catalog leaves room for them: an
acquisition mark names the extractor's id, and the catalog's rows carry the
material a mapping needs. No mapping and no new role is built here.

## Out of scope
- The extractor vocabulary mapping (madarch-8bdc.4.2): no engine-side map from
  the extractors' own vocabulary to the catalog's kinds, and no change to what
  the extractors emit.
- The POV roles (madarch-8bdc.4.3): the six roles of decision 0031 stay the six
  the wiki declares; the catalog's areas are what a later task ties them to.
- New templates. The catalog's kinds the engine cannot make yet show nothing,
  and the owner asked for no template yet. The template policy is a field only.
- A page that lists the whole catalog for a reader: the catalog is read, checked
  and kept, and the navigation shows the kinds with entities as it did.
- Deciding every row of the catalog. The rows are the research's, split to one
  kind per concept; where the decision did not settle a row it is listed under
  "Open questions".
- A network check of the sources. The check validates that a source is an
  http or https address with a host; whether the page answers is measured once
  at the change's acceptance and recorded here.

## Changes to requirements
- product-wiki/catalog (new at Base): the starter set holds the whole entity
  catalog in two levels with a row per kind, and a mechanical check — run by
  `bun run check` over the starter set and by the wiki's read of a product's
  manifest — refuses a kind without a field, a subgroup above its bound, two
  kinds of one concept id, an attribute declared as a kind, and an unknown
  area, subgroup or origin mark, naming file, line and kind; a kind with the
  template policy `none` shows no page. Scenarios: `starter-set-catalog`,
  `catalog-refusals`, `catalogue-only-kind`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted
requirement is retained verbatim from Base; the new requirement stands at the
file's end. No hand-written delta is stored.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages, the kinds the wiki shows today keep their templates, labels and descriptions, and a document kind is still read by its identifier, its headings or its terms.
- product-wiki/serve: serving a product is still one read of its working tree; the catalog adds findings to the manifest's own list and changes no page.
- product-wiki/questions-and-overview: the overview still lists the groups the manifest declares, and an empty group and a kind with no entity are still not shown.
- product-repository/draft: `madarch new` still writes the starter set as the product's own files; what it writes now includes the catalog's rows.
- product-wiki/live: a saved manifest still changes the pages at the next read; the catalog is read with it.

## Coverage
- product-wiki/catalog: test, static
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/questions-and-overview: test
- product-wiki/live: test
- product-repository/draft: test

## Where it is seen

Kind: command
Place: `madarch new`'s starter set, `bun run check` in a checkout, and a product's Problems page

1. Make a product with `madarch new` and open `madarch/kinds.yaml`: the `catalog:` mapping declares the schema, the `groups:` mapping holds the 26 areas and their 100 subgroups, and every kind of `kinds:` holds its `id`, `group`, `definition`, `sources`, `acquisition`, `status`, `relation-constraints` and `template-policy`.
2. Run `bun run check`: the catalog check prints `catalog: 26 areas, 100 subgroups, 490 kinds (67 with a page of their own or a member's row)` and the manifest it read, and exits 0.
3. Delete a `status:` line of one kind and run `bun run check` again: it prints the manifest's full path, the kind's line, and `kind "code.service": "status" is one of implemented, partial, not-implemented, got undefined`, and exits 1; open the product's wiki and the Problems page lists the same refusal with its file and line.

## Blocking questions
None.

## Design and decisions
- `src/knowledge/starter-catalog.ts` is the catalog's data (the areas, the
  subgroups, the rows, the relation names, the attributes and the schema) — the
  starter content `madarch new` writes, not engine behaviour.
- `src/knowledge/catalog.ts` is the reader and the check: the schema, a kind's
  row, and the findings of the catalog as a whole. It knows no area, kind or id.
- `src/knowledge/kinds.ts` reads `catalog:` beside `kinds:`, gives each kind its
  row, keeps the catalog's own findings apart from the manifest's others
  (`manifest.catalog.findings`), and leaves a kind with the policy `none` out of
  `manifest.kinds`, so the wiki shows no page for it.
- `scripts/check-catalog.ts` writes the starter set into a temporary product,
  reads it with the wiki's reader and reports every finding of that manifest
  except the ones that say what a product's documents lack (a product made a
  minute ago holds none). `bun run check` runs it after the type check and the
  architecture check.
- A manifest without `catalog:` is read as the versions before the catalog read
  it: a product's kinds keep working, and no finding is raised for the rows it
  does not hold. A kind that declares a catalog field without a catalog is a
  finding.
- The starter upgrade treats a kind's move to another subgroup as madarch's own
  change: `onlyMadarchAdditions` compares the declaration's other fields and
  accepts a group the starter set declares, so a product made before this change
  is still recognised as madarch's and brought to the current set.



What the review of the first round changed:

- **The catalog data.** A data catalog is now four kinds of its own (a catalog, a distribution, a data service and
  a catalog record) beside the OpenLineage dataset, and a catalog entry no longer claims the dataset's concept id;
  the desired deployment state is a kind of its own beside the act of deploying and the observed state, whose
  source is the controller's reconciliation rather than the environment-identity page; an actor is a person, and an
  external system is the external system kind; the SLA is one kind, and a supplier's service agreement names it
  rather than repeating it; a sunset date and an error budget are attributes of the API retirement policy and the
  error-budget policy, declared in `catalog.attributes`; and the relation name `generatedFrom` (SPDX 2.3) is
  SPDX 3's `generates`, with the direction the mapping declares.
- **The navigation's labels.** Every area and subgroup declares a short label in both languages beside its full
  name, and the check refuses a group without one or one longer than `GROUP_SHORT_LABEL_LIMIT` (18 code points, the
  240 px sidebar at 12 px uppercase beside the chevron and the count). The wiki app's navigation draws the short
  label and the catalogue keeps the full one; no template changed.
- **The check's report.** A manifest whose `catalog:` schema cannot be read now prints its own findings with the
  manifest's file and line before the check stops, instead of a refusal at the script's path and line 1.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-04:

- `bun run check` exit 0: `tsc --noEmit` clean (TypeScript 7.0.2), the architecture check at its 1 246 listed
  violations, and `catalog: 26 areas, 100 subgroups, 490 kinds (67 with a page of their own or a member's row)`.
- `MADARCH_SKIP_PERF=1 bun test test/catalog-read.test.ts test/catalog-check.test.ts`: 54 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun test test/knowledge-parse.test.ts test/knowledge-doc-entities.test.ts
  test/knowledge-subgroups.test.ts test/knowledge-settings.test.ts test/starter-set-upgrade.test.ts`:
  81 pass, 0 fail.
- The full suite cannot finish on this VM: `MADARCH_SKIP_PERF=1 bun test test/` runs 5 944 tests in one process
  and the second run was killed with exit 137 (out of memory) after 4 162 passes. Every failure seen in it was
  triaged in the report; each affected file passes alone, and the failures that remain are this machine's (root
  reading files made unreadable with `chmod`, PGlite and git answering timestamps as `+00:00`, one more agent
  adapter on `PATH`) or predate the change (`test/fill-claims.test.ts`, `test/loop-training.test.ts`, both
  failing identically with this change stashed). CI runs the suite in shards.
- `wiki/app`: `bun install --frozen-lockfile && bun run check` exit 0; `bun test` 310 pass, 1 flaky fail in
  `src/knowledge/knowledge.test.tsx` (shiki's keyword token), which passes alone (57 pass, 0 fail).
- StrykerJS 9 (command runner `bun test test/catalog-read.test.ts`, `coverageAnalysis: off`, from a scratch
  folder outside the repository with `typescript@5` beside it) on the committed `src/knowledge/catalog.ts`:
  491 mutants, 401 killed, 0 timed out, 90 survived — 81.67%. The survivors are 19 refusal-message texts, 15
  finding paths inside a nested field whose line is the same, 44 redundant guards in `||` chains, 7
  `MethodExpression` equivalents, and 5 comparator/filter equivalents (the breakdown is in the report).
- The sources: a one-time walk of the catalog's 200 addresses answered 194 with 2xx–3xx; the rest is recorded
  in the report (browser-readable pages that refuse a non-browser client, and rate limits).
- The independent review is the acceptance record's: it is not run by this change.

## DONE WHEN
The starter set `madarch new` writes holds the whole catalog: every area of
decision 0033's item 9, two levels with a subgroup of at most about twelve
kinds, and for every kind its id, definition, sources as addresses, acquisition
ways, implementation status, relation constraints and template policy. A
mechanical check — run by `bun run check` over the starter set and by the wiki's
read of a product's manifest — refuses a kind missing a field, a subgroup above
its bound, two kinds for one concept id, an attribute declared as a kind, and an
unknown area, subgroup or origin mark, naming the file, the line and the kind.
The starter set passes it, and the wiki shows the kinds it showed before.

The review round of 2026-11-05 added:

- `bun run check` exit 0 with the catalog at `26 areas, 100 subgroups, 490 kinds (67 with a page of their own or a
  member's row)`; the mapping's line unchanged at 56 kinds and 64 relations.
- `MADARCH_SKIP_PERF=1 bun test test/catalog-read.test.ts test/catalog-check.test.ts test/mapping-check.test.ts
  test/roles-check.test.ts test/neutral-repository-names.test.ts test/knowledge-parse.test.ts
  test/knowledge-doc-entities.test.ts test/knowledge-subgroups.test.ts test/knowledge-settings.test.ts
  test/starter-set-upgrade.test.ts test/wiki-readers.test.ts`: 201 pass, 0 fail.
- `wiki/app`: `bun run check` exit 0; `bun test` 311 pass, 1 fail in `src/knowledge/knowledge.test.tsx` (the shiki
  flake, green alone); `bun run build` exits 0.
- StrykerJS 9 on the groups' short-label block of `src/knowledge/kinds.ts` (lines 555-578) against
  `bun test test/catalog-read.test.ts`: 102 mutants, 72 killed, 30 survived — 70.59%; the survivors are the words
  of the refusal messages and the redundant `||` guards of the declaration's type checks.
