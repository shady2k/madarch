# Every model is an entity of its own kind, and so are the engine's own concepts

Change: madarch-64o5.114
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.114, madarch-64o5.109
Kind: no-behavior

## Intent
The owner's words of 2026-11-15: «машины состояний, переходы, все эти диаграммы … Это все должно быть в виде
отдельных сущностей» and «все сущности, в том числе сущности ядра, отображались в графе». A state machine,
its states, its transitions and the event that moves them are entities of their own kinds, never JSON on
another kind; a business process, an activity, a class view, a runtime scenario, a use case and an ER model
are kinds with their parts and flows; and the engine's own concepts — the kind, the field set, the link
type, the link behaviour, the responsibility, the accounting and the workflow — are catalogue entities too.

## Out of scope
- Drawing the engine's own entities on the product's pages; the catalogue declares them, the pages come later.
- A plugin that finds a machine declared by a known library; the kinds and the agent's reads are settled here.
- Filling the new kinds on madarch itself.

## Rationale
A machine that stood as a JSON field of `code.file`, `code.module`, `code.service` and `code.symbol` was
written by whatever filled the module, which is why the owner's module came back with states it does not
have. The same held for the manifest's lifecycle, status, transition and event kinds, which were a second
family of the same concepts. Splitting them into kinds of their own gives each a page, a key and relations,
lets a plugin or the agent fill it on its own, and removes the field from the kinds that only held it.

## Changes to requirements
None. The change realizes the existing `product-wiki` catalog requirement, which already says the starter
set holds the whole entity catalogue and that the engine holds no kind of its own; a machine, a state and a
transition are kinds that requirement's list did not yet cover.

## Preserved contracts
- product-wiki/catalog: the state-machine, state, transition, event, process, activity, class-view, scenario, use-case and data-model kinds declare their definitions, sources, acquisition, relation constraints, template policies and natural keys, and the check reads them
- fill-stages/configuration: a product still declares the kinds its fill plans, and a kind that names no producer is still refused

## Coverage
- product-wiki/catalog: static test
- fill-stages/configuration: static test

## Where it is seen
Kind: command
Place: `bun run check:catalog` and the catalogue page of a product made with `madarch init --template everything`

1. Run `bun run check:catalog`: the state machine, its states, its transitions and its event are among the kinds read, and no code kind declares a state machine as a field.
2. Read the catalogue page: «Конечный автомат», «Состояние», «Переход», «Событие», «Бизнес-процесс», «Шаг процесса», «Событие процесса», «Активность», «Узел активности», «Диаграмма классов» and «Логическая модель данных» stand with their own pages.
3. Read the engine's concepts on the catalogue page: «Вид», «Набор полей», «Тип связи», «Поведение связи», «Ответственность», «Учёт» and «Рабочий процесс» are kinds with fields and keys.

## Blocking questions
None.

## Design and decisions
A state machine names its subject and, for a kind's life cycle, the kind it belongs to; a state and a
transition are members of the machine's page, and the event that moves a transition is a kind of its own.
A business process has one kind with steps, gateways and events; a flow is an edge (`flowsTo`), never a
vertex, because an edge is never a vertex (ADR 0034 item 5). An activity has a node kind and the same flow
edge; a class diagram is a view over a module's or a domain's types; a logical data model groups a domain's
entities and is drawn over the tables; a use case holds steps; a runtime scenario holds steps that name who
sends what to whom. The engine's concepts keep the catalogue's own vocabulary and gain fields and keys, so
a product can change a kind, a link type or a workflow through the one write path.

## Acceptance evidence
Static: `bun run check` passed with the catalogue branch's merge.
Test: `bun run check:catalog` read 498 kinds with no finding, and the catalogue tests prove every state,
transition, event, activity, class view, data model and proposed kind has both labels, a description, a
key and the relations its declaration names.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
No kind carries a state machine, a lifecycle, a status or a transition as a field; each is a kind with its
page, its key and its relations; and the engine's own concepts are catalogue entities like the rest.

### Foundation integration: system-kind admission

The incoming branch adds the admission part of decision 0039 items 8 and 9. Protected names require explicit `extends: system:<name>` and additive extensions cannot replace the installed base contract. This increment is not proposal acceptance or a new installation/version store. The snapshot's installed system contracts, retained UIDs and typed assertion writes remain authoritative. The earlier catalogue expansion above remains historical material, not a replacement by the incoming proposal.

Conflict resolutions: the deleted legacy `event.yaml` stays deleted; `question.yaml` keeps the snapshot's active graph declaration and existing explicit inheritance; the automatically merged `kind.yaml` keeps one existing inheritance key rather than a duplicate and retains its active page. Operation receives its metadata-only explicit system inheritance. The change record keeps the snapshot history and records admission integration here, rather than replacing it with incoming pre-cutover assumptions. Parser and architecture-gate conflicts are resolved against current snapshot contracts, not a second operational system catalogue.

Validation: final focused system admission/overlay/architecture suites pass 80 tests with 281 assertions and zero failures (`/tmp/integrate-merge4-tests3.log`). `bun run check` passes with 560 inherited findings, zero new debt and zero I/O-span findings (`/tmp/integrate-merge4-check2.log`). The app check and all 231 tests pass; app build passes after correcting ownership of previously root-written ignored Vite output folders (`/tmp/integrate-merge4-app.log`, `/tmp/integrate-merge4-app-build3.log`). No runtime constant changed. System plugin-bound extension additions remain refused: UID transport alone does not yet enforce retained-target-only and extension-only writer authority; empty-key references can still allocate identities and invocation authority includes existence. Ordinary product plugin bindings remain admitted.

Exact remaining conflicts: `src/product/manifest/kinds.ts` keeps snapshot key-edge/evidence parsing and gains protected-name checks plus metadata-only system admission; `scripts/check/architecture/gates.ts` keeps current contextual proofs and excludes only the trusted presentation catalogue, never its words globally; `test/architecture-gates.test.ts` preserves current tests and adds the narrow vocabulary regression. Canonical transaction-mode tests now use the actual exported registry declaration and still refuse unrelated literals. Incoming edge fixtures gained the required bilingual labels and cardinality rather than weakening validation. Trusted display defaults hold no operational field contract.
