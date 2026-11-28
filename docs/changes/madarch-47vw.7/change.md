# A pressed fill's run ends with its units, its chain and its end, and a retried job carries its run on

Change: madarch-47vw.7
Base: b1b9ceb27238dd19806e74929bff643878966f99
Tasks: madarch-47vw.7
Kind: no-behavior

## Intent

ALX-2023 / madarch-47vw.7: after a fill failed, the wiki kept answering 409 and its
graph reads timed out until the daemon restarted, and a run whose plan refused stood
with no end at all. Two causes, one part of the patch each.

- **A run that will not finish releases what it holds before its end is published.**
  One path (`failAndSettleRun` in `src/fill/orchestrator.ts`) skips the units the run
  left, fails the run with the cause, settles the chain and then writes the end — only
  when this call is the one that moved the run. It is used by a refusal after the run
  began (a plan that refuses), a queue retry whose attempts are spent, an unexpected
  throw in the fill, and the api's own press when its job has no attempt left. The cause
  is the one the run machine accepts from a started attempt: `initialization-failed`
  only from `created`, `process-ended` from `planning` and `running` (`src/fill/fsm.ts`
  line 549).
- **The first end a run writes is its answer.** `writeFillEndIfAbsent`
  (`src/graph/fill-orchestration.ts`) reads `end_recorded` and writes the end in one
  write-locked transaction, so of two callers exactly one wins: a press that lost the
  run's transition keeps waiting for the end the winner writes, and a `succeeded` end is
  never replaced by a fallback failure.
- **A retried job of a run is that run's own retry, not proof its process died.**
  `startRun` reads `claim.job.attempt >= 1` as "the process that ran it ended" no more
  (`src/fill/orchestrator.ts`): an attempt validates the claim it was given
  (`queueService.isActive`), and a lapsed claim refuses with
  `fill-orchestrator/claim-lapsed` instead of ending the run the retry names. An attempt
  whose run has not settled while the queue still holds an attempt for it returns
  `retryable` and publishes nothing: the run keeps standing, its end is written by the
  attempt that finishes it, and the claim's heartbeat lives only as long as the attempt
  that drives it.
- **A live long-running fill is not recovered.** Recovery asks the queue, not only the
  rows: `recoverOrphanedRun` sweeps the run's unit claims first (`queue.recover`), reads
  the run's last activity from its own row and its units' rows (`lastRunActivityAt`), and
  refuses to recover a run whose unfinished unit job the queue still holds
  (`holdsUnfinished`). The negative claim check is repeated inside every write-locked
  step that skips a unit or fails the run (`failAndSettleRun`'s `eligible` under
  `controlWrite`/`lockFillScope`), so the "nobody holds it" answer is taken under the
  fence that serialises the run's writes. A queue read that fails counts as "held": a
  failed read is no proof of abandonment.
- **A press that adds nothing to a running fill ends its own request.** The api's queued
  press sweeps the product's queue and asks again; a job the queue still holds is a
  process that died without settling and the sweep hands it to the next attempt, while a
  job that is genuinely queued or running ends this press's request with a terminal
  answer instead of leaving the page waiting behind it.
- **A job is acknowledged only for the end it published.** The fill role settles its
  `fill-runs` job done only when the run's end is durable afterwards: an attempt that
  failed before it built its service published no end at all (a run already `planning`
  or `running` takes none from `failRequestedFill`), so the queue's next attempts carry
  the run and the last one ends it, instead of a completed job leaving the press waiting
  for an end no process writes.
- **A request refused at admission ends too.** A press the product refuses because another
  run still holds the chain records its own end, so the pressing page answers rather than
  waiting behind a run that never started.

## Rationale

Kind `no-behavior`: the contract does not move. A run still ends before its end is
written, one product fills one run at a time, the graph keeps one writer, and a plugin
keeps its confinement. What changes is that every way a run can stop now reaches that
end, once, and that a run a worker still holds is not ended under it.

## Out of scope

The ALX-1717 Step 1 stand replay, and any fill that calls a model: both are ALX-2025's
and the owner's, on the preserved stand.

## Preserved contracts

- fill-orchestrator/completion: a run's end is written once the run finished, after its units, its chain and its store are settled, and a run that reached `succeeded` keeps that answer.
- fill-orchestrator/plan: a plan that refuses or finds a unit another run works ends the run with the refusal named, and the graph it read stays readable.
- fill-orchestrator/attempt: a unit's lease and fencing token are what decide whether its worker may publish, and this part only asks the queue whether such a lease stands.
- fill-orchestrator/host: the host drives an attempt and stops its heartbeat when the attempt returns, whichever way it returns.
- fill-orchestrator/recovery: a run nothing moved for `RUN_ORPHAN_AFTER_MS` whose unfinished unit jobs the queue no longer holds is recoverable, and that proof is taken under the run's write fence.
- fill-queue/claim: the `fill-runs` job is the run's lock, its claim is the attempt's, and a claim that lapsed belongs to whoever holds it now.
- fill-queue/fail: a failed attempt is retried by the queue while it has attempts left, and a job whose attempts are spent leaves the run ended rather than waiting.
- fill-queue/heartbeat: a claim is kept alive only by the attempt that drives the run it names.
- fill-stages/registry: the stages and their plans are untouched.

## Coverage

- fill-orchestrator/completion: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/host: test
- fill-orchestrator/recovery: test
- fill-queue/claim: test
- fill-queue/fail: test
- fill-queue/heartbeat: test
- fill-stages/registry: test

## Where it is seen

Kind: internal
Place: the fill's run and its progress in the wiki, and `madarch fill` in a terminal
Reason: the change is a fill's own bookkeeping: a run that failed now ends, a run a worker still holds is left alone, and the press that asked for it answers instead of waiting, while the pages a reader opens are unchanged.
1. A person presses a fill whose plan refuses: the run ends `failed` with the refusal named, the graph still opens, and the same product accepts a new fill without a restart.
2. A person presses a fill while another one runs: the existing run is left as it is, and the second press answers instead of being refused until the daemon restarts.

## Blocking questions

None.

## DONE WHEN

- A run whose plan refuses, or whose queue attempts are spent, ends `failed` with its
  units skipped, its chain quiescent and its end written.
- A press that cannot start ends with a terminal answer, and the product accepts a new
  fill afterwards without a restart.
- A retried `fill-runs` job drives the run it names to that run's own end.
- A run that published or moved inside the recovery window, or whose outstanding unit job
  the queue still holds, is not recovered by another caller, and a queue read that fails
  is no proof of abandonment.
- A job settled done carries a run whose end a press can read: an attempt that published
  no end leaves its job to the queue's next attempt, and the last attempt ends the run.
