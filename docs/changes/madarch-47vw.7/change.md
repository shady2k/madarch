# A fill that will not finish releases what it holds and publishes its end once

Change: madarch-47vw.7
Base: b1b9ceb27238dd19806e74929bff643878966f99
Tasks: madarch-47vw.7
Kind: no-behavior

## Intent

ALX-2023 / madarch-47vw.7, first part: after a fill failed, the wiki kept answering 409 and
its graph reads timed out until the daemon restarted, and a run whose plan refused stood
with no end at all. A run that will not finish now releases what it holds before it
publishes its end, and only the caller that moved the run publishes that end.

- **A run that will not finish releases what it holds before its end is published.**
  One path (`failAndSettleRun` in `src/fill/orchestrator.ts`) skips the units the run
  left, fails the run with the cause, settles the chain and then writes the end — only
  when this call is the one that moved the run. It is used by a refusal after the run
  began (a plan that refuses), a queue retry whose attempts are spent, an unexpected throw
  in the fill, and the api's own press when its job has no attempt left.
- **The cause is the one the run machine accepts from a started attempt.** The cleanup
  path took the run only from `created`, which is why a run already `planning` was never
  ended (`src/fill/fsm.ts` line 549 accepts `initialization-failed` from `created` and
  `process-ended` from `planning` and `running`). A started attempt that will not carry
  the run further now fails it with the cause the machine takes there.
- **The first end a run writes is its answer.** `writeFillEndIfAbsent`
  (`src/graph/fill-orchestration.ts`) reads `end_recorded` and writes the end in one
  write-locked transaction, so of two callers exactly one wins: a recovery racing a normal
  completion never replaces a `succeeded` end, and the press's fallback failure is
  published only by the caller whose transition moved the run.
- **A press whose job has no attempt left ends its own request.** The api's queued press
  asks the queue whether the job it was given still holds an attempt; a spent job leaves
  the run standing for no one, so the press moves the run itself and answers with its end
  instead of waiting for ever.
- **A request refused at admission ends too.** A press the product refuses because another
  run still holds the chain records its own end, so the pressing page answers rather than
  waiting behind a run that never started.

## Rationale

Kind `no-behavior`: the contract does not move. A run still ends before its end is
written, one product fills one run at a time, the graph keeps one writer, and a plugin
keeps its confinement. What changes is that every way a run can stop now reaches that
end, once.

## Out of scope

Same-run retry, queue-ownership proof and recovery decisions are the second part of this
task and land in their own commit. The ALX-1717 Step 1 stand replay, and any fill that
calls a model, are ALX-2025's and the owner's, on the preserved stand.

## Preserved contracts

- fill-orchestrator/completion: a run's end is written once the run finished, after its units, its chain and its store are settled, and a run that reached `succeeded` keeps that answer.
- fill-orchestrator/plan: a plan that refuses or finds a unit another run works ends the run with the refusal named, and the graph it read stays readable.
- fill-orchestrator/recovery: a run nothing moved for `RUN_ORPHAN_AFTER_MS` is recoverable; this part changes only what such a run leaves behind, not how it is chosen.
- fill-queue/fail: a failed attempt is retried by the queue while it has attempts left, and a job whose attempts are spent leaves the run ended rather than waiting.
- fill-queue/claim: the `fill-runs` job is the run's lock, and the singleton key holds one unfinished fill per product.
- fill-stages/registry: the stages and their plans are untouched.

## Coverage

- fill-orchestrator/completion: test
- fill-orchestrator/plan: test
- fill-orchestrator/recovery: test
- fill-queue/fail: test
- fill-queue/claim: test
- fill-stages/registry: test

## Where it is seen

Kind: internal
Place: the fill's run and its progress in the wiki, and `madarch fill` in a terminal
Reason: the change is a fill's own bookkeeping: a run that failed now ends, and the press that asked for it answers instead of waiting, while the pages a reader opens are unchanged.
1. A person presses a fill whose plan refuses: the run ends `failed` with the refusal named, the graph still opens, and the same product accepts a new fill without a restart.

## Blocking questions

None.

## DONE WHEN

- A run whose plan refuses, or whose queue attempts are spent, ends `failed` with its
  units skipped, its chain quiescent and its end written.
- A press that cannot start ends with a terminal answer, and the product accepts a new
  fill afterwards without a restart.
- A fallback failure never replaces an end the run already won.
