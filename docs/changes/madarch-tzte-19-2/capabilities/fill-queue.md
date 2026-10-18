# Fill queue

Capability: fill-queue

## Purpose

Putting the fill's work where a worker can pick it up: a job is enqueued with a
priority and a singleton key, claimed under a lease, heartbeated while its unit
runs, settled when it finishes, retried with backoff when it fails and
dead-lettered when its retries are spent. The queue is a part of the process's
one database, beside the fact log, the query projection and the orchestrator's
own tables (decision 0027), so a claim and a settlement are short transactions
and an enqueue or a settlement can be handed the transaction of a caller whose
own work must land with it. This is the queue contract of decision 0027; what a
unit waits for and when it is published stays the orchestrator's.

## Requirement: owner — The queue lives in the process's one database

The queue shall be served by the process's database owner, opened once for the
fact log, the query projection, the queue and the orchestrator's tables, and
shall open no database, pool or server of its own. A claim, a heartbeat, a
settlement and a maintenance pass shall each be a short transaction of that
owner, and no agent session shall hold one. An operation given a transaction of
the caller shall make its statement inside it and commit or roll back with it.

### Scenario: one-database
- Given: a process whose owner holds the fact log, the query projection and the queue
- When: a queue is declared, a job is enqueued and claimed
- Then: the queue's tables answer from the owner's own connection, in the schema the queue was declared in, and no second database is opened

### Scenario: enqueue-in-transaction
- Given: a caller holding a write transaction of the owner, writing the fact log
- When: the caller enqueues a job with that transaction and the transaction commits
- Then: the job is there for the next claim, and a claim sees it only after the commit

### Scenario: rollback-leaves-neither
- Given: the same caller, whose transaction is rolled back after the enqueue
- When: the queue is read afterwards
- Then: nothing of the transaction is there: neither the fact log's write nor the job

### Scenario: settlement-in-transaction
- Given: a claimed job and a caller holding a transaction that settles it
- When: the transaction is rolled back
- Then: the job is still claimed by the attempt that held it, and that attempt settles it afterwards

## Requirement: declare — A queue is declared with its lease, retries and dead letter queue

Before a job is enqueued into a queue, the queue shall be declared: its name,
the lease a claim holds a job for, how many times a failed job is handed out
again, the delay before a retry and whether that delay doubles per attempt,
optionally how many seconds may pass between heartbeats before a claim is
treated as dead, whether it holds one unfinished job per singleton key, and the
queue a spent job is copied into. Declaring the same queue again shall replace
its settings whole, and a queue's tables shall live in the schema the service
was configured with. A name that is no stored object's name, a lease under a
second, a negative retry or retry delay, a heartbeat under ten seconds, a dead
letter queue that is the queue itself or that was never declared, and a
declaration that would change a queue's singleton rule shall each be refused,
naming the queue and the field.

### Scenario: declare-once
- Given: the queue `units-dead` exists and holds no job
- When: `units` is declared with a 60-second lease, two retries, a one-second doubling delay and `units-dead` as its dead letter queue, and a job of `units` is then claimed and fails for good
- Then: `units` exists with exactly those settings, every queue of the scenario is a row of the owner's own queue table, and the spent job lies in `units-dead`

### Scenario: declared-again
- Given: a queue declared with a 60-second lease, and a job enqueued after that declaration
- When: the queue is declared again with a 30-second lease
- Then: a job enqueued after the second declaration is claimed with a 30-second lease

### Scenario: heartbeat-too-short
- Given: a queue that is not declared yet
- When: it is declared with a nine-second heartbeat interval
- Then: the declaration is refused with `the queue "short-heartbeat" was declared with a heartbeat of 9 seconds: a heartbeat is a whole number of seconds, at least 10, or left out`

### Scenario: singleton-rule-fixed
- Given: a queue created holding no singletons
- When: it is declared again with singletons
- Then: the declaration is refused with `the queue "units" was already created holding no singletons, and a queue's singleton rule cannot change after it is created`

### Scenario: undeclared
- Given: a queue named `stale-read` that was never declared
- When: a job is enqueued into it, or it is claimed from, or its dead letters are read
- Then: each call is refused, naming `stale-read` and the declaration it is missing

## Requirement: enqueue — A job carries a priority and a singleton key

