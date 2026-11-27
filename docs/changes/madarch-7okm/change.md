# A touch the database did not answer no longer aborts a healthy attempt or discards the result its stage finished

Change: madarch-7okm
Base: f1c275289ba34eec5240a11aa573cabb76cac256
Tasks: madarch-7okm
Kind: no-behavior

## Intent

A long unit stage keeps what it finished. A single touch of its claim that the
database does not answer is recorded on the attempt and in the trace, and the
attempt carries on: the stage is not stopped, and the result it produced is taken
through the machine's own steps. Only the queue's own answer that the claim is no
longer alive, or the fence of the attempt's own step, decides that the claim
lapsed; a claim the fence refuses is still reported as lapsed and nothing is
published.

## Rationale

`attemptUnitPhases` touched its claim every third of `heartbeatSeconds` and treated
a rejected touch as a lost lease: the first rejection aborted the attempt's
`AbortController` — stopping a healthy forty-minute stage — and set a failure the
attempt re-threw after the stage had finished, so a finished result was thrown away
and the unit stayed `running` with a live job (`madarch-vmx9`'s class). A rejected
statement says the database did not answer the touch; it says nothing about the
claim. The queue already answers the question that matters, twice: `heartbeat`
answers `false` when the claim is no longer alive, and the attempt's own step is
fenced to its attempt and refuses with `ATTEMPT_STALE` when the claim lapsed — which
is the arbiter `attempt` and `publish` already name. The rejection is still evidence,
so it is written down: one line through the orchestrator's own `log` seam, and the
span's `madarch.heartbeatFailure` attribute. No requirement moves: this is the bug
its own task named, fixed without touching what the requirements ask.

## Out of scope

- `madarch-vmx9`: the second `running → retry_wait` transition dropped as a
  duplicate, and a `claim-lapsed` refusal that leaves the unit `running`, are the
  next change; nothing here touches the retry transition or the sweep.
- What a lapsed claim does to the unit's state: a `claim-lapsed` attempt still
  leaves the generation where it stands, as it does today.
- The queue's lease, its heartbeat interval and its retry policy.
- The stage interface: a stage's context, its signal and its progress are
  unchanged, so a stage that sees an abort still sees only a lease the queue said
  was lost or a cancellation.

## Changes to requirements

None: the arbiter of a lapsed claim stays the fence of the attempt's own step, as
it already reads, and no requirement ever asked for a failed touch to end an
attempt.

## Preserved contracts

- fill-orchestrator/attempt: no requirement moves: a worker still takes the lease, starts, runs its stage and takes the machine's own steps under the fencing token in force, and a step naming an older one is still refused.
- fill-orchestrator/publish: unchanged: one publication per unit generation, taken through the machine's own step, and a step whose fence refuses is reported as lapsed instead of published.
- fill-orchestrator/cancel: unchanged: a cancellation still revokes the attempt's authority through its controller, and the queue's own `false` answer to a touch still ends the attempt.
- fill-stages/registry: unchanged: no stage declaration, context or validation rule moves.
- server/protocol: unchanged: nothing this change adds is reachable from a route.

## Coverage

- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test
- fill-orchestrator/cancel: test
- fill-stages/registry: test
- server/protocol: static

## Where it is seen

Kind: internal
Place: `src/fill/orchestrator.ts`, `attemptUnitPhases`
Reason: a unit's attempt runs inside a fill, so the change is seen in a run's trace and its journal rather than on a page.

1. Run a fill whose unit stage is long enough to touch its claim several times,
   with one touch answered by a storage error. The stage finishes and the unit is
   published once; the run's log carries one line naming the job, the unit and the
   error, and the unit's span carries `madarch.heartbeatFailure`.
2. Run the same fill with the claim lapsed while the stage runs: the completion's
   fence refuses, the run records `unit-refused` with `fill-orchestrator/claim-lapsed`
   and nothing is published.

## Blocking questions

None.

## Design and decisions

- **The touch's rejection is recorded, not thrown.** A throw from the touching
  interval had nowhere to go but the attempt's own end, where it replaced the
  stage's result. The failure keeps the first error for the span, and every
  rejection writes one line through `FillOrchestrator.log` — the seam the
  orchestrator already declares for its own lines — so a reader of a run sees the
  touch that failed without a second durable record.
- **The in-flight touch is still awaited.** The attempt's `finally` clears the
  interval and awaits the touch it started, so a rejection that lands as the
  attempt ends is settled by the handler before the attempt returns and never
  reaches an unhandled-rejection handler. It is not a decision point any more.
- **The tests move the touch order by hand.** The queue a test lends answers the
  first touch for real, rejects the second, and marks the third; a stage that waits
  for the mark continues only after the rejection has been handled, whatever order
  the runtime runs its microtasks in, so no case sleeps or depends on a timer
  firing on time.
