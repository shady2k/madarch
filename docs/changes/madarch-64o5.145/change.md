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
