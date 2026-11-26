# The starter catalogue holds the owner's kinds, and no agent field reads a file

Change: madarch-64o5.109
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.109, madarch-64o5.114, madarch-64o5.115
Kind: no-behavior

## Intent
The owner asked on 2026-11-15 whether the catalogue entities he agreed that morning exist, and they did
not: `bun run check:catalog` read 526 kinds, but only 55 declared fields and 43 a natural key, 87
agent-bound fields told the agent to read a file, a glob or a repository, the Markdown page format was
still visible in `legacy_id`, `front`, `body`, `import-folder` and the slug key, and a third of the model
families the owner agreed had no kind. The catalogue is now the greenfield model he described: 498 kinds,
596 fields, 115 natural keys, 0 agent-bound fields that read a file, and the kinds for person, role,
permission, the behaviour and data models, the proposed kind and the one decision kind.

## Out of scope
- The bundled plugins' contracts: `disk`, `git` and `db-schema` still emit text, so `code.file`,
  `code.directory`, `code.gitlink`, `code.table.database`, `code.column.table` and `code.index.table`
  keep the plugin's text key rather than a reference.
- The reset path's remaining Markdown renderers for questions and corrections, which another change owns.
- Filling the new kinds on madarch itself; this change settles what the kinds are, not the fill.

## Rationale
The audit of 2026-11-15 (526 kinds, OK 409 / FIX 72 / MERGE 36 / REMOVE 9) is the reason for every edit,
read with the owner's three decisions of that day: the greenfield rule R10 (no trace of an earlier
format is migrated), the rule that the agent reads only the graph (a specialised plugin brings a document
into it), and his merges (a component is a module, one role kind serves the diagrams and the reading). The
fixes describe the thing, its natural key and its relations; the merges fold a second kind into the kind
that is the same thing; the removals drop what is not a thing (a file facet, a reified link, a computed
reservation). The six manifest constructs the audit called removals stay, because madarch-64o5.114 makes
the engine's own concepts entities too.

## Changes to requirements
None. The change realizes the existing `product-wiki` catalog requirement, whose text already holds the
whole entity catalogue, its check and its refusals; the kinds, the fields and the natural keys are the
code catching up with it.

## Preserved contracts
- product-wiki/catalog: the starter set still declares its areas, subgroups, concept ids, definitions, sources, acquisition, relation constraints and template policies, and the check still refuses a kind that leaves one out
- product-wiki/extractor-mapping: every extractor kind and relation still names a catalog kind or relation, and the mapping is unchanged
- fill-stages/configuration: a product still declares the kinds its fill reads, and the fill's plan still refuses a kind that names no producer
- product-wiki/internationalization: every kind still names and describes itself in English and Russian, and the new kinds do too

## Coverage
- product-wiki/catalog: static test
- product-wiki/extractor-mapping: static test
- fill-stages/configuration: static test
- product-wiki/internationalization: static test

## Where it is seen
Kind: command
Place: `bun run check:catalog` over the starter set, and the catalogue page of a product made with `madarch init --template everything`

1. Run `bun run check:catalog`: it prints `28 areas, 106 subgroups, 498 kinds (117 with a page of their own or a member's row)` and no finding.
2. Make a product with `madarch init --template everything`, then run `bun run check:catalog --folder` on its folder: the same counts and no finding.
3. Open the product's catalogue page and read «Человек», «Роль», «Право», «Роль доступа», «Активность», «Диаграмма классов», «Логическая модель данных», «Шаг сценария использования», «Событие процесса», «Предложенный вид» and «Решение».
4. Read any code kind's page: no field asks the reader to open a file.

## Blocking questions
None.

## Design and decisions
Counts before and after, measured over `catalog/` at `d60107d7` and at this branch's head: kinds 526 to
498, declared fields 395 to 596, kinds with a natural key 28 to 115, kinds with a page or a member row
83 to 117, agent-bound fields 92 to 406, of which the ones that read a file, a glob or a repository fall
87 to 0. An agent field counts as a read when its instruction names a path, a glob or a read of a file,
repository or document; "read from the text of the files the folder holds in the graph" is graph data,
not a read.

Kinds left unsettled, with the reason: the plugin-bound text keys named under Out of scope; the ER
foreign key and the BPMN and activity flows, which are edges with declared attributes rather than vertex
kinds because an edge is never a vertex (ADR 0034 item 5); `person` and `role`, which have no
`derives-from` because they are the roots of the access model; and the 443 catalogue rows the audit marked
OK and that still declare no fields.

The manifest reader now refuses an agent binding that begins with a read instruction or names a glob or a
`docs/` path, so the owner's rule is enforced where a binding is written, not only audited once.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture, UI, catalog, workflows, quarantine).
Test: `bun run check:catalog` printed 28 areas, 106 subgroups, 498 kinds (117 page or member rows) and
both templates clean; 32 catalogue, manifest and affected test files passed, 214 cases and one skip,
including `test/catalogue-starter-kinds.test.ts`, which makes a starter product, publishes its catalogue
and reads each new kind and its Russian label through `catalogueEntity`.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
`bun run check:catalog` reads the starter set with no finding and the counts above, a starter product's
catalogue page lists the new kinds, and no agent binding in `catalog/` names a file, a glob or a
repository.
