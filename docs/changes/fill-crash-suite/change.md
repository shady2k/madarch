# A crash-injection suite drives the compiled fill through kills, duplicates, late results, cancellation and a disabled producer

Change: fill-crash-suite
Base: 5c712dea9b05a1993ffe6ed8fd0035c985350df8
Tasks: madarch-tzte.19.6
Kind: behavior

## Intent

Decision 0027's first work is "a crash-injection prototype with fake agents, built
as the compiled binary: extractor → splitting unit → child summaries → parent join
→ consumer, on persistent PGlite and on PostgreSQL with several executor
processes; killing processes around claim, split, publication and
acknowledgement; duplicate and late results; an empty query turning non-empty;
cancellation during validation; a disabled required producer". The orchestrator
(madarch-tzte.19.5) landed with tests that drive its steps in one process; nothing
kills a process, nothing runs two executors at once, and the packaged binary has
never carried a fill.

After this change madarch has that suite: `test/fill-crash-driver.ts` is one
program the suite builds with `bun build --compile` — the fill's orchestrator over
a fixture chain of three fake stages on one database — and it runs one phase per
process, dying or pausing at a named point of a unit's life.
`test/fill-crash-suite.test.ts` drives it on a persistent PGlite folder and
`test/fill-crash-postgres.test.ts` runs three of its processes at once against the
PostgreSQL server `MADARCH_TEST_POSTGRES_URL` names, which CI's checks job starts.

Driving it found one gap and closed it. A unit is enqueued by the transaction that
admits it, and a worker takes its lease after it claims the job: a process killed
in that window leaves the unit `ready` with no lease, and the queue's own
maintenance settles the abandoned claim — with a queue declared with no retries of
its own that frees the unit's singleton key and leaves the unit with nothing for a
worker to claim, for ever, while the run's evidence still counted it runnable and
its chain stayed `active`. The run's own sweep now offers such a unit the queue
again; the offer is idempotent, because while an unfinished job carries the unit's
key the queue creates nothing.

## Out of scope

- Real stages and real agents: the suite's stages are the fixture's, as decision
  0027's own first work says, and no agent prompt is written or run.
- The fill's timed recovery: the suite never waits for a queue's own lease to
  lapse — a real-time wait is not a test — so it settles the claim a killed worker
  held by hand, which is what the queue's maintenance would do, and it moves the
  run's own clock by hand to expire the lease and bring a retry due.
- Any change to the publish, split, join, staleness or cancellation steps: the
  suite drives them as they landed.

## Rationale

Kind `behavior`: the change adds the recovery requirement to the fill orchestrator
and changes what the run does with a unit whose job the queue lost. Everything
else it holds to is the landed behavior, tested from outside.

## Changes to requirements

Added capability `fill-orchestrator` against an absent baseline. The proposal is
madarch-tzte.19.5's own, which landed as code but has not closed into the
specifications yet, plus one requirement this task's findings added:
`recovery` — a unit left `ready` by an attempt that never took its lease is
offered the queue again by the run's own sweep, idempotently. The integrator must
close madarch-tzte.19.5 before this change, so the specification ends as the
proposal here rather than without the requirement.

## Preserved contracts

- server/protocol: the server's own routes, answers and shutdown order are unchanged; the service the daemon owns is still created, held and stopped the way madarch-tzte.19.5 landed it, and nothing this change adds is reachable from a route.

## Coverage

- fill-orchestrator/plan: test
- fill-orchestrator/admit: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/join: test
- fill-orchestrator/staleness: test
- fill-orchestrator/publish: test
- fill-orchestrator/cancel: test
- fill-orchestrator/completion: test
- fill-orchestrator/recovery: test
- fill-orchestrator/host: test
- server/protocol: test

## Blocking questions

None.

## Design and decisions

- **One driver, many phases.** `test/fill-crash-driver.ts` reads a JSON spec (the
  database, the three seams the test moves by hand, the product, the run, the
  limits, the interruption and the phase), runs one phase, prints one JSON line
  and exits. A phase is `plan`, `run`, `sweep`, `report`, `cancel`, `recover`,
  `resubmit` or `service`: the test asks a process for exactly the step it wants
  and judges the line, so no assertion is made inside the program under test.
- **Time, the graph and the inputs are files.** The clock is a file whose text is
  the epoch milliseconds every phase reads, the graph is a file of rows by query
  and the inputs are a file of what each unit's facts stand on: one test moves any
  of them while a phase is frozen in the middle of a unit, and no test sleeps.
- **A kill is a seam, and so is a pause.** The driver's interruption stands at six
  points of a unit's life: `claim` (the queue handed the job over, nothing leased),
  `execute` (inside a stage, after its tracked read), `validation` (inside the
  stage's own `validate`), `split` (the split's transaction sealed its children and
  revoked the parent's lease, the job not yet acknowledged), `publication` (inside
  the publication's transaction, the machine's step taken and the facts not yet
  applied) and `acknowledgement` (after the publication's transaction committed).
  A crash kills the process where it stands; a pause holds it until the test writes
  a byte on its standard input, which is how one executor acts while another is
  frozen inside a unit. Every line a kill or a pause prints names the claim the
  process held, so the next phase settles exactly that claim.
- **The queue's own recovery, without waiting.** A claim a killed worker left is
  settled by the recovery phase, which first runs the queue's maintenance pass and
  then settles the claim itself when it is still the one in force — the same
  settlement the queue's timed sweep would make — and reports the state a claim
  that was already settled stands in, which is how the suite shows that a
  publication's own transaction settled its job.
- **The daemon's own service is driven too.** One phase builds
  `createFillOrchestratorService` — the service the background server owns — over
  the same fixture and drives a run to its end through it, so the packaged binary
  covers the host path and not only the orchestrator's steps.
- **What the suite found.** `src/fill/orchestrator.ts`'s sweep offers a unit
  standing `ready` with no lease its job again, under the unit's singleton key, and
  reports `unit-requeued` as its own durable event. `test/fill-orchestrator.test.ts`
  holds the two cases of it — a lost job is found by the next pass, a unit under a
  lease of its own is left alone — and the crash suite holds the end of it: the unit
  publishes exactly once after the worker that claimed it died before its lease.
