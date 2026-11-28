# Agent interface: proposed semantic contract

Status: **documentation proposal; no tracker API, protocol guarantee or runtime proof is implemented by this PR**. The [maintainer feedback](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890) sets the constraints; Q1–Q4 in the [model contract](model-contract.md) are contributor-proposed mechanisms requiring agreement. Examples are bounded review fixtures, not an executable schema or observed responses. [ADR 0035](../../decisions/0035-work-reservations-and-operation-sync.md) records the coordination proposal.

## 1. Scope and authority

The existing repository knowledge MCP tools in [`src/mcp/tools.ts`](../../../src/mcp/tools.ts) are not a tracker implementation. The registry below is new. Human UI, CLI and agent adapter must use one business contract and one storage-owner boundary; an adapter must not acquire its own task database or grant authority. The interface coordinates work and executor identity, not process launching or a universal agent scheduler.

All work data belongs in PostgreSQL: original request text, definitions, configurable fields, hierarchy and dependencies, priorities, lifecycle, comments, time, reservations, attempts, triage proposals, results, review decisions and operation receipts. Local-first storage uses PGlite through the same storage owner; a later server uses PostgreSQL. Graph badges and UI lists are projections. Cross-graph references use stable product/entity keys, never machine-local SQL IDs. Source evidence may reference immutable code commits, but work revisions are PostgreSQL revisions, not Git SHAs.

Without a server, Git transports **segmented operations and recovery checkpoints on a dedicated protected ref**, outside working trees. Git is not the task-document authority and does not perform semantic merges. A priority change is a database operation; it does not require a work-document commit or default-branch review. Transport-generated commits are not authored task documents. Shared grants require an online, durably confirmed arbitration outcome. Local planning, intake, comments and time must not wait for the G1 coordination prototype; production shared grants must.

A local-only product can accept its own operations without a remote, but cannot issue a reservation represented as globally shared. Joining a shared domain requires explicit identity/state reconciliation, not merging two independently authoritative databases. In a shared domain, offline edits are visibly pending PostgreSQL outbox records until accepted. They do not silently overwrite the last confirmed shared state.

## 2. Proposed adapters and envelope

| Adapter | Proposed invocation | Required behavior |
| --- | --- | --- |
| CLI | `madarch tracker v1 <operation> --json`, envelope on stdin | Dispatch to the local storage owner and selected transport; no HTTP server prerequisite. JSON result on stdout, diagnostics on stderr. |
| MCP | New tool `tracker_v1`, envelope as structured input/output | Same operations, permissions and domain errors; not one of the existing knowledge tools. |
| HTTP, later optional transport | `POST /api/tracker/v1/operations` | Same business outcomes and fencing; no new server-only approval or reservation semantics. |

These names and version `1.0` are proposals. Discovery returns supported versions, operation names, permission scopes, manifest/policy revisions, domain/epoch, transport mode, confirmed frontier, limits and retention/recovery capabilities. Unsupported operations/versions fail explicitly; unknown mutation fields are not silently ignored. Transport success is not evidence that a grant or every sync entry succeeded. Credentials never appear in JSON payloads or command-line flags.

Every request has `schema_version`, `operation`, `operation_id`, `product_key`, `actor` and `input`. `actor.principal_key` and `actor.session_key` must match authenticated credentials or a verified operation proof. Git author/committer strings, a caller-supplied role, an email address or `holder_key` alone confer no authority. In Git mode the protocol must bind the authenticated actor to the operation digest, product, domain and epoch; the credential format, trusted verifiers and authorization-revocation enforcement are Q4/G1 obligations, not guarantees established here.

Success carries `schema_version`, `operation_id`, `ok: true`, and `result`. Failure carries the same correlation fields, `ok: false`, and `error {code, message, retryable, details}`. Shared mutation outcomes additionally identify the confirmed domain/epoch and acceptance receipt. A locally queued request is reported as `pending`, never as a confirmed reservation. `operation.status` distinguishes `pending`, `accepted`, `rejected` and an unknown outcome; an unavailable remote cannot establish absence.

### Identity, revisions and basis

| Field | Proposed meaning |
| --- | --- |
| `product_key`, `work_key`, linked `entity_key` | Stable namespaced keys carried between machines. Local surrogate row IDs never travel. |
| `domain_key`, `epoch` | Coordination identity and recovery fence. Old-epoch requests are refused, not silently rebased. |
| `expected.item_revisions` | Explicit `{work_key, item_revision}` expectations for directly changed work; revisions are PostgreSQL item revisions. |
| `expected.structure_revision`, `expected.policy_revision` | Fences for hierarchy/dependency membership, including absent edges, and manifest/authorization/priority/lane policy. Exact physical granularity is Q1/Q4. |
| `queue_revision` | Readiness/ordering observation; grant validation checks the current queue and cannot trust a stale client sort. |
| `basis_token` | Opaque digest of relevant work content, prerequisite decisions, source evidence and configured guards. No execution-approval bit. A new token alone cannot make old evidence current. |
| `reservation_key`, `root_work_key`, `holder_key`, `generation` | Whole-subtree reservation and stable authorization identity of the authenticated taking participant/work subject. Holder identity survives executor/session replacement. It is not the independently editable `responsible_person` planning field or a third required UI assignment. Reservation generation fences release/revoke/transfer and is never reused. |
| `executor.principal_key`, `executor.session_key`, `executor_generation`, `attempt_key` | Replaceable executing principal/session and its attempt fence, scoped to the reservation. Reassignment rotates this fence without changing holder or reservation generation. |

