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
real agent or model execution; fabrication of owner process-approval receipts.

## Rationale

Kinds declare the data needed to fill them. Plugins are indivisible producers,
not engine-defined agent or deterministic categories. Invalid work must be
refused before an accepted run can silently do nothing. The owner's quoted “Да, ок” authorizes the task; no tooling approval receipt
is asserted by this record.

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

- PR 280 follow-up, `1ede175b`: catalogue producer metadata now expands wildcard producers only over kinds declared by the product, not catalogue-only kinds. The catalogue summary omits `pluginFolders`; single-kind detail retains declaration metadata. The measured serialized starter payload fell from 329802 to 298311 bytes, below the unchanged 300000-byte bound. Focused pure checks reported 10 passes and 2565 assertions; no bound was raised.
- PR 280 follow-up, `75a3d371`: publication-wait fixtures explicitly select a scripted adapter for an accepted fill. Queue/open spies verify waiting and dispatch without executing an agent. The six focused cases passed with 27 assertions, including `pending publication does not bypass the declared plugin agent requirement`.
- Historical evidence (the deferred-policy status is superseded by the owner decision below): The first responsive-fill reproduction failed during prepared-server setup before admission (0 passes, 2 failures, 1 error). An isolated rerun completed schema preparation in 3312.6 ms and reached HTTP 409 with the missing-agent refusal at `agent-fill/plugin.json:14` (0 passes, 1 failure, 1 assertion; 68.71 seconds). This confirms the isolated run belongs to the deferred no-agent group; it does not prove the cause of, or repair, the earlier setup timeout. The standalone and quarantine reproductions still refuse at `agent-fill/plugin.json:14` when no agent is selected. Those observations predate the owner decision below; they are not evidence of repaired planner behavior. Unnamed CI hook failures are not attributed to a source file without matching log evidence.

- Implementation remains partial for the all-engine declaration-only goal: repository-tree/history are still native foundational stages, not ordinary plugin declarations. The owner's disk/git-as-plugin example is not migrated. Explicit native-prerequisite selection without an enabled plugin producer is refused; wildcard general-agent can cover it when enabled with a runnable agent. Full-run plugin targets use declared output union while native stages remain. This is a limitation, not a completed migration claim.

- Independent review identified disabled/omitted plugin-stage admission and cross-plugin prerequisite-completion regressions. Regression scenarios are included in this proposal; implementation fixes and final review are still pending. This is not a green review claim.

- `test/fill-target-selection.test.ts`: before implementation, 1 failure because derives-from was unknown; after implementation, 1 pass and 3 assertions. The fixture selects source and summary, not their dependant report.
- Implementation evidence and tracker check receipts are recorded separately by the coordinator after the final source revision. This observation is not a receipt for the full required checks.


### Main integration merge and glossary profiling (2026-11-12)

The architecture reference was corrected before merging: repository facts now come from the declared ordinary disk and git plugins, not the deleted native repository-facts stage. Main `9bdeee93` was merged with a no-fast-forward merge, retaining its wiki kind pages, section graphs and fill-page presentation. The declaration-driven ordinary-plugin contract remains authoritative for fill semantics. Earlier partial-native observations above are historical, not the current implementation.

A fresh merged-source glossary baseline passed its first two cases but took 178.456 and 203.945 seconds. The corresponding fill spans were 164.917 and 196.618 seconds. These timings are a performance defect, not acceptance merely because the tests passed. Existing trace capture found repeated pre-invocation work and thousands of durable graph-read transactions; details and final measurements follow in the delivery report.

The import validator now indexes verified absolute paths instead of finding each dependency by a linear scan. Every file is still hashed and every reachable import is still checked. A tracked-read sequence index preserves the existing read and progress transactions. Glossary content reads use eight workers and restore original file order before extraction; no file or content is omitted. A pressed fill prepares sanitized pinned repository object stores once and still copies them into each invocation's private filesystem inputs; the run removes its source stores in a finally block. No existing limits or timeouts were raised.

Final validation and profiling receipts are recorded below after the allowed focused run settles. The new glossary worker bound is eight outstanding existing graph reads; it does not change the host's limits. The catalogue list no longer sends redundant `filled`, which is exactly `count > 0`; the wiki derives that value, and single-kind details retain it. Producer, agent, source and declaration information are preserved. The prior 300415-byte payload failure is not hidden by raising the 300000-byte bound.

