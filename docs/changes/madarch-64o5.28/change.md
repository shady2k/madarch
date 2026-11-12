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
- fill-stages/plugin-agent-admission: require an agent only when an enabled planned plugin requests one, with a prestart declaration-location refusal.

Complete proposed capability: `capabilities/fill-stages.md`. Existing stage
registry, configuration, snapshot and graph contracts remain unchanged; the
new requirements specify the product plugin fill path.

## Coverage

- fill-stages/plugin-declarations: static, test, mutation, review
- fill-stages/plugin-order: static, test, mutation, review
- fill-stages/plugin-selection: static, test, mutation, review
- fill-stages/plugin-agent-admission: static, test, review

## Where it is seen

Kind: command
Place: madarch fill --entity document.summary --agent scripted --token-cap 1000

1. Select a kind in the CLI or wiki fill page.
2. Review its transitive prerequisites and named producers.
3. If the plan requests an agent, choose one; otherwise start without one. Missing a required agent is refused before start with the plugin file and line and how to choose.
4. Read the final refined page with preserved sources.

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

## Acceptance evidence

- PR 280 busy-fill follow-up, `1cf7313e`: a read-only preflight reports an existing nonterminal chain before planning a new request or resolving its agent. It shares the orchestrator's existing terminal-state classification; atomic admission remains with the orchestrator. The filtered CLI case `the second fill says a fill is already running, since when, and how to follow it, with no internal code` passed with 11 assertions (1 pass, 1 filtered, 0 failures) using the existing deadline preload. The historical no-active-run case preceded the owner decision below; its deferred-policy status is superseded. No real agent was run.
- PR 280 native-reader follow-up, `bb100f77`: mapped kind counts are aggregated across the legacy native graph and canonical typed-opinion tables. Entity lookup reads both declared sources within one SQL snapshot, as listing already does, rather than returning early from the generated-table path. Valid typed fields remain; this is not an alias migration or native-kind exception. Focused validation across three files passed: 9 cases, 41 assertions, including the unchanged declared-entity cases.
- The final root `bun run check` passed after the count and lookup repairs (93.51 seconds). This is static validation, not a claim that the whole PR or its runtime checks are green.

- PR 280 follow-up, `1ede175b`: catalogue producer metadata now expands wildcard producers only over kinds declared by the product, not catalogue-only kinds. The catalogue summary omits `pluginFolders`; single-kind detail retains declaration metadata. The measured serialized starter payload fell from 329802 to 298311 bytes, below the unchanged 300000-byte bound. Focused pure checks reported 10 passes and 2565 assertions; no bound was raised.
- PR 280 follow-up, `75a3d371`: publication-wait fixtures explicitly select a scripted adapter for an accepted fill. Queue/open spies verify waiting and dispatch without executing an agent. The six focused cases passed with 27 assertions, including `pending publication does not bypass the declared plugin agent requirement`.
- Historical evidence (the deferred-policy status is superseded by the owner decision below): The first responsive-fill reproduction failed during prepared-server setup before admission (0 passes, 2 failures, 1 error). An isolated rerun completed schema preparation in 3312.6 ms and reached HTTP 409 with the missing-agent refusal at `agent-fill/plugin.json:14` (0 passes, 1 failure, 1 assertion; 68.71 seconds). This confirms the isolated run belongs to the deferred no-agent group; it does not prove the cause of, or repair, the earlier setup timeout. The standalone and quarantine reproductions still refuse at `agent-fill/plugin.json:14` when no agent is selected. Those observations predate the owner decision below; they are not evidence of repaired planner behavior. Unnamed CI hook failures are not attributed to a source file without matching log evidence.

- Implementation remains partial for the all-engine declaration-only goal: repository-tree/history are still native foundational stages, not ordinary plugin declarations. The owner's disk/git-as-plugin example is not migrated. Explicit native-prerequisite selection without an enabled plugin producer is refused; wildcard general-agent can cover it when enabled with a runnable agent. Full-run plugin targets use declared output union while native stages remain. This is a limitation, not a completed migration claim.

- Independent review identified disabled/omitted plugin-stage admission and cross-plugin prerequisite-completion regressions. Regression scenarios are included in this proposal; implementation fixes and final review are still pending. This is not a green review claim.

- `test/fill-target-selection.test.ts`: before implementation, 1 failure because derives-from was unknown; after implementation, 1 pass and 3 assertions. The fixture selects source and summary, not their dependant report.
- Implementation evidence and tracker check receipts are recorded separately by the coordinator after the final source revision. This observation is not a receipt for the full required checks.
