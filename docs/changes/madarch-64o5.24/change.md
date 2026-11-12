# Close each source-history fixture before the next test file

Change: madarch-64o5.24
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.24
Kind: no-behavior

## Intent
Keep the existing history assertions and their deadlines while ensuring a test
file releases every history it opens. A following case must not pay for database
sessions left by the preceding file.

## Rationale
The task records unrelated PR failures of the first store-version case near its
unnamed five-second bound. The shard starts `test/history-sources.test.ts`, then
`test/history.test.ts`. Bun 1.4.2 sorts paths before choosing a contiguous,
duration-balanced shard; its artifact sorts keys by duration instead and does
not record execution order.

A diagnostic run of the same timed shard on main reproduced a five-second
cleanup timeout in the first active history case. Opening its database took
216.63 ms and opening its owner took 46.72 ms. Closing the owner took 0.48 ms,
but dropping its database took 9,022.71 ms. The drop continued after the hook
timed out and overlapped the following case. This is evidence of cleanup cost,
not evidence that the history read itself needs a larger bound.

## Out of scope
- Changing production history, PostgreSQL lifecycle, or query semantics.
- Raising the case, hook, file, or global test deadline.
- Changing quarantine policy or claiming ten CI repetitions already passed.
- Changing shard count, balancing, or the timing seed.

## Changes to requirements
None. This is a test-fixture cleanup change. The product's behavior is preserved.

## Preserved contracts
- model-history/store-version: valid and recorded times still select the stored assertions.
- model-history/sources: reads still return the union of sources and refuse conflicting ids.
- model-history/replace: removing an element still preserves both time-axis reads.

## Coverage
- model-history/store-version: test
- model-history/sources: test
- model-history/replace: test

## Where it is seen
Kind: command
Place: `bun test test/ --shard=2/5 --timings=/tmp/shard-2.json --update-timings`

1. Copy `.github/workflows/test-timings.json` to a temporary shard timing file.
2. Run timed shard 2 with Bun 1.4.2 using that copy.
3. Observe `history-sources.test.ts` followed immediately by `history.test.ts`.
4. Inspect the assertions and cleanup results, not the duration-sorted artifact key order.

## Design and decisions
### Scenario: fixture owner is released
- Given: the source-history file opens histories through its fixture helper
- When: a case finishes, including an assertion failure
- Then: every history opened by that case is closed before the next case starts

### Scenario: the next file keeps its history assertions
- Given: the source-history file precedes the history file in timed shard 2
- When: the store-version cases run with their existing deadlines
- Then: the valid-time and known-time assertions are unchanged and the preceding file leaves no open history sessions

The fixture that opens a history owns its closure. Keep cleanup in the test
file's existing fixture lifecycle rather than changing production adapters or
adding time to hide an unclosed fixture. Diagnostic logging is temporary and
must not remain in the accepted change.

## Acceptance evidence
- Red: on main's timed shard 2, `nothing is returned before the commit's valid
  time` failed in its cleanup hook at 5,353.80 ms; its database drop later
  completed at 9,022.71 ms. The original first case is quarantined, so this red
  is the first active case, not a claim that the quarantined case ran.
- CI provenance: PR 278 run `43220817638` has 33 shard-2 files; main run
  `43212280903` has 32. The additional PR file is
  `knowledge-catalog-declaration.test.ts`. Both start with the same two history
  files by the pinned Bun algorithm.
- The full local diagnostic shard completed in 521.17 s: 166 passed, 22 skipped,
  4 failed across 32 files. All four failures were in `history.test.ts`: the
  first active case's cleanup hook, file-path persistence, legacy-digest refusal,
  and the exclusive-kind safety-net case. This is red evidence, not a passing
  shard. Its timing artifact update failed with EPERM, so the original copied
  timing file is not a measured output of this run.
- The exact PR 278 artifacts are publicly downloadable at
  `https://nightly.link/shady2k/madarch/actions/artifacts/13945347324.zip`
  (attempt 1) and
  `https://nightly.link/shady2k/madarch/actions/artifacts/13945939379.zip`
  (attempt 2). Their key order is measured-duration order, not execution order.
  Bun's pinned source establishes the path order:
  `https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/cli/test/Timings.rs#L149-L181`
  and the serial iteration at
  `https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/cli/test_command.rs#L2738-L2782`.
- Red-to-green scope: the red above is the existing first active case. The
  originally quarantined case did not run in that baseline; no red result for
  it is claimed. The restored original case's green result complements, rather
  than replaces, the first active case's regression evidence.
- Targeted green in the diagnostic shard after closing the preceding file's
  histories: the original quarantined store-version case, temporarily enabled
  for measurement, passed in 744.48 ms. Its phases were clone 315 ms, owner
  open 52 ms, write 66 ms, read 3 ms, and database drop 252 ms. The next case
  passed in 972.29 ms. The first snapshot showed zero leaked client sessions,
  compared with eleven before the fixture cleanup.
- The diagnostic shard after cleanup completed in 565.16 s: 165 passed,
  21 skipped, 6 failed, and 1 error. It is not a passing full shard. Own-store
  history timeouts remain, including the file-path persistence case and an
  idempotent case; two page-budget cold-limit assertions also failed, and an
  own-history PostgreSQL startup reached its 60-second bound. These failures
  are reported rather than attributed to or hidden by this fixture cleanup.
- Static checks passed twice. The final-source `bun run check` exited 0;
  its architecture report retained 18 baseline SQL violations and introduced
  none. The final source removes the temporary diagnostic hooks and prior
  phase console output; neither is part of the cleanup mechanism.
- Permanent ownership regression: the source-history file captures the run
  server's initial test-database names and checks that teardown restores that
  set. It verifies database ownership directly rather than relying on a time
  limit. With cleanup deliberately removed, the focused run produced 11
  passed and 1 failed with 29 assertions in 21.47 s: the regression expected
  no added databases and received eleven test-database names. Cleanup was
  restored afterward. This is a manual cleanup-removal mutation, not a
  Stryker run; it was detected by the ownership assertion.
- Final-source focused green: 13 passed, 26 filtered out, 0 failed, with 33
  assertions in 20.72 s across the two history files. The ownership assertion
  passes with cleanup restored. Bun ran `history.test.ts` before
  `history-sources.test.ts` for this explicit-file invocation: this result
  proves the focused checks, not the timed shard's file order. The earlier
  full diagnostic shard provides the same-order timing evidence.
- Independent bounded static review found no blocking issue in the cleanup's
  ownership chain. This was source inspection, not an independent runtime
  rerun. The final delivery `bun run check` also completed successfully after
  the focused regression run. No completed full-shard acceptance claim is made
  here; the failed full diagnostic run remains reported above.
- Feature document gate passes with `--candidate worktree --target origin/main`.
  Kind `no-behavior` does not require owner approval under the current policy;
  acceptance must report its actual check result, not an invented missing
  approval. No completed acceptance claim is made here.
- No owner approval is fabricated.

## Blocking questions
None.

## DONE WHEN
Each source-history fixture closes its histories on success and failure; the
unchanged history assertions pass after that file in timed shard 2; the task's
required repeated CI evidence and the document gate are satisfied without
raising deadlines or weakening assertions.
