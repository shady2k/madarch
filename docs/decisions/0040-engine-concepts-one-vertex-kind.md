# 0040. One vertex kind for each engine concept: kind, workflow, relation

Status: accepted — option A, the owner's choice of 2026-11-17 06:43 UTC (decision note on ALX-12; review ALX-153)
Date: 2026-11-17
Task: madarch-64o5.74 (finding madarch-ninm)

Builds on 0039 items 1, 6, 8, 9 and 34 and the item 9 clarification of
2026-11-17 (ALX-99): the manifest's own kinds are engine-owned, each relation
among them has one declaration, and the catalogue may only extend them. This
record asks the owner to apply the same rule to the three concepts that are
still stored twice. It is a storage-model choice, so the owner makes it; the
options and the recommendation are the architect's.

## Context and problem

Read on the cutover commit `5df3e5c8f` and the stack head `1020478ba`
(`tl/k-core7`). Declaration layers and stored vertex kinds differ: the
catalogue's `kind.yaml` says `extends: system:kind`, and the parser and
`withSystemContract` merge it into the system kind of the same name
(`src/product/manifest/kinds.ts:1693-1708`, `src/graph/system-contract.ts:119-134`),
so it is one stored kind, not two.

| Concept | Stored vertex kinds today | Who writes them |
|---|---|---|
| A kind of the product | `kind` (system kind with the catalogue's nullable extension) and `manifest.kind` | `kind`: only an agent fill (`acquisition: conversation, agent-from-graph`); `manifest.kind`: catalogue publication (`src/graph/manifest-publication.ts:136,151-152`), read by the wiki's catalogue (`src/graph/graphql-read.ts:377,1551`) |
| A workflow | `workflow` (catalogue kind) and `manifest.workflow` with `manifest.workflow-stage` | `workflow`: only an agent fill; `manifest.workflow` and its stages: publication |
| A relation between kinds | `link-type` (catalogue kind, edges `link-type-from-kinds` / `link-type-to-kinds` to `kind`, JSON `from_kinds`, `to_kinds`, `labels`) and `manifest.relation`, plus the edges `manifest.relation-edge` and `manifest.depends-on` between `manifest.kind` vertices | `link-type`: only an agent fill; `manifest.*`: publication |

`manifest.relation-edge` joins two `manifest.kind` vertices and names its
relation by a text discriminator; it does not connect a `manifest.relation`
vertex to its permitted ends, and publication writes no pair edge for an `any`
end (`manifest-publication.ts:160-176`). Only `link-type-from-kinds` /
`link-type-to-kinds` connect a relation definition to its ends. The relation
`manifest.depends-on` also has a second label set in the catalogue's relation
vocabulary (`catalog/catalog.yaml:1047`): «от него зависят» against the
contract's «нужен для».

What the reader sees: a kind's page (e.g. «Файл») is a `manifest.kind`
vertex, and the owner asked on it «Что это за manifest.kind?»
(madarch-64o5.114). The catalogue entries «Вид», «Рабочий процесс», «Тип
связи» list the catalogue kinds' vertices, empty without an agent fill, while
the catalogue itself lists every kind. Published workflows and relations are
in the published schema (`src/graphql/manifest.ts:122`): search finds them and
they open on the generic entity page (`graphql-read.ts:405-411,1098-1113`,
`wiki/app/src/components/search.tsx:37-41`), but no catalogue list shows them
and they have no presentation of their own.

No check fails on these three today: at `5df3e5c8f` every one of the 149
catalogue edges that touches them has a lower bound of 0. The fourth such
concept, the workflow stage, did fail (`CARDINALITY_INVALID for
workflow-stages`, ALX-65); the item 9 clarification decided it and
`1987a1ba4` (ALX-101, in the stack) removed the catalogue's stage and its
`workflow-stages` edge.

Independent of this choice: showing labels instead of raw keys is already
required by 0039 item 6, and the clarified item 9 already protects `manifest.*`.

## Options

**A. The engine's record is the one; the catalogue kind is its extension.**
Per concept one engine-owned stored kind that publication writes and the wiki
reads. `kind` and `manifest.kind` become one; the catalogue's `kind.yaml`,
`workflow.yaml` and `link-type.yaml` extend the engine's kind (labels,
descriptions, nullable fields, optional edges) instead of storing a second
one. For the relation, the definition-to-end edges are kept and re-targeted to
the engine's relation record, and an `any` end gets an explicit
representation before the JSON fields `from_kinds` / `to_kinds` go; the
catalogue's second label set for `manifest.depends-on` goes. Internal names
are the architect's reversible choice when the task is cut. Each concept is a
separate, separately checkable step: kind first (it carries the owner's
question), then workflow, then relation. Search and generic pages keep working
throughout. Cost: kind 4–6, workflow 2–4, relation 4–6 agent hours on
gpt-6.1-sol (graph core), plus review and a full `bun test`.

