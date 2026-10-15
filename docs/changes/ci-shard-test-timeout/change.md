# Keep the repeated model-view check within a reliable test deadline

Change: ci-shard-test-timeout
Base: e2eb2bcc41fd8c65283d9bcf41407ef5edbe82cb
Tasks: madarch-o83b
Kind: no-behavior

## Intent
The existing model-view test checks that a repository checked twice produces byte-identical views. In PR CI run 38749252649, that test took 5,072 ms and exceeded Bun's default 5,000 ms test deadline by 72 ms. Its isolated local run took 4,722 ms. Give this one two-render test 15 seconds so normal scheduling variation does not make the CI suite fail before it checks the same output.

## Rationale
This changes only the test runner's deadline. The model-check implementation, fixture, expected bytes, assertion, and rendered output stay unchanged. The sharded suite cannot be accepted while this existing check sometimes times out at its 5-second default.

## Out of scope
- Changing model-check output, behavior, or requirements.
- Changing any other test's timeout or the Bun-wide default.
- Changing shard count or timing allocation.

## Changes to requirements
None. This is a no-behavior test reliability change.

## Preserved contracts
- model-check/views: with a compiled model and requested views folder, the check renders the model's views into that folder. The test continues to check that a second run produces exactly the same files; only its per-test deadline changes.

## Coverage
- model-check/views: test

## Blocking questions
None.

## Design and decisions
Set the test timeout to 15,000 ms on the repeated-render test alone. Keep the 5-second default for all other tests. The focused test and `bun run check` are run locally; PR CI verifies all test files, preserved workflow checks, and shard coverage.

## Acceptance evidence
The task `madarch-o83b` carries passed `static`, `test`, `mutation`, and `review` receipts at revision `5dcb760532a9f253`. PR run `38749252649` verified exact-once coverage for 89 root test files and recorded every shard below 10 minutes, but failed the old 5-second timeout. Final post-fix PR CI integration evidence is pending.

## DONE WHEN
The focused rendering assertion passes under the explicit 15-second deadline; the PR CI suite and exact-once check pass; all five shard job times remain below 10 minutes.
