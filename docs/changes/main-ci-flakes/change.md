# Main's CI is green again: three flaky tests fixed at their cause

Change: main-ci-flakes
Base: dfdaba6612be29db7e6b779ee8a86a1692478f8d
Tasks: madarch-m38l.5
Kind: no-behavior

## Intent
Main's CI has been red since the merge of PR #146 (runs 39793194578 and 39829622009) although the
PRs were green. Three tests fail intermittently, each for a cause in the test:
- test shard 4, "(unnamed) ... a beforeEach/afterEach hook timed out" at 6051 ms: the preload's
  end-of-run `afterAll(remove)` in test/run-scratch.ts named no bound, so removing a scratch holding a
  file's databases and workspaces ran against the default; it now names 120 s.
- test shard 1, the ACP probe case "an agent without an adapter names what is missing": it asserted
  that the install command does not contain "-g", and the random scratch folder in the command
  (`madarch-test-run-g4ze8j`) can contain it; it now compares the command's arguments.
- wiki/app graph-diagrams.test.tsx "the app stops watching once the diagram is near": the test read
  its spied listeners when the deferral words rendered, before the effect that adds them ran; it now
  waits for the watching itself.

## Rationale
`no-behavior`: tests only, no product code and no requirement moves.

## Out of scope
- The old app's graph diagrams, which madarch-m38l.4 removes.

## Preserved contracts
- graph-queries/rebuild: no product code changes; the graph is still rebuilt from git alone.

## Coverage
- graph-queries/rebuild: test

## Where it is seen

Kind: internal
Place: the CI workflow's test shards and checks job
Reason: only tests change; nothing a person reaches changes.

1. A person opens main's CI and sees the checks and all test shards pass.

## Blocking questions
None.

## Design and decisions
Each fix is at the cause; no retry and no skip.

## Acceptance evidence
CI run of the pull request, and a pod run of the ACP probe and views-one-view files.

## DONE WHEN
- the three cases pass repeatedly on the pod and in CI.
