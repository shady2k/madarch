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
- Given: no queue named `units` exists
- When: `units` is declared with a 60-second lease, two retries, a one-second doubling delay and `units-dead` as its dead letter queue
- Then: the queue exists with exactly those settings, and `units-dead` is a queue too

### Scenario: declared-again
- Given: a queue declared with a 60-second lease, and a job enqueued after that declaration
- When: the queue is declared again with a 30-second lease
- Then: a job enqueued after the second declaration is claimed with a 30-second lease

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
which case nothing is created. A job may name the moment it may first be claimed,
and it may be enqueued inside a caller's transaction. A non-whole-number priority,
a singleton key on a queue that holds no singletons and a missing key on one that
does shall each be refused, naming the queue.

### Scenario: singleton-held
- Given: a queue declared with singletons and a job enqueued under the key `a`
- When: another job is enqueued under `a` and a third under `b`
- Then: the second created nothing, the third was created, and both keys' jobs are claimed independently

### Scenario: singleton-freed
- Given: the job under `a` claimed and completed
- When: a job is enqueued under `a` again
- Then: it is created, since no unfinished job holds that key

### Scenario: priority-stored
- Given: three jobs enqueued with the priorities 1, 5 and 3
- When: two are claimed
- Then: they are the priority-5 and the priority-3 job

### Scenario: key-without-singletons
- Given: a queue declared without singletons
- When: a job is enqueued with a singleton key
- Then: the enqueue is refused with `the queue "units" holds no singletons, and the enqueue named the singleton key "k"`

## Requirement: claim — A claim holds its jobs under a lease and reports their attempts

A claim shall take up to the number of jobs it asks for from a declared queue,
the highest priority first, then the oldest, and ids in code point order where
two jobs were enqueued in the same instant, so that the same set of jobs comes
back in the same order. Every claimed job shall carry its data, how many times it
was claimed before, and the lease the queue declared, and an empty queue shall
answer no jobs.

### Scenario: order
- Given: three jobs enqueued with the priorities 1, 5 and 3, in that order
- When: two jobs are claimed, and then one
- Then: the first claim answers the priority-5 job and then the priority-3 job, and the second answers the priority-1 job, each with attempt 0 and the queue's lease

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
shall treat a claim whose heartbeat is older than that interval as dead at its
next maintenance pass, which is how a worker that died without settling is
noticed sooner than the lease would notice it.

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
answer shall say it failed. A failure named by an attempt that is no longer the
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
- Then: the failure is refused with `the job "…" of the queue "units" was not failed: its attempt 0 is no longer the one the queue hands out, or the claim lapsed and the job is already somewhere else`

## Requirement: recover — A lapsed claim is recovered

A maintenance pass over a declared queue shall settle every claim whose lease
lapsed, or whose heartbeat went quiet past the declared interval, as a failed
attempt through the same retry and dead letter rules as a failure: the job
returns as its next attempt or is dead-lettered when its retries are spent. A
process serving the queue shall run such passes while it lives, so a worker that
died is recovered without anyone asking; the pass shall also be runnable on
demand.

### Scenario: lease-lapsed
- Given: a job claimed under a one-second lease, whose attempt settles nothing
- When: the lease has lapsed and a maintenance pass runs
- Then: the job is claimable again as attempt 1, and the attempt that held it can neither complete nor heartbeat it

### Scenario: retries-spent
- Given: a claim whose lease lapsed on a job with no attempts left
- When: the maintenance pass runs
- Then: the job is in the queue's dead letter queue with its reason, and the queue hands out no job

## Requirement: dead-letters — Spent jobs are readable with their reason

Reading a queue's dead letters shall answer the jobs its retries were spent on,
each with the original job's id and data, the queue it failed on, the reason its
last attempt failed with, how many times it was handed out and when it was
dead-lettered, newest first and at most the number asked for. A queue that
declares no dead letter queue shall answer no dead letters.

### Scenario: one-dead-letter
- Given: a job dead-lettered after its retries were spent with the reason `the second attempt failed`
- When: the queue's dead letters are read
- Then: one job is answered, with that reason, its source queue, `attempts: 1` and a time

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
