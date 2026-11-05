# 0035. One authority grants durable work reservations; clients synchronize operations

Status: proposed
Date: 2026-11-04

Proposed amendments to 0023 and 0029; clarification of 0022, 0027, 0028 and 0033.
Not effective until accepted. Companion: [0034](0034-human-and-agent-work-interfaces.md).

## Context and problem

The [tracker discussion](../vision/tracker-discussion-2026-10-13.md) requires a worker
to claim online, work disconnected for an unbounded time, create child proposals and
later synchronize. Concurrent agents must not both obtain authoritative ownership.
A returning former owner must not overwrite the replacement's result.

A Git merge of two independent claims detects the conflict after both clients began.
An expiring execution lease permits recovery without a person but contradicts the
unbounded offline guarantee. Holding a SQL lock or connection for the duration of
work also fails on disconnect. A task reservation is durable domain data, not a
long-lived database lock, a fill worker lease, or an advisory graph-walk reservation.

0023 puts authored content in Git and later operational data on a server; 0029's
broad language puts all non-rebuildable writing in Markdown. Work definitions fit
Git, but reservations and accepted operations need one transactional authority and
cannot be reconstructed from documents. The exception must be stated explicitly.

## Decision drivers

- Concurrent ready-and-claim and claim-versus-reopen have a serial, explainable outcome.
- No ownership expires merely because a worker disconnects or credentials expire.
- A stale client can preserve its result, never silently make it current.
- Each field has one authority; a projection cannot grant permission.
- A crash between Git publication and operational adoption cannot expose half a plan.
- Time, acceptance, operation identities and generations survive restart and backup
  recovery, independently of the rebuildable knowledge graph.

## Considered options

1. **Git-only task state and merges.** Keeps everything portable in one history, but
   cannot guarantee an exclusive shared grant before execution across independent
   offline clients. Retained for authored definitions, not operational coordination.
2. **Expiring leases, like internal fill work.** Reclaims abandoned work automatically;
   a disconnected client loses ownership on a clock. Valid alternative for a bounded
   offline product, not the requested scenario.
3. **Durable generation-fenced reservations and operation synchronization**
   (recommended). One authority persists ownership and validates each operation;
   explicit recovery replaces expiry. Costs authoritative storage availability for
   new grants and a backup/recovery discipline.
4. **Everything in a new tracker database.** Simple atomic updates, but removes authored
   definitions from product Git and creates a separate product catalog. Rejected for
   this product; a transactional state store need not own the documents' text.

## Proposed decision

### Field authority

| Data | Authoritative home | Other representations |
| --- | --- | --- |
| Work definition: ID, type, title, scope, criteria, parent/dependencies, source links, priority, estimates, responsibility, milestone/release | Immutable documents in the product Git repository | Operational active-revision pointer and graph index; neither independently edits authored fields. |
| Lifecycle, execution approval, reservation/generation, sessions, attempts, submissions, review decisions, time and synchronization journal | Transactional operational store behind the existing storage owner | Read-only wiki/API/graph projections and optional portable receipts. |
| Code and product source evidence | Its named repository and immutable revision, or approved immutable report store | References and integrity metadata on submissions. |
| Generated knowledge and task badges | Derived from their authorities | Rebuildable; no reservation or acceptance is recovered by guessing from a badge. |

This explicitly qualifies 0023's authored-data row and server-only operational-data
wording, and 0029's blanket non-rebuildable-Markdown rule **for tracker operations**.
Task review decisions/receipts in Git are exports, not independently editable acceptance.
Other product documents and their existing acceptance/correction records are unchanged.
The local-only mode has one PGlite-backed authority; a shared coordination domain has
one PostgreSQL-backed authority reached by local clients. An offline cache/outbox is
not another authority. Both reuse 0033's storage-owner interfaces, not a second direct
SQL access path. The graph extraction queue called `work_item` in 0028 is an internal
job, not the product Work item defined by this concept.

### Transaction boundary and fences

A short authority transaction validates authentication, permission, idempotency,
expected active-definition/state revisions, ownership and the complete readiness
basis; it grants one reservation and writes the attempt, journal result and durable
event together. Claim is not a ready query followed by an unconditional write.

Proposal: use PostgreSQL serializable transactions for multi-row invariants, with
unique constraints on active ownership and operation IDs. Include prerequisite and
hierarchy membership reads, including absence, so a concurrent edge insertion cannot
escape validation. A serialization failure aborts the whole transaction; retry only
the bounded internal transaction on the unchanged operation, re-evaluating guards.
A business revision conflict is returned to the caller, not retried with new intent.
PGlite conformance must prove the same observable behavior; if that guarantee cannot
be provided, local grants remain disabled rather than claiming equivalent semantics.
No SQL transaction stays open during human input, agent execution or Git I/O.

A reservation records authenticated principal/session, attempt, generation and basis.
Generation advances when ownership ends or moves and is never reused. Internal fill
lease expiry does not release it. Transfer requires fresh impact, an authorized reason
and target-session consent; administrative revocation can instead clear ownership so
another worker claims later. Worker mutations check current ownership and basis.
Submission stores evidence and ends ownership atomically; acceptance is another
permission and transaction. Changed scope or prerequisites invalidate the basis,
including submitted evidence; they do not silently rewrite the attempt's contract.
An acceptance-basis change to accepted work requires an explicit authorized reopen
first; prior acceptance remains historical and cannot satisfy the revised outcome.
Incomplete but structurally valid definitions may be adopted as drafts, never opened
or claimed until complete. Returning a definition proposal records an attributed
decision, not a result-review transition; adoption and return serialize on the
proposal's decision revision while its content remains immutable.

