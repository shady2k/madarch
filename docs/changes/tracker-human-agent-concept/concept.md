# One work system for people and agents

Status: proposal for discussion. Authoring this concept is approved; its architecture,
implementation, migration and milestone scheduling are not. No product capability is
changed by this PR. Supporting task: madarch-ae8g; deferred tracker epic: madarch-lk4r.

## Reading the proposal

- This page: goal, vocabulary, shared behavior and decisions to discuss.
- [Human interface](human-interface.md): planning, decomposition and review, with a
  [static screen concept](mockup.html). Download/open the HTML in a browser; it is not
  a working tracker.
- [Agent interface](agent-interface.md): proposed operations, examples and recovery.
- [Design](design.md): existing-system inventory, boundaries and acceptance mapping.
- [Development plan](development-plan.md): proposed checkpoints, migration and proof.
- [ADR 0034](../../decisions/0034-human-and-agent-work-interfaces.md): two surfaces,
  one work model; explicit structured human editing.
- [ADR 0035](../../decisions/0035-work-reservations-and-operation-sync.md): exclusive
  ownership, field authority, Git publication and offline synchronization.

## Outcome and authorization

The owner requested on 2026-11-04 a human interface for working with and decomposing
tasks **and** an agent interface, development documentation and ADRs in a concept PR,
then discussion of comments before development. This extends the
[2026-10-13 tracker discussion](../../vision/tracker-discussion-2026-10-13.md).
The earlier discussion is source material, not an accepted protocol.

A product engineer can turn a product outcome into reviewable work, organize its
scope and dependencies, authorize execution and judge results in madarch. An already
running agent can discover eligible work, take exclusive responsibility, obtain its
context and submit evidence. Both see the same identities, criteria, ownership and
history. A person can also execute work under the same ownership rules.

Priority when qualities conflict: no double ownership or silent loss of a person's
intent; then recoverable disconnected work; then convenience and throughput. A stale
view must say it is stale. The success demonstration is one person decomposing an
outcome, two agents competing for one eligible leaf, one delivering it, and a person
reviewing it, entirely through the two supported surfaces.

The human interface is not just an agent monitor. Creating, editing, splitting,
reparenting, prioritizing, linking dependencies and reviewing work are structured
operations available without chat, a terminal or manual Git editing. Chat remains
an optional way to propose the same operations. Neither surface edits generated wiki
prose or raw graph facts. This is a **proposed narrow amendment** to ADR 0033 point 28,
not a claim that its existing chat-only rule already permits direct task editing.

## Proposed vocabulary

These definitions belong to this proposal until accepted; the current glossary is
not silently redefined.

| Term | Meaning |
| --- | --- |
| Work item | Work to achieve an outcome, linked to existing product entities; not a second copy of a requirement or use case. |
| Definition | Authored scope, criteria and planning relationships at one immutable Git revision. |
| Leaf / container | An executable work item with no active children / a non-executable item whose outcome is decomposed. |
| Decomposition | A proposed, reviewed change to a work tree and its dependency edges, adopted as one bounded bundle. |
| Responsible person | The person accountable for the outcome; not automatically its executing owner or reviewer. |
| Principal / session | Authenticated person or service identity / one authenticated working session. A display name grants no authority. |
| Reservation | Durable exclusive permission for one principal/session to execute one leaf, identified by a generation. |
| Attempt | One execution under a reservation and an immutable basis; transfer or a new claim makes another attempt. |
| Basis | Definition, referenced source revisions, prerequisite acceptances and execution approval on which work is authorized. |
| Submission / acceptance | Evidence offered by a worker / a separate authorized judgement of criteria at a specific basis. |
| Coordination domain | The set of work whose ownership is decided by one authoritative service, locally or on a shared server. |

Feature, stage, task, bug and research kinds use the product registry. Milestones and
releases group outcomes; they are not synonyms for task states. The first supported
profile uses the lifecycle below. Registry customization may label/refine states but
must map to these semantic classes and cannot remove ownership or acceptance guards;
an unsupported profile is refused, not guessed. More general workflow customization
is not a prerequisite of the first usable slice.

## Authored model and decomposition

Every item has a stable product-scoped identity, kind, title, description, bounded
scope, stable criterion IDs, responsible person, priority, estimates and links to
product entities at revisions. It may name a parent, gating dependencies, a milestone
and a release. IDs survive renames and reparenting. Names and paths alone are not IDs.

The hierarchy expresses decomposition, not execution order. A gating edge says
which accepted result is needed. Neither list order nor parentage silently adds a
prerequisite. Only accepted prerequisites count; submitted work is not accepted.
Cross-product gating is out of the first profile: related links may cross products,
but a remote acceptance is not trusted as a local grant without a later federation
contract.

A decomposition preview shows the complete before/after bundle: children, criteria
coverage, residual parent work, changed links, owners and invalidated bases.
Decomposition keeps the original identity/history as a container. A sibling split
may instead keep the original as a residual executable leaf, or explicitly cancel
it if wholly replaced. Neither operation clones acceptance into new items.
Unknown supplied links, unauthorized edits, self-parenting and dependency/hierarchy
cycles refuse adoption. Existing criteria must be accounted for; incomplete new
drafts expose missing scope/criteria without inventing them. Criterion coverage is
a review aid, not an automated proof that the decomposition is sufficient.

All definitions in a bundle become active together or none do. Large plans must be
split into independently meaningful bundles before approval, never truncated by the
server. A reserved leaf cannot become a container until its reservation is explicitly
released or revoked. Children never inherit a globally valid execution reservation.
A person may edit planning data while work is reserved, but adoption shows and
records the effect on that attempt's basis. There is no last-writer-wins overwrite.

