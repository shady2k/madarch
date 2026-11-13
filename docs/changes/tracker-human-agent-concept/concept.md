# One work system for people and agents

Status: revised proposal for discussion; no implementation or acceptance claim.
Revision basis: [@shady2k's review of PR 218, 2026-11-07](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890).

## Attribution and scope

This is a proposal contributed by the author of PR 218, @avlokhturov. The original
request and permission to publish a draft came from the contributor's assistant
session, **not** from repository owner @shady2k. The earlier wording attributing that
request and publication permission to the repository owner was incorrect.

The maintainer's review now supplies the product decisions below. The detailed
manifest, tables and coordination mechanisms remain proposals for agreement and
proof. This documentation revision neither starts runtime development nor migrates
live work. Local bookkeeping IDs used by the contributor are explained in
[the change record](change.md); they are not upstream tracker tasks or approvals.

## Reading the proposal

- This page: purpose, shared rules, traceability and remaining agreements.
- [Model contract](model-contract.md): the proposed uniform manifest rule, table
  responsibilities and evidence from established tracker models. These are the first
  two implementation agreements, not accepted DDL or an executable configuration.
- [Human interface](human-interface.md) and [static mockup](mockup.html): free intake,
  planning/decomposition, queue, review, comments, time and recovery.
- [Agent interface](agent-interface.md): the same commands, identities, refusals and
  synchronization semantics through HTTP, CLI and MCP.
- [Design](design.md): current source inventory, integration and constraint checks.
- [Development plan](development-plan.md): local delivery alongside fill, an independent
  coordination proof and staged integration/cutover.
- [ADR 0034](../../decisions/0034-human-and-agent-work-interfaces.md): work kinds,
  interfaces, ordering and product-configured workflow/acceptance.
- [ADR 0035](../../decisions/0035-work-reservations-and-operation-sync.md): PostgreSQL
  state, operation transport and subtree reservations.

The [2026-10-13 discussion](../../vision/tracker-discussion-2026-10-13.md) remains
historical source material. Where it or the first PR draft differs from the maintainer's
2026-11-07 decisions, the newer decisions govern this proposal.

## Outcome

A person can freely describe a need, inspect its place in the product's work, discuss
it, decompose it and follow its result inside madarch. An already-running agent can
triage and execute suitable work through the same model and rules. Neither side needs
a second task list, an available conversational agent just to create a task, or a
separate source of truth for status and ownership.

The tracker does not select models, launch agents or manage their processes. External
executors provide results and verified actor/model identity to the work contract.
Development and deployment stay outside fill execution, while the product reuses one
workflow engine, one catalog and the existing storage-owner boundary.

## Maintainer decisions and their coverage

The identifiers below refer to the numbered review points, not new upstream tasks.

| ID | Decided requirement | Where the revision makes it concrete |
| --- | --- | --- |
| R01 | Every work field lives in PostgreSQL, locally and on a server; priority changes need no commit. | Model contract field authority; ADR 0035; local-stage priority/edit acceptance. |
| R02 | Serverless Git is segmented operation-file transport on a dedicated ref outside working trees; grants require remote contact; later server changes transport only. | ADR 0035; agent sync contract; G1 concurrent-claim/pruning proof. |
| R03 | Reservation covers a chosen subtree, refuses another holder inside it and includes newly created children. | Ownership rules below; agent reservation commands; G1 ancestor/descendant cases. |
| R04 | Any human participant can create work; queued agent triage preserves their words and never silently closes or rewrites the request. | Human intake/review; model request and interpretation records; L1 acceptance. |
| R05 | No per-task execution approval; the product owner manages the queue, agents propose. | Priority commands and take guards; no execution-approval API. |
| R06 | Features and debt share priority levels; parallel work shares a level; a configured method such as WSJF only suggests placement. | Model priority policy; whole-feature move and proposal review. |
| R07 | Ready work is suitable, free and unblocked; lower work cannot bypass suitable higher work; caps, named refusals, owner exceptions and blocker inheritance apply. | Shared ready/take rule; I1 priority/cap races. |
| R08 | No expiry; authorized human roles investigate/unlock; configurable stale-sync Problems threshold defaults to 24 hours. | Product role/settings data; Problems and recovery scenarios. |
| R09 | Responsible person and executor agent are distinct; replacing an agent is not reservation transfer. | Model identities; executor assignment and stale-executor fences. |
| R10 | Configurable A/B/C acceptance, agents as approvers, inherited graph criticality. | Lane requirements below; model policy; I1 evidence/merge checks. |
| R11 | Each kind has manifest-defined statuses/transitions under one uniform rule and engine, not a fixed first lifecycle. | First manifest agreement; arbitrary-status conformance. |
| R12 | Start local tracker alongside fill, with catalog fields, comments, time and early br import; learn from mature trackers; link by stable keys; agree manifest and tables first. | Model comparison; M0/L1/G1 plan and current-main inventory. |

The additional graph-direction constraint is covered by the design's snapshot/stable-key
boundary and its fill-contention check: current as-is plus multiple to-be, not a new
dependency on ADR 0028's temporal version rows.

## Shared vocabulary and identities

| Term | Meaning in this proposal |
| --- | --- |
| Work item | A catalog entity representing work, with configurable kind, fields and workflow. A task is one kind, not a separate catalog. |
| Original request | The person's verbatim input, author and capture time, retained independently of later interpretations or editable summaries. |
| Triage | Queued work that proposes duplicate/contradiction links, discovery, scope, criteria, decomposition and lane; its reasoning remains visible. |
| Responsible person | The human accountable for the outcome. This planning assignment is not an authentication grant. |
| Executor agent | The currently designated agent performing work; its sessions/attempts can change without transferring the enclosing reservation. |
| Reservation holder | The authenticated subject holding the chosen subtree. Internal holder authorization is separate from the two visible assignments. Q2 settles its delegation mapping. |
| Priority level | An owner-controlled place on the product's common ordering scale. Equal levels permit parallel work where other guards allow it. |
| Acceptance lane | A product-configured set of evidence, reviewer and merge rules, influenced by inherited criticality. It is not a workflow status. |
| Stable key | A product/entity identity that survives machine changes, import and local numeric-ID remapping. Human labels and paths are not identity. |

Work links use `product_key`, `work_key` and stable graph entity keys. A local SQL
surrogate can accelerate joins but never crosses a replica boundary. Evidence pins
its source commit, content digest or retained snapshot, not an unqualified current
numeric graph row.

## Intake, planning and workflow

Creating a task requires the person's words, not a complete specification. Missing
scope or criteria is a visible reason for triage, not a reason to lose or reject the
request. The product's configured intake rule places it in the queue without giving
its author permission to choose a privileged priority. Agent suggestions are separate
records; changing the original interpretation, marking a duplicate or closing work is
an explicit, attributed action under the product workflow.

People can structure work themselves through fields, trees and decomposition previews.
An agent is optional assistance, not the only editor. Decomposition preserves stable
identity, request history, comments, time and incoming/outgoing dependencies. Parentage
expresses structure; a typed dependency expresses an execution prerequisite. Neither
is inferred from list position. Coverage of parent criteria is a review aid, never an
automatic proof that a parent outcome has been accepted.

Each kind declares its own status identifiers, transitions, guards and effects in the
uniform manifest contract. The service discovers the available actions and uses one
engine to validate them. There is no mandatory `draft/open/in_progress/submitted`
profile hidden underneath configurable labels. Readiness, reservation, synchronization
freshness, evidence validity and acceptance policy are separate facts; the manifest
can use them as guards without turning each into a hard-coded status.

## Queue ordering and taking work

`work.ready` is a permission-scoped observation, not a grant. It shows suitable work
for the participant's areas, unmet prerequisites, reservation coverage, effective
priority and any people-per-feature cap. The take operation rechecks the whole
predicate against the coordinated state, including the absence of suitable higher
free work. A concurrent priority change, new blocker or claim cannot be bypassed by
presenting an earlier ready list.

Only the product owner changes authoritative priority or grants an explicit exception
to its order. Agents may suggest a level, including a configured WSJF estimate; they
cannot turn the suggestion into authority. Moving a feature moves its priority group
atomically. A blocker temporarily inherits the highest urgency of work it blocks;
the owner's base level remains recorded so urgency can be recomputed when the
blocking relation ends. The exact group/level rule is part of the first model agreement.

A refusal identifies the higher suitable work, or a permission-safe explanation if
its details cannot be shown. A policy exception records who allowed it, its bounded
scope and the queue/policy basis. It is not the removed per-task approval step under
a different name: ordinary correctly ordered work needs no individual permission.

## Subtree ownership, executors and disconnects

A take selects a root: a whole feature or a narrower branch. A reservation includes
all descendants, including children subsequently created offline. Another holder
cannot claim an ancestor or descendant of that reserved scope. The taker cannot
reserve a branch containing someone else's work.

Q2's conservative proposal uses the existing ancestor grant rather than overlapping
reservations. To let another holder take a child, the enclosing reservation must first
be explicitly released or restructured through an agreed protocol; no silent partial
delegation is assumed. This is a design choice still to agree, not an extra decision
attributed to the maintainer.

Replacing an executor fences its old sessions/attempts but keeps the subtree holder.
Changing the responsible person likewise does not confer authority. Submitting a
child's result does not silently release the whole branch; release is explicit.
History retains earlier assignments and rejected late results without presenting them
as current evidence.

Taking shared work requires remote connection even in the first local/serverless
version. Previously confirmed holders can continue offline, create children and
record comments/time/results. Local pending commands are not global grants.
Reservation age, credential expiry and stale sync do not release ownership. After
24 hours without sync by default, the Problems page shows an actionable stale-holder
entry; product and per-item settings cover leave. An authorized human investigates
and unlocks manually, with a reason and a new fence against the old holder.

## Acceptance by product policy

The maintainer's minimum lane requirements are:

| Lane | Required review/merge rule |
| --- | --- |
| C | Green merge request plus review by another agent on another model; an authorized agent may merge. |
| B | C's checks and independent agent review, plus a person's approval of the merge. |
| A | A person is mandatory and another responsible person reviews; a lone developer does not need that second responsible person. |

An agent counts as an approver when the policy allows it. Evidence must identify the
actual reviewer and model; a worker's self-declared model string is not verified
independence. Human/agent permissions and merge authority are evaluated independently
of the responsible-person field.

An agent proposes the lane and a person may correct it with visible reasoning.
Criticality is marked on graph nodes during build and inherited downward; changing
inside a critical service takes its applicable lane. Q3 must settle mixed-scope lane
composition, the relation of A's technical checks to B/C, and authority for a policy
exception. The proposed conservative baseline keeps the strictest applicable floor
and C's technical evidence for A, without claiming that the review already settled
those details. Corrections do not silently erase inherited criticality.

## Remaining agreements, not reopened product choices

| ID | Agreement and proposed starting point | Required before |
| --- | --- | --- |
| Q1 | Review the uniform manifest rule and logical table structure in the model contract together; align them with the catalog/fill refactor, using mature tracker concepts. | M0 acceptance and production implementation. |
| Q2 | Stable holder/delegation identity, replacement of executors and parent-to-child handoff. Proposed baseline: no overlapping claims, explicit enclosing release before another holder takes a child. | G1 coordination verdict and production shared ownership. |
| Q3 | Lane composition, sole-developer qualification and authorized corrections/exceptions. Preserve the maintainer's A/B/C minimums; stricter composition is a proposal. | I1 automatic acceptance/merge behavior. |
| Q4 | Prove Git arbitration, authenticated actor binding, remote protection, safe checkpoints/pruning and later server conformance. CAS is a candidate mechanism, not a proven distributed guarantee. | G1 acceptance and any production shared grant. |

Storage in PostgreSQL, subtree coverage, free human intake, no per-task approval,
owner-controlled enforced ordering, non-expiry and configurable workflows are already
constraints from the maintainer. The next revision must not ask to choose them again.

## Scope boundary

This package keeps proposed behavior separate from current capability specifications.
It includes no running tracker, runtime schema, migration execution or coordination
proof. The static mockup is an illustrative document with inert business controls.
No executor fleet, model picker, Jira synchronization, billing or cross-product
federation is added. An external server later replaces transport, not the catalog,
workflow engine or acceptance rules.
