# Outside the graph only the owner's machinery list: the fill's leases, control and drafts go, and raw telemetry is bounded

Change: madarch-64o5.140
Base: 46459a31
Tasks: madarch-64o5.140
Kind: behavior

## Intent
Decision 0039 (items 11–13 and 33) closes what may stand outside the graph: the graph's own tables, pg-boss's queue with its locking, expiry and retries, caches rebuildable from the graph, and raw logs and traces kept for a limited time. This change takes the fill's hand-made machinery out of that list's way.

- `fill_run_lease` and `fill_unit_lease` are removed. A unit is a pg-boss job: the queue's claim is the attempt's lock, the job's expiry is the attempt's bound, its retry allowance is the generation's, and a claim the queue hands out again is the unit's next attempt. A run records the job attempt that holds it, and a later attempt of that job is the queue's own proof that the process which ran the run ended.
- `fill_control` is removed. A person's pause and stop are states of the run's own state machine: the api role writes them through the run's machine, and the handler reads the run's state before every step it takes.
- `fill_unit_draft` and `fill_unit_draft_part` are removed. There is no draft: a unit's writes go through the one writer inside the publication's own transaction, accepted or refused at once, and a generation that fails leaves what an earlier attempt wrote visible. The writer's journal row names the unit that wrote it.
- Raw telemetry is bounded by the machine's settings: `the madarch home/settings.json` names how many days the most detailed logs and traces stand (three by default), how many bytes they may take, and how many runs stand at most; the oldest records go first, whichever bound is reached first.

## Out of scope
The rest of the foundation: the assertion storage of item 25, the operation receipts and revision preconditions of item 24, and the run and unit vertices of item 8. The run's, unit's and publication's rows still stand in the fill's own tables; this change only takes five of them away.

## Rationale
The owner asked that nothing outside the graph duplicate what the machinery already does: «если PG Boss это делает, зачем нам дублировать?» and «Черновик единицы тем более не нужен. Мы либо принимаем создание сущности, либо отказываем.» A hand-made lease table beside pg-boss's claim, a control row beside the run's state and a stored draft beside the one writer were three such duplications. The trace and log files are evidence of a run, not an archive: the durable results are the graph's, and the raw records stand for a limited time («Пусть у нас очень подробные логи там хранятся 3 дня.»).

## Changes to requirements
- fill-orchestrator/attempt: a worker follows one unit through its attempt — the queue's claim, its expiry and its retries; there is no lease row and no draft set, and a unit's writes go through the one writer when the generation publishes.
- fill-orchestrator/recovery: a unit whose worker died is retried by the queue itself; a run whose job the queue hands out again is ended as the process that ran it ended.
- fill-orchestrator/publish: a generation publishes the writes its producer answered through the one writer, checked against the run's own state and the attempt the queue handed out; no draft set and no fencing row stand between.
- fill-orchestrator/cancel: a pause and a stop are the run's own states, read by the handler before every step; no control row is written or read.
- fill-orchestrator/host: the run's own job in the store's queue is the run's lock, heartbeated while the run lasts.
- fill-queue/declare: the fill's queue carries the generation's retry allowance and delay, and the attempt's expiry.

## Preserved contracts
- fill-queue/owner: the queue lives in the process's one database, as it did.
- fill-queue/claim: a claim still holds its jobs under a lease and reports their attempts; the fill's units are what now rely on it.
- fill-orchestrator/plan: a run plans its units from the declared stages, as it did.
- fill-orchestrator/admit: admission stays within the run's limits and in its declared order.
- fill-orchestrator/split: a split still seals its children and its parent together.
- fill-orchestrator/join: a parent still resumes only when its children are published and fresh.
- fill-orchestrator/staleness: what the run read and what its units stand on are still rechecked.
- fill-orchestrator/completion: a run still finishes with what it covered.
- product-wiki/shell: no page changes.
- product-wiki/reading-typography: no page changes.

## Coverage
- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test
- fill-orchestrator/cancel: test
- fill-orchestrator/recovery: test
- fill-orchestrator/host: test
- fill-orchestrator/plan: test
- fill-orchestrator/admit: test
- fill-orchestrator/split: test
- fill-orchestrator/join: test
- fill-orchestrator/staleness: test
- fill-orchestrator/completion: test
- fill-queue/owner: test
- fill-queue/claim: test
- product-wiki/shell: test
- product-wiki/reading-typography: test

## Design and decisions
- `test/fill-orchestrator.test.ts`: a pause and a resume through the run's state, a stop written through the run's own machine, a worker killed inside its attempt retried by the queue, the publication of an attempt the queue handed out again refused, the run's own job as its lock, and the fill's five tables with their foreign keys.
- `test/fill-state-store.test.ts`: the attempt the queue hands out recorded on the generation, a retry wait, and a failed generation that retracts nothing.
- `test/fill-fsm.test.ts`: the unit machine without the lease, draft and validation states.
- `test/fill-runs.test.ts`: a scoped control that writes nothing on an ended run.
- `test/trace-retention.test.ts`: the raw records removed by age, by the byte budget and by the run count, and the machine settings that name the bounds.
- `test/plugin-output-partitions.test.ts`: a failed partition keeps what the partitions that answered wrote.
- `test/producer-outcomes.test.ts`: a producer's outcome read from the generation that recorded it.

## Where it is seen
Kind: internal
Place: the fill's tables, its queue declarations and `the madarch home/settings.json`
Reason: no page of a product shows a lease, a control row, a draft or a retention bound.
1. A store made by this change holds no `fill_run_lease`, `fill_unit_lease`, `fill_control`, `fill_unit_draft` or `fill_unit_draft_part` table, and the architecture check's table list names five fewer tables.
2. A unit that fails keeps what it wrote, and a worker killed inside its attempt is retried by the queue.
3. A pause or a stop of a run another process drives takes effect through the run's own state, and no control row is written.
4. A machine's `settings.json` bounds the raw logs and traces by age, bytes and runs; the oldest go first.
