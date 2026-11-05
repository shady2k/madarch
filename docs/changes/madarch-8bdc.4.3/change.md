# Ten POV roles lead the catalog's areas and subgroups, and an area no role leads is refused

Change: madarch-8bdc.4.3
Base: ad6c2f9d97304b9f67598c085f19faee99385eb4
Tasks: madarch-8bdc.4.3
Kind: behavior

## Intent
Decision 0033 (item 12) and the owner's points 28, 29 and 31 tie the entity catalog to the wiki's POV: a kind
belongs to exactly one subgroup, a role lists the areas or subgroups it leads, and the ten roles are product,
analyst, architect, developer, operations, tester, designer, security engineer, platform/DevOps and product
lead. The starter set `madarch new` writes now declares all ten, each with the areas or subgroups it leads, and
every area is led by at least one role. The engine keeps no list of roles: a role's name is the product's own
data, as a kind's is.

The check refuses a role that names an area or a subgroup the manifest does not declare, and an area no role
leads — naming the file, the line and the role. The starter set passes it. Today's six roles keep their meaning
(the blocks they open and the groups they lead), and the four new ones work the same way: the reader's settings
accept the product's roles, the role card and the menu offer them, and the navigation leads with their areas.

## Rationale
The catalog of madarch-8bdc.4.1 declares 26 areas and 100 subgroups and the roles of 4.1's starter set led four
of those areas between them; the owner asked for the ten roles by name (point 29) and for the roles to lead an
area or a subgroup (point 31). A role nobody can choose is not a POV, so the roles become data the product
declares, the settings offer exactly the roles of the product being read, and the check keeps the coverage
whole: an area no role leads is a gap the wiki would show as a corner nobody of any role reads.

Keeping today's six roles' `open` lists as they were is what "today's six roles keep their meaning" means: the
blocks a developer sees open, and the groups put first, are the same as before. The four new roles are given
their own areas and a page reading like their neighbours (a designer opens what a product role opens; a
security engineer opens the properties, the relations and the graph; a platform engineer the operations
blocks; a product lead the stated and implemented sides).

## Out of scope
- New templates and new blocks: the roles name the blocks the library has.
- Roles beyond the ten in the starter set: a product may declare more or other roles, and the engine reads them.
- The agent starting from a role's areas (decision 0033, item 12's last sentence): it is the fill's turn-taking,
  not this check.
- The catalog's own rows beyond the areas' coverage: this change adds no kind and no subgroup.

## Changes to requirements
- product-wiki/pov (new at Base): the starter set declares the ten roles, each leading areas or subgroups, and
  every area is led by at least one role; the engine holds no role list, the settings and the reader offer the
  product's roles, and the check refuses a role naming an unknown area or subgroup and an area no role leads,
  naming the file, the line and the role. Scenarios: `ten-roles-lead`, `pov-refusals`, `pov-is-data`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted requirement is retained verbatim
from Base; `catalog` (madarch-8bdc.4.1), `extractor-mapping` (madarch-8bdc.4.2) and the new `pov` stand at the
file's end.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages; a role changes what stands open and what leads, as it did.
- product-wiki/live: a saved manifest still changes the roles the wiki offers at the next read.
- product-wiki/serve: the settings route still keeps the reader's role in the madarch home; it now accepts the product's roles.
- product-repository/draft: `madarch new` still writes the starter set as the product's own files; what it writes now declares ten roles.

## Coverage
- product-wiki/catalog: test
- product-wiki/extractor-mapping: test
- product-wiki/pov: test, static
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-repository/draft: test

## Where it is seen

Kind: command
Place: the starter set's `roles:` and `bun run check`

1. Make a product with `madarch new` and open `madarch/kinds.yaml`: its `roles:` block declares the ten roles, each with `lead:` naming the areas or subgroups it leads, and the six roles the wiki had keep the `open:` lists they had.
2. Run `bun run check`: the catalog check passes with the ten roles, and every area of the catalog is reached by at least one role's `lead`.
3. Remove an area from every role's `lead` and run it again: it prints the manifest's full path, the area's line and the words "no role leads it", with the roles that exist, and exits 1.

## Blocking questions
None.

## Design and decisions
- `src/knowledge/kinds.ts` reads `roles:` as data: a role's name is one word without whitespace, "everything"
  is every role at once and is not declared, and a role's `lead` names declared areas or subgroups. The POV rule
  that every area is led lives beside it, active when a catalog and roles are both declared.
- `src/knowledge/settings.ts` takes the roles the settings accept from its caller; the settings route passes
  the product's own (`KnowledgeProduct.declaredRoles()`), and `CHOOSABLE_ROLES` is gone from the engine.
- `wiki/app/src/knowledge/roles.ts` offers the roles the server answers (`rolesOf`), with "everything" last; the
  card and the menu read them, and the four new roles have their names and one-line descriptions in en and ru.
- `src/knowledge/seed.ts` declares the ten roles with their lead lists; `src/extract` is untouched.

## Acceptance evidence
Measured in the worker VM (4 vCPU, 8 GB, arm64), 2026-11-05:

- `bun run check` exit 0: types clean, the architecture check at its 1 243 listed violations (one entry left the
  list: the `RoleName` type is gone), and the catalog check's lines unchanged.
- `MADARCH_SKIP_PERF=1 bun test test/roles-check.test.ts`: 8 pass, 0 fail; the focused set of the files this
  change touches or that read the starter data (`test/catalog-read.test.ts`, `test/catalog-check.test.ts`,
  `test/mapping-check.test.ts`, `test/wiki-readers.test.ts`, `test/knowledge-settings.test.ts`,
  `test/starter-set-upgrade.test.ts`, `test/knowledge-subgroups.test.ts`, `test/knowledge-parse.test.ts`,
  `test/knowledge-doc-entities.test.ts`, `test/knowledge-status-freshness.test.ts`, `test/loop-entities.test.ts`,
  `test/neutral-repository-names.test.ts`, `test/writer.test.ts`, `test/writer-graph.test.ts`,
  `test/knowledge-enrichment-units.test.ts`): 298 pass, 0 fail; `test/knowledge-server.test.ts` and
  `test/knowledge-vertical.test.ts` together: 57 pass, 0 fail.
- `wiki/app`: `bun run check` exit 0; `bun test` 310 pass, 1 fail in `src/knowledge/knowledge.test.tsx` (the
  shiki keyword-token flake seen on the base as well), which passes alone (57 pass, 0 fail).
- StrykerJS 9 (command runner `bun test test/roles-check.test.ts`, `coverageAnalysis: off`, from a scratch
  folder outside the repository with `typescript@5` beside it) on the roles block of `src/knowledge/kinds.ts`
  (lines 596-634, the lines this change adds): 175 mutants, 124 killed, 0 timed out, 51 survived — 70.86%. The
  survivors are the words of the refusal messages and the redundant `||` guards of the declaration's type
  checks; the breakdown is in the report.
- The full suite is CI's: it does not fit this VM's memory (exit 137 in one process, as recorded for
  madarch-8bdc.4.1), and every file this change touches was run alone.
- The independent review is the acceptance record's: it is not run by this change.

## DONE WHEN
The starter set names the ten roles and the areas or subgroups each leads, every area is led by at least one
role, today's six roles keep their meaning, and the check refuses an unknown area or subgroup in a role and an
area no role leads, naming the file, the line and the role; the starter set passes; and a test plants each
refusal and its pass.
