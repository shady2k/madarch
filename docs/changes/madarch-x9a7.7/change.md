# Return plugin fill scenarios to the blocking test shards

Change: madarch-x9a7.7
Base: 16d0caf41f5914df258c15dbb1c30e91f2e0b11b
Tasks: madarch-x9a7.7
Kind: no-behavior

## Intent

Run all six plugin fill scenarios in the blocking shards with headroom under
the 30-second single-file limit.

## Rationale

The two deterministic contract violations each wait for two five-second
backoffs. Set their test-only retry delay to zero and keep the existing retry
count. Run the 2,603-file case in its own file, where it can be measured and
sharded independently of the five smaller cases.

## Out of scope

Engine behavior, production retry policy, and the CI single-file threshold.

## Changes to requirements

None.

## Preserved contracts

- fill-orchestrator/plan: the selected kinds, their dependencies and the available general agent are still checked against the actual units and published rows.
- fill-orchestrator/attempt: the forbidden writes and reads still fail with the expected reasons and leave no forbidden or selected output.
- fill-orchestrator/publish: the 2,603 published rows still identify their producer and source evidence, and the independent producer still publishes when the system Git probe fails.

## Coverage

- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test

## Where it is seen

Kind: internal
Place: the blocking test shards and the single-file timing runner
Reason: the change affects test setup, timing evidence, and CI selection.

1. Run both plugin fill test files individually without the slow-test flag and check the timings and pass counts.
2. Check that both files are selected by the blocking sharded runner.

## Blocking questions

None.