A human may execute directly; the same holder/executor distinctions apply. A delegated agent proves current authority to act for the holder rather than merely supplying its key. `responsible_person` may differ from the holder; changing that planning field neither transfers a reservation nor grants execution authority. The exact human/agent holder and delegation mapping requires Q2 agreement. Session credential expiration does not release a reservation. Reauthentication does not resurrect an obsolete executor fence. Concurrent item edits use explicit revision comparisons, not last-write-wins.

Multi-item operations are atomic at their domain boundary. A decomposition preview returns its affected revision vector and `impact_token`; apply compares both and either creates all requested relationships/children or none. A root reservation need not enumerate an unbounded subtree in JSON: its structural fence and validator cover the full descendant closure, including concurrent insertions. Compact tokens must not turn validation into a partial or first-page-only check.

## 3. Discovery, manifest and bounded reads

`manifest.get` exposes the approved Q1 model: entity kinds, configurable fields, each kind's status IDs and transitions, one uniform transition rule/engine, referenced semantic guards, product roles/permissions, area eligibility, priority policy and acceptance lanes. Status names in a product are data, not a hidden canonical lifecycle. There is no mandatory initial `draft/open/in_progress` profile and no separate engine per entity kind.

Work creation by a human product participant requires neither an agent/planner gate nor complete acceptance criteria. Original words are stored verbatim, separately from normalized fields and proposed improvements. Incomplete work may be visible but fail a configured execution guard. Intake/triage queue order and execution priority order are distinct: triage takes requests in queue order; execution uses the owner-managed priority queue.

Proposed discovery limits: pages default 50, maximum 100; JSON request maximum 1 MiB; explicit decomposition bundles, sync batches and evidence manifests maximum 100 entries. Oversize requests fail before domain mutation; no silent truncation or partial decomposition. A subtree's exclusion is not limited to 100 descendants. Large explicit edits require independently meaningful operations rather than an invisible split transaction.

`work.list`, `work.ready`, comments and history use opaque bounded page tokens bound to product, authorized actor, filters, ordering and snapshot frontier. A stable ordering tuple ends in `work_key`; equal priority means parallel eligibility, not a hidden key-order execution restriction. `work.get` gives a bounded detail projection with current revisions, original request, responsible human, effective reservation/executor, blockers, lane and reasons; long comments/history/evidence references are paged through their named read operations. No evidence bodies are embedded into every list row.

A completed snapshot and its catch-up cursor are persisted together. Expired snapshots restart explicitly. Permissions are rechecked; inaccessible objects are not disclosed through errors, page tokens or receipts. Authorization changes invalidate affected cached projections and require resnapshot rather than leaking revoked data.

## 4. Shared operation registry

All names are proposed exact values, shared with the human interface. Product roles grant capabilities; role names such as administrator, CTO or head of development are configured data, not hard-coded identities. Read permission does not imply write, owner priority, manual unlock or review authority. Mutations authenticate, deduplicate and check applicable current revisions, permissions, structural/semantic guards and executor fences.