## Shared lifecycle

| From | Operation | To and condition |
| --- | --- | --- |
| No item | Adopt a structurally valid definition | `draft`; scope/criteria may be incomplete, and no execution approval or reservation is implied. |
| `draft` | Open | `open`; definition and required fields are valid. |
| `open` leaf | Claim | `in_progress`; ready predicates and exclusive grant checked in the same transaction. |
| `in_progress` | Release or administrative revoke | `open`; attempt ends, reservation clears, generation advances. |
| `in_progress` | Transfer with target acknowledgement | `in_progress`; old attempt ends, one new owner/attempt starts, generation advances. |
| `in_progress` | Submit evidence | `submitted`; submission stored and ownership cleared atomically. |
| `open` container | Submit aggregate criterion evidence | `submitted`; authorized review preparation, no execution claim. |
| `submitted` | Accept | `accepted`; current basis and every criterion judged by an authorized reviewer. |
| `submitted` | Return with reason | `open`; submission retained; next execution requires another claim. |
| `accepted` | Reopen with reason and impact preview | `open`; prior acceptance remains in history and dependent bases invalidate. |
| Any nonterminal state | Cancel with reason and impact preview | `cancelled`; active ownership revoked, no silent cancellation of children. |

Accepted work is reopened before cancellation; cancelled work is terminal in the
first profile. Recovering its purpose creates explicitly linked new work, not a
hidden resurrection. A board move requests one of these operations; it cannot set
a status field directly.

An accepted item must be explicitly reopened before adopting any change that affects
its accepted basis: scope, criteria, prerequisites, source pins or decomposition.
The old acceptance remains historical, never proof of the revised outcome.
A returned definition proposal retains its rationale and attribution without changing
the item's lifecycle; it is distinct from returning a submitted execution result.

`ready`, `blocked`, `basis_changed`, publication status and `last_seen` are separate
observations, not extra lifecycle states. An open leaf is ready only with an active
complete definition, accepted prerequisites, person-granted execution approval and
no reservation. A parent is never executable or automatically accepted because all
its children finished: integration criteria still need evidence and review.

Changing the responsible person does not transfer execution. A stale heartbeat does
not release a reservation. Submission ends execution but does not accept its result.
Default review policy prohibits self-review; a product may explicitly allow it for
a principal that independently holds review permission. The execution approval of
the first profile is a person's decision, not an agent-created policy.

## Ownership, change and recovery

Reservations cover one leaf, not a repository, document, subtree or all work of an
agent. They persist through disconnects until release, submit, cancellation or explicit
transfer/revocation. This cannot physically stop an offline computer; it prevents
that computer's obsolete actions from changing authoritative state.

Worker commands carry item/definition revisions, attempt, reservation generation
and basis token. A transfer requires a fresh impact preview, authorized reason and
the target authenticated session's acknowledgement. If no target is available, an
administrator revokes instead; the replacement later claims normally.

A changed scope, source, prerequisite acceptance or execution approval invalidates
the attempt's basis without hiding its reservation. Old-basis submission cannot be
accepted by fetching a new token. The worker releases; an authorized person reviews
the change and approval; a fresh claim acknowledges the new basis. Safe stale results
remain rejected artifacts available for incorporation by a current owner. Reopening
a prerequisite does not falsely report its dependants as still ready.

Offline clients may continue previously reserved work and retain proposals, children,
time and evidence locally. They cannot grant shared claims, accept results or transfer
ownership. Sync reports every operation as accepted, rejected or awaiting a dependency;
rejection never deletes the local work. A local-only product can have one local
authority, but disconnected replicas of a shared product cannot each become it.

## Exclusions and boundaries

- No choice of model, process supervisor, agent installation, autonomous code execution
  or new universal scheduler. Development/deployment executors remain external.
- No replacement of the graph's entity catalog, raw fact edits or free editing of
  generated prose. Existing scoped tasks are migrated, not duplicated.
- No A2A transport selection, Jira bidirectional sync, federation, billing, resource
  booking or cryptographic role signatures in this first profile.
- No promise that 10,000 items meet a latency bound: that is the proposed scale fixture,
  not an observed measurement. Both surfaces use bounded responses.
- No conversion of this concept into accepted capability specs, activated tracker
  milestones or ready implementation tasks before review and the owner's go-ahead.

## Decisions to settle in the PR

| Question | Recommendation | Cost / alternative |
| --- | --- | --- |
| May people directly edit structured work? | Yes, through the common checked commands; keep generated content agent-mediated. | Explicit exception to ADR 0033. Chat-only planning does not meet the requested interface. |
| What owns live lifecycle, reservations and acceptance? | Transactional operational store; Git owns definitions, and exported receipts are read-only. | Requires operational backup and changes the broad wording of ADRs 0023/0029; Git-only state cannot provide the proposed shared atomic grant. |
| Should ownership expire automatically? | No, matching the requested unbounded offline scenario. | Lost clients require explicit recovery. Expiring leases favor availability but require a different offline guarantee. |
| What is the first usable result? | Human decomposition, agent claim/submission and human acceptance in one vertical slice, after a bounded concurrency prototype. | Not an API-only or UI-only delivery. Full offline synchronization follows as a separately acceptable checkpoint. |
| Which review policy is the default? | No self-review; explicit product policy may permit a separately authorized reviewer. | Single-person use needs a consciously recorded policy, not a hidden privilege. |

The PR accepts comments on these proposals. Approval of the documentation PR alone
is not authorization to begin implementation or to migrate the current tracker.
