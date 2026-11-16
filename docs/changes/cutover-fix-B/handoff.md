# Cutover fix B: partial handoff

Branch: `foundation/cutover-fix-B`
Base: `origin/foundation/cutover-snapshot` (`eff3e64f`).

This is a partial result, not stage acceptance. No production storage or assertion-core file was changed. No new tables, compatibility aliases or fallback readers were added. No real agent was started.

## Implemented

Six test files now exercise decision 0039 items 2, 13, 24, 25 and 31 using parent-edge keys, host-authorized immediate writes, retained outcomes, shared fixture identity and immutable evidence entities. These are fixture corrections, not claims that the corresponding production foundation items are complete.

The final runs of the six changed files total 21 passed, zero failed. The imports run selected the two plugin-unit cases; its product-fill cases are still unresolved. All plugin-enabled diagnostic runs explicitly set `MADARCH_PLUGIN_SANDBOX=off` in the command only. This deliberately grants host-account access; no repository default changed.

## Per-file results

Timeouts mean incomplete results, never passes. Initial runs were isolated file by file with 90-second process bounds; selected off runs used 150 seconds, final diagnostics 40 seconds. The heartbeat validation used 140 seconds and imports-unit validation 30 seconds. These are command bounds, not changes to test constants.

| File | Cause / observation | Fix | Latest result |
|---|---|---|---|
| `agent-fill-bundle.test.ts` | No failure reproduced | Unchanged | 3 pass, 0 fail |
| `agent-fill-e2e.test.ts` | Run did not finish; root cause not established | Unfixed | 40-second timeout with sandbox off |
| `agent-unit-bound.test.ts` | Fixture lacked immediate-operation authority (0039.13,24) | Trusted operation callback | 3 pass, 0 fail |
| `bulk-file-opinions.test.ts` | Independent stores had unrelated identity namespaces (0039.2,25) | Shared explicit namespace and path origin | 1 pass, 0 fail |
| `consistency-plugin.test.ts` | Confined fills fail; sandbox-off run also stalls | Unfixed; not classified environment-only | 150-second timeout with sandbox off |
| `daemon-one-store.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `db-schema-path.test.ts` | Confinement unavailable; off run passes first two cases but stalls in product-fill section | Unfixed; not classified environment-only | 2 observed passes; 150-second timeout |
| `fill-already-running.test.ts` | First case passes; process did not finish | Unfixed | 1 observed pass; timeout |
| `fill-entities.test.ts` | Run did not finish; root cause not established | Unfixed | 40-second timeout with sandbox off |
| `fill-one-store.test.ts` | CLI fill fails; downstream store assertions cascade | Unfixed; root cause not established | Incomplete run, failures observed |
| `fill-orchestrator.test.ts` | 10-second case timeouts and closed-owner cascades | Unfixed; runtime root cause not established | Incomplete run, failures observed |
| `fill-run.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `fill-runs.test.ts` | Cancellation state reaches terminal before final progress emission; suspected duplicate run-state writer | Unfixed; see blocker below | 12 pass, 1 fail |
| `fill-states.test.ts` | Status request exceeds five seconds; no final summary | Unfixed | 90-second timeout |
| `fill-trace.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `fill-updates-before-fill.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `fill-updates-run.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `git-file-history.test.ts` | Pure git cases pass; fill failed under sandbox confinement | Unfixed; off rerun still needed | 10 pass, 1 fail |
| `imports-heartbeat.test.ts` | Missing operation authority and scalar repository key (0039.2,24) | Operation callback and parent-edge key | 1 pass, 0 fail |
| `imports-path.test.ts` | Expected only package vertices and repository evidence instead of immutable blob entities (0039.1,31) | Assert package vertices separately and SHA-256 blob evidence/content | 2 pass, 0 fail; 3 filtered in final targeted run; full off run timed out |
| `plugin-agent-edge-order.test.ts` | Fixture catalogue rejected: old reference fields, keys and unresolved text-list schema | Unfixed | 0 pass, 1 fail with sandbox off |
| `plugin-agent-fill.test.ts` | Fixture catalogue rejected; code.file absent and old reference fields/keys | Unfixed | 0 pass, 5 fail with sandbox off |
| `plugin-declaration-change.test.ts` | Prepared manifest missing at test line 91 | Unfixed; cause not established | 0 pass, 3 fail with sandbox off |
| `plugin-fill-access.test.ts` | Snapshot fixture used completed instead of published (0039.13) | Published terminal state | 13 pass, 0 fail |
| `plugin-fill-scenarios.test.ts` | Old repository evidence shape; retired generated wide tables and fill_event | Unfixed | 4 observed failures with sandbox off before 150-second timeout |
| `plugin-output-partitions.test.ts` | Confined fills fail; sandbox-off rerun did not finish | Unfixed; not classified environment-only | 40-second off timeout |
| `plugin-partial-problems.test.ts` | Legacy draft-buffer argument (0039.13,24) | Outcome callback; assert retained outcome | 1 pass, 0 fail |
| `plugin-support-reconciliation.test.ts` | Confinement failure reproduced; sandbox-off rerun did not finish | Unfixed; not classified environment-only | 40-second off timeout |
| `producer-lifecycle.test.ts` | Problem collides with system problem GraphQL type; later queries still use wide opinions | Unfixed | 0 pass, 1 fail |
| `queue.test.ts` | Same-tick enqueue order differs from expectation under pg-boss | Unfixed; ordering policy needs decision | 20 pass, 1 fail |
| `source-follows-fill.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |
| `trace-report.test.ts` | Run did not finish; root cause not established | Unfixed | 90-second timeout; no final summary |

