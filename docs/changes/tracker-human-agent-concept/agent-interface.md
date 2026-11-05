# Agent interface: proposed semantic contract

Status: **proposal for PR review, not an implemented API or execution approval**. This document specifies the agent-facing part of the human/agent tracker concept. The human interface edits and reviews the same work items, through the same authority and concurrency rules. Numbers and operation names below are concrete review proposals, not measured limits or compatibility promises.

## 1. Existing surface and scope

The current repository MCP inventory is the seven read-only tools declared in [`src/mcp/tools.ts`](../../../src/mcp/tools.ts): `get_symbol`, `get_context`, `trace_flow`, `get_document_sections`, `search_pages`, `get_page`, and `search_questions`. They expose repository knowledge; none claims work, changes a work definition, reports execution, or accepts a result. The proposed operations below are **new**, not capabilities available through those names today.

This interface coordinates work, not agent processes, models, executors, or scheduling. A client may choose a candidate; the service does not launch it. A human worker claims through the same service. There is no agent-only backlog, shadow task database, universal scheduler, or authority in an MCP adapter.

The drivers are: a person can decompose and authorize work without losing control of its meaning; an agent can discover, claim, execute, and submit that work without duplicate ownership; both can recover from disconnects without silently losing results or accepting stale work. The conformance scenarios below turn those drivers into observable obligations.

## 2. One authority, three adapters

Proposed semantic version `1.0` has one operation registry and one JSON envelope:

| Surface | Proposed invocation | Required behavior |
| --- | --- | --- |
| HTTP | `POST /api/tracker/v1/operations` with the envelope as JSON | Authenticate the request and dispatch the operation. Queries also use this endpoint; no mutation via GET. |
| CLI | `madarch tracker v1 <operation> --json`, reading the envelope from standard input | Call the same authority; emit the response envelope to stdout, diagnostics to stderr. Credentials are not JSON arguments or command-line flags. |
| MCP | Proposed tool `tracker_v1`, with the envelope as its argument schema | Return the same envelope as structured content. Domain errors set `isError: true`; retain the exact domain code. This tool does not exist in today's inventory. |

`capabilities.get` is the bootstrap operation on all three adapters. An unsupported major version returns `UNSUPPORTED_VERSION` without performing work. Minor versions may add optional response fields and capabilities, not change existing meanings. Unknown mutation input fields are rejected rather than silently ignored. A client must not invoke an operation or optional feature absent from discovery. Authentication/transport failure is not a successful empty result.

The CLI returns exit status 0 for a successful operation (including a durably queued publication or a sync response whose entries must be inspected), 2 for invalid input/version, 3 for a domain conflict, 4 for authentication/permission failure, and 5 for a retryable transport/service failure. HTTP and MCP still expose per-entry sync outcomes, not just transport success.

### Canonical state

- Authored definitions live in Git: stable product-scoped ID, type, title, description, acceptance criteria, scope, parent, gating dependencies, linked entities and source revisions, priority, milestone/release, responsible person, and estimate.
- The transactional operational store owns lifecycle, reservations, attempts, progress/time, evidence submissions, acceptance decisions, the operation journal, and the pointer to the active immutable Git definition revision. It requires backup plus journal recovery; Git cannot reconstruct these records.
- A Git proposal is not an active definition. The publication journal first retains a validated immutable commit on a proposal ref, then transactionally compares expected old revisions and adopts all definition pointers/relationships or none. It subsequently exposes the adopted revision on the designated work publication ref. Pending publication blocks claims on affected items, including after adoption; a failed ref update is recovered, not force-pushed away. This is **not** one atomic SQL-and-Git transaction. ADR [0035](../../decisions/0035-work-reservations-and-operation-sync.md) defines the crash windows; an unadopted commit cannot make work ready.
- Graph views, task badges, events, and CLI caches are projections. The existing storage-owner boundary must be reused; adapters do not create a second owner.

### Identities and revisions

Every envelope contains `schema_version`, `operation`, `operation_id`, `product_id`, `actor`, and `input`. For item operations, `input.work_item_id` is a stable product-scoped identifier. Proposal-created IDs use client-generated UUIDs in that namespace; provisional display titles are not IDs.

`actor.principal_id` identifies an authenticated human or service principal; `actor.session_id` identifies a server-authenticated session of that principal. Credentials bind both values; caller strings never confer identity. A mismatch returns `IDENTITY_MISMATCH`. Session credentials may expire, but expiration does not release a reservation. Reauthentication may resume the same server session when authorized; a different session needs explicit transfer rather than borrowing its predecessor's token. `responsible_person_id` is an authored planning field, not the executing principal or authorization to execute.

An `attempt_id` identifies one execution attempt, minted by the authority on claim or transfer. A reservation also has a monotonically increasing `generation`, scoped to its item and never reset when a session or authority restarts. Worker writes supply both. A reserved item has exactly one owner principal/session and attempt.

