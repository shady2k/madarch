# Fill orchestrator

Capability: fill-orchestrator

## Purpose

Running the fill's work as decision 0027 declares it and decision 0039 amends it:
a run plans its units from the stage registry, admits them within the run's
resource limits by an order it can explain, hands them to workers through the
durable queue, follows each unit through the attempts the queue hands out, a
split and a join, marks what went stale when the graph or the inputs moved,
cancels what was stopped, and publishes each generation exactly once in one short
transaction of the process's one database. A unit is a pg-boss job: the queue's
claim is the attempt's lock, its expiry the attempt's bound and its retry
allowance the generation's, so the fill keeps no lease table of its own. There is
no draft: a unit's writes go through the one writer inside the publication's own
transaction, and a generation that fails leaves what an earlier attempt wrote
visible. The orchestrator is a component of the background server: the server
creates it, holds it and stops it, and the fill runs beside the wikis it fills
rather than in a command of its own.

## Requirement: plan — A run plans its units from the declared stages

A run shall derive the stage graph from the declared stages and the product's
configuration, snapshot the pinned product snapshot and the digest of the
resolved stage configurations it planned with, and ask every enabled stage for
its units. Each unit shall carry a stable id that never contains a run id, its
own place in the plan, and the digest of the named inputs its facts will stand
on, hashed with the fill runtime's own hashing. A required capability no enabled
stage produces shall block the run with the starvation path the derivation named,
naming the disabled producer where there is one, and a stage whose plan found a
producer's inputs but nothing in them shall be reported as such, never as a
starvation. A product configuration that moved under a run shall refuse a second
planning of it, and a run whose units are already published under the same
identity shall reuse them rather than plan them again.

### Scenario: planned-from-the-registry
- Given: a registry of three stages whose capabilities form the chain snapshot → modules → overview, and a product that configures none of them
- When: the run is planned
- Then: the run is `running` with its planning epoch closed, one unit stands for every unit every enabled stage planned, each in `planned`, and every unit's inputs digest is the digest of the named inputs the run hashed

### Scenario: starved-consumer
- Given: a registry whose `modules` stage requires the capability `file-facts` and no stage produces it
- When: the run is planned
- Then: the run is `blocked`, no unit exists, and the run's own progress names the path `modules → file-facts → no producer`

### Scenario: producer-disabled
- Given: the same registry with a `snapshot` stage that produces `file-facts`, and a product configuration that disables `snapshot`
- When: the run is planned
- Then: the run is `blocked` and the path it names is `modules → file-facts → snapshot (disabled)`

### Scenario: found-nothing
- Given: an enabled `modules` stage whose plan answers no unit and the coverage `nothing-found`
- When: the run is planned
- Then: the run is `running`, the stage is reported as having found nothing, and the units of the other stages stand planned

### Scenario: configuration-moved
- Given: a run planned against one resolved configuration
- When: the product's fill configuration changes and the run is planned again
- Then: the planning is refused, naming the digest the run planned with and the one the product now resolves

### Scenario: reuse
- Given: a unit of this product whose identity and inputs digest are unchanged and whose generation is already published
- When: a new run of the same product is planned
- Then: the unit is reported as reused, no generation of it is opened, and the new run plans nothing for it

## Requirement: admit — Admission stays within the run's limits, in an order the run can explain

Admission shall take the run's own slots and each stage's concurrency, in an
order that puts the earlier stage first, then the stage's own plan order with the
ageing a unit has waited subtracted, and the unit id in code point order where
two units still tie. A unit's ageing shall lift it one place for every ageing
step it waited, so no unit is starved by a stream of more important ones, and a
later stage shall never overtake an earlier one. The step that admits a unit and
the enqueue of its job shall be one transaction of the database owner, taken
under the run's own row, so a slot can never be given twice and a unit is never
admitted without a job.

### Scenario: slots
- Given: one stage with a concurrency of two, three planned units and a run whose own limit is two units at once
- When: the run admits
- Then: the two units the plan named first are `ready` with jobs, the third waits for a slot, and its admission answers that it waits

### Scenario: slot-freed
- Given: the same run with one of its admitted units published
- When: it admits again
- Then: the unit that waited is `ready`, and its job is in the queue