## Blockers and remaining work

- `/work/cutover-fix-B/src/graph/operation-host.ts:101-118` writes `system.run.state` from the operation host, while `/work/cutover-fix-B/src/fill/orchestrator.ts:2178` calls it with `cancelled` before canonical cancellation settles. The paused-stop test observes a cancelled run and cancelled unit but misses `run-cancelled`. Suspect that the extra writer makes `settleRun` take its already-final return. This is a diagnosis to verify, not a tested fix. Reconcile the single run-state authority before changing the test.
- `/work/cutover-fix-B/test/plugin-fill-scenarios.test.ts:78` still queries generated wide tables and `node.key`; line 160 still queries `fill_event`. Move to typed assertion and progress readers without shrinking the assertions.
- `/work/cutover-fix-B/test/fixtures/plugin-declaration-scenarios/main.js:8` still emits repository/path evidence without an entity target. It needs real immutable evidence entities, not just a renamed field.
- `/work/cutover-fix-B/test/producer-lifecycle.test.ts:99` still reads title/detail/said_by/evidence from a wide opinion row. Its earlier GraphQL collision currently prevents reaching this reader. Both need correction.
- `/work/cutover-fix-B/test/plugin-declaration-change.test.ts:91` reads no published manifest after activation. Find why preparation/publication did not populate it.
- `/work/cutover-fix-B/src/product/manifest/kinds.ts:1888` rejects old fixture field declarations; agent fixture catalogue generation also leaves unresolved text-list schema references. Update fixture contracts before attempting agent turns.
- Queue same-tick ordering failed once. Do not weaken the test without confirming the ordering contract delegated to pg-boss.
- Fill/orchestration stalls remain unisolated. Available memory was 7.2 GB and disk had 18 GB free on the last check; load alone is not an established explanation. No assertion-core change is proposed without a smaller reproducer.

## Checks

- `bun run check`: FAILED at `/work/cutover-fix-B/test/graphql-executor.test.ts:340`, TS7053 (`allDemoFile` indexed on `{}`). Later root gates did not run. This file is outside this assignment.
- Wiki: frozen install, `bun run check`, `bun test` passed: 124 pass, zero fail, 587 assertions, 23 files.
- Changed test validations: 21 pass, zero fail, 81 assertions; imports validation filters out three cases.
- No mutation run was performed. No stage acceptance claimed.
- No UI or screen change; screenshots not applicable.

Assumptions: shared-store equality in the batch fixture requires one explicit identity namespace; accepted callback-only hosts are test doubles, not production authorization. No production constants changed.

## Document gate

```text
Document gate (feature) refused change cutover-fix-B, kind no-behavior.
A no-behavior change owes a rationale, preserved contracts ("- capability/requirement: why unchanged") with coverage for each, and no proposed capability files.
Checks it owes: static, test, mutation, review.
Capability document: docs/system/capabilities/fill-orchestrator.md (exists on the target).

  untracked-change: change/taskIds — a change names existing leaf tasks: file or split the task first

Guide: .shady2k/integration.md, "Document gate".
```
