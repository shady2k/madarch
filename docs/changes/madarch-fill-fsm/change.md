# The fill's unit, run and chain state machines, persisted with fencing tokens

Change: madarch-fill-fsm
Base: 82d5edbb1e716df722497d0ccc1ef5a2724448ed
Tasks: madarch-tzte.19.4
Kind: no-behavior

## Intent
Give decision 0027's orchestration its state machines: one pure, declared transition
table each for a unit's generations and attempts, for a run, and for a product's
chain of runs, persisted through one narrow database interface, with the fencing
token that refuses a late worker. Nothing a person sees changes; what changes is
that the fill's phases are an explicit table a test can hold to the decision,
instead of stage names and JSON files.

## Rationale
The landed fill (`src/product/fill-runtime.ts`) keeps its unit states as
`pending | running | complete | blocked | stale` in per-unit JSON files, marks a unit
complete before its stage is committed, and locks work inside one process. Decision
0027 replaces that with persisted state machines owned by one database owner, so
this task declares the machines and their tables without changing any accepted
requirement: the fill capability that these machines will carry is still the
proposal `docs/changes/fill-pipeline-monday`, and decision 0027 supersedes its
persistence design.

## Out of scope
- The orchestrator that drives the machines: planning, admission, splitting,
  joining, staleness, cancellation and exactly-once publication are madarch-tzte.19.5.
- The queue: madarch-tzte.19.2. The stage registry: madarch-tzte.19.3.
- The process database owner: madarch-tzte.19.1. This change defines the narrow
  interface it must satisfy and opens PGlite only in the tests.
- Any change to the fill runtime, the wizard, the wiki or a product's pages.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/pages: no state-machine step writes a page, a draft or a git object; the store writes its own tables, and pages stay the product's Markdown.

## Coverage
- product-wiki/pages: test

## Blocking questions
None.

## Design and decisions
- **Pure transitions.** `src/fill/fsm.ts` declares each machine's states, events and
  transitions; every transition names the guards that must hold and the actions it
  performs. `src/fill/fsm-core.ts` hands the declared table to XState's pure
  `transition` and returns the effects for the caller to perform after the new
  state is persisted; nothing in either module reads a clock, a database or an
  agent session.
- **XState fits.** Checked before choosing it: a pure-transition machine compiled
  with `bun build --compile` (bun 1.4.2) and ran from the binary, `xstate@5.33.3`
  adds about 131 KB to an 81 MB binary (probe in a scratch folder outside the
  repository), and TypeScript 7 type-checks it. `src/fill/fsm.ts` itself was
  compiled into a binary and run (`bun build --compile`, exit 0).
- **Refusals are named values.** A step the table does not allow returns
  `{ ok: false, refusal }` with the code `fill-unit/no-transition`,
  `fill-unit/guard-refused` or `fill-unit/unknown-state`, the state, the event and
  the guard that refused it; the store returns the same value and writes nothing.
  The store's own refusals carry `fill-store/<what>` (`lease-not-advanced`,
  `unit-not-replaceable`) and its own journal step ids `fill-store/…-->…`, kept
  apart from the machines' `fill-unit/…`, `fill-run/…` and `fill-chain/…` codes.
- **Fencing.** A generation's `fence` column is the authority. Every lease takes a
  greater token than the unit has issued before, and every step that advances,
  blocks or ends a live generation names the generation in force and the token in
  force — the steps that stand where no lease is held included (`planned`,
  `ready`, `waiting_children`, `blocked`, `retry_wait`), so a worker whose lease
  was revoked cannot block or fail the attempt that replaced it either.
  `fence-current` refuses a step naming an older token and `generation-current` one
  naming an older generation. Only `invalidate` and `cancel` — the run control's
  authority over whatever generation stands — name neither. A replacement
  generation opens with a fencing floor at the token its predecessor reached, so no
  token is reused by the unit.
- **A failed child follows the run's resolved policy.** Decision 0027 requires "an
  explicit policy for a failed child (propagate, block, accept partial)". A `join`
  names the policy and every child's outcome: every child published and fresh joins;
  the failed ones accepted as partial join under `accept-partial`; `propagate` fails
  the parent with the cause `child-failed` without spending its retry; `block` is an
  ordinary block naming the child.
- **Persistence.** `src/fill/state-store.ts` owns six tables (`fill_chain`,
  `fill_run`, `fill_unit`, `fill_unit_generation`, `fill_unit_lease`,
  `fill_transition`) and borrows them through `FillStateDatabase`, whose whole
  surface is one transaction-aware `transaction(kind, work)` — the slice
  madarch-tzte.19.1's one-database-owner must provide. It offers the one step in two
  shapes: the plain form opens one transaction for one step (`advanceUnit`), and the
  `…In` form steps on the executor of a transaction the caller already opened
  (`advanceUnitIn`, `leaseUnitIn`), which is what the decision's publication step
  needs — the generation's `published` state, the publication record and the effects
  that are storage, in one short transaction. A unit's identity is `(product,
  stage_id, scope_key)`: `createUnit` answers the unit that identity already has, so
  a resumed planning epoch continues it instead of raising on the unique key. A
  published generation records `published_at`, a stale one `stale_at` and its
  replacement link, and every step appends to `fill_transition`.
- **Where the run and chain tables say more than the decision's sentence.** Planning
  ends a run as well: `planning → blocked` records the starvation path the stage
  registry reports, and `planning → failed` records a spent budget. `cancelling →
  cancelled` requires nothing runnable, in flight or waiting and no publication
  pending, so a cancelled run leaves no work running behind it. A quiescent chain
  wakes to `active` for the next run; nothing returns it to `idle`, which is a chain
  that never ran.

- **The diagram** of the unit machine is the `stateDiagram-v2` in the module's doc
  comment, rendered from the table; a test keeps the two equal, so it cannot drift.
- **Note for madarch-tzte.19.5 (the orchestrator).** Switch `state-store.ts` from
  `test/fill-fsm-pglite.ts` to the owner madarch-tzte.19.1 provides; take the
  publication step with `advanceUnitIn(executor, …)` inside the owner's one
  transaction, so the generation's `published` state, the uniquely constrained
  publication record and the effects that are storage commit together; perform the
  rest of the returned effects (enqueue, revoke, schedule, retract, link, emit
  progress) right after that transaction, idempotently, and create the publication
  record itself; this change does not.
- **Note for madarch-tzte.19.1.** The interface this change needs is
  `transaction('snapshot' | 'write', (executor: SqlExecutor) => Promise<T>)` over
  the borrowed owner, and the executor handed to the work must be usable again by
  `advanceUnitIn`/`leaseUnitIn` inside that same transaction; `SqlExecutor` is this
  repository's existing query interface.

## Acceptance evidence
Local focused tests, `bun run check`, the compiled-binary probe and one independent
review are recorded in the integration queue and in the tracker's check records.
Mutation is not run per task in this run (the owner runs it once per assembled
stage).

## DONE WHEN
- Pure transitions (XState pure transitions or an equivalent table) for unit (generations and attempts; planned, ready, leased, running, draft, validating, published, waiting_children, retry_wait, blocked, failed, stale, cancelled), run (created, planning, running, pausing, paused, cancelling, cancelled, succeeded, completed_partial, blocked, failed) and chain (idle, active, quiescent), each guard and side effect named.
- Every allowed transition has a test and every disallowed transition is refused with a named reason; persistence round-trips; a late lease with an old fence is refused.