`expected.definition_revision` pins the active immutable Git revision; `expected.state_revision` is a monotonically increasing operational item revision. All item-changing operations compare both, including progress and time writes. Multi-item operations supply an expected pair for every affected item, including ancestors or dependants whose coordination state will change. A missing expectation is `PRECONDITION_REQUIRED`, not last-write-wins. Read operations need no expectations.

`basis_token` is an opaque authority-issued fingerprint of the active definition, accepted gating prerequisites and their decision IDs, linked-source revisions, and execution approval. A readiness observation returns this token. The reservation pins it. A relevant source/definition/approval/dependency change invalidates the basis even if the worker's own item title did not change. Readiness and acceptance inspect the authoritative basis, not cached graph badges. State-only progress does not change the basis token.

## 3. Discovery, bounds, and authorization

`capabilities.get` returns supported schema versions and operations, the authenticated actor, coordination-domain ID, effective permission scopes, limits, event-retention/resnapshot rules, and whether online sync is supported. Discovery is descriptive; every operation rechecks permission and current state.

Proposed capability names are `work.read`, `definition.propose`, `definition.apply`, `execution.approve`, `work.execute`, `work.transfer`, `work.review`, `work.reopen`, and `work.cancel`. `work.execute` does not imply any planning, execution-approval, or review permission. For the first release, `execution.approve` is exercisable only by an authorized person; no agent-generated policy approval. Later explicit policies need a separately reviewed extension. An agent may have `definition.propose` without `definition.apply` or `execution.approve`.

`work.review` is required to accept or return submissions, including when reviewer and submitter are the same principal. Self-submission never grants it. A product's discovered `allow_self_review` policy can further prohibit same-principal review even with that permission. This proposal defaults that policy to false. Permission checking precedes disclosure of item details; inaccessible IDs return `NOT_FOUND` rather than confirming their existence.

Proposed limits: list/event pages default 50, maximum 100; definition/decomposition bundles maximum 100 affected items; sync batches maximum 100 operations; JSON request maximum 1 MiB; evidence manifest maximum 100 references. Limits are discovered, validated before mutation, and return `LIMIT_EXCEEDED` rather than silently dropping entries. Large work must be planned as independently meaningful bundles, not secretly split into partial decompositions.

`work.list` supports bounded filters for lifecycle, computed readiness, type, parent, dependency, responsible person, executing principal, priority, and milestone/release. Sorting is a documented stable tuple, such as priority then ID. Projection fields are explicit; evidence bodies and histories are not embedded in list rows. Opaque page tokens bind product, actor permissions, filters, sort, and snapshot. Changing a filter requires a new query. `work.get` returns a bounded detail record; separate `work.history` pages hold progress, time, attempts, and review decisions. Evidence manifests use `evidence.list` pages. A list snapshot carries an event cursor for race-free catch-up after enumeration. Snapshot expiration returns `SNAPSHOT_EXPIRED`; restart the query. No unbounded recursive dependency/tree expansion is implicit.

## 4. Operation registry

All names in this table are proposed exact `operation` values. Mutations require an operation ID, authentication, permission, and the applicable expected revisions. A rejection makes no lifecycle/ownership change, except that an authenticated rejected submission can retain its evidence as explicitly described below.