The six-case glossary regression passed with 28 assertions in 864.87 seconds before the final durable-read batching follow-up. Its first two cases took 92.276 and 144.586 seconds; corresponding fill spans were 77.845 and 137.488 seconds. Run-owned preparation reduced the measured 25 repository-preparation spans from roughly 33–35 seconds to 1.529 seconds. The glossary unit remained 44.630 seconds, versus 44.798 seconds with only the sequence index: eight concurrent reads alone did not solve the lock bottleneck. Traces identify the per-run progress-row lock as the dominant concurrent wait, not glossary text processing. These are diagnostic timings, not a completed performance claim.

The repaired catalogue focused test passes with 3569 assertions and its original 300000-byte bound. Three focused file/manifest/startup conflict regressions pass with 28 assertions. The wiki fill/kind presentation checks pass 22 cases and 115 assertions after the payload repair. Full-suite and final enforced-sandbox acceptance remain delegated to CI; no CI run on `6ff27f3a` is claimed.

The durable-read follow-up coalesces concurrently completed graph reads within one attempt. Each batch takes the generation lock once and stores every original read in order, including repeated-query sequence updates. A separate transaction takes the run lock once and appends every progress event. Answers are released only after both commits and their own sink delivery. An event-transaction failure rolls back all its events while keeping the already committed read records. Execution and validation readers have separate closed scopes and drain outstanding calls before cleanup. The new focused sequence/rollback checks pass two cases and 21 assertions. No bulk graph API, reduced inventory, weakened assertion, combined read/event transaction, or raised limit was introduced.

Final-source focused validation: all six glossary cases pass (28 assertions, 761.51 seconds). The first two tests take 92.515 and 106.214 seconds, compared with the fresh merged baseline 178.456 and 203.945 seconds. Their fill spans are 78.211 and 98.212 seconds (baseline 164.917 and 196.618). In the second fill, execute/publish/scheduler totals are 62.262/7.070/18.982 seconds; repository preparation is 1.459 seconds and closure verification 5.242 seconds. The glossary unit takes 21.487 seconds, with 5603 counted SQL statements and 1105 transactions, compared with 44.630 seconds, 8869 statements and 4371 transactions before batching. Every original graph read and progress event remains durable; batching reduces locks and commits, not content or records. Aggregate SQL/transaction span durations may overlap and must not be read as wall time.

The final root and wiki checks pass; the root reports the same 18 listed SQL-layer architecture findings with no allowlist change. The seconds-level whole-fixture performance target remains unmet: passing the unchanged 300-second per-case bounds is not a performance acceptance claim. These source-level repairs are delivered with that residual explicitly unresolved. The old native 10.444655832-second measurement used a different product inventory and is not a controlled ratio against this fixture. No full suite or CI acceptance is claimed. Bundle prerequisite is the freshly fetched `origin/fix/madarch-64o5.30-28` at `6d19ce48f541f0f762f3d4b720c1be18a531fa70`.


### PR #280 functional CI follow-up (2026-11-12)

This follow-up is based on pushed commit `db44aae4`; it does not rewrite that history. Agent capability is not participation: wildcard gap availability does not schedule an agent. Explicitly configured agent invocations still require an available adapter before admission. Selected kinds with no configured producer receive durable per-kind `kind-abstained` events. Their missing prerequisites are not marked successful. A manifest without plugins still plans that ordinary stage and can complete with no invocations.

Ordinary graph reads now qualify JSON evidence values, avoiding collision with a declared text field named `place`. Graph verdict snapshots receive the published ordinary graph contract through their own database owner. The quarantine parser declares only its actual file prerequisite; its typed output references are unchanged. Fixtures now use ordinary declared identities, explicit scoped disk producers where extraction is required, and canonical code-kind table names. No native fallback, bound increase, omitted input file, or read/event transaction merge was introduced. One resolved SQL-layer architecture baseline entry was removed, not waived.

Validation is recorded in the delivery report; earlier failed diagnostic runs are not acceptance. The performance target documented above remains unresolved and was not the priority of this CI follow-up. The bundle prerequisite for this follow-up is `db44aae41dd6f08f241262bef9d3b7e8b77b841f`.