### Publishing a definition or decomposition

1. Validate and retain an immutable proposal against expected active revisions. Record
   a durable publication intent with its operation ID, digest and affected-item vector.
2. Create a content-addressed Git commit under a managed proposal ref, retaining the
   author's input and attribution. The proposal commit is not an active plan and does
   not replace canonical default-branch definitions. Remote push is not a prerequisite
   of a local-only product; shared authority must durably possess the commit it adopts.
3. In a short authority transaction, recheck permissions, all relevant revisions,
   cycles, ownership and basis impacts, then adopt all definition pointers/relationships
   or none. Append the adoption result and durable events in that transaction.
4. A durable publisher exposes the adopted revision on the product's designated work
   publication ref. The service reports pending Git publication until it is exposed;
   no affected item can be claimed during that pending state. Default-branch integration
   is a separately observed Git operation; external Git changes are new proposals for
   adoption, not direct operational state changes.

There is no distributed SQL-and-Git atomic commit. A restart reconciles the journal:
pre-adoption commits remain proposals; post-adoption publication resumes idempotently.
Concurrent publication uses expected-ref updates and item revision comparison.
Each target commit contains an immutable manifest binding the journal's operation
identity/digest, adopted tree, affected definition revisions and predecessor.
After a lost completion, recovery may finalize an exact target already present in
the managed ref's validated publication chain, including beneath a later published
descendant. It verifies the target/manifest against the journal, never treats an
arbitrary merge ancestor or failed compare-and-swap as proof, never moves the ref
backwards and never overwrites newer active definitions/state. Other conflicts retain
pending status and are reported for explicit recovery. Readers use the active
revision plus verified publication state, not whichever branch a filesystem exposes.
The prototype must prove A publishing R0 → R1, losing its completion, then B publishing
R1 → R2: recovery completes A exactly once and leaves R2 current. It must also prove a
failed ref update without such evidence remains pending before this is accepted.

### Offline operations, evidence and recovery

Clients store operations and dependencies in an outbox, not merged database files.
The idempotency key is product + authenticated principal + operation ID, bound to the
semantic request digest. Same request returns its original outcome; different payload
under the same key conflicts. Retain results or tombstones for the lifetime in which
the identity can be replayed; no clock-based expiry can enable a duplicate write.
An authority-domain retirement explicitly makes its old operations unusable.

An offline worker may continue its already-granted attempt and create proposals with
stable IDs. It cannot claim new shared work, transfer, approve or accept globally.
Child proposals do not inherit a grant. Sync returns per-operation outcomes; atomic
plan adoption is one operation, not partially accepted children. Dependent outbox
entries await the actual prior result before materializing expected revisions.
Safe late results from an authentic former owner are retained as rejected artifacts,
not as current submissions. Local rejected material remains available for review.

Operational backup includes domain identity, active revision pointers, generations,
operation deduplication records, evidence references and the journal. Test recovery
with a disconnected former owner. If fencing history may have gone backwards, freeze
writes, invalidate prior domain credentials and resume under a fresh authority epoch
only after the old authority is demonstrably fenced off. Do not run two writable
restores of one domain. Cache rebuild and ordinary product fill must never erase this
store. Neither a graph dump nor Git alone is an operational backup.

## Consequences

- A new shared grant needs the authority online; this is the availability price of
  exclusive ownership. Existing offline work survives, but accepted actions are fenced.
- Abandoned work needs explicit human recovery. Last-seen is an observation, not a
  licence to duplicate execution.
- A work definition may be visible as a pending proposal while not active, and an
  adopted plan may temporarily wait for Git publication before becoming executable.
- Two stores require a recoverable publication protocol, not a claim of one transaction.
- Unbounded disconnection prevents cheap time-based deduplication cleanup. Journal
  compaction must retain identities/tombstones; detailed retention policy is reviewed
  before offline implementation, not silently assumed.
- Live work migration requires a freeze, ID mapping, reconciliation and authority
  transfer. No continuous two-way br/Markdown/database writer is introduced.

## Validation and revisit

The [development plan](../changes/tracker-human-agent-concept/development-plan.md)
assigns proofs for claim races, dependency changes, transfer, old-owner submission,
Git/store crash windows, operation replay and backup recovery. The
[agent contract](../changes/tracker-human-agent-concept/agent-interface.md) gives the
proposed envelope/errors and conformance examples. No such runtime proof is claimed
by this documentation PR.

Revisit if bounded disconnection becomes acceptable, if a chosen external tracker
can serve as the authoritative arbiter, or if measurements show the proposed serial
transaction boundary cannot support the product's workload without another strategy.

## Sources

- [PostgreSQL 18, transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html):
  serializable transactions and retry obligations; read committed alone does not protect
  arbitrary multi-row business invariants.
- [PostgreSQL 18, explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html):
  row locks end with transactions; advisory session locks end with sessions. Neither
  is the persistent offline reservation proposed here.
- [0023](0023-data-storage-boundary.md), [0028](0028-temporal-graph-store.md),
  [0029](0029-knowledge-in-markdown-graph-as-index.md),
  [0033](0033-one-workflow-by-entity-kinds.md).
