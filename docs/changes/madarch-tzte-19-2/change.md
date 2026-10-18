# A durable queue on the process's one database: claimed, heartbeated, settled, retried and dead-lettered

Change: madarch-tzte-19-2
Base: 435b2ea7
Tasks: madarch-tzte.19.2
Kind: behavior

## Intent

Decision 0027 puts the fill's work in a durable queue in the same database as the
fact log, the query projection and the orchestrator's tables, with claim and
settlement as short transactions. Nothing of that exists: the landed fill keeps
its units in JSON files and locks work inside one process, and no queue of any
kind is in the tree.

After this change madarch has a queue it owns the contract of: a queue is
declared with its lease, its retries and the delay between them, its heartbeat
interval and the queue a spent job is copied into; a job is enqueued with a
priority and, on a queue that holds singletons, the key it is unique by; a claim
takes the highest-priority jobs oldest-first under the queue's lease and reports
each job's attempt; a heartbeat keeps a live claim and is refused for one that
lapsed; a settlement is fenced to the attempt that was claimed, so a worker whose
claim was handed out again cannot settle the newer attempt's job; a failure waits
for its next attempt under the declared delay, doubling with backoff, and a job
whose retries are spent is copied into the dead letter queue with the reason it
failed with; and a maintenance pass recovers a claim whose lease lapsed, which is
what makes a killed worker recoverable.