An enqueue shall store the job's data with its priority, where a higher number is
claimed first, and its singleton key on a queue that holds singletons, and shall
answer the job it created or that a job with that key is already unfinished, in
which case nothing is created. It shall take the queue's next place for the job,
which is what a claim reads to answer the jobs in the order they were enqueued.
A job may name the moment it may first be claimed, and it may be enqueued inside
a caller's transaction. A non-whole-number priority, a singleton key on a queue
that holds no singletons, a missing key on one that does and an empty key shall
each be refused, naming the queue.

### Scenario: singleton-held
- Given: a queue declared with singletons and a job enqueued under the key `a`
- When: another job is enqueued under `a` and a third under `b`
- Then: the second created nothing, the third was created, and both keys' jobs are claimed independently

### Scenario: singleton-held-while-claimed
- Given: the job under `a` claimed
- When: another job is enqueued under `a`
- Then: it creates nothing, since a claimed job is unfinished too

### Scenario: singleton-freed
- Given: the job under `a` claimed and completed
- When: a job is enqueued under `a` again
- Then: it is created, since no unfinished job holds that key

### Scenario: singleton-key-empty
- Given: a queue declared with singletons
- When: a job is enqueued with the empty singleton key
- Then: the enqueue is refused with `the enqueue into the queue "plans" named an empty singleton key: a key is the name a job is unique by, and the queue folds an empty one with no key at all, so it would hold every job of the queue back`

### Scenario: priority-stored
- Given: three jobs enqueued with the priorities 1, 5 and 3
- When: two are claimed
- Then: they are the priority-5 and the priority-3 job

### Scenario: key-without-singletons
- Given: a queue declared without singletons
- When: a job is enqueued with a singleton key
- Then: the enqueue is refused with `the queue "units" holds no singletons, and the enqueue named the singleton key "k"`

## Requirement: claim — A claim holds its jobs under a lease and reports their attempts

A claim shall take up to the number of jobs it asks for — a whole number, at
least one, refused by name outside that — from a declared queue, the highest
priority first and then the order the jobs were enqueued in, whatever instant
they were enqueued in, so that the same set of jobs comes back in the same order
and a claim of fewer answers the oldest of them. Enqueue order shall be the
queue's own and not the store clock's: every enqueue shall take the queue's next
place — at least a millisecond past the last one and never behind the clock, kept
in the queue's own schema — and write it as the job's creation time in the
enqueue's own transaction, so that two jobs of one queue never share an instant,
whether the store's clock is coarse or one transaction enqueues several jobs.
Where two jobs do share an instant — a row written into the queue beside this
adapter — ids in code point order shall decide the order of the batch a claim is
handed. Which of several jobs sharing one instant a claim of fewer than all of
them takes is the store's own choice, since the store holds no order between
them, and nothing is promised about it. A job that is retried, or whose claim a
maintenance pass recovered, shall keep the place it was enqueued at, so that it
is claimed before the jobs enqueued after it once it is due again. Every
claimed job shall carry its data, how many times it was claimed before, the retry
allowance it was enqueued with, and the lease the queue declared, and an empty
queue shall answer no jobs.

### Scenario: order
- Given: three jobs enqueued with the priorities 1, 5 and 3, in that order
- When: two jobs are claimed, and then one
- Then: the first claim answers the priority-5 job and then the priority-3 job, and the second answers the priority-1 job, each with attempt 0, the queue's lease and the retry allowance the job was enqueued with

### Scenario: order-equal-priority
- Given: three jobs of one priority, enqueued one after another
- When: all three are claimed
- Then: they come back in the order they were enqueued

### Scenario: order-inside-one-tick
- Given: five jobs of one priority enqueued inside one transaction, which would give them one instant
- When: two are claimed and then three
- Then: they come back in the order they were enqueued: the first two, then the last three

### Scenario: order-written-beside-the-adapter
- Given: two jobs written into a queue's table at one instant, in the reverse of their ids' code point order
- When: both are claimed
- Then: they come back in code point order of their ids

### Scenario: order-kept-through-a-retry
- Given: a queue that retries a failed job after a second, and two jobs of it enqueued one after another
- When: the first job's first attempt fails, and its retry comes due with the second still waiting
- Then: the claim answers the first job as its attempt 1 before the second job

### Scenario: order-kept-through-a-recovery
- Given: a queue whose lease is a second, and two jobs of it enqueued one after another
- When: the first job is claimed, its lease lapses and a maintenance pass recovers it
- Then: the claim answers the recovered job as its attempt 1 before the second job

### Scenario: order-kept-after-a-dead-letter
- Given: a queue whose first failure is final, and two jobs of it enqueued one after another
- When: the first job's only attempt fails and it is dead-lettered
- Then: the dead letter queue holds a copy naming the failed job's id, and the claim answers the second job

