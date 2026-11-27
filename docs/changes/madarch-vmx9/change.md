# A unit whose attempt ended holds a retry or a terminal state, never `running`, and a run that cannot move says why

Change: madarch-vmx9
Base: f7b5c89b5b5231de5607d8ce27ca7e30c0ce0c99
Tasks: madarch-vmx9
Kind: no-behavior

## Intent

The `recovery` requirement already reads this way: a generation whose lease lapsed "shall be retried under
the cause the lapse is, whatever step the dead attempt had reached", and a unit the attempt left without
publishing "shall be made runnable again by the run's own sweep". The engine followed it for every state but
the one an attempt holds its lease in: a unit left `running` was left there for the life of the run, because
the sweep never moved it and the run's own evidence counts an in-flight unit — so the run never settled and
a host waited out its whole retry budget before reporting `state: running, settled: false`.

A generation now leaves `running` through the machine's own `lease-expired` retry, in one transaction with
the progress event that names it: the retry is scheduled at its moment (the sweep's wake enqueues it then),
or the generation fails when it has no retry left. Three places take that step:

- `claimLapsed`, for a refusal the attempt's own step ended in (`ATTEMPT_STALE`): the claim it holds is the
  attempt's own job, and the queue judges a settle by the job's state and its retry count, never by its
  lease, so an attempt whose lease lapsed by time settles its job in the same transaction as the step and
  frees the unit's key for the retry. A job the queue already gave to a later attempt, or settled on its
  own, refuses that settle, and then only a key no job of the queue holds ends the attempt.
- `sweepUnits`, for a unit standing `running` that no unfinished job holds: the queue's own answer, read
  through the new `QueueService.holdsUnfinished`, is what tells the sweep that nothing will finish it.
- nothing else: the queue hands one job out once (the units' queue is declared with `retries: 0`), so a unit
  standing `running` while a job for it is free is the sweep's case, and the attempt that claimed a job for
  such a unit takes no branch of its own.

A host no longer gives up on a run a pass can still move: `driveFor` keeps its wait, up to the budget,
while a unit the run owes stands `running` — the sweep ends an attempt the queue no longer holds, and one
the queue does hold is ended by the queue's own maintenance — and stops at once for a unit in another
non-terminal state that names no retry moment. Its report then names the units and the states that hold
the run.

## Out of scope

- The graph writer's duplicate rule: a value a source already states is still folded into that source's own
  assertion, and two sources' claims on one slot are still retained as their own assertions. The second
  `running → retry_wait` transition the task named is measured here as a step of its own (two retries, three
  attempts, the third publishing), and the unit state's only writer is the fill state machine, so the writer
  is untouched.
- The queue's lease, its heartbeat interval, its retry policy and pg-boss's own maintenance: a claim the
  queue already gave to a later attempt, or settled itself, is still the queue's to own, and
  `holdsUnfinished` only reads what the queue holds. What an attempt settles is the job it still holds
  itself, with the queue's own `complete`.
- What a `ready`, `blocked`, `waiting_children` or `retry_wait` unit does, the run's settlement guards and the
  run machine's own transitions.

## Rationale

The step that ends such an attempt is already in the table and nothing took it: `running → retry_wait` with
cause `lease-expired`, which names no live attempt's fence because the attempt it ends is gone. Two pieces
were missing. First, who settles a claim that lapsed by time: the queue's maintenance moves such a job to
`failed` only on its own pass, at most once per monitor interval, while the attempt that still holds the job
can settle it at once, because `complete` fences on the job's state and its retry count and not on the
lease — the case a real fill meets, where nobody dies and nothing is handed on. Second, the question the
sweep could not ask — "does the queue still hold a job for this unit?" — whose answer is one indexed row of
the queue's own table (`holdsUnfinished`, the predicate of pg-boss's exclusive index), read inside the
sweep's transaction. The alternative, offering the job with `enqueue` and reading
`created`, writes on every pass and takes the queue's ordering locks to answer a question. A lapsed attempt
spends a retry of its generation where it has one, which is what the `recovery` requirement asks and what
`retryAttempt` already does for a spent budget.

## Changes to requirements

None: the `recovery` requirement already asks for a lapsed attempt to be retried whatever step the dead
attempt had reached, and this change is what makes the engine do it for the state an attempt holds its lease
in. No capability document changes.

## Preserved contracts

- fill-orchestrator/attempt: no requirement moves: a worker still takes the lease, starts, runs its stage and takes the machine's own steps under the fencing token in force, and a step naming an older one is still refused. A stage that raised still spends a retry rather than failing its unit.
- fill-orchestrator/publish: unchanged: one publication per unit generation, and a step whose fence refuses is still reported as lapsed, never published.
- fill-orchestrator/recovery: the sweep still offers a `ready` unit its job again, still leaves a leased attempt alone until its lease lapses, and now also ends the attempt of a `running` unit whose claim the queue no longer holds — under the same cause a lapse is retried with. An attempt its own operation refused with `claim-lapsed` ends its generation itself, and settles the job it still holds in the same transaction.
- fill-orchestrator/completion: unchanged: a run finishes with what it covered, and a run still owing a retry or an in-flight unit still does not finish; the unit that held it open is now a `retry_wait` it can finish, not a `running` it cannot.
- fill-orchestrator/host: a run that settles is reported as before; a run that does not settle names the units and the states that hold it. The host keeps its retry wait while a unit the run owes stands `running` — a pass can still end that attempt — and stops it at once for a unit in another state that names no retry moment.
- fill-stages/registry: unchanged: no stage declaration, context or validation rule moves.
- server/protocol: unchanged: nothing this change adds is reachable from a route.

## Coverage

- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test
- fill-orchestrator/recovery: test
- fill-orchestrator/completion: test
- fill-orchestrator/host: test
- fill-stages/registry: test
- server/protocol: static

## Where it is seen

Kind: internal
Place: `src/fill/orchestrator.ts`, `src/fill/orchestrator-host.ts`, `src/adapters/pg-boss-queue.ts`
Reason: a lapsed attempt ends inside a run, so the change is seen in the run's journal, its trace and the report of a run that did not settle, rather than on a page.

1. Run a fill whose unit stage outlives its lease while its worker is still alive: the attempt's next operation is refused with `claim-lapsed`, the attempt settles the job it holds, and the run records the refusal and the retry — the unit is `retry_wait` with its retry moment named and its key free, the attempt after it publishes, and the run succeeds without waiting for the queue's maintenance.
2. Kill a worker inside its attempt and let the queue expire its claim: the host keeps its wait, the queue's maintenance settles the claim, the sweep ends the attempt through the same step, and its retry publishes.
3. Leave a generation with no retry the same way: the unit fails and the run ends `failed` rather than waiting out the budget.
4. Ask a host to drive a run nothing can move — a unit standing `blocked`, say: its report names the units and the states that hold it, at once.

## Blocking questions

None.

## Design and decisions

- **The queue answers what it holds.** `QueueService.holdsUnfinished(queue, singletonKey, transaction?)` reads one row of the queue's own job table (`state <= 'active'`, pg-boss's exclusive-index predicate) inside the caller's transaction when one is given. It creates nothing, so a sweep may ask it of a unit standing `running` on every pass.
- **A claim in hand is settled by the attempt that holds it.** `complete` fences on the job's state (`active`) and its retry count, never on its lease, so an attempt whose lease lapsed by time settles its own job, and one the queue gave to a later attempt refuses it. After the settle the same transaction asks `holdsUnfinished`, which then answers whether the key is really free: a key still held is an attempt this pass must not end.
- **The step is the machine's own.** `running → retry_wait` with cause `lease-expired` and no fence (the attempt it names is gone), or `running → failed` with cause `retries-exhausted` naming the generation's recorded fence. Each writes the transition, the progress event and (for a retry) its moment in one transaction of the owner.
- **The retry's job is offered by the wake, not by the step.** The sweep's `retry_wait` branch already enqueues a unit whose moment came, so ending an attempt only schedules the moment; a job the caller held is settled, never re-created.
- **The budget is for retries that are due and for attempts only time ends.** `driveFor` waits while a unit the run still owes names a retry moment, or while one stands `running` — a pass still moves that unit, either by ending an attempt the queue let go of or once the queue's maintenance does. A unit in another non-terminal state that names no moment stops the wait at once, and `stoppedBecause` names the units and states that hold the run.
