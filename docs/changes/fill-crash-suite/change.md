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

Driving it found two ways an attempt's death could hold a run for ever, and closed
them. A unit is enqueued by the transaction that admits it, and a worker takes its
lease after it claims the job: a process killed in that window leaves the unit
`ready` with no lease, and the queue's own maintenance settles the abandoned claim
— with a queue declared with no retries of its own that frees the unit's singleton
key and leaves the unit with nothing for a worker to claim. The run's own sweep now
offers such a unit the queue again; the offer is idempotent, because while an
unfinished job carries the unit's key the queue creates nothing. And a worker
killed between its draft and its publication leaves the unit `draft` or
`validating`: the unit machine retried a lapsed lease only from `leased` and
`running`, so nothing could move that unit either, and the sweep's own fallback —
failing a generation with retries left — is refused, rightly, by the machine's own
`fail-cause` guard. The lapse is now retried from `draft` and `validating` too,
with the dead attempt's draft retracted. In both cases the run's evidence had gone
on counting the unit runnable while its chain stayed `active`, so nothing else
could ever fill that product.

## Out of scope

- Real stages and real agents: the suite's stages are the fixture's, as decision
  0027's own first work says, and no agent prompt is written or run.
- The fill's timed recovery: the suite never waits for a queue's own lease to
  lapse — a real-time wait is not a test — so it settles the claim a killed worker
  held by hand, which is what the queue's maintenance would do, and it moves the
  run's own clock by hand to expire the lease and bring a retry due.
- Any change to the publish, split, join, staleness or cancellation steps: the
  suite drives them as they landed. The one step that changed is the sweep's
  recovery of an attempt that never published, above.
- A kill between every machine step and its effect: the suite's interruption points
  are the queue's claim and settlement and the fixture's stages, which reach the
  windows around a claim, a split's seal and acknowledgement, a stage's read, a
  validation and a publication's own transaction. The windows no seam of this
  change reaches are the sweep's wake of a retry and its enqueue, a join and its
  enqueue, and an unblock and its enqueue; the recovery requirement covers them —
  a unit they leave `ready` is offered again by the next sweep — but no kill of
  this suite stands inside one, and that is named here rather than implied.
- A second publication request submitted by a live worker of the same generation:
  the duplicate and late results are submitted at the store's own publication
  interface, which is where the exactly-once rule lives (madarch-tzte.19.4's tests
  hold that interface), and the live-worker race is the PostgreSQL leg's "a worker
  that lost its fence publishes nothing", where a real executor's publication is
  refused by the token it lost.

## Rationale

Kind `behavior`: the change adds the recovery requirement to the fill orchestrator
and changes what the run does with a unit an attempt left without publishing —
the sweep offers a lost job again, and the unit machine retries a lapsed lease from
`draft` and `validating` as it already did from `leased` and `running`. Everything
else it holds to is the landed behavior, tested from outside.

## Changes to requirements

Added capability `fill-orchestrator` against an absent baseline. The proposal is
madarch-tzte.19.5's own, which landed as code but has not closed into the
specifications yet, plus one requirement this task's findings added: `recovery` —
what an attempt that never published left is worked again by the run's own sweep,
whether its job was lost before its lease or its lease lapsed while it stood
`draft` or `validating`. The integrator must close madarch-tzte.19.5 before this
change, so the specification ends as the proposal here rather than without the
requirement.

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
- **A failed claim is readable.** The fixture declares the run's queue with a dead
  letter queue of its own, which the production host does not: a queue declared
  without one answers no dead letters whatever happened to its jobs, so "the only
  job the queue failed for good is the claim the killed worker held" would be
  unreadable. Every test that recovers such a claim therefore holds the run to
  exactly one dead letter, and every other test to none.
- **What the suite's time is.** Nothing in it sleeps for time: every moment is the
  clock file the test writes, and every kill and pause is a seam. The only timers
  are the two on the pipe a driver's lines arrive through — the deadline that ends a
  hung phase with its own message instead of the runner's, and the interval it
  re-reads that pipe at — and the driver ends itself when the test that started it
  is gone, so no paused phase is left holding a core.
- **What the offer costs.** The sweep offers a job for every unit standing
  `ready` on every pass, which is one enqueue the queue answers with "nothing
  created" while the unit's own job is unfinished, and one created job when it is
  gone. A re-offered job names no priority: the unit lost the place its admission
  gave it when its job was lost, and being claimed after the work already queued
  is what keeps the offer cheap and its order explainable.
- **The daemon's own service is driven too.** One phase builds
  `createFillOrchestratorService` — the service the background server owns — over
  the same fixture and drives a run to its end through it, so the packaged binary
  covers the host path and not only the orchestrator's steps.
- **The refusal a raced sweep reports.** The lapse branch answers with the machine's
  own words when neither the retry nor the failure is allowed. With the lapse
  retried from every state a lease is held in, that is the branch of a unit another
  executor moved between this pass's read and its step — a race, not a resting
  state — and it exists so such a pass says what it could not do rather than
  passing the unit over. No test of this change reaches it, and none can without a
  second writer inside the same pass.
- **What the suite found.** Two ways for a killed attempt to hold a run for ever,
  both closed where they stand. `src/fill/orchestrator.ts`'s sweep offers a unit
  standing `ready` with no lease its job again, under the unit's singleton key, and
  reports `unit-requeued` as its own durable event. `src/fill/fsm.ts`'s unit machine
  retries a lapsed lease from `draft` and `validating` as well as from `leased` and
  `running`, which is what lets the sweep retry a worker killed between its draft
  and its publication. `test/fill-orchestrator.test.ts` holds every case:
  a lost job is found by the next pass, a unit whose unfinished job the queue still
  holds is offered nothing, a unit under a lease of its own is left to it, a unit
  left `ready` by a lost enqueue is offered again though its lease stands revoked,
  and a lease that lapsed while the unit stood `validating` is retried with its
  draft retracted and nothing published. The crash suite holds the end of each:
  the unit publishes exactly once after the worker that claimed it died before its
  lease, and again after the worker that died with its publication's transaction.