| Operation | Essential input | Result and rule |
| --- | --- | --- |
| `capabilities.get` | Authenticated context | Versions, operations, permissions, limits, domain/epoch, transport and retention capabilities. |
| `manifest.get` | Product, optional manifest revision | Configured kinds/fields/statuses/transitions and policy references; no default status enum imposed by the adapter. |
| `work.create` | Stable new key, kind, original request, supplied fields | PostgreSQL work record in the manifest's configured entry state. Human product participants may omit criteria; preserve original words verbatim. |
| `work.get` | `work_key`, projection | Bounded current record and actionable reasons; not a grant. |
| `work.list` | Filters, sort, page/limit | Permission-scoped snapshot with catch-up cursor. Filters include kind, configured status, parent, responsibility, executor, area and priority. |
| `work.history` | `work_key`, page/limit, optional record type | Immutable operations, proposals, results/evidence references, review, time and ownership history. |
| `work.ready` | Requester/holder context, areas, page/limit | Free, unblocked, suitable candidates by effective priority; visible blockers, cap/eligibility reasons and `queue_revision`. No reservation. |
| `work.update` | Expected revisions, explicit editable fields, reason | Atomic permitted edits. Cannot bypass specialized priority, ownership, original-text or lifecycle rules by patching protected fields. |
| `triage.propose` | Next queued request, expected queue/item revisions, analysis and suggested changes | Attributed immutable proposal for duplicates, contradictions, discovery, decomposition or criteria; does not rewrite or close the original. |
| `triage.apply` | Proposal key, expected proposal/item revisions, authorized decision | Apply explicitly selected proposed changes atomically, preserving original words and attribution. A resulting lifecycle change must pass the same transition engine. |
| `triage.return` | Proposal key/revision, reason | Record an explicit return, retaining proposal history. Apply and return serialize on proposal revision. |
| `decomposition.preview` | Root, stable child keys/fields, relationships, expectations | Complete impact summary/token including affected reservation closure and inherited priority/lane; no partial insertion. |
| `decomposition.apply` | Preview token and unchanged bundle/expectations | Atomic database change; new children inherit enclosing reservation. No Git definition adoption/publication step. |
| `workflow.transition` | Work, configured transition ID, expectations, required evidence/context | One engine validates the manifest rule and semantic guards. It cannot manufacture acceptance, change ownership or bypass review requirements through a status name. |
| `priority.propose` | Work/feature, suggested level, rationale/estimate | Agent suggestion only. WSJF or configured estimator does not change the owner's queue. |
| `priority.set` | Owner-authorized level change, expected priority/affected revisions, reason | Consistently move feature and its work on one shared feature/debt scale; preserve history and explain inherited effective levels. |
| `priority.exception` | Product-owner identity, work/holder scope, higher-work context, reason, expected policy/queue | Audited explicit authorization for a lower-priority take. Not a generic guard bypass; rechecked against its scope and current context. |
| `reservation.take` | Root, holder, executor context, revisions, basis, optional exception key | Online arbitration of whole subtree, suitability/priority/cap and exclusion together. Returns grant only with durable confirmed receipt. |
| `reservation.release` | Reservation/generation, holder authority, current expectations, reason | Explicitly release the entire reserved subtree and fence its executors. No implicit release on submission or disconnect. |
| `reservation.revoke` | Reservation/generation, authorized recovery role, current expectations, investigation/reason | Manual unlock with audit and fencing; inactivity alone never invokes it. |
| `reservation.transfer` | Reservation, current expectations, authorized source/recovery decision, authenticated target consent, target holder/context, reason | Explicit stable-holder transfer; new reservation generation and executor attempt. Recheck exclusion, target eligibility, cap and applicable queue/exception policy. Not executor replacement. |
| `executor.assign` | Reservation/generation, expected executor generation, target authenticated principal/session consent, basis acknowledgement, reason | Holder or authorized role replaces executor and rotates executor generation/attempt; holder, reservation generation and subtree remain unchanged. |
| `comments.add` | Work, stable comment key, text, applicable expectations | Attributed append, preserving original request. No implicit state/priority change. |
| `comments.list` | Work, page/limit | Bounded visible comment history. |
| `time.append` | Work, stable entry key, interval/duration, actor/attempt attribution | Append time; nonnegative duration and ordered interval. Personal retrospective time may be recorded without a live grant, but never treated as a current executor write or acceptance. |
| `time.correct` | Original entry key, stable correction key, adjustment, reason | Append correction; never rewrite original attribution or history. |
| `result.submit` | Work, expected revisions, reservation and executor fences, basis, immutable criterion/evidence references | Record result against the current attempt/basis. Does not accept work or release any reserved descendants. |
| `acceptance.evaluate` | Work/result and current basis | Explain effective lane, inherited criticality, missing evidence, reviewer independence and permitted next actions. Evaluation is not acceptance. |
| `acceptance.record` | Work/result, expected revisions, current basis, decisions/evidence, authorized reviewer/merger identity | Record lane-compliant decisions. Completion transitions still pass the uniform engine; parent acceptance is not implied by accepted children. |
| `problems.list` | Filters, page/limit | Inactivity and coordination problems with observed facts, policy thresholds and recovery actions; never an assertion that an agent is dead. |
| `operation.status` | Original operation ID and origin principal context | Authorized durable result/receipt or explicit pending/unknown status; recover a lost reply without new operation identity. |
| `sync.push` | Bounded complete envelopes with `depends_on` IDs | Per-entry accepted/rejected/pending outcomes; no atomicity across the whole batch, and no offline grant privilege. |
| `sync.pull` | Confirmed cursor or snapshot request, page/limit | Bounded accepted changes/checkpoint instructions and next cursor; deduplicable delivery, no silent gap. |

There is no execution-approval API. The owner-managed queue grants permission to start subject to current guards; creating a request or proposing a priority is not authority to reorder it. There is no Git work-definition adoption/publication registry. Configured statuses do not provide an escape hatch from specialized business rules.

## 5. Whole-subtree ownership, ordered taking and executor replacement

### Grant predicate

At one accepted ordering point, `reservation.take` must validate all of the following, including changes since a readiness read:

1. Authenticated holder/delegate and target executor are authorized; requested root and intended work satisfy configured execution/area eligibility guards. Reserving a container is allowed, but does not mark blocked descendants executable.
2. No existing grant intersects the root's ancestor/descendant closure. Another holder inside the subtree prevents taking its parent. New children created under a reserved root inherit that reservation; reparenting cannot evade exclusion.
3. The candidate is unblocked/free and no higher effective-priority, free, unblocked work suitable to this requester is available, unless the product owner supplied an applicable explicit exception. A container take must not conceal a lower-priority execution choice: check the suitable execution frontier it covers against suitable higher work outside it, and recheck before starting newly eligible work. Exact frontier representation is a Q1/Q4 proof obligation.
4. Feature people cap and current hierarchy/policy/priority are satisfied. Proposed counting is distinct human participants represented by active grants under a policy-defined holder-to-person mapping, not executor sessions or the mutable `responsible_person` field; a broad take spanning features checks each affected feature. Counting/delegation and exception rules need Q1/Q2 agreement. Replacing an executor for the same holder adds no person.
5. Revisions, relevant dependency/source basis and any target consent are current. Claim and predicate validation are one serial semantic decision, not a check followed by an unconditional write.