### Expanded CI validation (2026-11-13)

The owner-supplied 185-file list was run file-by-file in serialized batches. The first pass finished with 148 passing files and 37 failing files. A complete 37-file retry finished with 18 passing files and 19 failing files; subsequent focused reruns repaired more fixtures, but this is not a clean CI acceptance result. Raw per-file receipts and durable summaries are retained under `/tmp/m28-ci-{wide,retry,next,repair,recheck}-*` in the delivery workspace.

The final original 14-file rerun passed 12 files. `wiki-readers.test.ts` still hit unchanged 10-second case bounds with downstream errors; `wiki-fill-button-walk.test.ts` passed its two functional cases but failed its unchanged cleanup-hook deadline. Other unresolved receipts include the cached status 50-millisecond target, killed-parent PostgreSQL teardown within two seconds, multi-fill graph/MCP deadlines, product CLI/reset/linked-document fill bounds, disk-only tree-status presentation, and three consistency-fixture cases (the final focused receipt passed five cases but failed three). No timeout or size constant was raised, no input inventory was omitted, and no native fallback or architecture waiver was added.

Later focused reruns passed both agent integration files, the two-phase schema integration (real partial abstention followed by complete static publication), the repository server, tracker, selection and menu tests. Root checks and wiki checks passed; the root has 17 already-listed SQL-layer architecture findings. A fresh Linux build passed its graph-store smoke. Final delivery receipts state any remaining failures explicitly.

The retained ordinary disk profile keeps the complete seeded product, real closure inventory and five linked source files: first fill 61.379 seconds, changed-file fill 48.175 seconds. Changed-fill spans include 5481 SQL statements and 2288 transaction spans; their overlapping duration sums are not wall time. This is diagnostic evidence, not performance acceptance. The seconds-level goal remains unmet. Invocation-local immutable snapshot capture deduplication preserves every field binding and durable read/event record; it adds no cross-invocation cache.

### Main integration: #295 and #296

Merged `origin/main` at `14d70d12` into the PR checkpoint `97fd9bf2` with a real two-parent merge. Main's split `madarch/catalog.yaml` and per-kind `madarch/kinds/<area>/<subgroup>/<kind>.yaml` layout, roles, purposes, facts, manifest cache, run page and Fill button are retained. Declaration-owned fields, natural keys and `derives-from` are in the repository `catalog/` kind YAML files, copied into products unchanged. The union restores `code.gitlink`: 520 kinds and 75 page/member kinds. No native repository stage or graph publication fallback was restored.

Main's JSON-content language recognition was moved from deleted `repository-facts.ts` into `plugins/disk/reader.ts`. Main file facts now have real ordinary producers: disk publishes parent directory (`.` for root files); git publishes distinct exact-path non-merge commit count and maximum commit timestamp. Rename predecessor paths are not followed. Empty available history yields zero count and null date; the repository shallow-history signal remains independent. These choices match main's previous read projections while retaining ordinary provenance and selected-output publication.

Conflicted tests use split catalogue fixtures and canonical graph APIs. The original cap values and complete seeded closure inventory remain unchanged. Checks and targeted receipts are listed in the delivery report; the full suite was not run. No production sandbox acceptance is inferred from sandbox-off integration receipts. Known pre-merge failures remain diagnostic failures, not passing acceptance.

### Merge validation receipts

Both `bun run check` commands passed: root `/tmp/m28-main-merge-root-final.log`, wiki `/tmp/m28-main-merge-wiki-final-2.log`. Root reports 17 already-listed SQL-layer findings, no new waiver. All 17 conflicted root test files ran individually in serialized labelled batches, plus two repository-language files. Latest file-level outcomes: 16 pass, 3 fail. The remaining failures are consistency-plugin (five cases pass, three fail), graph-records (unchanged ten-second fixture hook), and repository-language-publication (unchanged sixty-second case). The latter preserves the real invalid-JSON to valid-JSON opinion replacement and no-op replay but cannot claim acceptance after timing out. All other conflicted root test files pass, including the final fill-selection rerun.

