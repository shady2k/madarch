# 0034. Work kinds share human and agent interfaces, product workflows and ordered queues

Status: proposed; maintainer requirements recorded, manifest/table agreement still required
Date: 2026-11-08

Revises the initial proposal in PR 218, not an already accepted implementation.
Companion: [0035](0035-work-reservations-and-operation-sync.md).
Scope: [concept](../changes/tracker-human-agent-concept/concept.md),
[first model agreements](../changes/tracker-human-agent-concept/model-contract.md).

## Context and problem

PR 218 was contributed by @avlokhturov. Its original request and permission to publish
a draft came from the contributor's assistant session, not repository owner @shady2k.
The earlier attribution in this ADR was wrong. The repository maintainer's
[review on 2026-11-07](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890)
now sets the product requirements this revision follows.

Madarch already has catalog kinds, product workflow declarations, a wiki task surface,
scoped Markdown tasks and repository knowledge tools. The
[current source inventory](../changes/tracker-human-agent-concept/design.md#current-source-inventory)
was refreshed against main at `ef37484d`. Existing catalog implementation statuses and
the simple task's `open/closed` field are not a sufficient work lifecycle contract.

People need to enter and organize work directly; agents need to triage and execute
suitable work without creating a separate queue. A fixed tracker lifecycle, an
individual execution-approval switch and a universal self-review default do not match
the maintainer's decisions. Product-defined workflow, enforced ordering and acceptance
lanes must apply equally to the human interface and every machine adapter.

## Decision drivers

- A human participant can submit an incomplete need without an agent or planner gate;
  their words remain intact through triage, decomposition and review.
- One catalog and one uniform manifest/engine serve work kinds and other entities.
- Product owners control the relative order of features and debt; agents can propose
  but cannot quietly bypass suitable higher work.
- Responsible person, replaceable executor and subtree ownership are not conflated.
- Review and merge rules are product policy, with verifiable people/agents/models and
  graph-inherited criticality, not a hard-coded human approval on every task.
- A usable local tracker with comments, time and early import can develop alongside
  fill without promising unproved distributed grants.

## Considered options

1. **Agent-only editing and chat-based intake.** Rejected: point 28 of 0033 governs
   wiki/graph text, not a prohibition on freely creating tasks. It would unnecessarily
   make human work depend on agent availability.
2. **A specialized tracker engine with fixed starter statuses.** Rejected by review
   point 11: it duplicates the product's workflow/catalog model, even if labels can
   later be customized.
3. **One catalog and uniform rule, with human and machine adapters** (chosen direction).
   Configurable kinds, fields, transitions and policy use the same checked operations.
   The first manifest/table agreements and substantive UI work are prerequisites.
4. **Keep an external tracker as the only work surface.** Not the requested direction.
   Mature tracker models inform the entity design and br supplies import data; neither
   is a second live authority alongside madarch.

These alternatives explain the trade-off. The revised PR does not ask the maintainer
to re-decide free human tasks or configurable workflows that the review already set.

## Proposed decision

### Work is ordinary product data

Extend catalog entities with work fields, typed links, original requests, comments,
time, assignments and result records. Work lives in PostgreSQL as ADR 0035 specifies;
there is no Git document per work item and no commit required to change priority.
Use stable product/entity keys, not machine-local numeric graph IDs. The
[model comparison](../changes/tracker-human-agent-concept/model-contract.md#1-reuse-mature-concepts-not-a-second-tracker-catalog)
uses Jira's typed relationships and YouTrack's issue/custom-field/comment/time concepts,
without claiming those systems prove madarch's coordination guarantees.

The first two agreements are the uniform manifest rule and table structure. Reuse the
existing product Manifest/kinds/workflow boundaries, with one engine interpreting
kind-specific statuses, transitions and guard/effect capabilities. No fixed state
profile is the hidden implementation beneath configurable labels. The invariant layer
cannot be disabled by a product omitting a necessary authorization or ownership guard.

### Free intake, visible triage and decomposition

Any authenticated human product participant can create a task directly. Required scope,
criteria or a complete interpretation belong to the appropriate later work step, not
to a gate that discards the initial request. Store the person's words verbatim with
who/when; editable summaries and agent interpretations link to that capture.

The item enters the owner-configured queue. At its turn, an agent checks duplicates,
contradictions, discovery needs, decomposition and criteria. It proposes its findings;
it never silently rewrites or closes the person's request. Human structured editing
and decomposition remain available without conversation. Preview and apply are shared
operations with revision, permission, cycle and ownership-impact checks, not UI-only
state. Comments, time and history remain attached through moves and splits.

The human [interface](../changes/tracker-human-agent-concept/human-interface.md) includes
backlog/tree/board, detail, request/triage review, decomposition, result review and
Problems. Board moves request manifest transitions; drag has keyboard and click/tap
alternatives. HTTP, CLI and MCP use the [same contract](../changes/tracker-human-agent-concept/agent-interface.md).

### Ordered work, not per-task execution approval

The product owner places features and technical debt on one priority-level scale.
Equal levels allow parallel work, subject to dependencies, areas, reservations and
optional people-per-feature limits. A configured method such as WSJF only proposes
initial placement. An agent cannot apply its own ranking.

Ready queries show suitable free unblocked work. Taking work revalidates ordering,
including whether suitable higher work is free; a refusal identifies that work.
Only the product owner can authorize an explicit order exception. A blocker inherits
the urgency of the work it blocks without permanently overwriting its base placement.
Whole-feature movement is atomic. The model agreement supplies the exact level/group
and participant-count rules.

There is no `execution.approve` step. Normal correctly ordered work is authorized by
queue policy and actor permissions. An exception to order is a bounded, attributed
exception, not an approval toggle required on every item.

### Responsibilities, reservations and Problems

The responsible human and executor agent are separate assignments. Replacing the agent
is not a reservation transfer; its old sessions are fenced while the holder keeps the
subtree. Changing the responsible-person field does not grant authority. ADR 0035
covers the chosen-root reservation and inherited children.

Ownership never expires. A default 24 hours without successful synchronization creates
or updates an entry on Problems, with product/per-task overrides such as leave. It
does not prove death or authorize automatic takeover. Product-configured human roles
investigate and unlock explicitly. Q2 still needs agreement on the stable holder's
delegation mapping and parent-to-child handoff, with no implicit overlapping claims.

### Acceptance lanes and graph criticality

The maintainer's lane requirements are:

| Lane | Rule |
| --- | --- |
| C | Green merge request and review by another agent on another model; an authorized agent may merge. |
| B | C plus a person's approval of the merge. |
| A | A person is mandatory and another responsible person reviews; a lone developer needs no second responsible person. |

Agents are approvers where policy permits. Record verifiable reviewer/model identity,
reviewed revision and evidence; a result's claimed green check is not an independent
review. The agent proposes a lane, a person may correct it, and graph criticality
marked during build is inherited downward. Work inside a critical service takes its
applicable lane.

Q3 must settle composition across affected scopes, A's technical baseline, who qualifies
for the sole-developer exception and authority for policy corrections/exceptions. The
conservative recommendation keeps the strictest applicable criticality floor and C's
technical evidence for A; this recommendation is not falsely attributed to the review.
No blanket self-review boolean substitutes for these rules.

## Relationship to accepted decisions

### 0033 point 28: clarify scope, do not invent an exception

Its protected editing path applies to wiki/graph text. Creating and structuring work
is not a breach of that rule, as the maintainer clarified. Generated knowledge prose
and raw facts remain outside free task editing. Both paths retain human intent and
use checked operations appropriate to their authority; work-instance changes do not
inherit the knowledge path's Git-publication requirement.

### 0033 point 29: explicit proposed amendment

The accepted paragraph still says execution in the MVP waits for an individual human
“yes” and the person merges the agent's PR. The proposed replacement for **work
execution and acceptance** is:

> Work follows the product-owner-managed ordered queue, guarded by suitability,
> dependencies and reservations; there is no separate approval for every task.
> Acceptance and merge follow the product's lane rules. An authorized agent may
> merge lane C after its required checks and independent different-model review;
> human participation follows B/A policy. Development/deployment execution remains
> outside fill orchestration behind the external executor contract.

The earlier accepted wording remains as history until this amendment is accepted.
A note on 0033 points here; this PR does not silently rewrite its accepted body.

### 0022, 0023 and 0029

0022's external-executor boundary stands: madarch holds work, not a fleet/process
scheduler; Lifemodel is a possible client, not a required runtime. Reusing one workflow
engine does not put external development processes inside the fill worker.
ADR 0035 records the proposed work-data qualification of 0023/0029: **all** work data
is PostgreSQL data, not merely reservations while definitions remain Markdown. Other
knowledge/document contracts are not replaced by this tracker proposal.

## Consequences and acceptance

- Two first-class surfaces share semantics; neither can bypass another's rules.
- Catalog/workflow reuse avoids a second taxonomy but requires the manifest/table
  agreement before implementation rather than a fixed-profile shortcut.
- Subtree exclusion and strict ordering can reduce availability. Explicit handoff,
  area/cap explanations and owner exceptions are part of usability, not optional admin
  work added after the happy path.
- Local intake, comments/time and import proceed alongside fill after M0. G1 must
  prove coordinated ownership before it is advertised as available to shared clients.
- Replace old task writers at the accepted authority cutover. No permanent alias can
  bypass queue, reservation or lane guards.

Acceptance uses the [development plan](../changes/tracker-human-agent-concept/development-plan.md):
model checks M01–M07, human/agent scenario catalogs and design constraints C01–C14.
A static mockup is layout evidence only. No current capability specification or running
implementation is changed by this ADR's proposed text.

## Sources

- [Maintainer's twelve decisions and attribution correction](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890).
- [Earlier tracker discussion](../vision/tracker-discussion-2026-10-13.md), historical input superseded where the review differs.
- [0022](0022-architecture-extension-points.md), [0023](0023-data-storage-boundary.md),
  [0029](0029-knowledge-in-markdown-graph-as-index.md), [0033](0033-one-workflow-by-entity-kinds.md).
- [W3C, Understanding Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).
