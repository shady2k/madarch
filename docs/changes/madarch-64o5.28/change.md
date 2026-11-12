# Declaration-driven plugin fill

Change: madarch-64o5.28
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.28
Kind: behavior

## Intent

Use kind prerequisites and plugin output, read and refinement declarations to
select, validate and order fill work. Preserve source evidence while displaying
the final refinement opinion. The manifest contract is `contract.md`.

## Out of scope

Drafting prerequisite declarations for the remaining starter catalogue kinds;
real agent or model execution; owner review or approval of the contract.

## Rationale

Kinds declare the data needed to fill them. Plugins are indivisible producers,
not engine-defined agent or deterministic categories. Invalid work must be
refused before an accepted run can silently do nothing. Owner approval remains
required and is not asserted by this record.

## Changes to requirements

- fill-stages/plugin-declarations: declare kind prerequisites and plugin production, reads, refinement and concurrency, with startup validation.
- fill-stages/plugin-order: derive producer ordering and reject conflicts/cycles, retaining fact sources and final refinement visibility.
- fill-stages/plugin-selection: share prerequisite-only selection between wiki and CLI and refuse unavailable producers.

Complete proposed capability: `capabilities/fill-stages.md`. Existing stage
registry, configuration, snapshot and graph contracts remain unchanged; the
new requirements specify the product plugin fill path.

## Coverage

- fill-stages/plugin-declarations: static, test, mutation, review
- fill-stages/plugin-order: static, test, mutation, review
- fill-stages/plugin-selection: static, test, mutation, review

## Where it is seen

Kind: command
Place: madarch fill --entity document.summary --agent scripted --token-cap 1000

1. Select a kind in the CLI or wiki fill page.
2. Review its transitive prerequisites and named producers.
3. Start the fill, or read a refusal naming the declaration file and line.
4. Read the final refined page with preserved sources.

## Blocking questions

None.

## Acceptance evidence

- Independent review identified disabled/omitted plugin-stage admission and cross-plugin prerequisite-completion regressions. Regression scenarios are included in this proposal; implementation fixes and final review are still pending. This is not a green review claim.

- `test/fill-target-selection.test.ts`: before implementation, 1 failure because derives-from was unknown; after implementation, 1 pass and 3 assertions. The fixture selects source and summary, not their dependant report.
- Implementation evidence and tracker check receipts are recorded separately by the coordinator after the final source revision. This observation is not a receipt for the full required checks.