| Operation | Essential input and permission | Result and semantics |
| --- | --- | --- |
| `capabilities.get` | Authenticated actor | Version, permissions, limits, coordination domain, and policy discovery. |
| `work.list` | Filters, projection, page token/limit; `work.read` | Permission-scoped bounded snapshot page and event cursor. `ready=true` is an observation, not a grant. |
| `work.get` | Item ID; `work.read` | Active definition, state/revisions, basis status, owner, pending proposal summary, and allowed actions. |
| `work.history` | Item ID, page token/limit; `work.read` | Bounded immutable history, including superseded attempts and review decisions. |
| `evidence.list` | Item ID, submission or rejected-artifact ID, page token/limit; `work.read` | Bounded references and criterion mapping, with visibility filtering. |
| `work.readiness` | Item ID; `work.read` | `ready`, reason codes, current expectations, and basis token; does not reserve. |
| `definition.propose` | Base revisions, changed authored fields, rationale; `definition.propose` | Immutable proposal ID and decision revision; no adoption, opening, execution approval, or claim. |
| `decomposition.propose` | Parent, stable child IDs, child definitions, links, affected base revisions, rationale; `definition.propose` | One immutable proposed bundle plus affected ownership/basis preview. Incomplete new drafts are labeled; proposed children are not globally executable. |
| `definition.preview` | Proposal ID; `work.read` on affected items | Validated affected-item revision vector, proposal decision revision and `impact_token`, including owners and invalidations. No writes. |
| `definition.return` | Proposal ID, expected proposal decision revision, reason; `definition.apply` | Append attributed return decision; retain immutable body and rationale without changing work lifecycle. A returned or already adopted proposal cannot be applied. Amendments create a new linked proposal. |
| `definition.apply` | Proposal ID, expected proposal decision revision, preview `impact_token`, expected vector, reason; `definition.apply` | Validated proposal commit, all-or-none operational adoption and durable ref publication. Returns `pending_publication` and journal ID until publication completes, or `adopted`. Pending items cannot be claimed. Does not approve execution or accept parents. |
| `work.open` | Draft item, expected revisions; `definition.apply` | `draft -> open` when the active definition is complete; a container can open but cannot be claimed. |
| `execution.approve` | Leaf ID, expected revisions, basis fingerprint and approval rationale; `execution.approve` | Explicit person decision bound to the definition/prerequisite/source basis. It does not reserve or accept work. Returns updated basis token. |
| `execution.revoke` | Item, expectations, impact token if owned, reason; `execution.approve` | Revoke approval, invalidate readiness and an active attempt's basis; never silently expire its reservation. |
| `work.claim` | Item, expectations, readiness basis token; `work.execute` | In one transaction recompute readiness and grant reservation/new attempt, `open -> in_progress`. No separate check-then-write grant. |
| `work.progress` | Item, expectations, reservation, basis token, summary, optional percent; owning session + `work.execute` | Append progress and observed `last_seen`; percent is informational, never acceptance. |
| `work.time` | Item, expectations, reservation, basis token, stable entry ID, start/end and duration; owning session + `work.execute` | Append attributed time entry. Reject duplicate entry IDs with differing data; corrections are append-only entries referencing the earlier entry, not historical overwrites. |
| `work.release` | Item, current expectations, reservation, reason; owning session + `work.execute` | End attempt, clear reservation, increment generation, `in_progress -> open`. Allowed despite stale attempt basis; no evidence acceptance. |
| `work.impact` | Item and proposed action/target; appropriate read permission | Current affected-item vector, owners, basis changes, and impact token for transfer, cancel, reopen, or revocation. No mutation. |
| `work.transfer_acknowledge` | Item, current expectations, impact token, basis token; target session + `work.execute` | Record authenticated target consent and issue a token bound to that preview; no ownership or item revision change. |
| `work.transfer` | Current expectations, impact token, old reservation, authenticated target principal/session, reason, target basis acknowledgement; `work.transfer` | End old attempt, increment generation, create target attempt/reservation atomically. Target must have `work.execute`; stale basis must be resolved first. No overlap between owners. |
| `work.revoke` | Item, current expectations, impact token, reason; `work.transfer` | Administrative recovery: end attempt, clear reservation, increment generation, `in_progress -> open`; replacement must claim separately. |
| `work.submit` | Item, expectations, reservation, basis token, criterion-to-evidence manifest, result summary; owning session + `work.execute` | Atomically store immutable submission, end attempt, clear reservation, increment generation, `in_progress -> submitted`. Not acceptance. |
| `review.submit_container` | Open container, expectations, current basis, aggregate criterion evidence; `work.review` | `open -> submitted` without execution ownership; children do not automatically satisfy its criteria. Separate acceptance required. |
| `review.accept` | Item, expectations, submission ID, basis token, criterion decisions and rationale; `work.review` | Revalidate submission basis and complete criterion decisions; append acceptance, `submitted -> accepted`. No reservation required. |
| `review.return` | Submitted item, expectations, submission ID, reason; `work.review` | Preserve submission/review record, `submitted -> open`; next worker needs a new claim. |
| `review.reopen` | Accepted item, affected expectations, impact token, reason; `work.reopen` | Preserve former acceptance, `accepted -> open`; invalidate dependent readiness and running/submitted bases atomically. |
| `work.cancel` | Nonterminal item, affected expectations, impact token, reason; `work.cancel` | Explicit terminal `cancelled`; revoke any reservation and increment generation. Show ownership/dependant impact first; no cascading cancellation unless explicitly included. Accepted work must first be reopened; cancelled work is not resurrected by this operation. |
| `operation.status` | Original operation ID; authenticated originating principal, or authorized audit scope | `pending_publication`, terminal result/rejection, or `OPERATION_UNKNOWN`; resolve lost replies without issuing a new operation. |
| `events.read` | Durable cursor, page limit; `work.read` | Ordered bounded event page and next cursor; long polling may wait but never changes event meaning. |
| `sync.push` | Ordered batch of complete operation envelopes with `depends_on` operation IDs | Per-entry `accepted`, `rejected`, or `pending_dependency`; ordinary permissions/fences still apply. No special offline authority. |

`definition.apply` also applies decomposition proposals; there is no alternative partial child-adoption endpoint. Before adoption, supplied fields/references, cycles and parent/leaf invariants are validated. A new or existing `draft` may lack scope/criteria or other readiness fields; adoption returns those omissions explicitly. Non-draft definitions must remain complete, and `work.open`/`work.claim` always require completeness. An accepted item must first undergo authorized `review.reopen` before adopting an acceptance-basis change (scope, criteria, prerequisite/source pins or decomposition); the old acceptance never certifies the revised definition. Turning an owned leaf into a container requires the preview to identify its reservation and an explicit authorized release/revocation; `definition.apply` rejects `ACTIVE_RESERVATION` until resolved. An agent cannot bury execution approval in authored fields, a proposal, or a sync bundle. Unknown fields such as `auto_claim` or `auto_accept` are invalid.

