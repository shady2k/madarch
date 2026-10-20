# Fill orchestrator

Capability: fill-orchestrator

## Purpose

Running the fill's work as decision 0027 declares it: a run plans its units from
the stage registry, admits them within the run's resource limits by an order it
can explain, hands them to workers through the durable queue, follows each unit
through a lease with a fencing token, a draft, a split and a join, marks what
went stale when the graph or the inputs moved, revokes what was cancelled, and
publishes each generation exactly once in one short transaction of the process's
one database. The orchestrator is a component of the background server: the
server creates it, holds it and stops it, and the fill runs beside the wikis it
fills rather than in a command of its own.

## Requirement: plan — A run plans its units from the declared stages

A run shall derive the stage graph from the declared stages and the product's
configuration, snapshot the pinned product snapshot and the digest of the
resolved stage configurations it planned with, and ask every enabled stage for
its units. Each unit shall carry a stable id that never contains a run id, its
own place in the plan, and the digest of the named inputs its facts will stand
on, hashed with the fill runtime's own hashing, and of the versions that decide
what it reads and answers — its stage's own version and the stage's prompt, answer
schema and model versions, together its cache key's known part. A required capability no enabled
stage produces shall block the run with the starvation path the derivation named,
naming the disabled producer where there is one, and a stage whose plan found a
producer's inputs but nothing in them shall be reported as such, never as a
starvation. A product configuration that moved under a run shall refuse a second
planning of it. A published generation whose cache key did not move shall be
inherited, never planned again, while one whose key moved shall be invalidated and
replaced under this run (`staleness` names the key's parts). A stage whose plan
reads what its producers publish may name no unit at a first planning; the run
shall plan such a stage again once its producers have published — one reopened
planning epoch of the same run, taken when nothing is runnable, in flight or
waiting, and a stage due only where the run has published past that stage's
recorded attempt — so a product's first fill does the work of the stages whose
plans read the graph, and a run whose stages all answered reopens nothing. A run
that was lost between a producer's publication and its consumer's planning shall
plan the consumer when it is driven again, from the publications it stands on,
to the same result a run without the loss reaches.

### Scenario: planned-from-the-registry
- Given: a registry of three stages whose capabilities form the chain snapshot → modules → overview, and a product that configures none of them
- When: the run is planned
- Then: the run is `running` with its planning epoch closed, one unit stands for every unit every enabled stage planned, each in `planned`, and every unit's inputs digest is the digest of the named inputs the run hashed

### Scenario: first-fill-plans-the-empty-stages
- Given: a registry whose consumer stage's plan names its units from what its producer publishes, and a product no run has filled
- When: the product's first run is planned and driven
- Then: the producer's units publish, the run reopens its planning epoch, the consumer's stage plans its units from the published facts, they run and publish in the same run, and the run ends `succeeded`

### Scenario: crash-before-the-reopened-planning
- Given: the same first run whose process was lost after the producer published and before the consumer's planning
- When: the run is driven again over the store it left
- Then: the consumer's stage is planned from the published facts, publishes its units exactly once, and the run reaches the same result a run without the loss reaches

### Scenario: a-filled-product-re-plans-nothing
- Given: a product whose every stage planned and published under a run
- When: another run of the product, with no change, is planned and driven
- Then: every stage's plan is answered by its inheritance, no planning epoch is reopened, and the run plans nothing

### Scenario: inherited-key
- Given: a published generation whose named inputs and versions hash what they hashed, and whose every recorded read still answers what it answered
- When: another run of the product plans that unit
- Then: the unit is in the run's reused set, no generation is planned for it, and the run works nothing on its behalf

### Scenario: key-moved
- Given: a published generation whose recorded read answered one row
- When: another run of the product plans that unit after the read answers two
- Then: the published generation is `stale` and linked to a replacement generation standing `planned` in the new run, and the run's progress names the read that moved

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
- Given: a unit of this product whose cache key stands as it stood — its named inputs, the versions it was planned under, and every read it recorded still answering what it answered — and whose generation is already published
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

## Requirement: attempt — A worker follows one unit through a lease, a draft and a validation

A worker shall claim one job, and, for a unit that is runnable, take the lease
the store issues — the next fencing token and the next attempt — start it, run
its stage with the tracked reads, the draft set, the progress and the
cancellation signal the stage's context carries, and then take the machine's own
steps: `submit-draft` with the set the stage wrote, `validate-draft` with the
stage's own judgement, and `publish`. Every step shall name the generation and
the fencing token in force, and a step naming an older one shall be refused,
leaving the generation as it stands. A stage that raised shall spend a retry
rather than fail the unit where a retry is left, and its draft shall be retracted
so the next attempt starts clean.

### Scenario: one-attempt
- Given: a planned and admitted unit of a stage that drafts one write and validates it
- When: a worker works the job
- Then: the unit is `published` with its publication recorded, its one fact applied, its job settled, and its journal shows `planned → ready → leased → running → draft → validating → published` under the generation's first fencing token

### Scenario: late-attempt
- Given: a published generation
- When: a worker claims a job for it again
- Then: the worker settles the job and reports that the unit is published, the generation's record and its journal are unchanged, and no second publication exists

### Scenario: validation-refused
- Given: a stage whose validation refuses its first draft and accepts the next
- When: the first attempt runs
- Then: the unit stands in `retry_wait` with one retry spent, a public moment the retry may run at, its draft retracted and nothing published, and the next attempt after that moment publishes

### Scenario: stage-raised
- Given: a stage whose execution raises
- When: a worker works its unit
- Then: the attempt ends in a retry under the transient-failure cause where a retry is left, and the generation fails for good when none is

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

A generation's cache key shall be the four parts decision 0026 names — its
tracked reads with their result membership, the spans it read, its named inputs,
and the prompt, schema and model versions — and every part shall be rechecked
against the graph, the pins and the versions in force.

A tracked read shall be recorded with the digest of the answer it stands under:
the rows it answered in a canonical order, an empty answer included. A span read
shall be recorded as its place in the run's pins — the repository, the file and
the lines — with the digest of the bytes it read, and never with the commit it
read them at, so a recheck at a later pin compares bytes with bytes and a span
whose bytes did not move is no change. Every read shall be rechecked at
publication: a read whose membership moved shall refuse the publication before
any fact lands, and a read the graph can no longer answer at all — the file an
evidence span cited is gone, or shorter than the span's first line — shall refuse
it the same way, the reason carrying the reader's own words; the attempt shall
retry with its draft retracted. A failure of the reader that is no movement of
the graph — a store error, a statement a stage wrote wrong — shall fail the run
rather than refuse the publication as a moved read.

A published generation shall be marked stale when any part of its cache key
moved — a recorded read that answers something else, a span's bytes at the run's
own pin, its named inputs, or the stage, prompt, answer-schema and model versions
it was planned under — with the publication staying an immutable record, and its
replacement generation shall be opened with a fencing floor at the token the
stale one reached.

A run shall also reach the product's published generations it did not plan whose
stage consumes a fact kind a stage that published in this run produces, recheck
them by the same key and replace those whose key moved into this run, so what a
change reaches over the declared capabilities is rerun and nothing else. A
generation whose stage this run does not run shall be left as its record.

### Scenario: read-moved-at-publication
- Given: a unit whose read answered nothing and whose graph gained a row after the read
- When: the attempt publishes
- Then: the publication is refused, naming the query, the empty answer and the answer it gives now, nothing is applied, and the unit stands in `retry_wait`

### Scenario: published-read-moved
- Given: a published generation that read one query answering one row
- When: the query answers two rows and the run rechecks its staleness
- Then: the generation is `stale` with its publication and its `published_at` kept, generation 2 stands `planned`, and the two are linked

### Scenario: read-unanswerable-at-publication
- Given: a unit whose read was answered and whose file the commit then deleted, before the unit publishes
- When: the attempt publishes
- Then: the publication is refused with `fill-publication/reads-stale`, the reason carries the reader's own words, nothing is applied, and the unit stands in `retry_wait`

### Scenario: span-moved
- Given: a published generation that read the lines 1 to 3 of one file, and a commit that changes that file
- When: a run rechecks its staleness at its own pin
- Then: the generation is `stale`, its replacement stands `planned` in that run, and the replacement's cause names the span read

### Scenario: span-unchanged
- Given: a published generation that read the lines 1 to 3 of one file, and a commit that changes another file
- When: a run rechecks its staleness at its own pin
- Then: the generation is left `published`, and nothing of its cache key moved

### Scenario: read-unanswerable
- Given: a published generation that read a span of a file, and a commit that deletes that file
- When: a run rechecks its staleness
- Then: the generation is `stale` with the reason the reader gave, and the run carries on: a read that cannot be answered is a read that moved, never a failure of the run

### Scenario: versions-named
- Given: a published generation planned under one prompt version
- When: a run that resolves another rechecks its staleness
- Then: the reason names the version that moved, in the versions' own words, and not two opaque digests

### Scenario: version-moved
- Given: a published generation planned under one prompt version, and a run that resolves another
- When: the run plans that unit
- Then: the generation is `stale` and its replacement is planned in the run, and no read of it is consulted

### Scenario: reached-over-the-edges
- Given: a published generation, of another run, of a stage that consumes a fact kind a stage of this run published, whose recorded read moved
- When: this run's sweep finds nothing else outstanding
- Then: the generation is `stale`, its replacement stands `planned` in this run at the stage's own place, and the run's progress names what moved

### Scenario: not-reached
- Given: a published generation of a stage that consumes no fact kind a stage of this run produces
- When: this run's sweep finds nothing else outstanding
- Then: the generation stands `published`, and this run reads none of its keys

### Scenario: inputs-moved
- Given: a planned generation of a unit whose named inputs hash one digest
- When: an input changes and the run rechecks its staleness
- Then: the generation is `stale`, its replacement stands `planned` under the new digest, and the replacement's fencing floor is the token the stale generation reached

## Requirement: update — A commit reruns only the units and pages its changes reach

A run that follows a commit shall run the deterministic stages for what changed
and shall propagate the change over the declared capabilities to the agent units
whose cache key moved, in the dependency order the derived stage graph names. A
unit of a stage whose producer published in this run shall be rechecked again
after that publication — its planning-time comparison is made against the graph
as it stood then — so what the publication landed is part of what its own key is
compared with. A unit whose key did not move shall not run. The pages a person
sees shall follow the facts the publications change: the run shall announce
exactly the pages whose facts its publications added, changed or stopped holding
in the product's graph — a fact it only cites again is no change, and a fact the
product holds for the first time is one — and a page whose facts it did not change
shall not be announced.

### Scenario: one-file-commit
- Given: a product whose fill has published its deterministic stages and its agent units, and a commit that changes one file of one code repository
- When: an update run of the product plans and is driven
- Then: the units that run are the changed file's own, its dependants' and the units whose reads or spans the commit moved, in the derived stage order; the untouched files' units and the untouched repository's units are reused; and no other unit runs

### Scenario: pages-follow-the-facts
- Given: the same product and the same one-file commit
- When: the update run publishes
- Then: the pages announced are the pages whose facts the run's publications added, changed or stopped holding in the product's graph, and no other page is announced

### Scenario: page-cited-again
- Given: a publication that cites a fact again, whose row stands as it stands — a measured field it re-measures unchanged among them
- When: it publishes
- Then: that fact's page is not announced, and the pages of the facts it did change are

### Scenario: page-gained
- Given: a fact another product of the same home already stored, whose row stands as it stands, and this product's first publication of it
- When: that publication lands
- Then: the fact's page is announced on this product's channel and on no other product's

### Scenario: dependency-order
- Given: an agent unit whose recorded read answers the facts of a stage that publishes in this run
- When: the update run drives
- Then: the unit is rechecked after that publication, is replaced where its read moved, and runs after the stage whose facts it reads has published

### Scenario: disabled-stage
- Given: a product whose configuration disables the stage a published generation belongs to
- When: an update run plans and sweeps
- Then: no unit of that stage is planned and no generation of it is replaced, and its published facts stand as they are

## Requirement: publish — One publication per unit generation

A publication shall be one short transaction of the process's one database owner:
it shall check the generation and the fencing token as the machine holds them,
the run's control and its cancellation intent, recheck every read the draft
stands on, apply the unit's fact set within its ownership scope, take the
machine's `publish` step and write a publication record uniquely constrained to
the unit and its generation, with the queue's settlement for that attempt in the
same transaction. A repeated request with the same identity and the same digest
shall answer the existing record and write nothing; a request whose digest
differs from the recorded one shall be refused. A failure anywhere in that
transaction shall leave no publication, no fact and no state change behind.

### Scenario: published-once
- Given: a validated generation
- When: it is published
- Then: one publication record stands for the generation, naming the digest of its inputs, its draft and its stage version, and its job is settled in the same transaction

### Scenario: replayed
- Given: a published generation
- When: the same identity and digest are published again
- Then: the existing record is answered, no fact is applied a second time, and no second record exists

### Scenario: different-digest
- Given: a published generation
- When: the same generation is published under another digest
- Then: the request is refused with `fill-publication/digest-mismatch`, and the recorded publication stands unchanged

### Scenario: rolled-back
- Given: a publication whose fact application fails
- When: the transaction fails
- Then: no publication record stands, the generation is still `validating`, and the attempt's job is not settled

### Scenario: authority-revoked
- Given: a run that is cancelling or cancelled
- When: a generation of it is published
- Then: the publication is refused with `fill-publication/authority-revoked` and nothing is written

## Requirement: cancel — Cancellation revokes authority before it settles

Cancelling a run shall persist the intent, revoke the authority of every
generation the run planned — aborting each in-flight attempt's own cancellation
signal — cancel each live generation, revoke its lease and retract its
unpublished draft, and settle the run to `cancelled` once nothing runnable, in
flight or waiting stands and no publication is pending. A pause shall admit no
new work, leave what is in flight to finish, and stand `paused` once it drained;
a resume shall open the next planning epoch. Stopping a run shall be a
cancellation with the stop's own cause.

### Scenario: cancelled
- Given: a run with one attempt running
- When: the run is cancelled
- Then: the attempt's signal is aborted, its generation is `cancelled`, the run is `cancelled` with `running → cancelling → cancelled` in its journal, and a publication of that generation afterwards is refused

### Scenario: paused
- Given: a run with one admitted unit and a control that asks for a pause
- When: the run's scheduler passes and the in-flight unit finishes
- Then: the run admits nothing new, is `pausing` while the work stands, is `paused` once it drained, and its next planning epoch carries it to its end after a resume

### Scenario: stopped
- Given: a run with one planned unit and a control that asks for a stop
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

A unit an attempt left without publishing shall be made runnable again by the run's
own sweep: no worker holds it, and nothing else would ever work it. A unit standing
`ready` whose job the queue no longer holds shall be offered the queue again — the
worker that claimed it may have died between the claim and the lease, and the
queue's own maintenance settles such a claim, which frees the unit's singleton key
and leaves nothing for a worker to claim. That offer shall be made on every sweep,
without a record of what was lost, and shall be idempotent: while an unfinished job
carries the unit's key the queue creates nothing, so a job that is still queued or
still claimed is left exactly as it stands. A generation whose lease lapsed while
its attempt stood `leased`, `running`, `draft` or `validating` shall be retried
under the cause the lapse is, whatever step the dead attempt had reached: a worker
killed between its draft and its publication holds nothing publishable, and its
draft shall be retracted so the next attempt starts clean. A unit standing
`leased`, `running`, `draft` or `validating` — the states an attempt holds a lease
in — shall be left to that lease until it lapses, and the run shall report each unit
it recovered as its own durable event.

### Scenario: lost-claim
- Given: a run whose unit stands `ready` because the worker that claimed its job died before it took the lease, and a queue that settled that claim as failed
- When: the run sweeps
- Then: the unit's job is in the queue again for a worker to claim, the unit still stands `ready` under no lease, and a sweep made while that job is unfinished changes nothing

### Scenario: killed-before-publication
- Given: a unit whose attempt stands `validating` when its worker is killed, with the draft set that attempt recorded
- When: the run sweeps after the attempt's lease lapsed
- Then: the generation stands `retry_wait` with a retry spent and its draft retracted, nothing is published for it, and the attempt that follows the retry publishes exactly once

### Scenario: leased-left-alone
- Given: a run whose unit stands `leased` under a lease the store issued
- When: the run sweeps before that lease lapses
- Then: nothing is offered or retried for it: the lease is what holds the unit, and no second job of it is enqueued

### Scenario: recovered-once
- Given: the same unit after the run recovered it
- When: a worker claims its job and works the unit
- Then: the generation is published exactly once, with one publication record and one application of its facts

## Requirement: host — The background server owns the orchestrator

The orchestrator shall be created by the host that owns the process: the
background server builds it over the process's one database owner and the durable
queue, holds it for the life of the process and stops it with its own shutdown,
so the fill runs inside the serving process. A host shall open nothing before a
fill is asked for, shall create the fill's tables and declare the queue once, and
shall refuse a run whose wiring — the pinned snapshot, the configuration, the
graph the units read, the inputs their facts stand on and the store a published
fact set lands in — is not given, naming exactly what is missing.

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
- Then: the run settles, the process's fill database exists under the home, a second run of the same product reuses what the first opened, and stopping the service closes the queue and the database