### Scenario: ageing
- Given: two units of one stage, the second less important than the first, both planned at the same moment
- When: the second has waited two ageing steps
- Then: it stands one place before the first, and a unit of a later stage still stands after both

### Scenario: enqueue-in-the-admission
- Given: an admission of one unit
- When: the job the admission enqueued is claimed
- Then: the job names that unit and its generation

## Requirement: attempt — A worker follows one unit through the attempts the queue hands out

A worker shall claim one job, and, for a unit that is runnable, take the machine's
own `start` step naming the attempt the generation's context records next — the
queue's claim is the attempt's lock, its expiry the attempt's bound and its retry
allowance the generation's, so the store issues no lease and keeps no fencing
token. It shall run its stage with the tracked reads, the write sink, the progress
and the cancellation signal the stage's context carries, and then take the
machine's own `publish` step with the writes the stage answered. A step naming an
attempt the generation already passed shall be refused, leaving the generation as
it stands. A stage that raised shall ask the queue for the generation's next
attempt where the queue's retry allowance leaves one, rather than fail the unit;
a generation whose attempts are spent fails. Nothing is kept between the attempt
and its publication: a generation that fails leaves what an earlier attempt wrote
visible, because the writes went through the one writer already.

### Scenario: one-attempt
- Given: a planned and admitted unit of a stage that writes one producer outcome
- When: a worker works the job
- Then: the unit is `published` with its publication recorded, its writes applied, its job settled, and its journal shows `planned → ready → running → published` under the generation's first attempt

### Scenario: late-attempt
- Given: a published generation
- When: a worker claims a job for it again
- Then: the worker settles the job and reports that the unit is published, the generation's record and its journal are unchanged, and no second publication exists

### Scenario: attempt-stale
- Given: a generation whose next attempt started while an earlier attempt was still inside its stage
- When: the earlier attempt publishes
- Then: the publication is refused with `fill-publication/attempt-stale`, the earlier attempt's claim is settled with the refusal, and nothing it wrote under that refusal stands

### Scenario: stage-raised
- Given: a stage whose execution raises
- When: a worker works its unit
- Then: the queue is asked for the generation's next attempt where its retry allowance leaves one, and the generation fails for good when none is

## Requirement: split — A split seals its children and its parent together

A split shall create the child generations its stage named, seal them against the
parent's generation and take the parent's own `wait-for-children` step in one
transaction of the owner, with each child carrying its own place in the plan and
its own inputs digest, so a parent waits for exactly the children sealed with it
or for none of them. The parent's lease shall be released while its children run.
A split whose children are more than the run's bound, whose children estimate
more work together than the bound allows, or which would nest deeper than the
bound shall block the parent with the reason instead, and shall seal nothing.

### Scenario: sealed
- Given: a stage that splits its unit into two named children
- When: a worker works the parent
- Then: the parent is `waiting_children` with its lease revoked, two child generations stand `planned`, each sealed against the parent, and the parent's journal shows `running → waiting_children`

### Scenario: too-many-children
- Given: a run whose bound is two children and a stage that splits into three
- When: a worker works the parent
- Then: the parent is `blocked` with the reason naming three children and the bound, no child generation exists and nothing is sealed

### Scenario: too-much-work
- Given: a run whose split-work bound is 9 000 tokens and a stage that splits into two children estimating 5 000 each
- When: a worker works the parent
- Then: the parent is `blocked` with the reason naming 10 000 tokens and the bound

## Requirement: join — A parent resumes only when its children are published and fresh

A waiting parent shall join its sealed children once every one of them is
published and still fresh — every read each child recorded still answering what
it answered — or once the run's policy for a failed child accepts the failed ones
as partial, and shall be runnable again with the store's next fencing token. A
child that ended failed, cancelled or stale shall fail the parent where the
policy propagates it, block the parent where the policy blocks, and be accepted
as partial where the run says so. A child generation that has since opened a
replacement shall be read as the generation the split sealed, never as the one in
force.

### Scenario: join
- Given: a split parent and two children that both published under reads that did not move
- When: the run sweeps and the parent's job is worked
- Then: the parent joins, stands `ready`, is leased under a greater fencing token than its first attempt, runs its stage again and publishes

### Scenario: child-failed-propagates
- Given: a run whose policy propagates a failed child and a split whose child was cancelled
- When: the run sweeps
- Then: the parent is `failed` under the child-failed cause, and the run completes partially