Features and debt share one priority-level scale. Equal-level eligible work can be taken in parallel. Feature movement moves inherited work consistently; item overrides, if supported, must be explicit policy, not accidental stale copies. A blocking item inherits the urgency needed by blocked work through a computed dependency relation, including transitive blockers; the owner's base level remains unchanged and the derived urgency disappears when the blocking relation ends. No agent may convert its estimate into an authorized priority change.

If higher suitable work is free, return `HIGHER_PRIORITY_AVAILABLE` with visible higher `work_key` values and the violated rule, not a generic conflict. If a cap or area policy excludes it, explain why it was not suitable rather than treating every higher item as an unconditional veto. Policy needs consistent visibility for execution queues: do not disclose hidden work through diagnostics or grant lower work by ignoring an authorization-visible blocker. A generic restricted-policy reason may accompany visible IDs where access prevents full detail.

### Nonexpiring reservation and Q2 boundary

The maintainer requires ancestor/descendant exclusion between holders. Q2 additionally proposes **no overlapping reservations even for the same holder**: use the existing ancestor grant, rather than create duplicate grants from separate sessions. This conservative refinement is not a maintainer-approved delegation protocol. To let another holder take a child, release/restructure the enclosing reservation explicitly and then arbitrate new grants; there is no implicit child carve-out. The released interval is visible and another eligible caller may win. A future atomic delegation protocol would need a separate agreement.

No timeout, heartbeat, session expiry, successful result submission or acceptance silently releases a subtree. Manual release/revoke/transfer changes the reservation generation and fences old executor writes. By default, more than 24 hours without synchronization creates or updates one Problems entry per affected reservation; product defaults and per-item leave overrides are configurable PostgreSQL data. The observation records when synchronization was last confirmed, not whether a process is alive. Only configured authorized product roles investigate/unlock; the monitor does not steal work.

`executor.assign` is different: an authorized holder/role selects an authenticated target with current basis acknowledgement and target consent, rotates `executor_generation`/`attempt_key`, and retains the stable holder and reservation generation. The old executor receives `STALE_EXECUTOR` even if it still has valid product credentials. This is not a new take, a priority exception or a holder transfer. A source/criteria/dependency change keeps ownership but invalidates affected attempt/result bases; explicit reconciliation and a new acknowledged attempt are necessary before new result acceptance. Copying a fresh token onto old evidence is insufficient.

## 6. Configured workflow and acceptance lanes

`workflow.transition` uses the same manifest-declared transition rule for every kind. Semantic guards may refer to current reservations, configured readiness, prerequisite decisions or lane evidence. There is no fixed universal list of statuses. `ready`, effective priority, inactivity and reservation ownership are derived facts, not mandatory lifecycle states. A submitted result remains distinct from an accepted result regardless of a product's chosen labels.

Maintainer lane minimums:

- **C:** green merge request and review by another agent on another model; an authorized agent may merge.
- **B:** the same technical evidence as C, plus human merge approval.
- **A:** mandatory human review plus another responsible reviewer; the second-responsible exception applies to a sole developer.

An agent proposes a lane; a person may correct it. Relevant graph-node criticality is inherited downward and imposes its lane requirement. Q3 proposes composing all touched/inherited requirements conservatively and retaining C's technical evidence for A. That composition, the authorized criticality-exception role and sole-developer qualification remain open agreement points. A human correction is audited, not an unqualified bypass of a mandatory floor. A generic `allow_self_review` switch cannot replace lane-specific independent identities, model evidence, human approval and responsible-reviewer rules.

Acceptance records must bind authenticated reviewers/approvers, evidence/result and basis, MR revision/status, model attribution where required, and the policy revision evaluated. Caller-supplied model names alone are not proof of independent review; how trusted evidence establishes them is an admission question. Green status or approval for an earlier MR revision must not silently approve a later change. Acceptance cannot manufacture a Git merge; the actual code repository merge permission/result is independently checked and recorded. Every child satisfying its own configured acceptance guard does not automatically satisfy the parent's criteria.

## 7. Git arbitration, operation durability and reconnect

### Candidate Q4 protocol, requiring G1 proof

Use one protected transport ref, proposed name `refs/madarch/work-operations`, for a coordination domain. Segments carry ordered operations and receipts; checkpoints carry recoverable PostgreSQL domain state and validation/deduplication fences. They are not editable task files, not graph snapshots and not the default branch. Git is the carrier; deterministic madarch validation decides business outcomes.