**B. The catalogue kind is the one; the engine reads the catalogue's vertices.**
Publication writes `kind`, `workflow`, `link-type`; `manifest.*` goes. The
product's catalogue then defines the shape the engine reads its own catalogue
through, so a product can change or break what the engine depends on.
Contradicts 0039 item 9 and its clarification, which the owner would revise.
Cost: about 14–20 agent hours plus the revision.

**C. Leave the storage as is; do only the display work item 6 already
requires.** Raw keys disappear from pages. «Вид», «Рабочий процесс», «Тип
связи» still list empty catalogue kinds beside the published records. After
lasting data, any later merge is a migration of every product.

## Decision

Option A. The owner, 2026-11-17 06:43 UTC, after the history was walked
through with him on ALX-12: «Ну да, получается так. Если у нас граф
предварительно заполняется нашими системными видами, то ниоткуда из других
мест они добавляться не должны. Более того, никакая сущность из каталога не
может добавлять системные виды. да»

- For each engine concept — a kind, a workflow with its stages, a relation —
  exactly one stored kind exists, owned and written by the engine at start;
  the wiki's lists «Вид», «Рабочий процесс», «Тип связи» read it.
- The catalogue's three kinds (`catalog/common/schema/kind.yaml`,
  `workflow.yaml`, `link-type.yaml`) stop being kinds of their own; the
  engine's system `kind` and `manifest.kind` (and their workflow and relation
  counterparts) become one stored kind per concept. The relation keeps its
  definition-to-end edges, re-targeted to the engine's record, with an
  explicit representation of an `any` end before the JSON fields go; the
  second label set of `manifest.depends-on` goes.
- No other place adds an engine concept: no catalogue entity, product
  manifest, plugin or agent declares or writes a kind, workflow, stage or
  relation definition of its own. What the catalogue may still do is the
  item 9 clarification's extension of an engine kind — labels, descriptions,
  nullable fields, optional edges — which adds no stored kind and no vertex.
- Order: inside the foundation stage, after the cutover stack lands and the
  acceptance test `.148` is green, before lasting data; concept by concept —
  kind, then workflow, then relation — each checked on its own. Graph-core
  work, so the strong model.

## Recommendation

A. It applies the rule the owner already accepted, removes the doubled lists
without removing a page, and can be done concept by concept inside the
foundation stage (madarch-64o5), after the cutover stack lands and the
acceptance test `.148` is green (the work touches the same files), and before
lasting data. If the owner wants a smaller step, kind alone is the first one.

## Rule for the architecture check, independent of the choice

The already decided part of the clarified item 9: the catalogue declares no
vertex or edge kind under a protected name (`system.*`, `manifest.*`) and no
edge whose lower bound requires a protected vertex to carry it. Its
prerequisite, the removal of the catalogue's stage (`1987a1ba4`), is in the
stack head `1020478ba`; a static read of that tree finds no catalogue vertex
or edge under a protected name and no catalogue edge to a protected vertex.
The rule is enabled against that tree, and its first run is the evidence.

With A chosen, the rule gains its second half, enabled with the first
concept's change (kind) and widened with each later one: the catalogue
declares no vertex kind for an engine concept — a kind whose subject is
kinds, workflows, workflow stages or relation definitions — other than an
`extends` of the engine's kind that adds no stored kind of its own. Violation
scenario: a catalogue file `kind.yaml` declaring its own stored kind «Вид»
with agent acquisition fails the check, naming the file, line and the engine
kind it duplicates.

## Reversibility

Before lasting data any option can be undone at the price of the work, since
products are refilled without migration. After lasting data each becomes a
migration, so the choice is irreversible in the sense of the squad's decision
rights and is the owner's.

## Consequences of A

A product cannot redefine what a kind, a workflow or a relation is; it can add
nullable fields and optional edges. Changing these concepts is an engine
release with its migration (0039 item 34).