### Scenario: empty
- Given: a declared queue holding no job
- When: it is claimed
- Then: the answer is no jobs

### Scenario: claim-limit
- Given: a declared queue and a claim asking for no whole number of jobs
- When: the claim is made
- Then: it is refused with `the claim of the queue "units" asked for 0 jobs: a claim takes a whole number of jobs, at least 1`

## Requirement: heartbeat — A live claim is kept, a lost one is refused

A heartbeat shall refresh the claim of the attempt it names, so the queue does
not treat it as dead before its lease lapses, and shall answer whether the claim
is still held: false when the attempt is no longer the one the queue hands out,
or when the job has been settled. A queue that declares a heartbeat interval
shall treat a claim whose heartbeat is older than the interval the job was
enqueued under as dead at its next maintenance pass, which is how a worker that
died without settling is noticed sooner than the lease would notice it: a claim
of such a job, never heartbeated, is recovered by a pass ten and four tenths of a
second after the claim whose lease is a whole minute.

### Scenario: kept
- Given: a claimed job whose attempt is the one in force
- When: its heartbeat is sent
- Then: the answer is that the claim is held

### Scenario: lost
- Given: a claim whose lease lapsed and whose job was handed out again
- When: the lapsed attempt sends a heartbeat
- Then: the answer is that the claim is not held

### Scenario: settled
- Given: a job claimed and completed
- When: the attempt that completed it sends a heartbeat
- Then: the answer is that the claim is not held

### Scenario: interval-lapsed
- Given: a queue declared with a ten-second heartbeat interval and a 60-second lease, and a job of it claimed and never heartbeated
- When: ten and four tenths of a second have passed and a maintenance pass runs
- Then: the job is claimable again as attempt 1, the answer for its first attempt is that the claim is not held, and nothing was dead-lettered, since a retry was left

## Requirement: complete — A settlement is fenced to its attempt

Completing a job shall settle the attempt it names and store the optional output
beside it, answering that it settled when that attempt was the one in force and
that it settled nothing when the attempt had been handed out again or the job had
already been settled. A completion given a caller's transaction shall commit or
roll back with it.

### Scenario: settled-once
- Given: a claimed job
- When: it is completed and then claimed again
- Then: the claim answers no jobs, and the second completion of the same attempt settles nothing

### Scenario: stale
- Given: a claim whose lease lapsed and whose job was claimed again as attempt 1
- When: the attempt-0 claim is completed
- Then: nothing is settled and the answer is false

## Requirement: fail — A failure retries with backoff and dead-letters when the retries are spent

Failing a job shall store the reason it failed with and settle it as a failure:
while the job has attempts left it shall wait for its next attempt under the
queue's retry delay, which doubles with the attempt where the queue declares
backoff, and the answer shall say it will be retried; when its retries are spent
it shall be marked failed and copied into the queue's dead letter queue, and the
answer shall say it failed. What the answer says is what the settlement did,
judged by the retry allowance the job itself carries from its enqueue, never by
the queue's latest declaration: a queue declared again after a job was enqueued
changes neither that job's allowance nor the answer about it. A failure named by an attempt that is no longer the
one in force shall settle nothing and shall be refused, naming the job and the
queue. A failure given a caller's transaction shall commit or roll back with it.

### Scenario: retried
- Given: a job whose queue retries once after exactly one second
- When: the job's first attempt fails
- Then: the answer is `retry`, the job is not claimable at once, and after the second it is claimable again as attempt 1

### Scenario: backoff
- Given: a job whose queue retries twice with a one-second delay that doubles
- When: its first two attempts fail
- Then: the first retry is claimable after 2.1 seconds and the second is not claimable after 1.9 more, and is claimable after 2.2 more

### Scenario: dead-lettered
- Given: the same job, whose retries are spent after its second failure
- When: its last attempt fails with `the second attempt failed`
- Then: the answer is `failed`, the queue hands out no job, and the dead letter queue holds one job with the original data, its source queue, the reason, its attempt count and when it arrived

### Scenario: stale-failure
- Given: an attempt whose lease lapsed and whose job was handed out again
- When: the lapsed attempt fails the job
- Then: the failure is refused with `the job "…" of the queue "leases" was not failed: its attempt 0 is no longer the one the queue hands out, or the claim lapsed and the job is already somewhere else`

