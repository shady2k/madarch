# The fill runs: planned from the registry, admitted within its limits, leased under fences, split, joined, invalidated, cancelled and published once per generation

Change: fill-orchestrator
Base: fc76c4bd
Tasks: madarch-tzte.19.5
Kind: behavior

## Intent

Decision 0027 makes the fill an orchestrator over a declared stage registry, the
persisted state machines and a durable queue. The registry (madarch-tzte.19.3),
the machines and their store (madarch-tzte.19.4), the queue (madarch-tzte.19.2)
and the process's one database owner (madarch-tzte.19.1) have landed; nothing
drives them. The landed fill keeps its units in JSON files, locks work inside one
process and marks a unit complete before its stage is committed.

After this change madarch has the orchestrator: a run plans its units from the
enabled stages and the product's configuration, snapshots what it resolved,
admits the units within the run's own slots and each stage's concurrency in an
order it can explain (the earlier stage first, then the plan's own importance
with the ageing a unit has waited subtracted, then code point order), hands each
admitted unit to a worker through the queue, leases it under a fencing token that
grows across its generations, runs its stage with tracked reads and a private
draft, records the draft, validates it and publishes it in one short transaction
that writes the unique publication record and settles the job; splits a unit into
a sealed child set within bounds on depth, children and total work; resumes a
waiting parent only when every sealed child published and is still fresh, or
under the run's own policy for a failed child; marks what went stale when a
recorded read, empty answers included, or a named input moved; cancels a run by
revoking the authority of everything it planned before it settles; and finishes
the run as `succeeded` or `completed_partial` with what it covered. The state
store now borrows the process's one database owner, and its temporary test
adapter is gone.

The background server owns the orchestrator: the daemon child creates one service
over the products home, hands it to the server, and the server stops it with
everything else it opened. Nothing is opened before a fill is asked for, and a
run whose wiring is missing is refused with exactly what is missing.

## Out of scope

- The fill's own stages: nothing registers a real stage module yet (the summary
  fixture of madarch-tzte.19.3 is a test's), and no agent prompt is written by
  this change. The graph a unit reads, the store a published fact set lands in
  and the product's configuration are seams the orchestrator is given; the tasks
  that wire the real ones come after this one.
- The crash-injection suite: madarch-tzte.19.6. This change recovers a lapsed
  lease, a due retry and a settled join in the sweep its scheduler runs; killing
  a fleet of executor processes around claim, split and publication is that
  suite's, and so is running the compiled binary through them.
- The MCP server a unit's agent reads through, the ACP session (madarch-tzte.22.1
  landed the client) and the unit's token limits: the stage's context carries the
  tracked reads, the draft, the progress and the cancellation signal this change
  owns, and the session behind them is a later task's.
- The git outbox that commits a stage's pages: this change settles the run's
  publication and its progress, not a commit.
