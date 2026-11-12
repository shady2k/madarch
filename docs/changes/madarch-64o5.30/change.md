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

- PR 280 busy-fill follow-up, `1cf7313e`: a read-only preflight reports an existing nonterminal chain before planning a new request or resolving its agent. It shares the orchestrator's existing terminal-state classification; atomic admission remains with the orchestrator. The filtered CLI case `the second fill says a fill is already running, since when, and how to follow it, with no internal code` passed with 11 assertions (1 pass, 1 filtered, 0 failures) using the existing deadline preload. The no-active-run case is unchanged and remains subject to the owner's no-agent decision. No real agent was run.
- PR 280 native-reader follow-up, `bb100f77`: mapped kind counts are aggregated across the legacy native graph and canonical typed-opinion tables. Entity lookup reads both declared sources within one SQL snapshot, as listing already does, rather than returning early from the generated-table path. Valid typed fields remain; this is not an alias migration or native-kind exception. Focused validation across three files passed: 9 cases, 41 assertions, including the unchanged declared-entity cases.
- The final root `bun run check` passed after the count and lookup repairs (93.51 seconds). This is static validation, not a claim that the whole PR or its runtime checks are green.

- PR 280 follow-up: catalogue summary projection now limits wildcard producer metadata to product-declared kinds and omits `pluginFolders`, while single-kind detail retains the declarations (`1ede175b`). The measured payload is 298311 bytes, down from 329802, under the unchanged 300000-byte bound.
- Publication-wait fixtures select a scripted adapter and use queue/open spies without running an agent (`75a3d371`): 6 passes, 27 assertions. A separate refusal case verifies that pending publication does not bypass the declared plugin agent requirement.
- Existing no-agent refusal remains unchanged pending the owner's decision. The first responsive-fill reproduction failed during prepared-server setup before admission (0 passes, 2 failures, 1 error). An isolated rerun completed schema preparation in 3312.6 ms and reached HTTP 409 with the missing-agent refusal at `agent-fill/plugin.json:14` (0 passes, 1 failure, 1 assertion; 68.71 seconds). This confirms the isolated run belongs to the deferred no-agent group; it does not prove the cause of, or repair, the earlier setup timeout. Standalone and quarantine reproductions reached the missing-agent refusal at `agent-fill/plugin.json:14`; this record does not claim those runs are green or authorize native-workflow bypasses.

- Independent review identified disabled/omitted plugin-stage admission and cross-plugin prerequisite-completion regressions. Regression scenarios are included in this proposal; implementation fixes and final review are still pending. This is not a green review claim.

- CLI red/green: `test/fill-agent-options.test.ts` first failed on missing --agent; after implementation it passed with 4 assertions and prerequisite-only help text.
- Wiki focused red/green: 4 failures and 2 passes before fixing disabled controls, request options and selection closure; 6 passes afterward.
- Wiki bounded manual mutation restored the always-disabled agent selector and the enabled-control assertion detected it; production code was restored. This is not a Stryker run.
- Wiki check passed TypeScript and architecture with 0 violations; build passed with existing CSS, externalized-module and chunk-size warnings. Final wiki suite: 414 passed, 0 failed across 35 files after stale category expectations were migrated.
- All agent-facing tests use Scripted fixture fetch stubs. No real agent or model was invoked and no execution constants were changed.