Proposal content is immutable; its decision revision guards the one adoption/return decision. `definition.return` and `definition.apply` serialize on that revision, so adoption cannot race a return and silently win both. A returned proposal may be referenced by a newly authored replacement, never reopened by overwriting its body. This proposal-decision state is not the work item's lifecycle.

The lifecycle is `draft -> open -> in_progress -> submitted -> accepted`, with explicit cancellation, return, reopen, and release transitions above. `blocked`, `ready`, and `last_seen` are not lifecycle states. Only accepted prerequisites satisfy gating dependencies. Accepted children never automatically accept a parent. A non-executable container can be submitted for human review via `review.submit_container` (requires `work.review`, expected revisions, current basis and aggregate criterion evidence); this is the sole additional operation for `open -> submitted` without a worker reservation, and it must not create an execution attempt or claim. A reviewer separately accepts it under `review.accept`; child closure alone is insufficient.

## 5. Readiness, fencing, and stale work

`work.claim` succeeds only for an open leaf with an active adopted and fully published definition, complete criteria and scope, accepted gating prerequisites, valid execution approval, and no reservation. The authority checks these predicates and the supplied revisions/basis in the grant transaction. Two simultaneous eligible callers cannot both succeed, even if both previously read `ready: true`.

A reservation does **not expire**. No wall-clock timeout, missed heartbeat, last-seen threshold, session expiry, or internal fill lease releases it. A disconnected worker remains the owner until submit, release, cancellation, or explicit transfer/revocation. The human interface may flag inactivity and offer recovery; it cannot report that the agent is definitely running or dead. Authority backup/restore must preserve generation monotonicity; recovery that cannot guarantee fencing must stop writes until an explicit authority recovery procedure establishes a new fenced epoch, rather than reuse old generations.

Worker writes must match authenticated owner principal/session, attempt ID, generation, expected revisions, and basis. Revision conflicts require a reread; they do not justify replacing supplied expectations blindly. Progress and time advance state revision and return the next value. Serialize item writes or deliberately handle those conflicts.

Changing scope, source basis, execution approval, or prerequisite acceptance does not silently rewrite an executing attempt. Its reservation stays visible and its basis becomes `basis_changed`. Progress/time/normal submission against the invalid basis are rejected. Release remains possible with current revisions and the old valid reservation. To resume: inspect the changed basis, release the obsolete attempt, obtain any required new person approval, then explicitly acknowledge the new basis in a new claim. Merely fetching the new token does not revalidate old evidence. Submitted work with an invalidated basis cannot be accepted; return it and execute again, preserving the previous submission.

An authorized transfer requires a fresh impact preview, a reason, and acknowledgement of the valid basis by the target authenticated session. That acknowledgement is a server-issued token bound to target session, item, basis, and transfer preview; it is not a caller-supplied `true`. The target obtains it through proposed `work.transfer_acknowledge` using `work.execute`, current expectations, impact token, and basis token; this records consent but grants no reservation. Transfer rejects missing/expired consent. Administrative recovery may instead release/revoke using `work.revoke` (`work.transfer`, current expectations, impact token, reason), which clears ownership, increments generation, and returns to `open`; a replacement then claims normally. Neither administrative permission nor a status message impersonates the target agent.

Late submissions from an authentic former owner are retained as immutable rejected artifacts if the caller retains product access and the manifest is safe and within limits. The response remains `STALE_RESERVATION` or `BASIS_CHANGED` and includes `rejected_artifact_id`; the current submission, reservation, and lifecycle remain untouched. Repeated delivery of the same operation does not create duplicate artifacts. Malformed, unauthorized, or secret-bearing uploads need not be retained; clients retain their local copy for reconciliation. Rejected artifacts are visible as rejected, never candidate acceptances. A current owner must make a new valid submission to incorporate useful work.

## 6. Evidence, time, and operation durability

Evidence manifests map each acceptance-criterion ID to immutable artifact references: repository identity and commit/path, content digest, test report identity, or an immutable attachment already staged with the authority. A mutable branch name or expiring URL alone is insufficient evidence. This proposal does not implement an attachment-upload service: initial manifests use resolvable, permission-checked immutable repository/report references. Evidence entries include producer, capture time, and the basis they describe; submission records attribute the authenticated submitter independently of supplied metadata. Never send credentials, access tokens, private keys, or unrelated secrets in progress, time, manifests, or evidence. Verification of evidence and permission to accept it remain separate from the submit operation.

Time is attributed to principal, session, attempt, and basis, with both client-observed interval and server receipt time. Duration is explicit; server receipt time is not time spent. Negative durations, reversed intervals, and duplicate conflicting entry IDs are validation errors. Corrections preserve the original entry and explain the adjustment. Time totals do not establish completion, ownership, or billing approval.