### Scenario: not-yet
- Given: a split whose children are still running
- When: the parent's job is worked
- Then: the job is settled, the parent stays `waiting_children`, and nothing of its generation changes

## Requirement: staleness — What the run read and what its units stand on are rechecked

A generation's tracked reads shall be recorded with the digest of the rows they
answered, empty answers included, and shall be rechecked at publication: a read
whose membership moved shall refuse the publication before any fact lands, and
the attempt shall retry with its draft retracted. A published generation whose
recorded read moved, or whose named inputs no longer hash the same, shall be
marked stale — the publication staying an immutable record — and its replacement
generation shall be opened with a fencing floor at the token the stale one
reached.

### Scenario: read-moved-at-publication
- Given: a unit whose read answered nothing and whose graph gained a row after the read
- When: the attempt publishes
- Then: the publication is refused, naming the query, the empty answer and the answer it gives now, nothing is applied, and the unit stands in `retry_wait`

### Scenario: published-read-moved
- Given: a published generation that read one query answering one row
- When: the query answers two rows and the run rechecks its staleness
- Then: the generation is `stale` with its publication and its `published_at` kept, generation 2 stands `planned`, and the two are linked

### Scenario: inputs-moved
- Given: a planned generation of a unit whose named inputs hash one digest
- When: an input changes and the run rechecks its staleness
- Then: the generation is `stale`, its replacement stands `planned` under the new digest, and the replacement's fencing floor is the token the stale generation reached

## Requirement: publish — One publication per unit generation

A publication shall be one short transaction of the process's one database owner:
it shall check the run's own state and its cancellation intent, the attempt the
queue handed the worker, recheck every read the writes stand on, apply the unit's
writes through the one writer within its ownership scope, take the machine's
`publish` step with what the producer answered, and write a publication record
uniquely constrained to the unit and its generation, with the queue's settlement
for that attempt in the same transaction. A repeated request with the same
identity and the same digest shall answer the existing record and write nothing; a
request whose digest differs from the recorded one shall be refused. A failure
anywhere in that transaction shall leave no publication, no write and no state
change behind. There is no stored draft: the writes the stage answered are applied
here or refused here.

### Scenario: published-once
- Given: a generation whose stage answered its writes
- When: it is published
- Then: one publication record stands for the generation, naming the digest of its inputs, its writes and its stage version, its writes are applied through the one writer, and its job is settled in the same transaction

### Scenario: replayed
- Given: a published generation
- When: the same identity and digest are published again
- Then: the existing record is answered, no write is applied a second time, and no second record exists

### Scenario: different-digest
- Given: a published generation
- When: the same generation is published under another digest
- Then: the request is refused with `fill-publication/digest-mismatch`, and the recorded publication stands unchanged

### Scenario: rolled-back
- Given: a publication whose write application fails
- When: the transaction fails
- Then: no publication record stands, the generation is still `running`, and the attempt's job is not settled

### Scenario: authority-revoked
- Given: a run that is cancelling or cancelled
- When: a generation of it is published
- Then: the publication is refused with `fill-publication/authority-revoked` and nothing is written

## Requirement: cancel — A pause and a stop are the run's own states

Cancelling a run shall persist the intent, revoke the authority of every
generation the run planned — aborting each in-flight attempt's own cancellation
signal — cancel each live generation, and settle the run to `cancelled` once
nothing runnable, in flight or waiting stands and no publication is pending. A
pause shall admit no new work, leave what is in flight to finish, and stand
`paused` once it drained; a resume shall open the next planning epoch. Stopping a
run shall be a cancellation with the stop's own cause. A pause and a stop are
states of the run's own machine: the api role writes them, the handler reads the
run's state before every step it takes, and no control row and no control file
stands between the two.

### Scenario: cancelled
- Given: a run with one attempt running
- When: the run is cancelled
- Then: the attempt's signal is aborted, its generation is `cancelled`, the run is `cancelled` with `running → cancelling → cancelled` in its journal, and a publication of that generation afterwards is refused

### Scenario: paused
- Given: a run with one admitted unit, and the run's own state written to `pausing`
- When: the run's scheduler passes and the in-flight unit finishes
- Then: the run admits nothing new, is `paused` once it drained, and its next planning epoch carries it to its end after a resume