- The old fill pipeline (`src/product/fill.ts`, `fill-runtime.ts`'s file state):
  this change reuses the runtime's hashing, its control file and its human-edit
  guard, and replaces nothing of the old path. That path is retired when the
  wiki's fill runs on the orchestrator.

## Rationale

Kind `behavior`: the change adds a capability the product did not have (the
orchestrator decision 0027 names) and changes how the fill's state store reaches
its database, rather than preserving an existing one. Nothing a person sees
changes yet, because no real stage is registered: the orchestrator is exercised
by fake stages in its tests and by the server that now owns it.

## Changes to requirements

Added capability `fill-orchestrator` against an absent baseline, its complete
proposed text in `capabilities/fill-orchestrator.md`, with the requirements
`plan`, `admit`, `attempt`, `split`, `join`, `staleness`, `publish`, `cancel`,
`completion` and `host`.

## Preserved contracts

- server/protocol: the server's own routes, its answers and the order in which it closes what it opened are unchanged; it stops the fill orchestrator it was given with everything else, and a run of the background server that was given none behaves exactly as before.
- product-repository/list: the daemon still serves every valid product in the home and lists the same products; the orchestrator service it now creates opens no database and no queue until a fill is asked for, so a products home with no fill is untouched.
- model-history/store-version: the history keeps its own tables and answers as before; the fill's state store and the orchestrator's tables borrow the same owner and write in their own tables, in a transaction of the owner and never one of their own.
- release-binary/installers: the release binary still builds, installs and runs on every platform it built for; nothing this change adds reads a file at run time, and the pglite assets the queue needed are already embedded.

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
- fill-orchestrator/host: test
- server/protocol: test
- product-repository/list: test
- model-history/store-version: test
- release-binary/installers: test

## Blocking questions

None.

## DONE WHEN

- With fake stages: planning from the registry, admission within concurrency slots by priority (PageRank-like with ageing), leases with fencing, split with sealed child sets and limits, parent join when children are published and fresh, staleness from tracked reads including empty results, cancellation revoking authority, and publication in one short transaction with a unique publication record (same digest returns the existing result, a different digest is refused).
- The background server owns the orchestrator; fill-runtime's kept parts (snapshots, input hashes, progress, pause/stop, human-edit guard) are reused.

## Design and decisions

- **The orchestrator is one module of pure steps.** `src/fill/orchestrator.ts`
  holds the planning, admission, sweeping, attempt, split, join, staleness,
  cancellation and settlement steps; `orchestrator-store.ts` holds the tables the
  orchestrator owns (the run's snapshot and resolved configuration, each unit's
  place in the plan, its tracked reads, its draft set, the child set a split
  sealed, the unique publication record and the durable progress events). Every
  step takes a named transition of `fsm.ts` and performs the effects the step
  returned, after the new state is committed: a step the table does not allow is
  a value carrying the machine's own refusal, and a refused step writes nothing.
- **The steps beside the machines are the decision's.** A split creates its
  children, seals them and takes the parent's `wait-for-children` step in one
  transaction (`createUnitIn`, `sealSplitIn`, `advanceUnitIn`), which is what
  "splits atomically persist the parent's checkpoint and a sealed child set"
  means. A publication is one transaction (`publishUnitIn`) that checks the
  generation and the fence as the machine holds them, refuses a run that is
  cancelling or cancelled, rechecks every recorded read, applies the fact set
  through the caller's own application, takes the `publish` step and inserts the
  record — with the queue's settlement for that attempt inside the same
  transaction. Admission counts the run's slots and the stage's concurrency
  inside the transaction that takes the `admit` step and enqueues the job, under
  the run's own row, so the slots are transactional.
- **Priority without a new field in the stage contract.** Decision 0027 admits by
  "PageRank as a priority with ageing and a deterministic tie-break". The stage
  contract (madarch-tzte.19.3) carries a plan's units in the order the plan put
  them, and decision 0026 has the graph compute importance (PageRank) before a
  plan names its units, so the orchestrator keeps that order as the unit's
  importance and records it with the stage's own place in the derived order and
  the moment it was planned. Nothing in the stage contract changed, so no other
  change's proposal is disturbed.
- **The retry is the unit's, not the queue's.** The queue is declared with no
  retries of its own: a settlement says an attempt is over, and the orchestrator
  enqueues the retry at the moment the machine's own context recorded. A lease
  that lapsed is swept the same way — retried while a retry is left, failed under
  the retries-exhausted cause when none is — and the attempt's own authority is
  aborted, so a worker that died cannot come back to a generation it lost.
- **What the landed runtime keeps, and what replaces it.** The pinned snapshot
  (the runtime's own `productSnapshot` shape) is recorded with the resolved
  configuration digest per run; the input hashing is `hashFillInputs` from
  `fill-runtime.ts`; the pause and stop control is `consumeFillControl` over the
  product's own state folder; the human-edit guard is the run's seam, and a
  conflict stales the stage's published generations and blocks the run, because a
  published generation is only ever invalidated, never overwritten. Progress is
  the runtime's normalized event (run, stage, unit, sequence, kind, summary),
  and it is persisted in the database the server owns rather than the runtime's
  JSONL journal — decision 0027 replaces "JSON state files and journal" while
  keeping "normalized progress and usage".
- **The store borrows the owner.** `FillStateDatabase` is now the owner's own
  `transaction`, which is what madarch-tzte.19.4 left for this task, and the
  temporary PGlite adapter its tests opened (`test/fill-fsm-pglite.ts`) is
  deleted: the store's tests open the process's owner as the server does. Two
  reads and one write were added to the store for what the orchestrator needs —
  the units of a run, one named generation (a parent's sealed child is read as
  the generation that was sealed, never as the one in force), and the storage half
  of the machine's `suspend-parent` effect, which releases a parent's lease while
  its children run.
- **The run records what it resolved before anything else.** A starved consumer
  is a run that planned and is then blocked, not a run that never planned: the
  machine allows `block` only from `planning`, so the `plan` step (and the
  configuration record it stands on) is taken first, and a graph that does not
  read at all is refused where it stands, before any step. A run whose units were
  all reused plans nothing and still succeeds: its required coverage is "nothing
  the run planned was lost", and decision 0027's distinction between "no producer"
  and "producer found nothing" is reported as its own durable event
  (`stage-found-nothing`) rather than read from a count of units.
- **Ageing lifts a unit one place per step it waited.** The order is the earlier
  stage first, then the plan's own position with the ageing subtracted, then the
  unit id in code point order; one step brings a unit level with the one before
  it, where the id decides, and the second takes it past. A later stage's unit
  never overtakes an earlier stage's, however long it waited: the stage graph is
  the fill's own order.

- **The server owns it.** `createFillOrchestratorService` builds the service the
  background server holds: it opens the process's database, creates the fill's
  tables and declares the queue on the first run asked for, and closes them when
  the server stops. The daemon creates it beside the wikis it serves and the
  server stops it with what it opened. The fill's own stages are registered by
  later tasks and no product's graph or fact store is wired yet, so a run asked
  for today is refused before it starts, with `fill-orchestrator/no-wiring`
  naming the snapshot, the configuration, the graph the units read, the inputs
  their facts stand on and the store a published fact set lands in — never served
  a run that would publish nothing in silence. The daemon still owns the service
  and stops it with everything else it opened, so the wiring a later task adds is
  a change to what the daemon passes and nothing else.
- **What the review changed.** One independent read-only review ran over this
  change and found two defects, eight should-fix items and nine nits; all of them
  are answered here, with a test where a test can say it.
  - The two defects: the publication applied the unit's facts **before** the
    machine's `publish` step, so a step the machine refused — a generation that
    went stale, a fence an attempt had lost — still committed its facts, because
    a refusal is a value and not a throw; the step is now taken first (its own
    `FOR UPDATE` on the generation's row serializes two publishers), the facts
    follow, and the record is written last, so a refusal writes nothing and a
    failure of the facts rolls the step back with them. And a run recorded
    `succeeded` while one of its units waited for a retry that was not due yet:
    the run's own evidence now counts every `retry_wait` generation as work it
    still owes, so a run cannot finish with a retry coming.
  - The should-fixes: the staleness sweep had no production caller, and the
    scheduler now runs it when the run has nothing else outstanding, before the
    run may finish; "reuse" was wider than the capability claims, and planning
    now inherits exactly a published generation whose inputs did not move,
    replaces a published or stale one whose inputs did, and refuses a unit
    another run is working on or left behind, by name; `record-resolution` is
    performed as the run's own durable event in the person's words (said in the
    code where the effect is performed); the claimed-but-untested scenarios now
    have tests, the server stopping the orchestrator it was given among them; the
    three transactions the orchestrator opens itself name their file, their line
    and the tables they touched, as the store's own operations do; and a step the
    machine refuses on a unit is reported (`UnitRefusal`) by the cancellation, the
    staleness sweep and the human-edit guard, never dropped in silence.
  - The nits: a dead ternary; the digest a starved run records says it resolved
    no configuration and names the paths rather than digesting the empty set of
    stages; `revokeUnitLease` revokes the fence it is given and answers that
    lease; `unit-leased` is emitted; a stage's progress notes are written durably
    after the attempt instead of being fired and forgotten; the run's snapshot is
    fill-runtime's own `productSnapshot` type rather than a second shape; whether
    planning created a unit is read before the creation rather than guessed from
    timestamps; the queue's heartbeat answer is honoured, so an attempt whose
    claim lapsed spends nothing; the publication's digest is computed inside the
    publication's transaction from the draft that transaction holds; and the
    daemon's default registry is no longer overridable by a spread.


The owner approval required for a behavior change is pending the coordinator;
the record on the task says so in the coordinator's own words.