For mutations, `(product_id, authenticated principal_id, operation_id)` is the idempotency key. The journal binds it to a canonical semantic payload digest including operation, schema version, actor session, expectations, reservation, and input; credentials and transport headers are excluded. Same key/same digest returns the original outcome without executing again, even when revisions have since advanced. Same key/different digest returns `IDEMPOTENCY_MISMATCH`. Authenticate and check access before disclosing a replay. Session changes use an authorized status lookup; they cannot silently rewrite the original request's actor.

Journal entries, domain writes, and durable event records commit together in the operational store. An interrupted connection after commit is an unknown outcome to the client, not permission to submit a new operation ID. Query `operation.status` or resend the identical request. An accepted publication request stays `pending_publication` while its journal reconciles Git and adoption; duplicate delivery must not publish a second competing proposal. A failed compare-and-adopt leaves an unadopted Git commit and a terminal conflict, not half-applied children. Terminal mutation results, including retained rejected artifacts, are durable; temporary `UNAVAILABLE`/`RATE_LIMITED` responses do not imply a terminal operation outcome. Keys or compacted tombstones must survive the product's operational lifetime; a retained tombstone without the full response returns `RESULT_ARCHIVED` and an audit reference, never re-executes the operation.

## 7. Representative JSON exchange

The following fixtures illustrate proposed wire data, not observed server responses. The `requests` and `responses` arrays are explanatory packaging; each numbered pair is a separate invocation of the common operation endpoint. Revision/hash values are illustrative opaque strings. Authentication binds `service:agent-a` and `session:42`; no credentials appear in the fixture. `WORK-17` already has an adopted, complete leaf definition and an explicit person's execution approval.

```json
{
  "requests": [
    {
      "schema_version": "1.0", "operation": "capabilities.get",
      "operation_id": "discover-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {}
    },
    {
      "schema_version": "1.0", "operation": "work.list",
      "operation_id": "list-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"filter": {"lifecycle": "open", "ready": true}, "limit": 50,
        "fields": ["id", "title", "lifecycle", "definition_revision", "state_revision"]}
    },
    {
      "schema_version": "1.0", "operation": "work.get",
      "operation_id": "get-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17"}
    },
    {
      "schema_version": "1.0", "operation": "work.readiness",
      "operation_id": "ready-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17"}
    },
    {
      "schema_version": "1.0", "operation": "work.claim",
      "operation_id": "claim-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17",
        "expected": {"definition_revision": "git:def-12", "state_revision": 8},
        "basis_token": "basis:b7"}
    },
    {
      "schema_version": "1.0", "operation": "work.progress",
      "operation_id": "progress-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17",
        "expected": {"definition_revision": "git:def-12", "state_revision": 9},
        "reservation": {"generation": 3, "attempt_id": "attempt:81"},
        "basis_token": "basis:b7", "summary": "Criterion C1 implementation ready for review", "percent": 80}
    },
    {
      "schema_version": "1.0", "operation": "work.time",
      "operation_id": "time-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17",
        "expected": {"definition_revision": "git:def-12", "state_revision": 10},
        "reservation": {"generation": 3, "attempt_id": "attempt:81"},
        "basis_token": "basis:b7", "entry_id": "time-entry:1",
        "started_at": "2026-11-04T10:00:00Z", "ended_at": "2026-11-04T10:15:00Z", "duration_seconds": 900}
    },
    {
      "schema_version": "1.0", "operation": "work.submit",
      "operation_id": "submit-01", "product_id": "product:demo",
      "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
      "input": {"work_item_id": "WORK-17",
        "expected": {"definition_revision": "git:def-12", "state_revision": 11},
        "reservation": {"generation": 3, "attempt_id": "attempt:81"},
        "basis_token": "basis:b7", "summary": "C1 implementation and verification evidence submitted",
        "evidence": [{"criterion_id": "C1", "kind": "repository",
          "repository_id": "repo:demo", "commit": "1111111111111111111111111111111111111111",
          "path": "reports/C1.json", "producer": "service:agent-a",
          "captured_at": "2026-11-04T10:15:00Z", "basis_token": "basis:b7"}]}
    }
  ],
  "responses": [
    {
      "schema_version": "1.0", "operation_id": "discover-01", "ok": true,
      "result": {"versions": ["1.0"], "coordination_domain_id": "authority:demo",
        "actor": {"principal_id": "service:agent-a", "session_id": "session:42"},
        "operations": ["capabilities.get", "work.list", "work.get", "work.history", "evidence.list", "work.readiness", "definition.propose", "decomposition.propose", "definition.preview", "work.claim", "work.progress", "work.time", "work.release", "work.impact", "work.transfer_acknowledge", "work.submit", "operation.status", "events.read", "sync.push"],
        "permissions": ["work.read", "definition.propose", "work.execute"],
        "limits": {"default_page": 50, "max_page": 100, "max_bundle_items": 100, "max_sync_operations": 100, "max_request_bytes": 1048576, "max_evidence_references": 100},
        "allow_self_review": false, "sync_supported": true,
        "events": {"retention_seconds": 2592000, "gap_action": "resnapshot"}}
    },
    {
      "schema_version": "1.0", "operation_id": "list-01", "ok": true,
      "result": {"items": [{"id": "WORK-17", "title": "Export selected records",
        "lifecycle": "open", "definition_revision": "git:def-12", "state_revision": 8}],
        "next_page_token": null, "snapshot_id": "snapshot:s1", "event_cursor": "cursor:100"}
    },
    {
      "schema_version": "1.0", "operation_id": "get-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "definition_revision": "git:def-12", "state_revision": 8,
        "definition": {"type": "task", "title": "Export selected records",
          "description": "Allow the selected records to be exported as CSV.",
          "criteria": [{"id": "C1", "text": "Export contains exactly the selected records, with CSV quoting preserved."}],
          "scope": {"included": ["Selected-record CSV export"], "excluded": ["Bulk export and new formats"]},
          "parent_id": null, "gating_dependencies": [], "linked_entities": [],
          "priority": 2, "milestone_id": null, "release_id": null,
          "responsible_person_id": "person:planner", "estimate_seconds": 1800},
        "lifecycle": "open", "basis_token": "basis:b7", "basis_status": "current",
        "reservation": null, "pending_proposals": [],
        "allowed_actions": ["work.claim", "definition.propose", "decomposition.propose"]}
    },
    {
      "schema_version": "1.0", "operation_id": "ready-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "ready": true, "reasons": [],
        "expected": {"definition_revision": "git:def-12", "state_revision": 8},
        "basis_token": "basis:b7", "execution_approval_id": "approval:person-6"}
    },
    {
      "schema_version": "1.0", "operation_id": "claim-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "lifecycle": "in_progress", "definition_revision": "git:def-12", "state_revision": 9,
        "basis_token": "basis:b7", "reservation": {"generation": 3, "attempt_id": "attempt:81",
          "principal_id": "service:agent-a", "session_id": "session:42", "expires_at": null}, "event_cursor": "cursor:101"}
    },
    {
      "schema_version": "1.0", "operation_id": "progress-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "definition_revision": "git:def-12", "state_revision": 10, "progress_id": "progress:1", "event_cursor": "cursor:102"}
    },
    {
      "schema_version": "1.0", "operation_id": "time-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "definition_revision": "git:def-12", "state_revision": 11, "entry_id": "time-entry:1", "event_cursor": "cursor:103"}
    },
    {
      "schema_version": "1.0", "operation_id": "submit-01", "ok": true,
      "result": {"work_item_id": "WORK-17", "lifecycle": "submitted", "definition_revision": "git:def-12", "state_revision": 12,
        "submission_id": "submission:91", "reservation": null, "generation": 4,
        "accepted": false, "event_cursor": "cursor:104"}
    }
  ]
}
```