The adapter behind that contract is pg-boss on the process's one database owner
(decision 0027's choice), with its PGlite backend profile over the owner's own
PGlite connection and its `pg` profile over the owner's PostgreSQL pool. It is
proved inside a compiled binary on a persistent PGlite data directory, across a
restart, and on PostgreSQL where a server is configured.

## Out of scope

- The orchestrator: admission and resource limits by priority with ageing, the
  unit graph, splits and joins, staleness, cancellation and exactly-once
  publication are madarch-tzte.19.5. This change gives it the queue those steps
  settle through, and nothing of the domain dependencies decision 0027 keeps out
  of the queue (a job's data is the orchestrator's own).
- The state machines and their store: madarch-tzte.19.4, landed.
- The stage registry: madarch-tzte.19.3, landed.
- The crash-injection suite: madarch-tzte.19.6. This change's recovery is one
  maintenance pass over one queue, proved by a lease that lapses; killing a fleet
  of executor processes around claim, split and publication is that suite's.
- Wiring the fill's stages, the wizard or the wiki onto the queue: nothing in
  this change enqueues a real unit.
- The release binary's own smoke test, which still walks `new`, `serve` and
  `list`; that a compiled binary opens the process's database is proved by this
  change's compiled-binary test with the same embedded files, not by that walk.

## Rationale

Kind `behavior`: the change adds a capability the product did not have (a durable
queue with a declared lease, retries, backoff and dead letters) rather than
preserving an existing one. Nothing a person sees changes yet, because nothing
runs the queue but its tests; the orchestrator that does is madarch-tzte.19.5.

## Changes to requirements

Added capability `fill-queue` against an absent baseline, its complete proposed
text in `capabilities/fill-queue.md`, with the requirements `owner`, `declare`,
`enqueue`, `claim`, `heartbeat`, `complete`, `fail`, `recover`, `dead-letters` and
`binary`.

## Preserved contracts

- model-history/store-version: the history keeps its own tables and answers as before; the queue shares the owner's connection, not the history's rows.
- model-history/replace: a source's replacement is unchanged by the queue's presence in the same database, one transaction of the owner included.
- graph-queries/rebuild: the projection rebuilds unchanged, the queue's schema is its own, and a rebuild inside a caller's transaction still sees that transaction's writes alone.
- release-binary/installers: the release binary still installs and runs on every platform it built for; it now also carries the files the embedded database reads, which nothing else reads.

## Coverage

- fill-queue/owner: test
- fill-queue/declare: test
- fill-queue/enqueue: test
- fill-queue/claim: test
- fill-queue/heartbeat: test
- fill-queue/complete: test
- fill-queue/fail: test
- fill-queue/recover: test
- fill-queue/dead-letters: test
- fill-queue/binary: test
- model-history/store-version: test
- model-history/replace: test
- graph-queries/rebuild: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The interface is madarch's, the adapter is pg-boss's.** `src/fill/queue.ts`
  declares `QueueService` in madarch's vocabulary — `declare`, `enqueue`, `claim`,
  `heartbeat`, `complete`, `fail`, `recover`, `deadLetters` — and
  `src/adapters/pg-boss-queue.ts` serves it with pg-boss. No pg-boss name reaches
  a caller, so decision 0027's fallback (an own leased queue on `FOR UPDATE SKIP
  LOCKED`) is another adapter behind the same interface and no caller changes.
  The mapping is direct: `singletons` is pg-boss's `exclusive` queue policy, the
  lease is `expireInSeconds`, the retries are `retryLimit`, the retry delay and
  backoff are `retryDelay` and `retryBackoff`, the heartbeat is
  `heartbeatSeconds` with `touch`, and the dead letter queue is pg-boss's own.
- **pg-boss runs on the owner's connection, not a second database.** A PGlite
  owner is handed to pg-boss through its own `fromPglite`, over a two-method face
  (`query`, `exec`) that runs every statement through the owner's serialization;
  a PostgreSQL owner gets a thin `IDatabase` over the pool the owner already
  holds. Both faces live in the adapter, so the queue's tables land in the same
  database and neither a pool nor an instance is opened beside the owner.
- **The owner gained two things the queue needed** (`src/adapters/database-owner.ts`,
  madarch-tzte.19.1's module). `backend` names the engine, which is how the
  adapter selects pg-boss's `pglite` or `postgres` profile. `exec(text)` runs a
  batch of statements that carries no parameters as one message to one
  connection — pg-boss sends its schema creation and its migrations as one
  `BEGIN …; … COMMIT;` text, and the extended protocol that `query` speaks takes
  exactly one statement. A statement that fails is rolled back on the same
  connection before the failure is thrown, on PGlite and on a pooled client
  alike, since a connection left in an aborted transaction refuses every later
  statement (this is the same protection pg-boss's own PGlite adapter keeps).
- **Every statement is short, and a caller's transaction is honoured.** An
  ordinary operation is one statement through the owner's `run`, which the owner
  serializes with its transactions; nothing the queue does holds a transaction
  across an agent session. `enqueue`, `complete` and `fail` also take a
  transaction of the caller and pass it to pg-boss as its `db`, so decision
  0027's publication — the unit's facts, its state and the queue's settlement in
  one short transaction — is expressible. A call made from inside the owner's own
  transaction without being given it is refused by the owner, as madarch-tzte.19.1
  made it.
- **A dead letter is a copy, and it says so.** pg-boss keeps a spent job as a new
  row in the dead letter queue: the copy has an id of its own and carries the
  failed job's id as its source, so `DeadLetter` answers both — `id` for the copy
  and `jobId` for the job that failed — with the failed job's data, its queue and
  the reason its last attempt failed with, and `retriesSpent` rather than a count
  of hand-outs, which is what pg-boss's `sourceRetryCount` is (the review of this
  change found the first version answering the copy's id as the job's, and the
  tests now pin both ids apart).
- **A claim is ordered by the adapter, because pg-boss does not order a batch.**
  pg-boss selects the top-N jobs by priority and creation time, but the rows an
  `UPDATE … RETURNING` hands back are in no promised order: `fetch` with a batch
  size above one returned the priority-3 job before the priority-5 one (measured
  on PGlite and PostgreSQL, 2026-10-18). The adapter therefore asks for the job
  metadata and orders the batch itself — priority descending, then the oldest,
  then ids in code point order — so a caller that claims with a limit can rely on
  the order, and two claims of the same rows answer the same order.
- **Every enqueue takes the queue's next place, so "the oldest" is enqueue
  order.** pg-boss orders a claim by priority and then by the job's creation
  time, and its own source says what that means for a tie: a batch insert shares
  one `job_now()`, the ids are random uuids and carry no order, and ties resolve
  in index order. A store's clock is coarse on some backends — pg-boss's own
  fetch comment names PGlite — and it is one transaction's for every statement
  inside that transaction, so equal-priority jobs enqueued one after another did
  tie and did come back in a random order: this change's first landing failed CI
  on exactly that (`test/queue-scenario.ts`, three jobs of `equal-priority`, run
  `39147690524` shard 2, where the same SHA passed on the re-run). The adapter
  gives each enqueue a place of its own: an upsert into
  `<schema>.madarch_enqueue_stamp` takes the queue's last stamp plus at least a
  millisecond, or the clock if that is later, and the same statement writes it as
  the job's `created_on`, inside the enqueue's own transaction — the caller's
  where one is given, one short write transaction of the owner's otherwise. Two
  enqueues of one queue therefore cannot share a place: the upsert holds the
  queue's stamp row until its transaction ends, so they take their places in the
  order they reach it. The step is a whole millisecond because every reader of
  the instant here is a JavaScript `Date`, and the microseconds a timestamp
  stores would be lost on the way back. This is what makes the store's own
  selection the enqueue order, so a claim of fewer than the jobs waiting takes
  the oldest rather than an arbitrary subset; the adapter still orders the batch
  it is handed, and its id tie-break stays as the answer for a row written into
  the queue beside the adapter. A job's place is written once and never changes,
  so a retried job, and one whose claim a maintenance pass recovered, keep the
  order they were enqueued in, and a dead-lettered job's copy carries the failed
  job's id and its own arrival time, which is what the dead letter read orders by.
  A copy is the one row here that gets no place of its own: pg-boss writes it
  inside its own settlement statement, and nothing in the adapter's hands names
  it. Two copies of one queue made in the same millisecond are therefore answered
  in the store's order, which is what the read asks for up to the millisecond it
  can tell apart; the scenario tells its two apart by dead-lettering them a
  thirty-millisecond pause apart, which is the same bound stated as a test.
  Reaching into pg-boss's `job` table is deliberate: the library offers no way
  to name a job's creation time, and `created_on` is the column its own fetch —
  and its own `findJobs` paging and its monitor's oldest-queued reading — treats
  as enqueue order. The table and column are pg-boss 12.38.0's; a version that
  renames them fails loudly at the first enqueue rather than silently losing the
  order, and the statement that writes the place checks the row it matched, so a
  write that reached nothing fails the enqueue instead of answering a job whose
  order the queue cannot keep. This is the `created_on` the jobs table carries:
  `<schema>.job` is its partitioned parent and a normal queue's rows live in
  `job_common`, its default partition, which an update through the parent
  reaches. Cost, stated for the orchestrator that wires a caller
  (madarch-tzte.19.5): the upsert holds the queue's stamp row until the enqueue's
  transaction ends, so an enqueue inside a long caller's transaction makes every
  other enqueue into that queue wait for it, and two transactions enqueuing into
  two queues in opposite order can deadlock, which the database answers by
  aborting one and nothing here retries. Publishing into one queue per
  transaction, or taking the places in one fixed queue order, is the caller's
  side of that. Two smaller consequences are recorded rather than fixed: a queue
  enqueued into faster than once a millisecond keeps its places ahead of the
  store's clock, which the monitor's oldest-queued reading reports as a negative
  number of seconds and nothing functional reads; and pg-boss's queue cache,
  evicted when another instance deletes and re-creates a declared queue, falls
  back to the owner's connection on a miss, so that enqueue inside our own
  transaction is refused by the owner with its own message where pg-boss would
  have said the queue does not exist. It fails either way; only the sentence is
  worse.
- **A declaration is applied to the queue as it stands.** pg-boss's `create_queue`
  inserts a queue once and never touches the row again, so a product that changes
  a stage's limits would keep the old ones silently. `declare` creates the queue
  if it is absent and then updates its settings, with an absent heartbeat or dead
  letter queue written as `null` so that "declared with none" means none. The one
  field it refuses to change is the singleton rule: the database's index over a
  queue's unfinished keys is built with the queue, and pg-boss refuses the change
  itself, so the declaration is refused here first, naming the queue.
- **Failures and recovery settle through pg-boss's own rules.** `fail` stores the
  reason as the job's output (`{ value: { message } }`, which is where pg-boss
  keeps a failure's message) and answers `retry` or `failed` from the attempt it
  was given against the retry allowance the *job* carries, which pg-boss stamps
  on it at enqueue: a queue declared again after a job was enqueued does not
  change that job's allowance, so reading the queue's latest declaration would
  answer `retry` for a job pg-boss had just failed for good (found by the review
  of this change; the scenario now declares a queue again between enqueue and
  failure, both ways round). `recover` runs one pg-boss supervision pass over the queue,
  which is what expires the claims whose lease lapsed and fails those whose
  heartbeat went quiet; the adapter leaves pg-boss's own background passes on
  while the process lives, so a killed worker is recovered without anyone asking,
  and a test turns them off to recover exactly when it says.
- **Fencing is pg-boss's attempt fence.** Every settle and refresh names the job's
  id with the attempt it was claimed as, and pg-boss's statements refuse an
  attempt that has moved on. A refused settle answers false (or, for `fail`, is
  refused, since a caller that failed a job it no longer holds has a bug rather
  than a race to ignore); a refused heartbeat answers false, which is how a
  worker learns its job is no longer its own.
- **The release binary carries the database's files.** `bun build --compile`
  bundles PGlite but not the three files its build reads at run time
  (`pglite.data`, `pglite.wasm`, `initdb.wasm`), which it resolves against the
  module it was bundled into — the binary's own root, where `--asset` lays
  them. The release build embedded the wiki app and the version only, so a
  PGlite opened inside the shipped binary had nothing to read; `madarch serve`
  reaches one (`src/server/sources.ts`), and the queue is the first thing in the
  tree that must open it inside a compiled binary. `scripts/pglite-assets.ts`
  names the three files once, `scripts/build-binary.ts` embeds them (the release
  walk in CI builds the binary that way on this change's pull request, since it
  watches `package.json`), and the queue's compiled-binary test stages the same
  three for the binary it builds.
- **A queue's own sweep is due once per pass interval.** pg-boss sweeps a queue
  only when its monitor claim comes due, which it takes for a minute whatever the
  pass interval is; with a one-second pass interval that gate would hold back the
  very recovery the interval was set for (measured: a lapsed one-second claim
  stayed `active` for eight seconds with the default gate, and was recovered
  within two with the gate aligned). The adapter therefore sets the monitor
  interval to the pass interval, and says in the option's own words that a pass
  asked for inside a queue's interval sweeps at its next turn.
- **The PostgreSQL leg runs in CI's checks job.** The queue's PostgreSQL suite
  skips itself where `MADARCH_TEST_POSTGRES_URL` is unset, and no sharded test
  job sets one, so `.github/workflows/ci.yml` now runs `test/queue-postgres.test.ts`
  beside the query adapter's own PostgreSQL test, in the one job that has a
  server. Without it the queue's postgres profile, its pooled statements and
  `PostgresOwner.exec` — the batch path its schema install needs — ran nowhere.
- **Messages are stated after measuring pg-boss, not assumed.** The claim order
  above, and that a settled or lapsed attempt's settle answers `affected: 0`
  (pg-boss's published answer type is empty while its runtime carries `{ jobs,
  requested, affected, settled }`), were read from the library's behaviour in a
  probe on this machine before they were written down; `settled()` in the adapter
  reads the runtime shape and the tests pin it.

- **What the review changed.** One independent review ran over this change's
  first commit and found two defects, one pipeline gap and five coverage
  weaknesses; all are fixed with tests, and its nits are taken. The defects: a
  dead letter answered the *copy's* id where the capability promises the failed
  job's (the queue keeps a new row and names the original in its source, so
  `DeadLetter` answers both ids now, pinned apart by the scenario); and `fail`
  judged its answer on the queue's latest declaration while pg-boss judges it on
  the allowance stamped on the job, so a queue declared again between enqueue and
  failure could answer `retry` for a job already failed for good (it now reads
  the job's own allowance, and the scenario re-declares such a queue both ways
  round). The gap: no CI job gives the sharded suite a PostgreSQL server, so the
  PostgreSQL leg was skipped everywhere — the checks job runs it now beside the
  query adapter's own PostgreSQL test. The coverage the review asked for is in
  the scenario: the stale attempt's failure refusal, a queue's heartbeat interval
  (its refusal under ten seconds and a claim recovered when its heartbeat went
  quiet), a lapsed lease on a job with no retries left, the automatic passes, the
  dead letter queue's absent, newest-first, limited and out-of-bound reads, and
  the batch's three ordering keys. The second round found no defect in the queue's
  behaviour and two doc/code disagreements — the published default of a dead
  letter read, and `recover`'s words against the sweep's own interval — both fixed
  here, with the two refusals it named (a claim of no whole number of jobs, a
  fractional priority) now in the scenario, the job's retry allowance in the order
  check, and one timing window widened from a tenth of a second of margin to half
  a second on either side. Its one confirmed residual: on PGlite a dropped
  tie-break comparator still passed the check that asked for ascending ids,
  because the store's own `UPDATE … RETURNING` answers ascending ids (measured
  over thirty runs), so that check proved the promise rather than the comparator;
  the follow-up below closes it with rows written in the reverse of their ids'
  order.
- **What the follow-up changed.** This change's first landing passed its own CI
  and failed another branch's: `test/queue-scenario.ts`'s three jobs of
  `equal-priority` came back in the wrong order on shard 2 of run `39147690524`,
  and the same SHA passed when the shard was re-run — the tie-break was a random
  id, so the failure was a coin toss away rather than gone. Claim order is now
  enqueue order by construction (the bullet above), the scenario puts five
  enqueues inside one transaction so the tie is made rather than waited for. The
  tie is made certain, the check's failure without the fix is not: five tied jobs
  claimed two at a time come back in the wanted order by chance about one run in
  ten, which is what the fix removes rather than a certainty it adds — the seam
  is the one instant, not the failing. Three more parts pin the paths that keep a
  job's place: a retry, a recovered claim and a dead letter. The comparator's
  residual from the review is closed by two rows written into the queue's table
  in the reverse of their ids' order: the claim answers them in id order, which
  insertion order gets wrong (whether a store happens to answer ascending ids is
  its own affair, and the adapter's sort is what the check holds). That promise
  is about the batch a claim is handed, and the requirement now says so: which of
  several jobs sharing one instant a claim of fewer takes is the store's own
  choice, since the store holds no order between them. The same scenario runs on
  PGlite and on PostgreSQL.

## DONE WHEN

- `QueueService` (enqueue with priority and singleton key, claim with lease,
  heartbeat, complete, fail with backoff, dead letter) is served by a pg-boss
  adapter on the process's shared database owner, with claim and settlement as
  short transactions.
- A compiled binary (`bun build --compile`) enqueues, claims, fails, retries and
  completes jobs on persistent PGlite, survives a restart, and the same scenario
  passes on PostgreSQL where `MADARCH_TEST_POSTGRES_URL` names a server and is
  skipped with that variable named as its reason where it does not.
- pg-boss runs inside the compiled binary on PGlite; the fallback the task names
  (an own `FOR UPDATE SKIP LOCKED` lease queue behind the same interface) is not
  needed, and no report of the failure it would answer is owed.
