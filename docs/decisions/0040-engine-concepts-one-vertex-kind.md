# 0040. One vertex kind for each engine concept: kind, workflow, relation

Status: proposed — the owner's choice is pending (decision note on ALX-12, review ALX-150)
Date: 2026-11-17
Task: madarch-64o5.74 (finding madarch-ninm)

Builds on 0039 items 6, 8 and 9 and the item 9 clarification of 2026-11-17
(ALX-99): the manifest's own kinds are engine-owned, each relation among them
has one declaration, and the catalogue may only extend them. This record
applies the same rule to the three concepts that are still declared two or
three times. It is a storage-model choice, so the owner makes it; the options
and the recommendation below are the architect's.

## Context and problem

Read on the cutover commit `5df3e5c8f`:

| Concept | Engine declarations | Catalogue declaration |
|---|---|---|
| A kind of the product | system kind `kind` (`src/graph/system-contract.ts:77`, a label field only, nothing writes it); protected `manifest.kind` (written by catalogue publication, `src/graph/manifest-publication.ts:136`; read by the wiki's catalogue, `src/graph/graphql-read.ts:377`, `:1551`) | catalogue kind `kind` (`catalog/common/schema/kind.yaml`, id `manifest.kinds`, `extends: system:kind`, acquisition `conversation`, `agent-from-graph`) |
| A workflow | protected `manifest.workflow` with `manifest.workflow-stage` keyed by `manifest.workflow-stage-workflow` | catalogue kind `workflow` (`catalog/common/schema/workflow.yaml`) and edge `workflow-stages` to `manifest.workflow-stage` |
| A relation between kinds | protected `manifest.relation` vertex, edges `manifest.relation-edge` and `manifest.depends-on` between `manifest.kind` vertices | catalogue kind `link-type` with JSON fields `from_kinds`, `to_kinds`, `labels` and edges `link-type-from-kinds`, `link-type-to-kinds` to `kind`; a second label set for `manifest.depends-on` in the catalogue's relation vocabulary (`catalog/catalog.yaml:1047`) |

What the reader sees today: a kind's page (e.g. «Файл») is a `manifest.kind`
vertex; the catalogue entries «Вид», «Рабочий процесс», «Тип связи» are the
catalogue kinds, whose lists hold only what an agent fill wrote, so without
one they are empty while the catalogue itself lists every kind. Published
workflows and relations (`manifest.workflow`, `manifest.relation`) have no
page and are read by no wiki query. The owner asked on a kind page «Что это
за manifest.kind?» (madarch-64o5.114, 2026-11-15).

No check fails on this today: every catalogue edge touching these vertices has
a lower bound of 0 (all 144 catalogue edges read). The stage, the fourth such
concept, did fail (`CARDINALITY_INVALID for workflow-stages`, ALX-65) and is
decided by the item 9 clarification.

## Options

**A. The engine's kind is the one; the catalogue kind is its extension.**
One engine-owned vertex kind per concept: publication writes it, the wiki
reads it, the catalogue's `kind.yaml`, `workflow.yaml` and `link-type.yaml`
become extensions (nullable fields, optional edges, labels and descriptions).
`manifest.kind` folds into the system kind `kind`; the workflow and the
relation become system kinds the same way; the JSON fields `from_kinds` and
`to_kinds` go, since the relation's ends are already edges (0039 item 1); the
catalogue's second label set for `manifest.depends-on` goes. Internal names
are the architect's reversible choice when the task is cut. The architecture
check refuses a catalogue kind that declares an engine concept other than by
`extends: system:<kind>`, a catalogue declaration under a protected name, and
a catalogue edge whose lower bound requires a protected vertex to carry it.
Reader: «Вид», «Рабочий процесс», «Тип связи» stay and list the real kinds,
workflows (with stages) and relations; a kind's page stays and no longer shows
a raw key. Nothing a reader has is removed; two lists of one thing become one.
Cost: about 9–13 agent hours on gpt-6.1-sol (graph core), plus review and a
full `bun test`.

**B. The catalogue kind is the one; the engine reads the catalogue's vertices.**
Publication writes the catalogue kinds `kind`, `workflow`, `link-type`;
`manifest.*` goes. The product's catalogue then defines the shape the engine
reads its own catalogue through (a kind that declares the kind of kinds), so a
product can change or break what the engine depends on. Contradicts 0039
item 9 and its clarification, which the owner would have to revise. Cost:
about 14–20 agent hours, plus the revision.

**C. Leave as is until lasting data.**
No work now. The reader keeps the empty lists beside the real catalogue; the
next deferred check that tightens on one of these concepts can fail in the
foundation stage the way the stage did. After the foundation, any choice
needs a migration of every product's data.

## Recommendation

A, as one task inside the foundation stage (madarch-64o5): the architecture
rule first, since it costs one to two hours and touches no product data; the
merge after the cutover stack lands and the acceptance test `.148` is green,
because it touches the same files (`manifest-contract.ts`,
`manifest-publication.ts`, `system-contract.ts`, `graphql-read.ts`,
`catalog/`) and before any lasting data.

## Reversibility

Before lasting data any option can be undone at the price of the work, since
products are refilled without migration. After lasting data each becomes a
migration, so the choice is irreversible in the sense of the squad's decision
rights and is the owner's.

## Consequences of A

A product cannot redefine what a kind, a workflow or a relation is; it can add
nullable fields and optional edges. Changing these concepts is an engine
release with its migration (0039 item 34).
