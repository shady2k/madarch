# Selective fill uses all declared plugins and the chosen agent

Change: madarch-64o5.30
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.30
Kind: behavior

## Intent

Fill every selected kind through its declared producers, including configured general-agent
gap filling and explicit field refinement, and offer the selected agent and token cap to any plugin.
Show producer names rather than engine-defined plugin categories.

## Out of scope

Real agent/model execution in tests; changing the manifest ordering contract
specified in madarch-64o5.28; drafting starter-kind prerequisites; owner approval.

## Rationale

Previously the wiki disabled agent and cap inputs and the selective server path
could accept a kind without running a producer. Any plugin may request an agent;
Page templates must not be accepted and silently ignored. The owner's quoted “Да, ок” authorizes the task; no tooling process-approval
receipt is asserted here.

## Changes to requirements

- selective-plugin-fill/execution: execute every selected kind through its declared producers, including general-agent, and refuse unavailable work before acceptance.
- selective-plugin-fill/run-options: expose wiki and CLI agent/cap inputs and carry them to any requesting plugin.
- selective-plugin-fill/conditional-agent: require agent selection only for planned requesting plugins, with an actionable disabled Run reason and prestart server refusal.
- selective-plugin-fill/named-producers: show plugin names without categories and preview prerequisite-only selection.

Complete proposed capability: `capabilities/selective-plugin-fill.md`.

## Coverage

- selective-plugin-fill/execution: static, test, mutation, review
- selective-plugin-fill/run-options: static, test, mutation, review
- selective-plugin-fill/conditional-agent: static, test, review
- selective-plugin-fill/named-producers: static, test, mutation, review

## Where it is seen

Kind: screen
Place: Product wiki, Fill page, and madarch fill --entity KIND --agent AGENT --token-cap N
Mockup: docs/changes/madarch-64o5.30/fill-setup.html

1. Open Fill and select a kind; review its prerequisites and producer names.
2. Choose an agent if a planned plugin requests one, and an optional positive token cap; the controls are enabled while idle. There is no no-agent option.
3. Run is disabled with a visible reason while a required agent is missing. Otherwise press Run, or supply the same options through the CLI; deterministic-only products need no agent.
4. A kind without a dedicated producer is filled by general-agent; invalid setup is refused before run acceptance.
5. Read the resulting kind page with the final refinement and preserved sources.

## Blocking questions

None.

## Design and decisions

### Owner decision: agent required only when the plan needs it

Plan from the product's enabled plugins. Require an agent only if a planned
plugin requests one. Without a selected agent, refuse before accepting,
queueing or starting work; name the requesting plugin's absolute manifest
filename and 1-based line and explain how to choose an agent in the wiki or
with `--agent`. Do not introduce a no-agent mode or a waiting-for-agent state.
A product enabling only deterministic plugins can fill without an agent.
The wiki makes the agent field required only for a plan that needs it and
keeps Run disabled with a visible reason until that requirement is met; it
offers no no-agent option.

Fixtures declare only the plugins they exercise. Deterministic-workflow tests
must not enable an unused agent plugin merely by default. Tests that exercise
agent-requesting plugins select scripted fixtures, never real agents or models.
Keep valid kind declarations and typed fields; removing them to evade failures
is not a fixture repair. No timeout or performance bound is raised.

The earlier deferred no-agent status below is superseded, not its historical
observations. In particular, neither this decision nor a fixture correction
proves the cause of or repair of the earlier prepared-server setup timeout.
This decision is not owner process approval or a full-suite-green claim.

### Review-section-4 contract revision (contract first)

The revised madarch-64o5.28 `contract.md` specifies all twelve final rules and
maps all eight section-1 scenarios S1–S8. It supersedes universal agent execution,
plugin-wide reads, and automatic earlier-refinement dependency exemptions.
Outputs own reads/refines; unclaimed coverage is declaration-only; explicit
per-kind/field agent configuration enables overlap. Access and selected scopes
are enforced. Required inputs must succeed; earlier reads name an immutable
producer version. Authored satisfaction uses an ordinary plugin. Observable
outcomes and producer-scoped replacement/retraction retain evidence/run identity.

This is the required contract-first revision, not implementation evidence.
The capabilities in this change follow that normative contract. No PostgreSQL,
heavy check, real model, timeout increase or bound increase was used to write it.
Historical acceptance observations below are retained, including unresolved
failures and the native-stage migration limitation. They are not proof of this
revision, an all-green result, or a process-approval receipt.

## Acceptance evidence

