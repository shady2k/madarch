# What a failed run left is worked again by the next run, at planning and at a repeat split

Change: madarch-47vw.8
Base: 195862fb2b0e669c20e80c4bbadfe38467d8924a
Tasks: madarch-47vw.8
Kind: no-behavior

## Intent

ALX-2023 / madarch-47vw.8, the owner-approved follow-up on ALX-2025. The deterministic
Step 1 of the preserved `alx1717-step1` stand could not run on any build after the queued
fill recovery fixes, because the stand still carries the units of a run that failed before
those fixes: one parent in `waiting_children`, 78 children in `planned`, and the units of
the stages the run never reached. Two places refused that residue to every later run, and
both are in `src/fill/orchestrator.ts`.

- **Planning retries only the states a run gives up on.** `planStageUnitsSpanned` retries a
  generation of an ended run only from `failed`, `blocked`, `cancelled` and `skipped`
  (`RETRYABLE_UNIT_STATES`). A generation the ended run left *live and unpublished* —
  `planned`, `ready`, `running`, `waiting_children`, `retry_wait` — is refused with
  `fill-orchestrator/unit-in-another-run`, and nothing else may free it: a failed run takes
  no cancel from run control, and `advanceUnitIn` allows such a run's generations only the
  `cancel` step. The planning now re-reads the generation and its owner under the run's own
  `lockFillScope`, releases a live unpublished generation with `advanceUnitIn` `cancel`, and
  opens this run's generation over it with `retryGenerationIn` in the same transaction. The
  existing retry from `failed`/`blocked`/`cancelled`/`skipped` stays as it was, and so does
  the established reuse: a published generation whose cache key still holds is inherited, a
  published or stale one whose key moved is replaced.
- **A repeat split seals the children of the run that splits now.** `splitAttempt` refused
  every child generation another run owned, ended run or not, and `createUnitIn` answers by
  the unit's scope rather than by the id the new run computes, so a repeat split of a stand
  could neither reuse the child it found nor open a generation of its own. The seal now
  decides each child under its own scope lock: a generation of a run that has not ended is
  still refused, a live unpublished generation of an ended run is cancelled and retried, a
  generation of an ended run that ended without publishing is retried, and the seal and the
  child's plan record the generation the store actually realized — its unit id and its
  generation — rather than the id the run computed. A child that already published is not
  reopened, and a child of this run is taken as it stands, so a repeat seal converges.

## Rationale

Kind `no-behavior`: the contract does not move. The capability's words already say a unit
is worked by one run at a time and that a generation its run ended without publishing is
retried, and the fill still has one writer for the graph, one fill entry point, the same
run-and-unit fence, and the same publication-once rule. What was missing was applying
those words to the residue an ended run leaves: `fill-orchestrator/plan` names the ended
owner as the case a later run may work through, and `fill-orchestrator/split` seals the
child set the parent waits for. Without this change a stand a failed run touched is
unrecoverable without a destructive reset, which the ALX-1717 evidence forbids.

The cancel is the step such a generation may take, and it is the step the run's own end
takes for what it holds: a generation a failed run left live has no authority to run, no
worker's lease to honour and nothing published, so releasing it records what happened to
it instead of leaving a live state no process will ever move. Both steps happen under
`lockFillScope` and re-read the generation and its owner first, so a generation another
run took in between refuses the preparation rather than being overwritten.

## Out of scope

- The ALX-1717 Step 1 replay itself, and any fill that calls a model: both belong to
  ALX-2025 and wait for the owner, on the preserved stand, after this change is merged.
- The units an ended run left in the private tables decision 0039 retired, and any
  migration of graph records that predate it.
- A published generation of an ended run named as a split's child: inheriting published
  work into a new run's split is a different decision with its own join semantics.

## Preserved contracts

- fill-orchestrator/plan: a run plans its units from the declared stages, and a unit another run is working is still refused with `fill-orchestrator/unit-in-another-run`; a published generation whose cache key still holds is still inherited, and one whose key moved is still replaced under the planning run.
- fill-orchestrator/split: a split seals its children and its parent together in one transaction, refuses the child set a parent generation already sealed, refuses a descendant, a unit another run works and a child standing under other inputs, and enforces its bounds; the parent waits for exactly the generations the seal recorded.
- fill-orchestrator/join: a parent resumes only when its children are published and fresh, and each child is judged as the generation the seal named.
- fill-orchestrator/publish: one publication per unit generation, by the one writer, under the run-and-unit fence.
- fill-orchestrator/cancel: cancellation revokes a generation's authority before it settles, and this change only takes the cancel a run's own end takes.
- fill-orchestrator/recovery: the sweep that makes an unpublished generation runnable again is unchanged, and a generation this change releases is one no lease holds.

## Coverage

- fill-orchestrator/plan: static, test, review
- fill-orchestrator/split: static, test, review
- fill-orchestrator/join: static, test, review
- fill-orchestrator/publish: static, test, review
- fill-orchestrator/cancel: static, test, review
- fill-orchestrator/recovery: static, test, review

## Where it is seen

Kind: internal
Place: the run trace of `POST /api/fill-selected` on the wiki's run page (`/p/run?run=…`), and `madarch fill` in a terminal
Reason: the change is the fill's own bookkeeping over the residue an earlier run left; no page gains a control or a field, while the run a person pressed no longer fails on a stand an earlier failed run touched.
1. A person presses the fill on a product whose earlier run failed and left its units live or skipped: the run plans instead of failing with `unit-in-another-run`, its trace names the generation each retry replaced, and the units of the ended run stand `cancelled`.
2. A parent that waits for children of the ended run splits again in the new run: its sealed children are the generations the new run opened, they run and publish under it, and the parent joins them and publishes.

## Blocking questions

None.

## DONE WHEN

- A new run plans the unit a failed run left `waiting_children` and the unit it left
  `planned`: each ends `cancelled` in the failed run, and the new run owns their next
  generation, under the planning run's own scope lock.
- The retry still happens for `failed`, `blocked`, `cancelled` and `skipped` generations of
  an ended run, and still does not happen for a generation of a run that has not ended.
- A repeat split over children of an ended run seals the generations the store realized,
  live leftovers and terminal ones alike, and the parent waits on those and not on the
  ended run's.
- A child of another run that has not ended is still refused, and a published child is never
  reopened.
- Both cases fail on the base and pass with the change, through the real store, the real
  queue and a repository-owned deterministic fixture, with no model call.
