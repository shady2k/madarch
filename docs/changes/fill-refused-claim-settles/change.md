# A worker whose step the machine refuses settles its claim, so a run survives a lease that lapses under a live worker

Change: fill-refused-claim-settles
Base: a2e497041b384ff7512975e282725a787f072b1e
Tasks: madarch-tzte.19.7
Kind: behavior

## Intent

madarch-tzte.19.7: main CI run 39192586611 failed the checks job in
`test/fill-crash-postgres.test.ts` — "the run never settled after the clock moved
4 times" — and the same tree passed the same job before and after it. The
PostgreSQL leg of the crash suite runs several executors at once, so the run's own
sweep can retry a lease that lapses under a worker that is still inside its stage:
the clock the suite moves by hand is the run's own, and the worker keeps working.
The failed report says what that leaves: `modules/left` stood `ready` with its
retry spent and its lease revoked at the moment of the retry, one publication
short, and the queue held exactly one unfinished job for it.

The cause is in the orchestrator, not in the suite's rounds or its clock. A
worker whose named step the unit machine refuses — `submit-draft`,
`validate-draft`, `block` or `wait-for-children`, each refusing because the unit
stands where another actor put it — answered `job: 'kept'` and settled nothing.
The claim it held is the unit's singleton key in the run's queue, which is
declared one unfinished job per key (pg-boss's `exclusive` policy: a unique index
over the name and the key for the states up to and including `active`), so every
later enqueue for that unit — the sweep's own retry job before it, and every offer
the sweep makes for a unit standing `ready` — was answered with "nothing created"
and vanished. The unit then rested `ready` with no job any worker could claim, and
the only thing that would free its key was the queue's own real-time lease, which
nothing in the suite waits for. PGlite's leg never shows it because its phases
never overlap: no clock move lands inside an attempt.

After this change the worker settles its claim at every refused step, with the
machine's own words as the reason, and the run keeps the refusal as its own
durable event (`unit-refused`), which is what the failed run had no trace of: its
report showed the unit's retry wake and nothing about the attempt that stopped.
The `keep` this replaces was a claim no one would ever settle again.

## Out of scope

- A claim whose worker was killed outright: it still stands in the queue until the
  queue's own maintenance expires it in real time, which is what the suite's
  `recover` phase models by settling such a claim by hand. That path is unchanged.
- The publication's own refusal: it already settles its claim, and its own
  `unit-blocked` event is left as it stands.
- The suite's round budget and its clock seam: no round or timeout changes, in
  either leg.
- Any change to the unit machine's transitions, the queue interface or the
  publication's transaction.

## Rationale

Kind `behavior`: the orchestrator changes what it does with a claim after the
machine refuses a step, and the run gains a kind of durable event. The capability's
`attempt` requirement gains the rule and its scenario; nothing else in the
specification moves.

## Changes to requirements

`docs/system/capabilities/fill-orchestrator.md`: the `attempt` requirement says a
worker shall settle the claim it holds when a step is refused, why that claim is
the unit's singleton key, and that the run reports the refusal as its own durable
event; the `refused-step` scenario holds it.

## Preserved contracts

- server/protocol: unchanged: nothing this change adds is reachable from a route, and the service the daemon owns is created, held and stopped as it landed.
- fill-queue/complete: unchanged: a settlement still names the claim it settles and is fenced to its attempt.
- fill-queue/enqueue: unchanged: a queue declared with singletons still creates nothing while an unfinished job carries the key.
- fill-stages/registry: unchanged: no stage declaration, context or validation rule moves.
- fill-orchestrator/publish: unchanged: a publication is still one transaction of the owner, and its own refusal still settles its claim.

## Coverage

- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test
- fill-queue/complete: test
- fill-queue/enqueue: test
- fill-stages/registry: test
- server/protocol: test

## Blocking questions

None.

## Design and decisions

- **The claim is settled by the worker, not by the sweep.** A sweep cannot settle a
  claim it does not hold: pg-boss fences a settlement to the attempt that claimed
  the job, and the queue's interface offers no way to settle the unfinished job of
  a singleton key. The worker that holds the claim is the only party that can let
  it go without a wait, and it is the party that knows why its attempt ended.
- **Completed, not failed.** The unit machine owns the attempt accounting: the
  generation stands in `retry_wait` with its retry spent, and its next job is the
  sweep's to offer. Failing the job instead would spend the queue's own retries and
  route a wake-up to the dead letter queue, which the suite reads as "the only job
  the queue failed for good is the claim a killed worker held".
- **A `unit-refused` event of its own.** `unit-blocked` names a state a unit
  stands in; a refused step is not one. The event carries the step, the machine's
  reason and what became of the claim (settled, or already the queue's own to
  settle), so a run that stops an attempt says so instead of leaving a reader with
  a wake that created nothing.
- **The tests open the window deterministically.** `test/fill-orchestrator.test.ts`
  makes the window from inside the stage: the stage's own `execute` moves the
  test's clock past the lease and runs the run's sweep, which retries the
  generation, and the step the worker comes back to is the one refused. The
  PostgreSQL leg pauses a worker at the suite's `execute` seam, moves the clock,
  sweeps from another process, and then reads the settlement off the suite's own
  recovery phase: it reports the claim `completed` — the run settled it — where a
  kept claim would be `active` for the suite to fail by hand.
- **What the fix leaves as it was.** A unit standing `ready` whose job the queue no
  longer holds is still offered the queue again on every pass, idempotently, and a
  unit under a lease of its own is still left to that lease. What changes is only
  that the run's own worker no longer leaves a claim for the queue's real-time
  clock to find.
