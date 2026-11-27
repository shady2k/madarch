# Approved catalogue dependency tree and explicit unpaged contracts

Change: madarch-64o5.144
Base: 2535d187abbbbd925ab3a3b38dc38bd7ac04e254
Tasks: madarch-64o5.144
Kind: behavior

## Intent
Apply the owner's catalogue tree and the coordinator's explicit catalogue-only prerequisite and deferred-edge contracts.

## Out of scope
Fills, agents, applicability cascade (madarch-64o5.145), federation, reserved-name redesign, page promotion, push and acceptance.

## Changes to requirements
- product-repository/catalogue-tree: whole-life-cycle dependencies and approved concept identities.
- product-repository/catalogue-only-contract: explicit empty prerequisites and waiting edges.

## Preserved contracts
None.

## Coverage
- product-repository/catalogue-tree: test
- product-repository/catalogue-only-contract: test

## Where it is seen
Kind: command
Place: bun run check:catalog and the fill-plan response

1. Run the catalogue check: read the merged catalogue counts and the named waiting edges; the snapshot keeps its split events and active graph-backed kinds.
2. Request a plan containing a catalogue-only prerequisite: read its no-producer-declared state.
3. Generate schema and storage contracts: waiting edges have neither types nor tables.

## Blocking questions
None.

## Acceptance evidence
Scripted checks only. See the hand-in report for commands and counts. No owner acceptance, independent review or mutation result is claimed.

### Foundation integration resolutions

The dependency tree is merged after system admission onto the typed assertion snapshot. Catalogue prerequisites are distinct from stored kinds: only a declaration absent from the runtime kind map is catalogue-only. An unpaged graph-backed declaration remains stored and appears once in fill planning. Deferred edges have a genuinely catalogue-only endpoint; a `none` page policy alone cannot defer a stored edge. No old JSON reference columns or publication tables return.

GraphQL conflict resolutions: `src/graphql/manifest.ts` retains the snapshot's protected assertion/manifest kinds and adds only the deferred-edge filter; `src/graphql/starter.graphql` is regenerated from the merged catalogue rather than taking the incoming pre-cutover schema. Reader Kind prefixes, localized fields and typed templates remain.

Exact catalogue conflict resolutions:


- `catalog/architecture/behaviour/event.yaml`: Remains deleted; did not resurrect ambiguous event. Existing process-event still derives from business-process; transition dependency now targets state-event.
- `catalog/architecture/behaviour/process-gateway.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/automation/process/process-step.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/catalog.yaml`: Kept all 149 local edge declarations and complete semantic-bindings unchanged; retained incoming relation vocabulary; inserted 19 incoming edges at top-level edges, not semantic-bindings; added native profile-product parent edge. Cardinalities described below.
- `catalog/data/job/data-job-run.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/data/storage/code.column.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/data/storage/code.database.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/data/storage/code.index.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/data/storage/code.table.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/documentation/feedback/correction.yaml`: Preserved current fields/labels and descriptions; appended document and person prerequisites.
- `catalog/operations/jobs/job-run.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/strategy/planning/backlog-item.yaml`: Honored incoming deletion; no remaining YAML reference.
- `catalog/testing/case/code.test-case.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/testing/case/code.test-quarantine.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/testing/run/test-result.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.
- `catalog/work/coordination/question.yaml`: Preserved system:question extension, nullable-only fields, labels and merge-4 wording; appended product prerequisite.
- `catalog/work/execution/task.yaml`: Preserved existing nullable facts and tracker/key identity; took owner-set priority wording, task.contains constraints and nullable integer queue_position; appended product prerequisite.
- `catalog/work/ways/constitution.yaml`: Retained local fields, keys, labels and key-edges; combined incoming derives-from prerequisites.


Remaining runtime conflicts: `src/fill/stages/plugin-contract.ts` retains the typed template contract and omits genuinely deferred edges; `src/plugin/fill-declarations.ts` retains support/partition rules and gains explicit empty prerequisites. An agent support read cannot survive after its explicitly declared source was removed as a forward dependency; bare ambiguous support reads still refuse. Asked support fields are satisfied only by a selected actual owner output, never a synthetic support producer. `kinds.ts` permits additive dependency metadata on system extensions while preserving inherited identity/field controls. Seeded partial catalogues retain endpoints of installed protected system contracts.

Test conflict resolutions: `test/catalog-check.test.ts`, `test/catalog-read.test.ts` derive observed counts; `test/catalog-test-quarantine.test.ts` keeps the native repository parent edge; `test/graphql-manifest-check.test.ts` keeps strict concrete endpoints/cardinality and Kind names; `test/graphql-schema-route.test.ts` keeps published-manifest isolation and localized reader behavior. Clean-merged fixtures use native term subject and directory repository key-edges.

Schema assumptions: new non-parent relations use optional unbounded cardinality at both ends, since the approved vocabulary declares no uniqueness or mandatory presence. New parent identities are restrictive. The new profile's eight lists use the installed text-list schema, not free JSON; citations remain assertion evidence, not embedded structured objects. This does not introduce the next merge's deterministic applicability behavior. The four snapshot-only catalogue kinds receive explicit scheduling dependencies; blob support depends on product rather than file, avoiding an evidence/file cycle.

Validation: `bun run check` passes with 560 inherited architecture findings and zero I/O-span or catalogue-pointer findings (`/tmp/integrate-merge5-check2.log`). Catalogue: 504 kinds, 121 displayed, five deferred edges. Planner/dependency/collision suites pass 45 tests (`/tmp/integrate-merge5-planner3.log`); unpaged/deferred contract suites pass three tests (`/tmp/integrate-merge5-only4.log`). Full route validation remains blocked by the snapshot's slow graph publication/read preparation: the integration run reaches PostgreSQL client exhaustion and read timeouts (`/tmp/integrate-merge5-route4.log`); the exact route suite on pristine eff3e64f also times out under a 160-second bound (`/tmp/baseline-graphql-route.log`). A broader catalogue run was bounded at 120 seconds while entering a database publication case; its passing cases are not claimed as a complete suite. No timeout or connection-limit constant was changed, and no speculative storage fix was made. These are reported limitations, not acceptance.