1. Authenticate the actor, fetch the protected ref and validate its accepted prefix/checkpoint, domain/epoch, operation identities and policy/authentication basis. Materialize the confirmed prefix through the storage owner. An arbitrary remote commit is not a trusted accepted operation.
2. Evaluate the unchanged request against that complete state, including hierarchy absence reads, priority, eligibility, caps, consent and fences. Build a deterministic candidate successor segment and receipt. A locally prepared candidate/outbox record grants nothing.
3. Compare-and-swap the single remote ref from the exact validated predecessor to that successor. Remote protection must prevent bypass, unauthorized rewrites and competing writable authorities. A failed CAS is not a grant: refetch, validate and reevaluate the same request. Business conflicts are returned rather than replacing expected revisions automatically.
4. A confirmed successful update, or verified recovery of that exact accepted operation under a later validated successor/checkpoint, permits acknowledgement. Apply the accepted outcome, journal and local events transactionally in PostgreSQL. Crash after remote acceptance but before local commit recovers by replay, not a second grant. No SQL transaction remains open during network/Git I/O.

CAS alone only orders bytes. It does **not** prove actor identity, authorized priority, truthful model evidence or deterministic semantic validation. G1 must establish a trusted writer/verifier and remote protection model which enforces these predicates, including malicious or outdated writers and credential revocation. If the available Git host cannot enforce the selected trust model, shared grants remain disabled there; an optional future server is not silently made an initial requirement. The prototype must settle feasibility, wire format and crash guarantees before production admission.

API visibility filtering cannot conceal raw payloads from a principal allowed to fetch the full transport ref. Q4 must establish compatible repository ACLs and deployment trust boundaries, and any required payload confidentiality, before promising item-level secrecy. This is a protocol admission risk, not a property supplied by page tokens.

Suppose A publishes predecessor R0 → R1 containing operation `take-a`, loses the reply, then B publishes R1 → R2. A recovers `take-a` only by checking its authenticated semantic digest and accepted receipt in the validated R2 prefix or checkpoint. It must not move the ref back to R1. If R1 was never accepted, arbitrary ancestry, a locally created commit or `OPERATION_UNKNOWN` is not proof of ownership. Retry the identical identity after reconciliation; never execute on uncertainty.

### Idempotency, pending work and fencing

The proposed idempotency key is `(domain_key, epoch, product_key, authenticated principal_key, operation_id)`. It binds a canonical semantic digest covering operation/version, actor session, expectations, fences and input, excluding transport credentials. Same key/same digest returns the original outcome; same key/different digest returns `IDEMPOTENCY_MISMATCH`. Access is checked before replay disclosure. Changed session credentials may authorize lookup but cannot rewrite the original actor/payload. New-epoch admission rejects old-epoch operations instead of replaying them under a new identity.

Domain changes, outcome/deduplication records and local durable events commit together when applying an accepted prefix. Exactly-once domain effect is a proof target built on retained identities and at-least-once delivery, not an assertion that transport never retries. Stable time/comment entry keys additionally detect conflicting duplicate domain entries submitted through different operation IDs.

Offline work may continue under a previously confirmed reservation, with ownership/basis displayed as last observed: an authorized person may have revoked or replaced it remotely. Capture results, comments and time locally; queued creation or decomposition does not grant new shared ownership. `sync.push` returns each entry's explicit accepted/rejected/pending outcome. Dependencies wait for an accepted prerequisite; a terminal rejection produces `DEPENDENCY_FAILED` for dependent operations, while unrelated entries may succeed. Cycles are invalid. When a predecessor determines later revisions, do not send the dependent request until its complete expectations are known; never send wildcard revisions or ask the receiver to silently rebase intent.

On reconnect, first resolve ambiguous IDs, fetch confirmed changes, inspect current holder/executor/basis, then send still-valid outbox entries. Outdated executor results remain local; safe, authorized late evidence may be retained as an explicitly rejected artifact with the error receipt, never a current submission. Retention does not authorize unsafe uploads or disclosure after access revocation. Personal retrospective time can be reconciled separately with historical attribution; it cannot mutate current attempt progress.

### Safe pruning and resnapshot

Segments may be pruned only after a durably published, verifiable checkpoint covers their accepted frontier and recovery obligations. Checkpoints must preserve domain/epoch, active reservations and monotonic generations, executor fences/attempt attribution, policy/auth basis, original request/history records required by product retention, operation identity/digest/outcome records or durable deduplication tombstones, stable time/comment identities, and the snapshot/catch-up frontier. Physical representation and storage budgets are Q4/O1 work; a Git commit hash alone is insufficient.

Before deletion, prove a clean machine can reconstruct confirmed PostgreSQL state from the retained checkpoint plus suffix, including all live fencing and replay rejection. Work history/data and synchronization history have distinct retention obligations: pruning transport segments is not permission to delete canonical comments, time, decisions or original requests. A receipt may point to a retained archive when its full response is no longer inline; identity/digest/outcome must still prevent a second effect. Do not time-expire deduplication just because a worker has been offline longer than expected.

An old cursor returns `CURSOR_GAP` and a checkpoint/snapshot instruction, never an empty successful page. Install the complete authorized snapshot and its frontier atomically, then pull the suffix; repeated events are deduplicated by event ID and revisions. Preserve the local outbox while resnapshotting. Replay of a pruned-but-accepted operation returns its retained outcome/archive reference, or an explicit non-replayable retired-epoch error; it must never become a new mutation.