- Owner-decision runtime follow-up (partial validation, not an all-green result): close-verdict passed 2 cases / 10 assertions in 106.07 seconds; quarantine passed 1 / 11 in 36.37 seconds; button passed 2 / 65 in 76.28 seconds; readers passed 17 / 64 in 140.36 seconds; already-running passed 2 / 14 in 49.89 seconds. Schema-source reported 2 passes, 1 failure, 29 assertions, 0 skips in 118.81 seconds; the observed failure is a native/generated `code.file` key mismatch, not the missing-agent policy. The isolated responsive run, with performance skipping unset, reached the performance assertion and failed: status p99 was 429.57 ms against the unchanged 300 ms bound (105.95 seconds total). This is an actual performance failure, distinct from the historical prepared-server setup timeout and missing-agent refusal. The same log reports Files = 0 while the terminal count is 600; the test failed on performance before the list assertion, so Files correctness is not established. This additional native/generated contract discrepancy is not repaired or attributed to the owner-policy change. Additional serialized fixture validation settled at 18 passes and 3 failures: fill-states 2/0 (15 assertions, 49.58 seconds), repository-wiki 6/0 (100, 338.51 seconds), glossary-path 5/1 (21, 305.94 seconds), fill-role-parent 1/2 (14, 170.43 seconds), roles-two-and-two 1/0 (22, 136.53 seconds), and plugin-declaration-change 3/0 (15, 286.01 seconds). Glossary's first extracted journal expected one operation but received two; later mutation cases passed. The idle/running child-role cases still found the store PostgreSQL alive after 2046/2012 ms against the unchanged 2000 ms bound; the SIGTERM case passed. Assertions and bounds were not weakened. These additional results do not resolve the schema, responsive or UI failures and are not an all-green result. No timeout or performance bound was raised; no full-suite-green or owner process approval is claimed.

- PR 280 busy-fill follow-up, `1cf7313e`: a read-only preflight reports an existing nonterminal chain before planning a new request or resolving its agent. It shares the orchestrator's existing terminal-state classification; atomic admission remains with the orchestrator. The filtered CLI case `the second fill says a fill is already running, since when, and how to follow it, with no internal code` passed with 11 assertions (1 pass, 1 filtered, 0 failures) using the existing deadline preload. The historical no-active-run case preceded the owner decision below; its deferred-policy status is superseded. No real agent was run.
- PR 280 native-reader follow-up, `bb100f77`: mapped kind counts are aggregated across the legacy native graph and canonical typed-opinion tables. Entity lookup reads both declared sources within one SQL snapshot, as listing already does, rather than returning early from the generated-table path. Valid typed fields remain; this is not an alias migration or native-kind exception. Focused validation across three files passed: 9 cases, 41 assertions, including the unchanged declared-entity cases.
- The final root `bun run check` passed after the count and lookup repairs (93.51 seconds). This is static validation, not a claim that the whole PR or its runtime checks are green.

- PR 280 follow-up: catalogue summary projection now limits wildcard producer metadata to product-declared kinds and omits `pluginFolders`, while single-kind detail retains the declarations (`1ede175b`). The measured payload is 298311 bytes, down from 329802, under the unchanged 300000-byte bound.
- Publication-wait fixtures select a scripted adapter and use queue/open spies without running an agent (`75a3d371`): 6 passes, 27 assertions. A separate refusal case verifies that pending publication does not bypass the declared plugin agent requirement.
- Historical evidence (the deferred-policy status is superseded by the owner decision below): The first responsive-fill reproduction failed during prepared-server setup before admission (0 passes, 2 failures, 1 error). An isolated rerun completed schema preparation in 3312.6 ms and reached HTTP 409 with the missing-agent refusal at `agent-fill/plugin.json:14` (0 passes, 1 failure, 1 assertion; 68.71 seconds). This confirms the isolated run belongs to the deferred no-agent group; it does not prove the cause of, or repair, the earlier setup timeout. Standalone and quarantine reproductions reached the missing-agent refusal at `agent-fill/plugin.json:14`; this record does not claim those runs are green or authorize native-workflow bypasses.

- Independent review identified disabled/omitted plugin-stage admission and cross-plugin prerequisite-completion regressions. Regression scenarios are included in this proposal; implementation fixes and final review are still pending. This is not a green review claim.

- CLI red/green: `test/fill-agent-options.test.ts` first failed on missing --agent; after implementation it passed with 4 assertions and prerequisite-only help text.
- Wiki focused red/green: 4 failures and 2 passes before fixing disabled controls, request options and selection closure; 6 passes afterward.
- Wiki bounded manual mutation restored the always-disabled agent selector and the enabled-control assertion detected it; production code was restored. This is not a Stryker run.
- Wiki check passed TypeScript and architecture with 0 violations; build passed with existing CSS, externalized-module and chunk-size warnings. Final wiki suite: 414 passed, 0 failed across 35 files after stale category expectations were migrated.
- All agent-facing tests use Scripted fixture fetch stubs. No real agent or model was invoked and no execution constants were changed.
