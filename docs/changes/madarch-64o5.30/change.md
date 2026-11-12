# Selective fill uses all declared plugins and the chosen agent

Change: madarch-64o5.30
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.30
Kind: behavior

## Intent

Fill every selected kind through its declared producers, including general-agent
as filler and refiner, and offer the selected agent and token cap to any plugin.
Show producer names rather than engine-defined plugin categories.

## Out of scope

Real agent/model execution in tests; changing the manifest ordering contract
specified in madarch-64o5.28; drafting starter-kind prerequisites; owner approval.

## Rationale

Previously the wiki disabled agent and cap inputs and the selective server path
could accept a kind without running a producer. Any plugin may request an agent;
Page templates must not be accepted and silently ignored. The owner has not
approved this proposal and no approval is asserted here.

## Changes to requirements

- selective-plugin-fill/execution: execute every selected kind through its declared producers, including general-agent, and refuse unavailable work before acceptance.
- selective-plugin-fill/run-options: expose wiki and CLI agent/cap inputs and carry them to any requesting plugin.
- selective-plugin-fill/named-producers: show plugin names without categories and preview prerequisite-only selection.

Complete proposed capability: `capabilities/selective-plugin-fill.md`.

## Coverage

- selective-plugin-fill/execution: static, test, mutation, review
- selective-plugin-fill/run-options: static, test, mutation, review
- selective-plugin-fill/named-producers: static, test, mutation, review

## Where it is seen

Kind: screen
Place: Product wiki, Fill page, and madarch fill --entity KIND --agent AGENT --token-cap N
Mockup: docs/changes/madarch-64o5.30/fill-setup.html

1. Open Fill and select a kind; review its prerequisites and producer names.
2. Choose an agent and optional positive token cap; the controls are enabled while idle.
3. Press Run, or supply the same options through the CLI.
4. A kind without a dedicated producer is filled by general-agent; invalid setup is refused before run acceptance.
5. Read the resulting kind page with the final refinement and preserved sources.

## Blocking questions

None.

## Acceptance evidence

- CLI red/green: `test/fill-agent-options.test.ts` first failed on missing --agent; after implementation it passed with 4 assertions and prerequisite-only help text.
- Wiki focused red/green: 4 failures and 2 passes before fixing disabled controls, request options and selection closure; 6 passes afterward.
- Wiki bounded manual mutation restored the always-disabled agent selector and the enabled-control assertion detected it; production code was restored. This is not a Stryker run.
- Wiki check passed TypeScript and architecture with 0 violations; build passed with existing CSS, externalized-module and chunk-size warnings. Final wiki suite: 414 passed, 0 failed across 35 files after stale category expectations were migrated.
- All agent-facing tests use Scripted fixture fetch stubs. No real agent or model was invoked and no execution constants were changed.