If backup restore could roll generations, operation identity or accepted frontier backward, freeze writes. Recovery must fence the old writer/domain epoch before a new epoch can accept work; two writable restores cannot coexist. Epoch rotation is not ordinary garbage collection and cannot silently abandon existing reservations or replay identities. PostgreSQL backup plus retained transport/checkpoint recovery must be exercised together; a graph export or source-code clone is not a work-data backup.

## 8. Representative bounded JSON exchanges

Each pair is a separate illustrative invocation. This is not a complete JSON schema. Product `product:demo` has configured a kind with status `queued`, priority levels where 1 precedes 2, and an eligible subtree `WORK-17` containing `WORK-18`. Both are suitable at level 2 and no higher suitable work is free at the confirmed frontier. `holder:alice` is authenticated taking participant Alice's stable holder identity; executor `agent:a` acts by her explicit delegation. The independent `responsible_person` planning field may name someone else and grants no authority. No per-task execution approval exists.

```json
{
  "request": {
    "schema_version": "1.0", "operation": "reservation.take",
    "operation_id": "take-a", "product_key": "product:demo",
    "actor": {"principal_key": "agent:a", "session_key": "session:a1"},
    "input": {
      "domain_key": "domain:demo", "epoch": 3,
      "work_key": "WORK-17", "holder_key": "holder:alice",
      "executor": {"principal_key": "agent:a", "session_key": "session:a1"},
      "expected": {
        "item_revisions": [{"work_key": "WORK-17", "item_revision": 8}],
        "structure_revision": 12, "policy_revision": 4
      },
      "queue_revision": 31, "basis_token": "basis:17-8"
    }
  },
  "response": {
    "schema_version": "1.0", "operation_id": "take-a", "ok": true,
    "result": {
      "outcome": "accepted", "domain_key": "domain:demo", "epoch": 3,
      "receipt": {"operation_id": "take-a", "frontier": "frontier:32", "semantic_digest": "digest:take-a"},
      "work_key": "WORK-17", "item_revision": 9,
      "reservation": {"reservation_key": "reservation:7", "root_work_key": "WORK-17", "holder_key": "holder:alice", "generation": 4},
      "executor": {"principal_key": "agent:a", "session_key": "session:a1", "executor_generation": 1, "attempt_key": "attempt:7a"},
      "basis_token": "basis:17-8", "covered_by_subtree": true
    }
  }
}
```

The receipt stands for a verified accepted outcome, not a client-provided proof. There is deliberately no `expires_at` or fixed lifecycle transition. Descendant `WORK-18` is covered even though the root-only response does not enumerate it. An independently eligible new child later inserted under `WORK-17` is covered by the same grant; it must still pass execution guards.

Later, authorized Alice replaces the executor after inspecting current state. Target consent `consent:b1` denotes independently authenticated consent bound to reservation, target and basis, not a caller-supplied boolean. Its acquisition/credential format is Q4 protocol work, not a separate execution approval endpoint.

```json
{
  "request": {
    "schema_version": "1.0", "operation": "executor.assign",
    "operation_id": "replace-a", "product_key": "product:demo",
    "actor": {"principal_key": "human:alice", "session_key": "session:alice1"},
    "input": {
      "domain_key": "domain:demo", "epoch": 3,
      "work_key": "WORK-17", "reservation_key": "reservation:7", "generation": 4,
      "expected": {
        "item_revisions": [{"work_key": "WORK-17", "item_revision": 9}],
        "structure_revision": 12, "policy_revision": 4
      },
      "expected_executor_generation": 1,
      "target_executor": {"principal_key": "agent:b", "session_key": "session:b1"},
      "target_consent": "consent:b1", "basis_token": "basis:17-8",
      "reason": "Replace executor while Alice remains the reservation holder"
    }
  },
  "response": {
    "schema_version": "1.0", "operation_id": "replace-a", "ok": true,
    "result": {
      "outcome": "accepted", "domain_key": "domain:demo", "epoch": 3,
      "receipt": {"operation_id": "replace-a", "frontier": "frontier:33", "semantic_digest": "digest:replace-a"},
      "item_revision": 10,
      "reservation": {"reservation_key": "reservation:7", "root_work_key": "WORK-17", "holder_key": "holder:alice", "generation": 4},
      "executor": {"principal_key": "agent:b", "session_key": "session:b1", "executor_generation": 2, "attempt_key": "attempt:7b"}
    }
  }
}
```

Independent priority-race fixture: a requester observed `WORK-30` at level 2, then the owner moved free suitable `WORK-9` to level 1 before the take was ordered. No exception was supplied:

```json
{
  "schema_version": "1.0", "operation_id": "take-lower", "ok": false,
  "error": {
    "code": "HIGHER_PRIORITY_AVAILABLE", "message": "Take higher suitable work or request a product-owner exception.",
    "retryable": false,
    "details": {"work_key": "WORK-30", "queue_revision": 42, "higher_work": [{"work_key": "WORK-9", "effective_level": 1}], "rule": "highest_suitable_free_level"}
  }
}
```

