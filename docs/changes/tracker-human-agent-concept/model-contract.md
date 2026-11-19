# First agreements: one manifest rule and one work data model

Status: proposed contract for M0 review, not accepted schema or executable configuration.
Source: [maintainer review, especially points 1 and 9–12](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890).
The [concept](concept.md) separates those decisions from Q1–Q4 mechanisms still to agree.

## 1. Reuse mature concepts, not a second tracker catalog

Primary-source comparison read for this revision:

| Source | Established structure | What madarch reuses / does not infer |
| --- | --- | --- |
| [Jira issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/) | A typed relationship has an inward issue, outward issue and link type; linking and commenting have distinct permissions. | Typed, directed links and permission checks. Parentage, blocking, duplicate and related are not interchangeable edges. Jira's duplicate-link/comment behavior is not adopted as madarch's idempotency contract. |
| [YouTrack Issue](https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html) | An issue belongs to a project and exposes a readable identifier, description, custom fields, reporter, parent/subtasks, links, comments and an external-source reference. | A catalog entity with configurable fields, stable source mapping and attached records, not a new class/table for each work kind. A display ID is distinct from identity. Its API shape is not copied wholesale. |
| [YouTrack time tracking](https://www.jetbrains.com/help/youtrack/devportal/operations-api-issues-issueID-timeTracking.html) | Time tracking is a separate issue sub-resource holding work entries. | Attributed time entries attached to work, independently auditable and pageable. YouTrack's `IssueWorkItem` means a time entry; it is not madarch's Work item. |

Neither source establishes madarch's subtree exclusivity, priority enforcement,
offline arbitration, A/B/C policy or Git transport safety. Those are product-specific
rules with their own acceptance scenarios. This comparison is an entity-model input,
not a recommendation to clone Jira, build a bidirectional integration, or adopt its
internal database schema.

## 2. Authority and identity

All work instance data lives in PostgreSQL: original requests, editable summaries,
field values, relationships, priorities, assignments, comments, time, reservations,
results, review decisions, policy settings and operation records. Local mode uses the
PostgreSQL-compatible storage boundary already present in madarch; server mode keeps
the same logical model. PGlite is a possible local runtime, not proof of concurrent
interactive performance.

The uniform manifest describes kinds, fields, workflow and policy references; it is
not a directory of work-instance documents. The existing glossary calls
`workspace.yaml` the product Manifest, and current fill workflows are product data in
`madarch/workflows.yaml`. Q1 must agree how the uniform declarations extend those
existing formats and how a validated configuration revision is installed. The
illustration below does not establish a competing manifest file or loader. PostgreSQL
holds the effective validated revision and work settings; file-sourced configuration
cannot silently change live work outside the checked installation/transition path.
Changing a work title or priority never edits those configuration files or requires a
Git commit.

Every catalog entity has a stable product-scoped key. A work row extends that entity;
it does not allocate a second catalog identity. Human-readable work numbers, source
paths and machine-local SQL IDs are secondary attributes. Import retains the old
system's ID in an explicit mapping. Graph links use stable entity keys plus a context
key for current as-is or a named to-be. Immutable evidence adds a source commit,
content digest or retained snapshot key. No operation transports `node_version.id` or
assumes identical numeric IDs on two machines.

## 3. Uniform manifest rule: proposed logical shape

One engine interprets declarations for every entity kind. Each declaration names:

1. Kind identity and configurable field definitions, types and validation.
2. Its own status identifiers and allowed transitions. These are data, not aliases
   for a private fixed tracker enum.
3. References to shared guard/effect capabilities, their required inputs and the
   permissions that may invoke them. A missing capability is a manifest error.
4. Which actions are currently eligible: for example queued triage versus delivery.
   Their preconditions are rules, not a hard-coded interpretation of a status name.
5. Policy references for ordering, area eligibility, reservations, review/merge and
   inactivity. A kind cannot remove mandatory coordinated-ownership or authorization
   checks by omitting a guard.

Illustrative logical input, deliberately not a file accepted by today's engine:

```json
{
  "schema_version": "proposal-1",
  "kinds": [
    {
      "key": "task",
      "fields": [
        { "key": "summary", "type": "text", "required_for": ["display"] },
        { "key": "scope", "type": "entity_reference_list", "required_for": ["delivery"] },
        { "key": "criteria", "type": "criterion_list", "required_for": ["delivery"] }
      ],
      "workflow": {
        "initial": "received",
        "statuses": ["received", "investigating", "checking", "resolved"],
        "actions": [
          { "key": "triage", "from": ["received"], "to": "investigating", "guards": ["ordered_reservation"], "effects": ["record_interpretation"] },
          { "key": "request_review", "from": ["investigating"], "to": "checking", "guards": ["current_evidence"], "effects": ["attach_result"] },
          { "key": "resolve", "from": ["checking"], "to": "resolved", "guards": ["lane_satisfied"], "effects": ["record_acceptance"] }
        ]
      },
      "policies": { "queue": "product-order", "review": "product-lanes" }
    },
    {
      "key": "research",
      "fields": [
        { "key": "question", "type": "text", "required_for": ["display"] }
      ],
      "workflow": {
        "initial": "questioned",
        "statuses": ["questioned", "answered"],
        "actions": [
          { "key": "record_answer", "from": ["questioned"], "to": "answered", "guards": ["ordered_reservation", "current_evidence", "lane_satisfied"], "effects": ["record_acceptance"] }
        ]
      },
      "policies": { "queue": "product-order", "review": "product-lanes" }
    }
  ]
}
```

These names demonstrate two different workflows, not required states for a first
release. Free request creation precedes delivery completeness; the original text is
retained even when a summary or kind-specific fields need triage. The eventual schema
must represent return/reopen/cancel and other product-declared transitions through
the same rule, rather than installing a second engine for those actions.

A workflow transition does not itself grant a reservation, release an enclosing branch
or merge a request. Those effects use checked capabilities with explicit scope. The
shared engine's invariant layer enforces authentication, revision and ownership
checks even if a product configuration is invalid. Reject the whole invalid manifest
with file/pointer, kind, field/transition and reason; no silently smaller valid subset.

Changing a manifest or policy is versioned and reviewed against existing items. A
removed status/field requires an explicit mapping and preview; unresolved items do
not get guessed replacement states. Installing changed rules invalidates stale action
previews and re-evaluates affected readiness/evidence. The M0 fixture must run two kinds
with unrelated status names through one engine and refuse an unknown guard or dangling
transition.

## 4. Proposed logical table responsibilities

These are logical responsibilities to agree, not an additive schema beside a new
catalog. Names of existing storage interfaces win at implementation; the generic
catalog tables being refactored may satisfy the first rows directly. In particular,
ADR 0028's current `work_item` is the fill queue, not the tracker work entity.

| Logical group | Key and retained data | Required invariant |
| --- | --- | --- |
| Product and installed manifest | `product_key`, configuration revision/digest, kind/field/workflow declarations | One effective validated revision; no independent engine per kind. |
| Catalog entity and typed relation | Stable entity/relation keys, kind, graph context, endpoints | Common catalog identity; no cross-machine numeric references. |
| Work detail | `work_key` referencing the catalog entity, summary, typed custom values, scope, criterion IDs, workflow state, `item_revision` | All instance values in PostgreSQL; state belongs to that kind's active manifest. |
| Request capture and interpretation | Capture key, verbatim bytes, person, time, optional conversation; separate proposed interpretation, rationale and decision | Original capture immutable; corrections/clarifications append with provenance. |
| Hierarchy and work links | Parent edge, blocking/related/duplicate links, structure revision | At most one parent; no hierarchy/dependency cycles; structure is not execution order. |
| Priority group and proposal | Feature/standalone group key, owner-set base level, pending proposal and decision, queue revision | Only product owner changes authoritative levels; whole-feature move is one operation. |
| Product roles, membership and areas | Role/permission definitions, verified principal membership, participant/area mapping, policy revision | Display names or submitted actor strings grant nothing. |
| Work assignments and executor history | Responsible person, executor principal/session, executor generation, attempt and change reason | Replacing executor fences old writes without transferring reservation; responsibility is not authority. |
| Reservation | Reservation/root/holder keys, generation, confirmed operation/frontier, explicit end record | Non-expiring subtree exclusion; new children inherit active coverage. |
| Comment | Stable comment key, work key, author, time, text, optional reply/source reference, visibility | Comments survive state changes/import; amendments retain prior attribution. |
| Time entry and correction | Stable entry key, work/participant/executor/attempt, observed interval, duration, source and correction reference | No duplicate accounting; corrections append, never silently rewrite an entry. |
| Result, criterion evidence and review | Result/evidence keys, basis, immutable artifacts, policy/lane, reviewer/model proof and decisions | Reported checks are not acceptance; stale or inaccessible required evidence cannot satisfy policy. |
| Product work settings and Problems | Feature cap, priority method, role references, default/per-item inactivity period, last successful sync and problem identity | 24 hours is the default observation threshold, never a reservation TTL. |
| Operation journal and local outbox | Domain/epoch, operation identity/digest, actor proof, expectations, outcome and transport frontier | Durable deduplication; pending local commands are not confirmed remote grants. |
| Import mapping and reconciliation | Source snapshot/system/key, stable target key, source checksum, mapping decisions and errors | Repeat import has the same identities; no fabricated reservation, approval or reviewer. |
| Snapshot/checkpoint references | Stable snapshot/frontier, context, integrity and retained evidence/agent-result references | History thinning cannot erase still-required evidence, fences or replay protection. |

Proposed physical starting point: indexed typed columns for identity, relationships,
priority, ownership and revisions; schema-validated JSONB for kind-specific values.
Do not encode reservations, dependencies or priority solely in an opaque custom-field
blob. Immutable append records carry their own keys and revisions. Q1 must accept the
foreign-key/index plan, transaction boundaries and field evolution before DDL is
implemented. A speculative DDL migration is not part of this PR.

## 5. Shared guards and proposed policy mechanics

### Priority and suitability

Proposal: smaller numeric levels are earlier; this is an implementation convention,
not a business claim that a particular number is urgent. A feature and its descendants
share a priority group; standalone debt can be its own group. Product-owner movement
of a feature changes the whole group's base level atomically. Dependencies determine
internal order rather than inventing hidden per-child priority ranks. New human
requests use an owner-configured intake placement; an agent may propose a different
placement but cannot apply it.

The effective level is the earlier of the assigned base level and the urgency inherited
from unsatisfied work it blocks, propagated transitively. Removing a blocking link or
satisfying its requirement recomputes inherited urgency without destroying the owner's
base placement. The ready and take checks use effective levels and current area
eligibility, permissions, prerequisite satisfaction, subtree coverage and feature cap.
They include membership/absence checks, not just revisions of the chosen leaf.

A cap counts people/participants, not agent processes. The proposed mapping counts
multiple verified executors acting for one person once; an unmapped service principal
cannot evade the cap by appearing as zero people. The exact participant mapping and
any service-only policy must be agreed in Q1/Q2 and exposed in discovery.

### Ownership and the two assignments

The responsible person and current executor remain the two planning/execution
assignments. `holder_key` is internal reservation authorization, not a third competing
assignee. It names the authenticated taking subject; it must not be inferred from
`responsible_person` or a caller-supplied agent name. Q2 must settle verified delegation
when an agent takes work for a person.

The conservative proposal has no overlapping independent reservations. A holder uses
its ancestor grant for descendants. To let another holder take a child, release the
enclosing scope explicitly before the new take; an atomic handoff/partition capability
would need its own agreed contract. Creating or reparenting children revalidates
coverage against the same structure revision. A parent cannot absorb another holder's
branch, and a move cannot escape a reservation accidentally.

An executor replacement advances `executor_generation` and the attempt, not the
reservation generation. Actual reservation release/revoke/transfer advances the
reservation fence. Late work is retained with its rejected or historical status; it
never overwrites current assignments, acceptance or ownership.

### Review, criticality and snapshot retention

The [concept's lane table](concept.md#acceptance-by-product-policy) records the exact
maintainer minimums. Q3's proposal composes affected scopes by the strictest inherited
lane and preserves C's technical evidence for A. This is not permission to silently
upgrade those proposals into an owner decision. Role-checked human correction records
its grounds and changed graph/policy basis. Sole-developer qualification and any
exception below an inherited floor require an explicit policy, not a client flag.

Graph-node criticality, manifest/work revisions, source evidence and policy revision
are part of result validity. A graph snapshot is an immutable evidence context, not a
version-row foreign key. Retention pins all snapshots/artifacts required by current
work, accepted evidence and paid agent-result reuse. A deliberate retention release
must leave an explicit unavailable-evidence record; ordinary age thinning cannot make
an earlier acceptance appear newly verified or silently lose paid results.

## 6. M0 agreement and observable checks

M0 is complete only when the maintainer agrees the manifest rule and table structure,
including their integration with the catalog/fill direction. The proposed schema is
not accepted merely because this file exists. The decision records must name accepted
choices and leave Q2–Q4 visible until their own admission points.

| Check | Observable scenario |
| --- | --- |
| M01 | Two kinds with unrelated status names use the same transition engine; unknown guards, invalid states and unsupported fields produce exact errors, not fallback states. |
| M02 | A person creates a request without criteria; original bytes survive triage, summary edits, duplicate proposals, comments and import. |
| M03 | Two databases deliberately assign different numeric IDs; imported work and graph links still resolve to the same stable keys in as-is/to-be contexts. |
| M04 | Change priority, custom field and comment locally: PostgreSQL reflects them without creating or editing a task file or a definition commit. |
| M05 | Renaming/removing a configured status requires a reviewed mapping for existing items; a stale transition proposal is refused after installation. |
| M06 | A manifest tries to omit ownership/authorization enforcement; the invariant layer refuses an unsafe transition rather than bypassing the work contract. |
| M07 | An imported historic completion has its source provenance but gains no fabricated live holder, current reviewer or model-independence proof. |

These are planned acceptance scenarios, not tests run by the documentation change.
