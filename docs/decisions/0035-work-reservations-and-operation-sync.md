# 0035. PostgreSQL work data, durable subtree reservations and Git operation transport

Status: proposed; revised after maintainer feedback
Date: 2026-11-08

Not effective until accepted. Companion: [0034](0034-human-and-agent-work-interfaces.md). This proposal qualifies the tracker boundaries in [0023](0023-data-storage-boundary.md), [0029](0029-knowledge-in-markdown-graph-as-index.md) and [0033](0033-one-workflow-by-entity-kinds.md). It does not introduce a dependency on [0028](0028-temporal-graph-store.md)'s temporal rows or graph extraction jobs. The [model contract](../changes/tracker-human-agent-concept/model-contract.md) owns Q1–Q4; the [agent contract](../changes/tracker-human-agent-concept/agent-interface.md) owns the proposed operation registry, envelope, errors and Axx scenarios.

## Context and authority of this revision

The [maintainer's feedback on PR 218](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890) requires all work data in PostgreSQL, local-first usability, a serverless Git operation transport, online arbitration for shared taking, nonexpiring whole-subtree reservations, owner-controlled priority, configurable workflows and acceptance lanes. This replaces the earlier draft's Git-authored work definitions, leaf-only grants, per-task execution approvals and server-first coordinator. That earlier draft was a contributor proposal, not an approved maintainer design.

The constraints below come from the maintainer. The CAS/segment/checkpoint protocol, exact manifest/table shape, conservative same-holder overlap rule, delegation mapping and lane composition are **proposed mechanisms**, not already accepted decisions. This documentation PR supplies no implementation or experimental evidence. G1 must prove the shared-coordination design before production shared grants; local catalog/UI/agent work need not wait for that proof.

## Maintainer constraints and observable checks

This is the closed constraint set for this ADR; R01–R12 follow the feedback traceability in the concept. Axx refer to future conformance checks, not executed tests.

| Constraint | Required behavior | Future check |
| --- | --- | --- |
| R01 — PostgreSQL work authority | Definitions, original text, priority, state, comments, time, reservations, reviews and settings are work records, not Git task documents. | A01, A06, A18: local records and replay have no definition-publication dependency. |
| R02 — Git transport, online grants | Dedicated segmented transport ref outside working trees; semantic validation by madarch; online durable arbitration before a shared grant; future server changes transport only. | A03, A16–A20, A22, A25. |
| R03 — Whole-subtree taking | Taker chooses level; ancestor/descendant exclusion; another holder inside prevents parent grant; new children inherit. | A03–A06, A13, including concurrent structural changes. |
| R04 — Ungated human intake | Any human product participant can create incomplete work; original words remain verbatim; agent triages in queue order and proposes changes explicitly. | A01, A06. |
| R05 — No per-task execution approval | Owner-managed queue plus configured eligibility/guards governs starting; agents cannot silently reorder it. | A07–A09; registry contains no execution approval operation. |
| R06 — One priority-level scale | Features/debt share levels, equal levels allow parallelism, feature movement is consistent; estimates suggest only. | A07, A09, A10. |
| R07 — Enforced suitable queue | Highest suitable free/unblocked work, areas and optional people caps checked at grant; owner-only explicit lower-priority exception; blockers inherit urgency without rewriting base levels. | A07–A10, including final-cap-place race. |
| R08 — No expiry | Manual authorized recovery only; default more-than-24h no-sync Problems signal, configurable defaults/leave overrides. | A12; disconnect/credential expiry never transfers ownership. |
| R09 — Responsible human and executor differ | Replace executor without transferring stable ownership; fence obsolete attempts. Responsible-person planning data is not itself authorization. | A11 and late-result A19. |
| R10 — Acceptance lanes | C: green MR plus another agent on another model, agent may merge. B: C plus human merge approval. A: human mandatory plus another responsible reviewer, second-responsible sole-developer exception. Inherited criticality constrains lane. | A14–A15; authenticated evidence, not a generic self-review toggle. |
| R11 — Manifest workflow | Configured statuses/transitions per kind; one rule and one engine, no mandatory first status profile. | A02, A14. |
| R12 — Local usable tracker alongside fill | Catalog/configurable fields, comments/time and early br import; stable cross-graph keys; agree manifest/table shape first. | A01, A23–A24; import/state reconciliation covered by integration plan. |

Kept architectural principles are one storage owner rather than adapter-owned databases (R01/R12), one configurable transition engine (R11), and observations distinct from ownership/acceptance authority (R02/R08/R10). Current as-is and multiple to-be graphs remain independent of this operation log; graph history uses age-thinned snapshots carrying paid agent results, not tracker adoption of graph-version/temporal rows. G1 fixtures must include real concurrent remote contenders; O1/L1 include the declared 10,000-item pagination fixture and measured single-connection PGlite responsiveness while fill is active. No throughput or latency claim is made here.

## Options and proposed direction

1. **Git-authored task files plus merged offline claims:** rejected against R01/R02. File merge discovers incompatible claims after both workers may already have started, and reprioritization should not require task-document commits.
2. **Expiring execution leases:** rejected against R08. Useful for bounded internal jobs, but a clock or disconnected session must not release product work.
3. **Mandatory central HTTP/PostgreSQL coordinator first:** could serialize operations, but contradicts the required initial serverless path. Retain a server as an optional later transport using the same contract, not a prerequisite hidden inside the CLI.
4. **PostgreSQL domain data plus serial Git operation transport and explicit durable ownership:** recommended under Q1–Q4. It respects the required data boundary and allows a serverless proof. It costs online remote availability for new shared grants, trusted publication/validation, safe checkpoint retention and manual recovery. Ordinary Git CAS alone is insufficient.

No alternate tracker database, Git definition-adoption protocol, execution-approval API, universal fixed lifecycle or leaf-only claim path remains in this proposal.

## Proposed decision

### 1. Data authority and storage boundary

| Data | Home / authority | Transport or projection |
| --- | --- | --- |
| All work fields, original request, proposals, hierarchy/dependencies, priority, responsibility, state, comments, time, grants, executor attempts, results and reviews | PostgreSQL through the existing storage owner; local PGlite or later server PostgreSQL | Git segments/checkpoints carry synchronized operations/recovery state; human/agent/graph views read the same records. |
| Product manifest/configuration and role/policy instances | Q1-agreed schema/configuration installation; work instances and effective product settings in PostgreSQL | `manifest.get` exposes the current approved rules. Installation/location and physical DDL remain agreement work, not Git task-document authority. |
| Accepted operation outcomes, deduplication identities and fencing state | Durable PostgreSQL domain state reconstructed from the validated accepted prefix/checkpoint when necessary | Protected transport prefix is the ordering/recovery evidence for shared acceptance, not independently editable fields. |
| Source code/evidence | Named source repository or immutable report/artifact store | Work records reference stable entity keys, immutable source revisions and digests. |
| Graph views/badges, cached ready lists | Derived from domain records and graph evidence | Rebuildable observations; cannot grant ownership or accept results. |

A local-only product can accept local operations without a remote. It cannot advertise them as shared grants. In a shared domain, a local pending operation is not accepted shared state. Disconnected users may create requests/proposals, record time/comments and continue already-granted work; their outbox and pending-state overlay are PostgreSQL data and remain visibly pending where global acceptance is required. Adoption into a shared domain requires explicit reconciliation and identity mapping; do not merge database files or run two writable independent authorities under one domain identity.

Reprioritization changes database state and is audited like any operation. It does not require authored Git task documents or a default-branch commit. Internal transport commits are allowed because Git carries operations, not because Git is the authoring surface. Code MR/merge evidence remains independently relevant to acceptance lanes.

### 2. Q1 manifest, table and serial semantic decision

The first agreement is a uniform manifest rule and table model: kinds/configurable fields, arbitrary status IDs/transitions and guard references, stable keys, product roles, eligibility, priority and lane rules. One engine applies the rule to every kind. Incomplete human-created requests are valid records; creation is not automatically execution readiness. Agent triage consumes intake queue order and records proposals, never silently rewriting or closing original requests.

The semantic unit is an authenticated, deduplicated operation with explicit item/structure/policy expectations. A valid operation atomically changes its domain records, result/receipt and local events. Multi-item decomposition is all-or-none. Validation includes hierarchy/dependency membership and absence reads, so a concurrent child or prerequisite insertion cannot evade an exclusion check.

Local application must provide serial invariant enforcement through the storage owner. Candidate implementation choices include serializable PostgreSQL transactions plus suitable constraints; PGlite equivalence and single-connection scheduling must be measured, not presumed. Exact DDL/transaction strategy is Q1/G1. No database transaction remains open while waiting for Git/network I/O, human input or agent execution. Fill and tracker do not obtain separate unsynchronized direct-SQL ownership paths.

Envelope fields shared with the agent contract are `product_key`, `actor {principal_key, session_key}`, `operation_id`, and `input`. Fences include `domain_key`, `epoch`, `expected.item_revisions`, `expected.structure_revision`, `expected.policy_revision`, and `basis_token`. Work revisions are PostgreSQL `item_revision` values, not Git definition SHAs. Source evidence can still name immutable code commits.

### 3. Q2 nonexpiring subtree reservations and executor fences

A grant records `reservation_key`, `root_work_key`, stable `holder_key` and non-reused `generation`. It covers the root's whole descendant subtree, including subsequently inserted children. An ancestor or descendant grant held by someone else excludes the new grant. Reparenting checks both old and new affected closures; no client may move work out of a reservation to evade fencing.

Q2 recommends prohibiting overlapping grants even for the same holder, including separate sessions: use the ancestor grant. This is more conservative than the maintainer's explicit cross-holder exclusion and needs agreement. To give another holder a child, explicitly release/restructure the enclosing reservation before new online takes. That interval is real and another eligible caller can win; no hidden partial release/delegation guarantee is promised. An atomic delegated-child protocol would require a separate decision.

`holder_key` identifies the authenticated taking participant/work subject, not the mutable `responsible_person` planning field. The two may differ. Editing responsibility neither transfers a grant nor gives a principal permission. An agent may act through explicit delegation to the stable holder; the exact human/agent holder/delegation mapping is part of Q2. It does not add a third mandatory UI assignment.

Executor identity is separately `principal_key`, `session_key`, `executor_generation` and `attempt_key`. `executor.assign` requires authorized holder/role action, authenticated target consent and current basis acknowledgement; it rotates executor generation/attempt without changing holder, reservation generation or subtree. Thus executor replacement is not a new take and consumes no additional people-cap place. Former executors cannot write current results merely because their product credentials remain valid.

Explicit `reservation.release`, authorized investigated `reservation.revoke`, or `reservation.transfer` ends/moves ownership and advances its generation, fencing old attempts. Transfer checks authenticated target consent and current target eligibility/caps/queue policy; it is distinct from executor replacement. `result.submit` and acceptance never implicitly release the whole subtree or siblings. No timeout, heartbeat, credential expiration or presumed worker death releases a reservation.

Default more-than-24h no-sync monitoring creates/updates a Problems entry, using configurable product and per-item leave thresholds. Problems record an observation and last confirmed sync; authorized product roles such as administrator/CTO/head of development investigate and unlock manually. Roles are product data. Monitoring does not pronounce an agent dead or automatically execute recovery.

### 4. Priority, suitability and lane rules are grant/acceptance predicates

`work.ready` is an observation. `reservation.take` rechecks free/unblocked execution guards, requester areas, effective priority, optional people cap and all subtree conflicts at the accepted ordering point. A lower suitable take is refused when higher suitable work is free, naming visible higher work and the policy reason. Only the product owner can authorize an explicitly scoped lower-priority exception; it does not bypass exclusion, area, cap or evidence guards.

Features and debt use one priority-level scale; equal levels permit parallelism. Owner changes move inherited feature work consistently. Estimators only propose initial placement. Blocking work inherits effective urgency from the work it blocks without permanently overwriting the owner's base levels, including removal of inherited urgency when the dependency no longer blocks.

A broad subtree grant cannot hide a lower-priority execution choice behind a container. Q1/Q4 must agree and prove how the suitable execution frontier under that root is compared with higher suitable free work outside it and how newly eligible work is guarded. Reserving a blocked descendant does not make it executable. Proposed cap counting uses distinct human participants represented by grants under a policy-defined holder/person mapping, not executor sessions or mutable responsibility fields; each affected feature is checked. Exact counting and delegation rules require Q1/Q2 agreement.

The owner-managed queue, not a per-task approval API, gives permission to start under those rules. Workflow status names are configured per kind; they cannot bypass the same semantic guards. Work ownership, lifecycle transitions, result submission and acceptance remain distinct facts.

Lane C requires green MR plus another agent on another model and permits authorized agent merge; B adds human merge approval; A requires human review and another responsible reviewer, with the sole-developer exception for the second responsible reviewer. Agents propose lanes; people may correct them with audit. Inherited relevant graph-node criticality imposes its lane requirement. Q3 recommends composing touched/inherited requirements conservatively and retaining C technical evidence for A; that composition, criticality exception authority and sole-developer qualification are not settled maintainer decisions.

`acceptance.evaluate` reports missing evidence; `acceptance.record` binds authenticated decisions to result, current basis, MR revision and effective policy. A caller's declared model name or generic self-review switch is insufficient. Source/criteria/prerequisite changes invalidate affected execution/result bases without silently releasing ownership; explicit acknowledgement/reconciliation must preserve historical evidence. Parent acceptance is not implied by accepted children.

### 5. Q4 candidate protected-ref arbitration, no server prerequisite

Use one protected dedicated ref per coordination domain, proposed name `refs/madarch/work-operations`, outside working trees. The ref carries segmented operation records, outcomes and checkpoints. Segmentation bounds transport/recovery units; it must not create independently writable grant histories. Semantic merge/validation belongs to madarch, not Git text merge.

Candidate shared mutation protocol:

1. Authenticate the actor and verify its proof binding operation digest, product/domain/epoch and session. Fetch the protected ref and validate its complete accepted prefix/checkpoint plus current policy/authorization basis. Materialize the confirmed state through the storage owner.
2. Check idempotency, permissions, revisions, relevant basis, hierarchy exclusion, current priority/eligibility/cap and other guards. Prepare one successor segment and deterministic outcome receipt. A local candidate/outbox record is never a reservation.
3. Compare-and-swap the remote ref from the exact validated predecessor to that candidate. Protection must prevent unauthorized publication/rewrites and a second writable authority. On CAS loss, refetch and revalidate the unchanged request; do not execute or silently replace the caller's expected revisions.
4. A durably confirmed successful update, or verified recovery of the exact accepted operation under a later validated successor/checkpoint, permits the grant acknowledgement. Apply domain result, deduplication outcome and local events together in PostgreSQL. Crash recovery replays this accepted outcome rather than granting again.

The global ordering point is protected remote acceptance, not an isolated local SQL commit. Local commit before publication may only record pending intent/candidate. Crash after publication but before local materialization is a replay case. A later HTTP server can supply the same ordered acceptance directly with transactions, but cutover must fence old writers and retain the same operation/identity/conflict semantics.

**CAS is necessary for this candidate, not sufficient for a secure protocol.** It orders bytes, not legitimate actions. G1 must demonstrate how the remote and trusted madarch writer/validator enforce authenticated actor proofs, current permissions/policy, semantic validity, no bypass, revocation and durable confirmed publication. Git author/committer strings are never authentication. Invalid/malicious/outdated writers must not advance an accepted prefix simply because they can construct a commit. If the available remote cannot enforce the agreed trust model, shared grants stay disabled on it until the mechanism is reconsidered; do not pretend a generic Git push already solves this.

Protected-ref readability also matters: API permission filtering cannot hide raw operation payloads from a user who can fetch the entire ref. The deployment trust boundary, repository ACLs and any required payload confidentiality must be agreed and tested rather than promised by the API. Target consent, model-attribution proofs, exact signature/credential encoding, remote durability and verification of checkpoints remain Q4 admission questions.

### 6. Lost replies, deduplication and disconnected clients

The idempotency key is proposed as `(domain_key, epoch, product_key, authenticated principal_key, operation_id)`, bound to a canonical digest of operation/version, original actor/session, expectations, fences and input. Credentials and transport headers are not the semantic payload. Same key/same digest returns the original outcome; changed digest conflicts. Authenticate and check access before disclosing a result. Changed session credentials may permit authorized status lookup, but cannot rewrite the original operation.

Example: A publishes R0→R1 with `take-a`, loses the response, and B publishes R1→R2. A can recover its original grant only by verifying `take-a`'s authenticated digest and accepted receipt under validated R2 or a covering checkpoint. It must not rewind the remote to R1 or treat arbitrary Git ancestry/local commit existence as acceptance. If A's publication never succeeded, an unknown status is not ownership; reconcile and retry the identical request without executing under uncertainty.

`operation.status` exposes pending/accepted/rejected/unknown explicitly. `sync.push` returns per-entry outcomes; a batch is not one implicit transaction. Outbox dependencies wait for accepted predecessors; failed predecessors produce explicit dependent failures, unrelated entries may succeed, cycles fail. If an earlier result determines later revisions, form the later immutable request only after obtaining that result; never use wildcard expectations or receiver-side silent rebase.

Already-granted workers may continue disconnected, understanding that ownership/basis is last observed and authorized remote revocation or executor replacement may have occurred. New shared takes cannot be granted offline. On reconnect resolve ambiguous IDs, pull confirmed changes, inspect holder/executor/basis, then send valid pending operations. Safe authorized stale evidence may be retained as a rejected artifact tied to the error; it never overwrites the replacement's result. Retain local rejected content when it cannot safely be stored remotely. Retrospective personal time retains historical attribution without becoming a current executor write or acceptance.

### 7. Segmentation, safe pruning and recovery

Transport history may be pruned, but offline replay and ownership fences may not be forgotten. Before deleting covered segments, publish and verify a durable checkpoint containing or securely referencing:

- Domain identity/epoch, accepted snapshot frontier and validated prefix commitment.
- All required canonical work data/history, including original text, comments, time and review decisions according to agreed product retention.
- Active subtree reservations, non-reused reservation generations, current executor generations/attempts and relevant retired fences.
- Current manifest/policy/authentication basis and retained evidence sufficient to validate the checkpoint and suffix, including authorization changes.
- Operation key/digest/outcome records or durable deduplication tombstones, plus stable domain entry identities and authorized archive references where detailed receipts are archived.

A clean machine must reconstruct confirmed PostgreSQL state from retained checkpoint and suffix, and an old client must remain unable to replay a pruned mutation or revive a stale grant. Removing Git transport segments does not authorize deleting PostgreSQL work history or operation identity. No time-based deduplication expiry is safe merely because a worker has been offline a long time. Finite retention requires explicit non-replayable epoch/domain retirement, with safe fencing and reconciliation, not silent resurrection of old operations under a new key.

`sync.pull` with an obsolete cursor returns `CURSOR_GAP` and a resnapshot instruction. Install one complete authorized snapshot and its frontier atomically, preserve the local outbox, then apply the suffix with event/operation deduplication. Never turn a missing segment into a successful empty page. A repeated accepted time entry returns its retained outcome/archive information, not a second duration. Permission changes invalidate cached unauthorized projections; old cursors do not confer access.

If restore cannot prove non-regressed generations, identities and accepted frontier, freeze writes. Recover only after demonstrably fencing the prior writer/epoch; never run two writable restores of one coordination domain. Epoch rotation cannot silently discard active ownership or replay history. Backup/restore must include PostgreSQL data and the retained transport/checkpoint trust/recovery material. A code clone, graph snapshot or local pending outbox is not a complete work backup.

Exact checkpoint encoding, archival layout, signature verification, tombstone size and recovery budgets are Q4/O1 questions. Pruning is admitted only with the required reconnect/deduplication/fence proof, not by assuming a Git garbage collector understands business history.

## Concrete future proof cases

| Case | Required serial outcome | Agent scenario |
| --- | --- | --- |
| Alice takes `FEATURE-1`; Bob simultaneously takes its `TASK-2` child | One confirmed remote acceptance; loser refetches and gets subtree conflict. No holder begins on local pending state. | A03–A04 |
| A child is inserted while parent take is arbitrated | Child either appears before the take and is covered, or is inserted afterward and inherits coverage; incompatible reparenting fails atomically. | A05–A06 |
| Lower suitable work was ready, then owner promotes higher suitable work | If promotion orders first, lower take fails naming higher work; if take orders first, no retroactive duplicate grant. Equal-level independent grants remain permitted. | A07–A10 |
| Holder Alice replaces executor A with B | Reservation generation/holder/subtree unchanged; executor fence increments once. A's delayed result is rejected; responsibility edits alone do not transfer anything. | A11 |
| A child result is accepted under parent reservation | Parent reservation and sibling coverage persist until explicit release/revoke/transfer. | A13 |
| Remote accepted R1 reply is lost, then another operation reaches R2 | Verify original accepted operation under R2/checkpoint and return same outcome without rewind or duplication. | A16–A18 |
| Pruned client sends old accepted time entry and obsolete executor output | Resnapshot plus suffix preserves outbox; time not counted again, obsolete output not current, active subtree exclusion preserved. | A19–A20 |
| Malicious writer fabricates author/model identity or bypasses semantic rules | No accepted grant without trusted authorization/validation; failure to establish enforcement blocks production shared claims. | A22 |

## Consequences and open decisions

- Every work field has a database home; transport recovery does not create a second independently editable Git definition authority.
- New shared taking depends on online durable arbitration, but not on a mandatory server. Local usable planning/comments/time and G1 proof can proceed in parallel after M0.
- Nonexpiring whole-subtree ownership trades automatic reclamation for explicit human investigation and recovery. Executor replacement remains routine without ownership transfer.
- Serial ordering alone cannot provide secure coordination. Git remote protections, credentials, trusted validation and confidentiality must be shown to satisfy the deployment model.
- Broad subtrees, priority/eligibility scans, cap races, single-connection PGlite and retained deduplication impose measurable costs; no complexity or performance claim is established by this ADR.
- Q1 manifest/table/frontier/cap details, Q2 overlap/delegation mapping, Q3 lane composition/exceptions and Q4 protocol/trust/retention remain proposed. The maintainer constraints are not open invitations to restore Git task documents, expiring claims or execution approvals.
- Migration/import and optional server cutover require explicit identity mapping, reconciliation and a fenced writable authority. No continuous two-way br/Markdown/database writer is introduced.

## Validation and revisit

The [development plan](../changes/tracker-human-agent-concept/development-plan.md) assigns M0 agreement, L1 local usability, G1 concurrent Git coordination proof, I1 integrated queue/lanes/recovery and O1 scale/operations. The agent contract's A01–A25 are future acceptance scenarios. No builds, runtime tests, protocol experiments or measured responsiveness results are claimed by this documentation revision.

Revisit the proposed mechanism if a supported Git remote cannot enforce its trust/atomicity/durability model, if the agreed subtree/priority frontier is impractical, or if checkpoint growth/restore proofs cannot support the required offline behavior. Return those mechanisms for agreement without weakening online exclusivity, original-text retention, nonexpiring ownership or the shared human/agent business contract silently.

## Sources

- [Maintainer feedback on PR 218](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890): product constraints driving this revision.
- [Git push](https://git-scm.com/docs/git-push): explicit expected-ref update mechanisms are a building block, not a domain-validation or actor-authorization protocol.
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html): serializable transactions and retry obligations; ordinary read-committed checks do not establish arbitrary multi-row invariants.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html): transactional/session locks are not durable disconnected work reservations.
- [Model contract](../changes/tracker-human-agent-concept/model-contract.md), [agent contract](../changes/tracker-human-agent-concept/agent-interface.md), [human interface](../changes/tracker-human-agent-concept/human-interface.md): proposed agreement questions and shared observable contract.