The conflicted wiki fill-setup test passes nine cases; main run page/Fill button tests pass nine cases; facts UI passes three cases; source facts passes four cases. Ordinary disk/git file-facts regressions pass two cases with 13 assertions, including exact-path rename history, merge exclusion and skewed commit dates. Split-folder preservation and cache tests pass 17 cases with 568 assertions after retaining transient plugin-declaration source errors as diagnostics rather than caching them. Full suite and new CI run were not performed. Earlier PR #280 performance/deadline failures were not claimed fixed by this merge.


### Owner-directed CI shared-cause repair after 7e98edd0

Grouped `/tmp/m28-ci-97fd9bf2.log` by first error line, without counting repeated summary echoes: 88 unique failures in 40 files; largest first-line family is `expect(received).toBe(expected)` (40 cases). Sixteen diagnostic blocks explicitly name the same upstream failure: the rolling runner's `/usr/bin/git` no longer matches the approved executable bytes. Disk repository failure then blocks its ordinary downstream producers, leaving partial fills and missing repository/file records. The exact byte refusal was correct; the release payload resolution was not.

The install now downloads a pinned Ubuntu Git package, verifies both archive and executable digests, and supplies that exact executable from `node_modules/.madarch-tools/git`; Linux x64 builds embed the same payload. The approved executable digest and plugin declarations are unchanged. Assumptions: Linux x64 install/build has `dpkg-deb` and existing ELF runtime dependencies. Other targets do not gain an approval or fallback. No deadline/cap changes.

Three independent fixtures were stale: refinement provenance must use entity detail rather than the deliberately value-only bounded prefix result; a pending-publication agent-refusal fixture must explicitly declare kind agent participation; and the UI's producerless empty example must have count zero because `filled` means a nonzero published count, independently of enabled producers. All substantive assertions remain, with a new populated-producerless UI case.

Consistency record APIs were incorrectly required to declare all catalogue kinds as executable inputs. The host already authorizes their specific `graphReads` rights; these named writer-record reads now retain that authorization without fabricating whole-catalogue prerequisites or self cycles. Entity value/files read guards and bounded cursor semantics stay intact.

Initial serialized local glossary-path validation passed all six cases (28 assertions); root check passed with the existing 17 SQL-layer findings and no new waiver. A new serialized per-file targeted batch covers all failure-map files except this already-run glossary and the separately validated UI, plus focused regression files. Final results will be recorded below; no full-suite success is claimed.


### CI7e repair checkpoint validation

### PR280 CI repair delivery

Base: 7e98edd0650dd1b3a3b36e0458d0228d2fcf9424. All repair commits carry Task: madarch-64o5.28.

Switched to /tmp/m28-ci-7e98edd0.log when it appeared: 91 unique failures across45 files, not180 summary markers. Maps /tmp/m28-ci7e-map.md and .json retain exact diagnostic evidence.

Largest shared cause repaired: rolling system Git differed from approved bytes. Install/build now supply verified pinned Git; executable verification and plugin pins unchanged. Read-only verified cache reuse fixed. Assumptions: Linux x64 Ubuntu runtime and dpkg-deb; unsupported targets gain no Git approval/fallback.

Other repaired groups: consistency record authorization by explicit graphReads (not whole catalogue prerequisites); declared subset starter output selection; explicit pending agent participation; ordered past durable-run fixtures; canonical provenance detail reads; complete repository-only fixture closure seeding; stage-qualified unit identity and inherited producer outcomes; current standing-file list/detail assertions; producerless UI count semantics. No existing deadlines, bounds or assertions weakened.

Latest serialized results: 36 passing / 11 failing or terminated files among 47 unique targeted root files. Additionally glossary-path6/0 and UI entities61/0 passed. Graph-records final17/0; consistency8/0; fill-selection,fill-runs,fill-run,loop-starter,selective-runtime,starter-selection-roles all pass. Passing root files:
- consistency-plugin.test.ts
- daemon-one-store.test.ts
- db-schema-path.test.ts
- fill-already-running.test.ts
- fill-entities.test.ts
- fill-one-store.test.ts
- fill-run.test.ts
- fill-runs.test.ts
- fill-selection.test.ts
- fill-states.test.ts
- fill-trace.test.ts
- fill-updates-run.test.ts
- graph-records-git-shapes.test.ts
- graph-records.test.ts
- graph-refinement.test.ts
- knowledge-close-verdict.test.ts
- knowledge-declared-entities.test.ts
- knowledge-entity-ids.test.ts
- knowledge-publication-state.test.ts
- knowledge-responsive.test.ts
- loop-starter.test.ts
- mcp-lock.test.ts
- mcp-product-repository.test.ts
- mcp-start.test.ts
- plugin-agent-edge-order.test.ts
- plugin-agent-fill.test.ts
- plugin-declaration-change.test.ts
- plugin-file-facts.test.ts
- plugin-fill-access.test.ts
- plugin-release-tools.test.ts
- roles-two-and-two.test.ts
- selective-runtime.test.ts
- starter-selection-roles.test.ts
- startup-template-publication.test.ts
- test-quarantine-fill.test.ts
- wiki-fill-button-walk.test.ts