## 9. Errors and recovery decisions

Authenticate and check access before disclosing details; check retained operation outcomes before reapplying current-state guards. For a new executor write, check reservation/executor fencing before incidental item revision conflicts so a replaced worker gets a useful explanation. Remaining validation can report multiple bounded causes. There is no promise that a stale structural/policy expectation always yields a priority-specific code; it must always reject unsafe work and return visible current reasons.

| Code | Required details and client action |
| --- | --- |
| `UNAUTHENTICATED`, `IDENTITY_MISMATCH`, `FORBIDDEN` | Correct credentials/delegation or request authorized action; never infer permission from Git authorship. |
| `NOT_FOUND`, `OPERATION_UNKNOWN` | Respect access scope. Unknown/ambiguous mutation outcome permits status/reconciliation and identical retry, not execution or a replacement operation ID. |
| `UNSUPPORTED_VERSION`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PRECONDITION_REQUIRED` | Discovered version/limit or missing expectation; correct deliberately before sending a new semantic request. |
| `REVISION_CONFLICT`, `STALE_PREVIEW`, `BASIS_CHANGED` | Changed visible keys/revisions or basis reasons; reread/reconcile, never blindly replace expectations or certify old evidence. |
| `SUBTREE_RESERVED` | Requested root and visible conflicting ancestor/descendant root, reservation key/generation; no partial grant. |
| `HIGHER_PRIORITY_AVAILABLE` | Visible higher suitable keys, effective levels and policy rule; wait/take higher work or obtain owner-scoped exception. |
| `AREA_INELIGIBLE`, `FEATURE_CAP_REACHED`, `NOT_READY` | Relevant area/feature, cap/count or blocking keys/guard IDs; a priority exception alone cannot bypass them. |
| `STALE_RESERVATION`, `STALE_EXECUTOR`, `TARGET_CONSENT_REQUIRED` | Supplied/current fences or missing target binding; stop current executor writes, retain local output. |
| `INVALID_TRANSITION`, `LANE_REQUIREMENT_UNMET` | Manifest transition/guard or lane with missing evidence/independent reviewer/approval; no hidden fallback workflow. |
| `IDEMPOTENCY_MISMATCH`, `DUPLICATE_ENTRY`, `INVALID_DEPENDENCY_GRAPH` | Original operation/entry identity or invalid edges; do not disguise a changed request as a retry. |
| `DEPENDENCY_FAILED` | Failed operation IDs; reconcile dependent intent without dropping its local content. |
| `CURSOR_GAP`, `SNAPSHOT_EXPIRED`, `RESULT_ARCHIVED` | Snapshot/checkpoint or authorized archive instruction; preserve outbox and replay protection. |
| `EPOCH_RETIRED`, `RECOVERY_REQUIRED` | Domain/epoch mismatch or unsafe restore; no implicit remapping of old operations. |
| `ONLINE_ARBITRATION_REQUIRED`, `ARBITRATION_UNCONFIRMED`, `UNAVAILABLE` | No new shared execution grant. Retain operation identity; inspect remote status before retrying uncertain writes. |

Transport-specific status/exit mappings can be agreed with the adapter schema; they cannot collapse pending/unknown into accepted. Errors and outcomes are structured and do not require parsing English messages.

## 10. Axx conformance scenarios for future implementation

All rows are **required future observations**, not tests run or evidence obtained by this documentation revision. Stages are proposed in the [development plan](development-plan.md); G1 must prove shared grant/auth/replay safety before admitting production shared claims. L1 local work is independently useful after M0 agreement.

| ID | Scenario | Required observation / stage |
| --- | --- | --- |
| A01 | Human creates a task containing only original words; agent triages next queue entry | Verbatim original retained; no criteria/agent gate; proposed duplicate/contradiction/discovery/decomposition changes are attributed and cannot silently close/rewrite it. L1/I1. |
| A02 | Two kinds declare different arbitrary status IDs/transitions | Both use one manifest rule/engine; unknown transitions fail and neither is forced into a canonical profile. M0/L1. |
| A03 | Human takes `FEATURE-1` while another holder takes descendant `TASK-2` from the same prefix | Exactly one CAS-ordered grant; loser receives visible subtree conflict, and both clients converge. Neither executes before confirmation. G1. |
| A04 | A parent already contains a different holder's grandchild reservation | Parent take fails atomically naming the conflict; unrelated free siblings remain takeable. Same-holder overlap also fails under proposed Q2, using the ancestor grant instead. G1. |
| A05 | Child insertion/reparenting races a root take | Valid accepted order either includes inherited coverage or rejects incompatible movement; no unreserved hole or overlapping grant. Structural absence reads and all descendants matter beyond the first page. G1. |
| A06 | Parent changes after decomposition preview | `STALE_PREVIEW`; zero partial children/links. Successful retry inserts all children in PostgreSQL and inherits enclosing grant without Git work-document adoption. L1/G1. |
| A07 | Owner promotes free suitable `WORK-9` after lower readiness read | Lower take revalidates and is refused with higher visible key/reason; if take was already confirmed first, no retroactive phantom second grant. Equal-level independent takes remain possible. G1/I1. |
| A08 | Higher item is area-ineligible, blocked or feature-cap-limited; two humans race the final cap place | Readiness explains suitability exclusions; lower work is permitted only when no higher suitable free candidate exists. At most one distinct additional human fills the final cap place. G1/I1. |
| A09 | Agent proposes higher priority, then owner grants a scoped lower-work exception | Proposal changes no owner level; only owner's authenticated decision admits the explicit exception, and unrelated guards remain enforced. I1. |
| A10 | Blocker holds up urgent work, then the dependency is resolved | Derived urgency raises blocker ordering, including transitive effects, without overwriting base priority; inherited urgency is removed when no longer justified. I1. |
| A11 | Executor A disconnects; Alice assigns executor B to the same reservation | Same holder/root/reservation generation; new executor generation/attempt. A's late current-result write gets `STALE_EXECUTOR`; B can act without reacquiring Alice's reservation or consuming another cap place. G1/I1. |
| A12 | No sync for more than 24h, then a configured leave override and manual recovery | One updated Problems entry reflects configured thresholds; no timeout releases work. Authorized investigated revoke advances generation; old owner cannot write as current. I1. |
| A13 | A child result is submitted/accepted while its holder reserves the parent | Neither operation releases siblings or subtree; only explicit release/revoke/transfer ends the reservation. Parent acceptance still needs its own criteria. I1. |
| A14 | Results meet C, B or A under touched/inherited criticality; reviewer/model or MR revision changes | Required lane evidence and authenticated independence enforced. B needs human merge approval; A needs human and another responsible reviewer unless qualified exception. Q3 composition is tested only after agreement. I1. |
| A15 | Scope/source/prerequisite basis changes during disconnected execution | Grant remains visible but stale results cannot become current acceptance; explicit acknowledged reconciliation preserves earlier evidence/decisions. I1. |
| A16 | A's remote R0→R1 succeeds, reply lost; B advances R1→R2 | Recover A exactly once using authenticated operation digest/receipt under validated R2; do not rewind remote or duplicate grant. A locally created/unaccepted R1 never counts. G1. |
| A17 | Remote CAS rejects A or connection breaks before outcome is known | A cannot execute; refetch/status establishes accepted same operation or revalidates unchanged request. Changed expectations require a deliberate new request, not automatic intent rewriting. G1. |
| A18 | Crash after remote acceptance before local PostgreSQL commit; then replay identical/different payload | Rebuild applies one domain effect and durable result. Identical key returns original outcome; changed digest fails. No SQL transaction spans Git I/O. G1. |
| A19 | Prune segments after checkpoint; an old client reconnects with accepted time operation and obsolete executor result | Cursor gap triggers full snapshot plus suffix without deleting outbox. Time replay does not double-count; old executor remains fenced even if original segment is gone. G1/O1. |
| A20 | Fresh machine reconstructs from retained checkpoint/suffix, then an old epoch or restored writer attempts to write | All work/history retention obligations, active grants, dedup and fences survive. Unsafe rollback freezes writes; independently writable old epoch cannot coexist. G1/O1. |
| A21 | Sync batch contains rejected stale result, independent comment and dependent operation | Per-entry outcomes preserve comment success, rejected artifact/local result, and explicit failed/pending dependency; no false whole-batch success. I1. |
| A22 | Forged Git author, unsigned/untrusted writer, revoked credential or stale-policy segment attempts a claim | Protected transport/validator refuses unauthorized acceptance. If enforcement cannot be demonstrated, shared claims stay disabled; CAS success alone is insufficient. G1. |
| A23 | Paginate 10,000 work items with concurrent changes, repeated events and revoked access | Bounds respected; one authorized snapshot plus suffix has no omission/duplicate domain effect; resnapshot removes revoked data. This is a fixture target, not a measured performance result. L1/O1. |
| A24 | Local single-connection PGlite handles tracker reads/comments/time alongside fill | Measure responsiveness and transaction contention on declared fixtures; no second storage-owner path or tracker dependency on graph temporal rows. L1/O1. |
| A25 | Replace Git transport with optional HTTP server for the same agreed domain | Same IDs, ordering/conflicts, holder/executor fences and receipts remain meaningful through an explicitly fenced cutover; no per-task execution approval or new lifecycle engine appears. O1. |

## 11. Open protocol decisions and admission

Q1 must agree manifest/table shape, policy granularity, eligibility/frontier/cap rules and physical history storage. Q2 must approve or change the conservative no-overlap/split rule. Q3 must settle lane composition and exceptions. Q4 must prove authenticated operation authorization, protected-ref arbitration, remote durability/lost-reply recovery, dedup/checkpoint trust, pruning and epoch recovery. Exact wire encoding, signature/credential scheme, target-consent proof and trusted model evidence remain open; these documents do not claim that ordinary Git hosting supplies them automatically.

The required behavior is not contingent on adding a server first. If the proposed serverless mechanism cannot meet the contract, the mechanism must return for agreement before shared grants are shipped. No runtime implementation, ready implementation tasks or accepted architecture is produced by this revision.
