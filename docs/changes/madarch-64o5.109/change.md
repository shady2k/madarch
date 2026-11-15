# The starter catalogue holds the owner's kinds, and no agent field reads a file

Change: madarch-64o5.109
Base: d60107d75581850ffec862234434a3224d844dd7
Tasks: madarch-64o5.109, madarch-64o5.114, madarch-64o5.115
Kind: request

## Rationale

The owner asked on 2026-11-15 whether the catalogue entities he agreed that morning exist, and they did
not. `bun run check:catalog` read 526 kinds, but only 55 declared fields and 43 a natural key — the rest
could show a page and hold nothing. 92 agent-bound fields, 87 of them, told the agent to read a file, a
glob or a repository, which his rule forbids: the agent reads only the graph, and a specialised plugin
brings a document into it. The Markdown-page model was still visible in `legacy_id`, `front`, `body`,
`import-folder` and the slug key; four code kinds carried state machines as JSON; the tracker's field set
was copied onto kinds that are not tracker items; and a third of the model families the owner agreed
(activity, class view, ER relationship, use-case step, scenario step, BPMN event and flow, one process
kind, one state-machine family) had no kind.

Three steps, each its own commit, in this order:

1. R10, greenfield: every trace of an earlier format is deleted, not migrated — `legacy_id`, `title`,
   `body`, the raw `front` JSON, the `import-folder` binding, the page field set and the `slug` key.
2. The audit's fixes, merges and removals: 72 kinds get fields, keys and relations that describe the
   thing; 36 are folded into the kind that is the same thing (with the greenfield corrections: a
   component is a C4 component and merges into the module, and the role kinds merge into one role); 3
   are removed as non-things (file facet, link, reservation) — the six manifest constructs the audit
   called removals stay, because madarch-64o5.114 makes the engine's own concepts entities too.
3. The missing kinds: person, role, permission, access role as their own kind, the behaviour and data
   model kinds, the proposed kind, and one decision kind.

## Where the catalogue stands

| What | Before | After |
|---|---|---|
| Kinds (catalogue entities) | 526 | 498 |
| Declared fields | 395 | 596 |
| Kinds with a natural key | 28 | 115 |
| Kinds with a page or a member row | 83 | 117 |
| Agent-bound fields | 92 | 406 |
| **Agent-bound fields that read a file, a glob or a repository** | **87** | **0** |
| Relation constraints | 1161 | 1235 |

Measured over `catalog/` by parsing each kind declaration at `d60107d7` and at this change's head. An
agent field counts as reading a file when its instruction names a path, a glob or a read of a file,
repository or document; an instruction that reads text the graph holds ("… read from the text of the
files the folder holds in the graph") is not such a read, because the file content is a graph entity.

## Preserved contracts

- A kind still declares `id`, `group` (by its folder), `definition`, `sources`, `acquisition`,
  `relation-constraints`, `template-policy`, `labels` and `description`; the manifest reader, the
  catalogue check and the GraphQL schema read exactly those.
- `audience` keeps naming declared reader roles. The roles are the natural keys of «Роль» entities: the
  same names, now a kind of their own, so an audience is a set of role entities rather than free words.
- The three starter value sets and the work kinds keep pointing at `value-set-entry`.
- The starter GraphQL SDL is regenerated from the catalogue (`bun scripts/write-starter-graphql.ts`) and
  still names every kind.
- Bundled plugin-bound fields keep the type their plugin declares (the plugin contract states text; a
  reference would refuse the plugin's own output).

## What changed beside the catalogue

- `src/product/manifest/kinds.ts`: the manifest reader refuses an agent binding that begins with a read
  instruction or names a glob or `docs/` path — the owner's rule, now enforced where a binding is written.
- `src/product/manifest.ts`: the product page takes its name into the kind's own title attribute
  (`title: name`) and keys the product by its name, not by an id in a slug field.
- `src/graph/graph-writes.ts`: a keyed entity may be stated by its key alone, so the product page exists
  from its name.
- `src/knowledge/reset.ts`: a reset reads every page opinion the graph holds instead of the two kinds the
  engine named; the page kinds are the kinds that declare a body.
- Test fixtures follow: a reduced product keeps the kinds its kinds name (resolved with the kept plugins'
  kinds rather than dropped), and a test that needs a page kind or a source-text kind declares one, as a
  product may.

## Coverage

- `catalog/`: the whole starter catalogue, which `bun run check:catalog` reads as `madarch init` writes it.
- The manifest reader's new refusal: `test/catalog-read.test.ts` plants a binding that sends the agent to
  a file and to a glob, and each is one finding.
- `bun run check`: tsc, the architecture check, the interface check, the catalogue check, the workflow
  check and the quarantine check.
- Catalogue and manifest tests: `catalog-check`, `catalog-read`, `catalog-descriptions`,
  `catalog-folder-preservation`, `catalog-work-common`, `catalogue-kind-relations`, `catalogue-diagram`,
  `catalogue-starter-kinds` (new), `work-kinds-cover-tracker`, `starter-value-sets`, `graphql-starter`,
  `draft-starter-copy`, `manifest-contract`, `product-manifest`, `kind-agent-manifest`,
  `manifest-kind-exclude`.

## Where it is seen

1. `madarch init` a product with the `everything` template; `bun run check:catalog --folder <product>`
   prints `catalog: 28 areas, 106 subgroups, 498 kinds (117 with a page of their own or a member's row)`
   and no finding.
2. Open the product's catalogue page and read «Человек» («People»), «Роль» («Roles»), «Право»
   («Permissions»), «Роль доступа» («Access roles»), «Активность», «Диаграмма классов», «Логическая
   модель данных», «Шаг сценария использования», «Событие процесса», «Предложенный вид» and
   «Решение» in the areas they stand in.
3. `test/catalogue-starter-kinds.test.ts` performs exactly this walk: a draft product, its catalogue
   published, `catalogueEntity(name: …)` for each new kind and its Russian label.
4. Open a code kind's page: no field asks a reader to open a file; each agent field names the graph data
   it rests on.

## Kinds left unsettled, and why

- `code.file`, `code.directory`, `code.gitlink` (repository, directory, `added_in`/`removed_in`,
  `other_repository`, `commit_hash`), `code.table.database`, `code.column.table`, `code.index.table`:
  the audit asks for references, but these fields are bound to the bundled `disk`, `git` and `db-schema`
  plugins, whose contracts declare text and emit text. A reference makes the graph writer refuse the
  plugin's own output (`fits()` demands `{kind, key}`), and changing the plugins' contracts and code is
  outside this catalogue change. They stay text keys until that plugin change lands; the fields are
  still the plugin's, not the agent's.
- `code.foreign-key` (the ER relationship): settled as an edge with declared attributes (`target_column`,
  `constraint`, `on_delete`, `on_update`), not as a vertex kind, because an edge is never a vertex
  (ADR 0034 item 5) — the audit offered either. For the same reason BPMN and activity flows are declared
  `flowsTo` edge kinds, not vertex kinds.
- `person`, `role`: no `derives-from`. They are the roots of the access model, found in conversation and
  the product's own settings; no other kind's discovery must finish first. Every other new kind derives
  from the kinds it is read out of.
- The 443 catalogue rows the audit marked OK and that still declare no fields are left as the audit found
  them: it counted them OK, and the owner's rule is to add kinds and fields as they are met.

## Blocking questions

None.
