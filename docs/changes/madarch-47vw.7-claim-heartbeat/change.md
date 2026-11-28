# A fill's queue claim is the attempt's for its whole life, and a lapsed attempt writes nothing

Change: madarch-47vw.7-claim-heartbeat
Base: 2141fb1e3d1d2e01ce7218fbf1c018d2ad490b8a
Tasks: madarch-47vw.7
Kind: no-behavior

## Intent

ALX-2023 / madarch-47vw.7, part A of the ALX-2073 decision. On the preserved ALX-1717
stand (`fill-20261128T065548001Z`, ALX-2025) a fill lost its claim halfway and left the
product unfillable until the daemon restarted: the claim stopped being heartbeated
before the failed run's cleanup began, the cleanup took longer than the 30 s the queue
lets a claim stand untouched, the queue's own sweep handed the job to its next attempt,
and the stale attempt then wrote units, run and chain under the attempt that now held
it — while its settlement threw out of the fill role and ended `--role fill`. Three
parts of the fill's own bookkeeping change, and nothing else does.

- **The claim is beaten from the claim to the settlement, not only while the run
  drives.** `runOne` (`src/knowledge/fill-role.ts`) starts
  `startClaimHeartbeat` (`src/fill/run-jobs.ts`) on the job it was handed and stops it
  after the queue's settlement, so the store's open, the run, `finishKnowledgeStore`,
  the cleanup of a run that failed and `writeFillEndIfAbsent` are all inside the
  attempt's own liveness. The heartbeat the orchestrator's host keeps for a run
  (`beginRunHeartbeat`) stays as it is, for a direct `startKnowledgeFill(..., { claim })`
  caller the role does not start.
- **A failed run's cleanup is one write, taken only under the attempt's own claim.**
  `failAndSettleRun` (`src/fill/orchestrator.ts`) skips the units the run left, fails the
  run and records its progress in one write-locked transaction instead of one per unit
  plus one for the run: the residue ALX-2025 measured — 60 units `skipped` committed,
  then the run's own step refusing and rolling back, leaving the run `running` and its
  chain `active` for ever — can no longer be written, and 60 sequential transactions no
  longer outlive the claim. The fence the caller passes (`eligible`) is asked inside the
  same transaction, and its answer now has a name: the cleanup returns `lapsed`.
  `src/knowledge/fill-run.ts` passes the attempt's own claim, re-read with the queue
  (`queueService.isActive`) inside that transaction, so an attempt whose claim lapsed
  writes no unit, no run, no chain and no end, and reports
  `fill-orchestrator/claim-lapsed` instead of a failure of its own.
- **A settlement the queue refuses is the attempt that lapsed saying so.** The adapter
  throws the same refusal it threw before, now as `JobClaimLapsedError`
  (`src/adapters/pg-boss-queue.ts`), and `settleFillRun` answers `'lapsed'` for it
  instead of throwing. `runOne` logs it and returns without ending the run or
  exhausting retries, and the role's loop (`runFillRole`) catches anything else a job
  raises, says it aloud and asks for the next job — one bad job no longer ends the
  process that serves the product. A done settlement the queue refuses for the same
  reason (`complete` answering false) is answered `'lapsed'` as well.
- **A redelivery whose product cannot be read writes its end only as the claim's
  holder.** That path published an end before asking anything; it now asks the queue
  first, so a stale attempt leaves the end to the attempt that holds the job.
- **The regression is observed through the role, not asked of a helper.**
  `test/fill-run-recovery.test.ts` presses one live queued `KnowledgeProduct`, drives the
  real `runFillRole`, and holds it at two moments: the run's store opening, before the run
  has a heartbeat of its own, and the run's owner closing, after that heartbeat stopped and
  with the queue's settlement still owed. At each it reads the claim from the queue itself
  and requires it to be this attempt's — still `active`, untouched by a retry, and past
  the 30 s a claim lives without a touch. Released, the role settles and the queue
  completes the same attempt, never a retry of it. Deleting the role's beat, leaving it
  only beside `service.run`, or stopping it once the run's end is published each fails the
  case.

## Rationale

Kind `no-behavior`: the contracts stand. A run still ends before its end is written,
its units still release before it, one product fills one run at a time, the graph keeps
one writer, and a plugin keeps its confinement. What changes is that the attempt's
claim outlives its own cleanup, that the cleanup is all-or-nothing under that claim, and
that a lapsed claim is an answer the worker handles instead of an error that ends it.
The 30 s heartbeat interval, the one-retry allowance and the retry delay are untouched:
they remain the queue's rules, and an attempt that loses its claim still leaves the run
to the next one.

## Out of scope

The `--role fill` child's supervision and respawn (part B of the same decision), the
graph's mention contract for raw source blobs and progress diagnostics (ALX-2074), the
read-worker timeouts measured after terminalization (a separate probe), and the ALX-1717
Step 1 stand replay.

## Preserved contracts

- fill-queue/claim: the `fill-runs` job is the run's lock, and a claim that lapsed belongs to whoever holds it now — the attempt that lost it writes nothing.
- fill-queue/fail: a failed attempt is retried by the queue while attempts remain, and a job whose attempts are spent answers `failed`; a settlement that is not this attempt's is refused, now as `JobClaimLapsedError`.
- fill-queue/heartbeat: only the attempt that drives the run keeps its claim alive, and it now keeps it from the claim through the settlement.
- fill-orchestrator/completion: a run's end is written once the run finished, by the attempt that moved it, and a `succeeded` end is never replaced.
- fill-orchestrator/plan: a plan that refuses still ends the run with the refusal named; the cleanup it leaves is one write.
- fill-orchestrator/recovery: a run nothing moved for the window whose unit jobs and `fill-runs` job the queue no longer holds is still recoverable, and the fence that proves it is the caller's.
- fill-orchestrator/attempt: a unit's lease and fencing token decide whether its worker may publish; nothing here moves that.

## Coverage

- fill-queue/claim: test
- fill-queue/fail: test
- fill-queue/heartbeat: test
- fill-orchestrator/completion: test
- fill-orchestrator/plan: test
- fill-orchestrator/recovery: test
- fill-orchestrator/attempt: test

## Where it is seen

Kind: internal
Place: the fill's run and its progress in the wiki, and `madarch fill` in a terminal
Reason: the change is the fill's own bookkeeping: a run that failed now releases everything once, an attempt that lost its claim no longer writes, and `--role fill` survives it, while the pages a reader opens are unchanged.
1. A person presses a fill that fails midway: the run ends `failed` with its units skipped, its chain quiescent and its end written, once.
2. A fill role loses its claim to the queue's sweep: the next attempt carries the same run to its own end, the graph reads, and the product accepts a fresh fill without a daemon restart.

## Blocking questions

None.

## DONE WHEN

- The `fill-runs` claim of an attempt is heartbeated from the claim through the queue's
  settlement, and stops when that attempt's settlement is written or refused.
- A failed run's cleanup writes every unit skip, the run's `failed` step and its
  progress once, in one transaction, and a write the graph refuses at its last step
  leaves the run, its units and its chain exactly as they stood.
- An attempt whose claim lapsed writes no unit, run, chain or `fill_end`, reports
  `fill-orchestrator/claim-lapsed`, and its settlement answers `'lapsed'` instead of
  throwing.
- The fill role keeps serving after a lapsed settlement and after an unexpected error
  in one job, and the same role carries the run on under the queue's next attempt.
- The queue still holds the attempt that claimed a pressed fill across its setup, its run
  and the time after the run's own heartbeat stopped, and it completes that attempt once
  the role settles it.