Remaining failures/terminations (not a full-suite pass):
- knowledge-server.test.ts (exit 1; /tmp/m28-ci97-rerun-knowledge-server.test.ts.log)
- mcp-records.test.ts (exit 1; /tmp/m28-ci97-rerun-mcp-records.test.ts.log)
- repository-wiki.test.ts (exit 143; /tmp/m28-ci97-rerun-repository-wiki.test.ts.log)
- product-reset.test.ts (exit 1; /tmp/m28-ci97-rerun-product-reset.test.ts.log)
- wiki-readers.test.ts (exit 137; /tmp/m28-ci97-rerun-wiki-readers.test.ts.log)
- repository-language-publication.test.ts (exit 1; /tmp/m28-ci7e-rerun-repository-language-publication.test.ts.log)
- api-role-first-page.test.ts (exit 1; /tmp/m28-ci7e-rerun-api-role-first-page.test.ts.log)
- knowledge-page-budget.test.ts (exit 1; /tmp/m28-ci7e-rerun-knowledge-page-budget.test.ts.log)
- draft-starter-copy.test.ts (exit 1; /tmp/m28-ci7e-rerun-draft-starter-copy.test.ts.log)
- product-wiki-serve.test.ts (exit 1; /tmp/m28-ci7e-rerun-product-wiki-serve.test.ts.log)
- product-cli.test.ts (exit 1; /tmp/m28-ci7e-rerun-product-cli.test.ts.log)

Remaining causes: knowledge-server fill deadlines then dependent404/socket cleanup; mcp-records120s setup; product-reset120s fills; repository-language60s case; API warm status67ms vs50ms; page-budget history1758ms vs300ms; repository-wiki143 and wiki-readers137 interrupted runs; compiled starter-copy, product-wiki-serve and CLI repo-add failures require follow-up. Exact tails /tmp/m28-ci7e-remaining-failures.json. No test budget increased.

Root bun run check passed on final code: existing17 SQL-layer findings, no waiver, catalogue520 kinds/75 page kinds. Native Linux release build failed own-wiki first-run smoke because own-wiki.lock pins da8570d28369a5603613e1aadd23cb29cc8cf307 whose external product kinds still use depends-on and plugins lack produces. Did not rewrite embedded upstream product or bypass smoke; needs source migration and reviewed upstream pin. /tmp/m28-ci97-build-retry.log and tool-review report contain evidence.

Sandbox-off integration results do not establish enforced-sandbox acceptance. Performance target remains unmet. All started commands/workers settled before delivery; targeted queue was resumed after kernel shutdown, not falsely reported complete at interruption. New bundle is a repair checkpoint with explicitly remaining failures, not CI-green acceptance.

### Owner decision: system Git (2026-11-13)

The owner requires the installed system Git, approved by its resolved executable path and a minimum supported version, not an exact executable digest. The ordinary disk and git plugins must use that approved executable only. There is no bundled Git, pinned package download, extraction, cache, alias or fallback. Resolution and version approval follow the same code path on Linux, macOS and Windows. Other declared tools keep their existing byte approval requirements.

A missing or unsupported Git must name the executable/version found and the version required. Its affected producer kinds receive explicit durable per-kind outcomes. Unrelated producers still run; a Git failure is not a whole-fill preflight refusal. Existing immutable repository snapshots, declared graph/file reads and writes, sandbox isolation and publication rules remain unchanged.

