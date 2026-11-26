# Profile-first kind applicability

Change: madarch-64o5.145
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.145
Kind: behavior

## Intent
Implement decision 0039 item 35 with typed per-product kind assertions, explicit applicability dependencies and catalogue marker rules. Profile-first planning suppresses inapplicable agent units. Terminal inapplicable answers require a search description and evidence. Catalogue and fill preparation render state, reason and ancestor. Languages and frameworks use a declared extension/filename map to normalized technology names. Every producer outcome maps to graph applicability; failure and abstention mean unknown, never absence.

## Out of scope
Exhaustive technology recognition; changing the durable fill state machine. Marker absence is a declared filename policy, not proof against arbitrary filenames; catalogue completeness remains outside this change.

## Changes to requirements
- fill-stages/applicability: evidence-backed absence, explicit cascading, static profile-first planning and plan response state.

## Preserved contracts
- fill-stages/registry: stages retain their existing registration and scheduling contract.

## Coverage
- fill-stages/applicability: static test mutation
- fill-stages/registry: static test

## Where it is seen
Kind: request
Place: catalogue and fill preparation; fill-plan response, kinds[].applicability; fill plugin planning and invocation

1. Read kind applicability state, search reason, evidence and contest in the plan response.
2. Compare pinned fixture repositories with and without Chart.yaml.
3. Verify a derived mark cites its ancestor, while structural-only dependencies do not cascade.
4. Verify source replacement and cross-source disagreement.

## Blocking questions
None.

## Acceptance evidence
See /tmp/madarch-64o5.145-report.md. Not accepted or closed. No real agent was run. No schema table outside the graph was added. Bounded manual mutations cover structural cascading, inverted marker result, disabled agent suppression, failed-to-absence mapping and technology extension/filename matching. Browser screenshots are unavailable: the box has no browser executable or cached Playwright browser.

## Storage-snapshot integration

Base of integration: eff3e64f, after merges .74, .139, .142, .114 and .144. Historical Base and acceptance status above are retained, not relabelled.

Conflict inventory and resolutions:
- `catalog/catalog.yaml`: keep the single native .144 profile-product identity edge, no duplicate incoming cascade relation.
- `catalog/design/screen/screen.yaml`, `catalog/infrastructure/compute/{kubernetes-cluster,kubernetes-node,node-pool}.yaml`, `catalog/infrastructure/orchestration/{k8s-autoscaler,k8s-configmap,k8s-cronjob,k8s-daemonset,k8s-ingress,k8s-job,k8s-namespace,k8s-pod,k8s-secret,k8s-statefulset}.yaml`, `catalog/ml/model/ml-model.yaml`: keep .144 structural prerequisites; add explicit .145 applicability dependencies and markers, not inferred absence from structural dependencies.
- `catalog/strategy/product/product-profile.yaml`: retain native product parent-key edge; graph-backed template-policy none is stored once, not deferred. Use eight installed text-list:v1 schemas and deterministic marker producers/technology maps. A shared offline installed-schema root-reference resolver permits semantic list shape validation; no free JSON debt added.
- `src/fill/plugin-turns.ts`: preserve native immediate writes, evidence validation and bounded reconciliation; add profile preparation/agent skips without incoming duplicate inline deletion loops. Preserve unchanged versus empty.
- `src/knowledge/fill-plan.ts`: retain localized plan/read data and explicit empty kinds; add stored applicability.
- `src/plugin/fill-declarations.ts`: retain explicit support scope, ambiguity refusal, forward-source pairing and empty prerequisites; add deterministic profile exemptions for both markers and technology maps and skip inapplicable agents only.
- `src/product/manifest/kinds.ts`: preserve nullable system overlays, protected admission and catalogue dependency metadata; add separate applicability/profile validation.
- `wiki/app/src/components/command-pages.test.tsx`: retain GraphQL-only reader mocks and add plan override/applicability fields.

Clean-merge audit: KnowledgeProduct's newly asynchronous fillPlan is awaited in its query branch and both server callers. Native operation scopes are retained; searched scope prefers scheduler plan_scope, then operation scope, then unit UID. Zero successful production is empty, not inapplicable; failed/abstained is failed/unknown, never absence. Evidence cites immutable graph assertions. Partial and inapplicable plugin refusals carry their distinct information; malformed terminal absence cannot hide writes/problems/blank search. Current UI kit and bilingual strings remain. The prior merge's isolated catalogue YAML fixture serialization was corrected (indentSeq:false), not its reader validation weakened.

Validation: `bun run check` passes at exactly 560 inherited findings, zero new I/O-span, writer or catalogue-pointer debt (`/tmp/integrate-merge6-check2.log`). Catalogue remains 504 kinds, now 120 displayed, five truly deferred edges. Profile/producer tests: 16 pass; pinned applicability/cascade tests: two pass; catalogue read/support/planner tests: 105 pass. Wiki app check, 233 tests and build pass (`/tmp/integrate-merge6-app.log`). No real agent fill was started; no runtime timeout, logging bound or connection-limit constant changed. Existing route preparation timeout remains recorded under .144. This is integration validation, not proposal acceptance or closure.

Transport follow-up: current-protocol fixtures declare actual graph rights and provide own-facts readers. Admission checks remain unchanged. Protocol suite: 39 pass; immediate payload/transport suite passes (`/tmp/integrate-merge6-chunks2.log`).