### Scenario: allowance-fixed-at-enqueue
- Given: a job enqueued on a queue declared with no retries, whose queue is then declared again with three, and a job enqueued on a queue declared with one retry, whose queue is then declared again with none
- When: each job's first attempt fails
- Then: the first answers `failed` and is not dead-lettered or claimable again, and the second answers `retry` and is claimable again as attempt 1

## Requirement: recover — A lapsed claim is recovered

A maintenance pass over a declared queue shall settle the claims whose lease
lapsed, or whose heartbeat went quiet past the declared interval, as failed
attempts through the same retry and dead letter rules as a failure: the job
returns as its next attempt or is dead-lettered when its retries are spent. The
pass shall be runnable on demand, and a service serving a queue shall also run
passes on its own while the process lives, so that a worker which died is
recovered without anyone asking; the interval between those passes shall be
configurable, and a queue shall come due for a sweep once per interval. Those two
facts together are what "recovered within an interval" means: a pass asked for
inside a queue's own interval sweeps that queue at its next turn rather than
twice, and the tests show both the automatic pass and the on-demand one.

### Scenario: lease-lapsed
- Given: a job claimed under a one-second lease, whose attempt settles nothing
- When: the lease has lapsed and a maintenance pass runs
- Then: the job is claimable again as attempt 1, and the attempt that held it can neither complete nor heartbeat it

### Scenario: retries-spent
- Given: a claim whose lease lapsed on a job with no attempts left
- When: the maintenance pass runs
- Then: the job is in the queue's dead letter queue with its reason, and the queue hands out no job

### Scenario: runs-while-the-process-lives
- Given: a service left to its own passes, over a queue with a one-second lease and a pass every second
- When: a job is claimed and its attempt does nothing
- Then: the job is claimable again as attempt 1 within a few passes, without anyone running a pass by hand, and the attempt that abandoned it settles nothing

## Requirement: dead-letters — Spent jobs are readable with their reason

Reading a queue's dead letters shall answer the jobs its retries were spent on,
each with the copy's own id, the id of the job that failed, that job's data, the
queue it failed on, the reason its last attempt failed with, how many retries it
consumed and when it was dead-lettered, newest first and at most the number
asked for, which shall be a whole number between 1 and 100000 and refused,
naming the queue, outside that. The order shall be the reader's, not the store's:
the queue keeps its dead letters oldest first, so a limited read shall take the
newest of them rather than the oldest. A queue that declares no dead letter queue shall
answer no dead letters.

### Scenario: one-dead-letter
- Given: a job dead-lettered after its retries were spent with the reason `the second attempt failed`
- When: the queue's dead letters are read
- Then: one job is answered, with that reason, its source queue, a `jobId` that is the id its claims carried and is not the copy's own `id`, `retriesSpent: 1` and a time

### Scenario: newest-first-and-limited
- Given: two jobs of one queue dead-lettered, the second after the first
- When: the queue's dead letters are read, and then read with a limit of one
- Then: both are answered newest first, and the limited read answers only the second

### Scenario: beyond-the-bound
- Given: a queue whose dead letters are read with a limit of 100001
- When: the read is made
- Then: it is refused with `the read of the queue "two-dead"'s dead letters asked for 100001 of them: a limit is a whole number between 1 and 100000`

### Scenario: none
- Given: a queue whose declaration names no dead letter queue, holding a job whose retries were spent
- When: its dead letters are read
- Then: no dead letters are answered

## Requirement: binary — The queue runs inside the compiled binary

The queue shall run inside the compiled madarch binary on the embedded PGlite
database: the binary shall carry the files that database's build reads, and a
test shall build a binary with `bun build --compile` and run the queue's own
operations in it. The same queue behaviour shall hold on PostgreSQL, where a
server is configured, and the PostgreSQL leg shall be skipped with that variable
named as its reason where none is.

### Scenario: compiled
- Given: a binary built with `bun build --compile` from an entry that opens the process's PGlite owner and serves the queue on it
- When: its first process enqueues a job, claims it, fails it, and a second process on the same data folder claims the retry and completes it
- Then: the first reports the job created, claimed as attempt 0 under the queue's lease and failed for retry, and the second claims the same job as attempt 1, completes it and finds the queue empty and the dead letter queue empty

### Scenario: postgres
- Given: a PostgreSQL server named by `MADARCH_TEST_POSTGRES_URL`
- When: every scenario above runs against an owner on that server
- Then: each answers as it does on PGlite; without that variable the run is skipped, saying that it names no server