### Scenario: stopped
- Given: a run with one planned unit, and the run's own state written to `cancelling`
- When: the scheduler passes
- Then: the run is `cancelled` and its generation is `cancelled`

### Scenario: blocked-unit
- Given: a generation a stage blocked with a reason
- When: a person resolves it and the unit is unblocked
- Then: the generation is runnable again and carries on to its publication

## Requirement: completion — A run finishes with what it covered

A run shall finish when its planning epoch is closed, nothing is runnable, in
flight or waiting, no publication is pending and its required coverage stands:
`succeeded` where every planned unit published, `completed_partial` where some
unit is blocked, failed, cancelled or stale. The product's chain of runs shall
stand `active` while the run does and become `quiescent` once it finished and
nothing is outstanding.

### Scenario: succeeded
- Given: a plan of four units across three stages that all publish
- When: the run is driven to its end
- Then: the run is `succeeded`, its evidence counts nothing runnable, in flight or waiting, its coverage is met, and the product's chain is `quiescent`

### Scenario: partial
- Given: a run whose only unit a stage blocked with a reason
- When: the run settles
- Then: the run is `completed_partial` and its evidence says the coverage is unmet

## Requirement: recovery — What an attempt that never published left is worked again

A unit an attempt left without publishing shall be made runnable again: its
generation's next attempt is the queue's to hand out, and the queue fails a claim
whose worker died and hands the job out again under the generation's retry
allowance. A unit standing `ready` whose job the queue no longer holds shall be
offered the queue again — a worker that claimed it may have died before it started
the attempt, and the queue's own maintenance settles such a claim, which frees the
unit's singleton key and leaves nothing for a worker to claim. That offer shall be
made on every sweep, without a record of what was lost, and shall be idempotent:
while an unfinished job carries the unit's key the queue creates nothing. A run
whose job the queue hands out again shall be ended as the process that ran it
ended: the run records the job attempt that holds it, and a later attempt of that
job is the queue's own proof that the earlier attempt is over. The run shall report
each unit it recovered as its own durable event.

### Scenario: killed-worker
- Given: a worker that claimed a unit's job, started its attempt and died inside it
- When: the claim's lease lapses and the queue's own maintenance fails it
- Then: the queue hands the job out again as the generation's next attempt, and that attempt publishes exactly once

### Scenario: lost-claim
- Given: a run whose unit stands `ready` because the worker that claimed its job died before it started the attempt, and a queue that settled that claim as failed
- When: the run sweeps
- Then: the unit's job is in the queue again for a worker to claim, the unit still stands `ready`, and a sweep made while that job is unfinished changes nothing

### Scenario: run-recovered
- Given: a run whose job the queue hands out again as a later attempt of the same job
- When: the next start claims it
- Then: the run is ended as `failed` with the process's ending as its cause, none of its units stays waiting, and the start answers `fill-orchestrator/run-recovered`

### Scenario: recovered-once
- Given: the same unit after the queue handed its job out again
- When: a worker claims it and works the unit
- Then: the generation is published exactly once, with one publication record and one application of its writes

## Requirement: host — The background server owns the orchestrator

The orchestrator shall be created by the host that owns the process: the
background server builds it over the process's one database owner and the durable
queue, holds it for the life of the process and stops it with its own shutdown,
so the fill runs inside the serving process. The run's own job in the store's
queue shall be the run's lock: the process that drives a run holds that job's
claim, heartbeats it while the run lasts and settles it when the run ends, and a
claim the queue hands out again ends the run the earlier process left. A host
shall open nothing before a fill is asked for, shall create the fill's tables and
declare the queue once, and shall refuse a run whose wiring — the pinned snapshot,
the configuration, the graph the units read, the inputs their facts stand on and
the store a published write set lands in — is not given, naming exactly what is
missing.

### Scenario: nothing-opened
- Given: a service with no wiring and a products home with nothing under it
- When: a run is asked for
- Then: the run is refused naming the missing wiring, and the home holds no database

### Scenario: owned-by-the-server
- Given: a daemon wired as the background server wires it
- When: the connection is stopped before any fill was asked for
- Then: nothing was opened, and stopping is safe to repeat

### Scenario: one-run
- Given: a wired service over a products home
- When: one run is asked for and driven
- Then: the run ends with its publications recorded, and the service closes what it opened