Disk declares Git 2.40 for `check-attr --source`; history declares Git 2.31 for `log --diff-merges=first-parent`. These are the minimums required by their actual commands, not an arbitrary installed version. Validation evidence is recorded in the delivery report; this decision does not claim that the deferred reset/repeat-fill performance defect is repaired.

### Repeat-fill repair and bounded page reads (2026-11-13)

The exact one-file Problems fixture, with the same sample pages and committed newline repeat, measured native repeat fill 73.817 seconds before this repair and 45.126 seconds after it. The native `origin/main` comparison was 9.694 seconds. These are diagnostic sandbox-off measurements, not enforced-sandbox acceptance or a claim that the remaining gap is eliminated. The combined repair reduced repeat work from 42 to 39 units and plugin starts from 26 to 23; private closure snapshots fell from 6.423 seconds to 0.104 seconds. Nested span totals are not additive.

The disk plugin now carries the complete generated `linguist-languages` 9.5.0 dataset as one JSON file, including all 833 languages and every field. Exact equality against the existing root-pinned upstream package, deterministic regeneration, the upstream MIT license and complete third-party notice preserve the source and meaning. Its runtime no longer copies and imports the package's hundreds of tiny modules and declarations on every isolated turn. This is full-data packaging consolidation, not truncated repository inventory or changed partition limits.

Admission reuses only immutable successful publication metadata keyed by exact unit and generation. Current dependency state and generation are still checked inside the authoritative transaction; changed generations and unsuccessful outcomes use live queries. A concurrent-generation abstention regression test guards this boundary. Conservative slot checks avoid opening transactions for candidates already known to wait.

Neighbor blocks choose the same natural-key ordered identities and complete totals before loading the bounded rows' full opinions and evidence. Declared kinds, active opinions, base context, edge multiplicity, ordering and page snapshot semantics remain unchanged. Independent PostgreSQL stores stop asynchronously while retaining their exclusive usage locks until shutdown completes. No existing deadlines, assertions, caps, concurrency limits or isolation checks were relaxed.

The original Problems cache suite passes all four tests under its unchanged 60-second limit (repeat cases 52.7–56.7 seconds). The 69-test scheduler, producer lifecycle, plugin scenario and PostgreSQL ownership run passes, including exact-generation and independent-shutdown tests. The latest full page budgets and reset/wiki cleanup validation must be reported separately; these facts do not certify the whole PR green. Exact CI-wrapper relative-product execution was attempted without sandbox-off and was refused by the host's unchanged AppArmor user-namespace policy. No policy was weakened.

### Cold readers and shutdown follow-up

Measured cold reads exposed full source opinions fetched only to retain path/size/form/mode metadata, map reads fetched unused blob content and evidence, and pin dates fetched every changed path of a commit. Dedicated projections now preserve the full required inventory, contested-field agreement and language provenance without fetching unused columns or changed paths. The full file/commit APIs remain unchanged. Related blocks constrain identity reads to all declared opposite-end kinds of the actual relations and requested directions, then materialize only the bounded ordered rows.

Shutdown timing isolated a different cause: a busy server spent 5.7 seconds waiting for a background graph-verdict scan, while queue and owner close took milliseconds. Product close now cancels the scan between reads, still awaits its current database read and owner cleanup, and prevents partial verdict-cache publication. Normal validation remains complete. The original multi-file wiki-readers suite now passes all 17 tests including its unchanged five-second cleanup hook. Real PostgreSQL lifecycle guards pass 9 tests / 41 assertions, including close during a blocked snapshot read, rejected cancellation, no cache publication, and standalone-fill behavior. Pure verdict tests pass 44 tests / 139 assertions.

The cold repository page improved from 2.536 seconds to 1.713 seconds in one original run, advancing the test to a remaining cold-commit failure. Later native runs varied: a repository read at 2.004 seconds still exceeded its unchanged two-second limit by four milliseconds. These observations are not an all-budget acceptance claim. The final delivery report records the final untouched-suite result and enforced sandbox limitation. No assertion, deadline, graph bound or sandbox policy was changed.

Final untouched page-budget rerun: one pass, one failure, 16 assertions. Repository, folder and file checks passed before the cold commit page failed at 251 ms against the unchanged 200 ms bound; the separate warm-history test passed. This remains a repair checkpoint, not CI-green acceptance. Root and wiki checks pass on the final source.