The agent reads the complete active definition before execution; readiness alone is not a substitute for understanding scope and criteria. A separate authorized reviewer reads submission `submission:91`, resolves its evidence, and uses `review.accept` with revision 12, basis `basis:b7`, criterion decisions, and a new operation ID. That transaction creates the acceptance decision and revision 13. It is intentionally absent from the worker's permissions and from the submission response.

## 8. Errors and recovery decisions

Error envelopes contain `schema_version`, `operation_id`, `ok: false`, and `error` with stable `code`, human-readable `message`, `retryable`, and structured `details`. They never require string parsing. On simultaneous failures, check authorization first, then idempotency replay, reservation fencing for worker writes, expected revisions, basis, and lifecycle/readiness. This yields a useful ownership error for an old worker rather than hiding it behind a revision mismatch.

| Code | HTTP | Client action |
| --- | --- | --- |
| `UNAUTHENTICATED`, `IDENTITY_MISMATCH` | 401 | Authenticate correctly; do not create or release work implicitly. |
| `FORBIDDEN`, `SELF_REVIEW_FORBIDDEN` | 403 | Seek an authorized person; retrying cannot grant permission. |
| `NOT_FOUND`, `OPERATION_UNKNOWN` | 404 | Correct scope/ID; unknown operation outcome permits only same-key retry, not a replacement key. |
| `UNSUPPORTED_VERSION`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` | 400 / 413 for byte overflow | Correct request using discovered schema/limits; new semantic request gets a new operation ID. |
| `PRECONDITION_REQUIRED` | 428 | Read required revisions and construct a deliberate request. |
| `REVISION_CONFLICT`, `STALE_PREVIEW` | 409 | Reread/repreview and reconcile; never auto-rebase a person's decision. |
| `NOT_READY`, `ACTIVE_RESERVATION`, `INVALID_TRANSITION` | 409 | Inspect reason codes; wait for actual prerequisites or explicit recovery. |
| `STALE_RESERVATION`, `BASIS_CHANGED`, `TRANSFER_ACK_REQUIRED` | 409 | Stop worker writes, preserve local output, inspect ownership/basis or obtain target consent. |
| `IDEMPOTENCY_MISMATCH`, `DUPLICATE_TIME_ENTRY`, `INVALID_DEPENDENCY_GRAPH` | 409 | Repair client sequencing or proposal; do not disguise a changed request as a retry. |
| `DEPENDENCY_FAILED` | 409 | Preserve the dependent outbox entry; reconcile the failed prerequisite operation before planning a new request. |
| `CURSOR_GAP`, `SNAPSHOT_EXPIRED`, `RESULT_ARCHIVED` | 410 | Resnapshot, restart query, or consult the archived operation reference as appropriate. |
| `RATE_LIMITED`, `UNAVAILABLE` | 429 / 503 | Bounded backoff honoring `retry_after_ms`; preserve the operation ID and check status after an ambiguous write. |

Readiness reason codes include `NOT_OPEN`, `NO_ACTIVE_DEFINITION`, `INCOMPLETE_CRITERIA`, `INCOMPLETE_SCOPE`, `CONTAINER_NOT_EXECUTABLE`, `DEPENDENCY_NOT_ACCEPTED`, `EXECUTION_APPROVAL_REQUIRED`, `RESERVED`, and `BASIS_UNRESOLVED`. The response can carry multiple reasons with visible dependency IDs; it does not expose hidden work.

Representative terminal errors, from independent scenarios:

```json
[
  {
    "schema_version": "1.0", "operation_id": "claim-agent-b", "ok": false,
    "error": {"code": "REVISION_CONFLICT", "message": "The item changed after readiness was read.", "retryable": false,
      "details": {"work_item_id": "WORK-17", "expected_state_revision": 8, "current_state_revision": 9,
        "readiness_reasons": ["NOT_OPEN", "RESERVED"]}}
  },
  {
    "schema_version": "1.0", "operation_id": "late-submit-02", "ok": false,
    "error": {"code": "STALE_RESERVATION", "message": "This attempt no longer owns execution.", "retryable": false,
      "details": {"supplied_generation": 3, "current_generation": 5, "rejected_artifact_id": "rejected:12"}}
  },
  {
    "schema_version": "1.0", "operation_id": "submit-after-reopen", "ok": false,
    "error": {"code": "BASIS_CHANGED", "message": "A prerequisite acceptance was reopened.", "retryable": false,
      "details": {"work_item_id": "WORK-17", "basis_token": "basis:b7", "changed_dependencies": ["WORK-9"], "rejected_artifact_id": "rejected:13"}}
  },
  {
    "schema_version": "1.0", "operation_id": "apply-children-01", "ok": false,
    "error": {"code": "STALE_PREVIEW", "message": "Parent or affected ownership changed after preview.", "retryable": false,
      "details": {"proposal_id": "proposal:8", "changed_items": ["WORK-17"], "adopted_items": []}}
  },
  {
    "schema_version": "1.0", "operation_id": "submit-01", "ok": false,
    "error": {"code": "IDEMPOTENCY_MISMATCH", "message": "This operation ID was already used with different evidence.", "retryable": false, "details": {}}
  },
  {
    "schema_version": "1.0", "operation_id": "agent-accept-01", "ok": false,
    "error": {"code": "FORBIDDEN", "message": "Review permission is required; submission does not grant it.", "retryable": false,
      "details": {"required_permission": "work.review"}}
  }
]
```

For the `BASIS_CHANGED` example, the worker has reread the current state revision but still holds the invalidated attempt basis. With an old state revision it instead receives `REVISION_CONFLICT` first; neither response allows acceptance or replacing the basis token on an old attempt.

## 9. Durable events and reconnect

Operational commits append ordered durable events with event ID, item ID, definition/state revisions, operation ID, event kind, and opaque cursor. Delivery is at least once. Consumers deduplicate by event ID and never treat a repeated event as a second write. Ordering is scoped to the coordination domain, not an assertion about external Git commits, other products, or wall clocks.

`events.read` uses a cursor after the last durably processed event. If the client receives a page but crashes before saving its cursor, the page may repeat. State updates are installed only if newer than the client's cached item revision. Projection lag is visible; claim and review always consult the authority, not the event consumer's cache.

A lost connection resumes from that saved cursor. If retention, authority recovery, or permission changes invalidate it, `CURSOR_GAP` returns a resnapshot instruction. Enumerate `work.list` under one bounded snapshot, persist its snapshot cursor with the completed local snapshot, then consume events after that cursor. While paging, do not advance to a moving latest cursor and omit changes between pages. Permission-scoped snapshots/events must also remove items from a client cache when access is revoked; a permission epoch change forces resnapshot rather than leaking revoked payloads. An event stream never grants access through possession of a cursor.

## 10. Offline and synchronization

Offline activity means a local cache/outbox, not a replica that grants globally valid ownership. Only work already reserved online can continue executing on its recorded basis. The client displays that ownership and readiness are last observed, not guaranteed current; another authorized person may have revoked them while disconnected. No new shared claim, acceptance, transfer, or dependency-readiness certification is valid offline. A deliberately local-only coordination domain may be authoritative for itself, but cannot later masquerade as the shared domain or merge competing reservations.

Agents may create local definition/decomposition proposals with stable IDs, capture progress/time/evidence, and queue operation envelopes. `depends_on` expresses outbox ordering; it grants no domain permission. When prior accepted operations determine a later expected revision, retain the later entry locally as `pending_dependency` until that response is known, then materialize its complete immutable request. Do not let the server substitute arbitrary current revisions or use a wildcard fence. An operation's payload and ID become immutable on its first send. Basis changes still require review, not mechanical revision substitution.

On reconnect, reconcile status for ambiguously delivered operation IDs, read current ownership/basis and events, then `sync.push` ready envelopes. Each entry receives `accepted` (operation durably accepted; inspect its possibly pending publication status), `rejected` (terminal error with retained local material), or `pending_dependency` (not executed yet). A dependency is satisfied only by successful terminal completion, not by queued Git publication. If its dependency fails, reject descendants with `DEPENDENCY_FAILED`; unrelated entries may succeed. Invalid outbox dependency cycles are `INVALID_DEPENDENCY_GRAPH`. The outer sync request does not turn the batch into a transaction or override each inner operation's journal key.

A decomposition bundle is one inner operation and adopts atomically; parent/children cannot trickle into execution because a subset happened to sync. Proposal creation and adoption do not approve execution. New children need explicit execution approval and individual online claims after adoption. Rejected edits, stale results, and time records remain available locally and, when safely received, in the rejected-artifact/audit history for human reconciliation. Nothing silently overwrites current state or silently drops the rejected result.

## 11. Conformance scenarios for a future implementation

These are proposed acceptance checks, not tests run in this documentation change.

| Scenario | Required observation |
| --- | --- |
| Human and agent race to claim one ready leaf | Exactly one reservation/attempt commits. Loser gets a revision/readiness conflict. Both surfaces read the same winner and generation. |
| Dependency reopened between readiness and claim | Claim fails; no attempt or reservation is created using the old accepted prerequisite. |
| Agent proposes a parent and three children | Proposal is reviewable but children are not executable. Applying it creates no execution approvals or reservations. |
| Parent changes after decomposition preview | Apply returns `STALE_PREVIEW`; no active child pointer or parent relationship is partially adopted. |
| Crash after Git commit but before adoption | Publication journal resolves pending/conflicted adoption; Git existence alone never makes children ready. Duplicate operation does not create a second adoption. |
| Worker disconnects and session credentials expire | Reservation remains non-expiring; no second worker can claim without explicit release/revocation/transfer. |
| Authorized person transfers a valid-basis item | Fresh preview, reason, and authenticated target consent are required; generation changes once, old attempt ends, new attempt owns exclusively. |
| Old worker submits after transfer | Current ownership/result unchanged; `STALE_RESERVATION` and one retained rejected artifact on safe authenticated submission. Identical retry creates no duplicate artifact. |
| Worker reports two concurrent updates at one state revision | One succeeds, one conflicts; no lost progress/time write. Client reconciles before forming another request. |
| Scope/source/prerequisite changes during execution | Basis becomes invalid, reservation stays visible, normal worker writes and acceptance cannot proceed. Release and explicit reapproval/new claim recover without rewriting history. |
| Submission succeeds but response is lost | Same-key replay or status returns the original submission; no second submission, time entry, or generation increment. |
| Same operation ID sent with changed evidence | `IDEMPOTENCY_MISMATCH`; original evidence remains immutable. |
| Submitter without review permission attempts acceptance | `FORBIDDEN`; item remains submitted. A self-review-disabled product also rejects a submitter with review permission. |
| Every child accepted | Container remains unaccepted until an explicit criterion-backed container submission and authorized acceptance. No claim of the container succeeds. |
| Offline client attempts a new shared claim | No local globally valid reservation; server evaluates an eventual online request against current state, without honoring offline timestamps. |
| Offline sync contains stale progress, independent proposal, and dependent submission | Stale entry rejected, unrelated proposal can succeed, dependent entry waits or fails with dependency error; no automatic replacement of fences. |
| Event page repeats or cursor falls outside retention | Duplicate events are harmless; gap requires snapshot plus catch-up, never silent omission. |
| Access revoked while client is disconnected | Old credentials/cursor cannot disclose protected items; reconnect invalidates permission-scoped cache through resnapshot. |
| 10,000-item fixture queried through every adapter | No response exceeds discovered page bounds; stable pagination enumerates all visible snapshot items without duplicates/omissions. This is a review target, not a performance claim. |
| Restore without reliable reservation fencing history | Authority refuses execution writes until safe epoch/fence recovery; it does not accidentally honor a pre-restore owner. |

## 12. Decisions still proposed for review

The operation names, generic MCP tool shape, exact permission vocabulary, self-review default, numeric bounds, container-review operation, target-consent mechanism, and durable journal retention policy are proposals, not accepted architecture. The shared lifecycle, one-authority boundary, human execution approval in the first release, non-expiring ownership with generation fencing, and distinction between submission and acceptance are the consistency requirements this proposal is designed to preserve. Implementation must wait for the concept PR discussion and explicit approval; no part of this document activates a tracker milestone or supplies an executable scaffold.
