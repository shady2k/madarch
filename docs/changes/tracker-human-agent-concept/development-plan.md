# Development and acceptance proposal

Status: proposed sequence, **not scheduled tasks or authorization to implement**.
The tracker epic madarch-lk4r remains deferred. The only active scope of this PR is
supporting documentation (madarch-ae8g). Existing current-milestone work is not moved.

## Start gate: discussion before implementation

1. Review the [concept](concept.md), both interfaces, ADRs 0034/0035 and the explicit
   amendments to accepted decisions. Resolve comments with evidence and rationale.
2. The owner chooses the tracker milestone's place, accepts or changes its outcomes,
   and separately authorizes the bounded prototype. A documentation merge alone is
   not that authorization.
3. Confirm the operational authority, authenticated identity integration, publication
   protocol and migration scope. Record accepted decisions, then turn the first
   approved checkpoint into tracked worker-sized tasks. Later checkpoints stay coarse.
4. Admit implementation only after the prototype's proof and the owner's go-ahead.
   Each production checkpoint carries a real capability delta and named checks; this
   supporting change cannot stand in for those approvals or receipts.

## Proposed independently acceptable checkpoints

| Checkpoint | What can be observed when accepted | Required result before it | Proof boundary |
| --- | --- | --- | --- |
| P0. Coordination/publication prototype | Two real clients contend for one item; transfer fences the old owner; a crash between Git and the store recovers without half a decomposition. | Concept choices accepted and prototype authorized. | Real PGlite and PostgreSQL transactions through the owner interface; generated repositories; no production migration. Negative result can change ADR0035. |
| P1. Human plans, agent executes, human accepts | A person creates and decomposes an outcome in the wiki, authorizes a child, an external agent claims and submits it through the shared contract, the person accepts/returns it and reviews the parent separately. | P0 and the common storage-owner seam. | Complete vertical path, real auth and browser UI; HTTP/CLI/MCP adapters agree; no chat-only or API-only substitute. |
| P2. Planning and review at product scale | Backlog/tree/board, split/reparent/dependency editing, proposal inbox and result review preserve identity and show live basis changes at 10,000 work items. | P1's shared definitions/lifecycle and event contract. | H01-H11 and H13-H16, bounded pagination, accessible controls and measured rendered surfaces. H12 covers only cached-state/offline display and refusal of new grants here; no reconnect claim. No claimed latency SLA until measured/agreed. |
| P3. Disconnected work and recovery | Already-reserved work survives disconnect; child proposals, time and results synchronize without duplicates, stale authority or lost rejected material. | P1's journal/fences, P2's conflict/recovery views, reviewed retention policy. | Full H12, two independent client stores, real reconnect and server restart/restore; per-operation outcomes and cursor-gap recovery. |
| P4. Existing work migrates and old writers disappear | Product scoped tasks and the explicitly chosen br backlog appear under the new model with preserved history and no competing mutation path. | Prior checkpoints, approved mapping and rehearsal; explicit cutover approval. | Reconciliation report, rollback rehearsal, full end-to-end walk, old writers refused/removed in the same cutover. |

P1 includes a bounded tree/decomposition editor, detail and review; P2 extends those
surfaces rather than postponing the first human interface. P0 is preparatory because
exclusive ownership and recoverable adoption are the evidence P1 rests on. It is not
presented as a usable tracker. Offline support is a separate checkpoint, not silently
removed from the agreed scope.

## P0 work packages to turn into tasks after approval

These are proposed packages with acceptance, not newly opened tracker leaves.

| Package | Observable criterion | Dependencies |
| --- | --- | --- |
| P0-A: authority contract and fixture | The same two-client command fixture runs on PGlite and PostgreSQL; actor/session, item revisions and rejected operations are observable through the service. | Accepted coordination choices. |
| P0-B: reservations and lifecycle | One of two simultaneous claims succeeds; claim racing prerequisite reopen is serializable; transfer/revoke rejects an old attempt; submission does not accept. | P0-A. |
| P0-C: Git/adoption journal | Kill after durable intent, after proposal commit, after adoption and before/after ref publication; restart converges once, never activates a partial plan or grants unpublished work. Also publish A (R0 → R1), lose its completion, then publish B (R1 → R2): recovery verifies A's exact manifest in the publication chain, finalizes A once and leaves R2 current. A mismatched manifest or unrelated merge ancestor must not pass. | P0-A; can proceed independently of P0-B against the common contract. |
| P0-D: recovery verdict | Lost replies, duplicate operation IDs, changed payload, permission loss, backup restore with an old client and concurrent cycle creation all yield the specified result or an explicit design failure. | P0-B and P0-C. |

Do not replace the prototype with mocked repositories or a fake arbitration service.
Use fixtures held/generated by this project, never another private checkout. Record
which guarantees the real database/runtime could not provide. A failed guarantee
returns to design, not a weaker acceptance assertion.

## P1 vertical slices to refine after P0

- Human creates a definition and sees the same adopted revision through CLI/MCP;
  incomplete drafts stay non-executable.
- Human decomposes it into two leaves with criteria and a dependency; stale preview,
  cycle and unauthorized relationship fail atomically without losing the proposal.
- Human approves a ready leaf; an authenticated agent claims it and reads exact source
  context; another agent cannot claim it. No executor is started by madarch.
- Agent records time/progress and immutable criterion evidence; a human accepts or
  returns it. Parent review names its integration criterion rather than counting children.
- Human changes scope or transfers ownership; old-basis/old-generation writes refuse,
  with retained rejected results and explicit reconciliation.

These slices include UI, service and agent adapter behavior together. They are not
separate backend/UI deliveries that leave an unusable scaffold on main. HTTP/CLI/MCP
share the operation implementation; only adapter-specific conformance is repeated.

## Migration and retirement

Two distinct sources must not be conflated: the product's simple Markdown tasks are
already a madarch feature; the br tracker used to develop the engine is a separately
chosen migration. The latter is not silently replaced by installing a new engine.

1. **Inventory and dry-run mapping.** Read immutable source snapshots, map product and
   legacy IDs to stable work IDs, preserve title/body/scope, origins, parentage, gating
   versus related links, comments, timestamps, historical actors, evidence and time.
   A historical actor is provenance, not an authenticated new principal.
2. **Explain semantic differences.** Legacy `open` maps to draft/open only after required
   fields validate. `in_progress`, `submitted` and `implemented` require reconciliation;
   they do not fabricate a live reservation. Legacy `closed` imports as historical
   completion with explicit legacy evidence and no invented reviewer; a person validates
   it before it can satisfy a newly enforced prerequisite. Deferred work stays deferred
   by admission/visibility policy, not silently ready.
3. **Refuse ambiguity.** Missing identities, cycles, dangling references, conflicting
   statuses or unsupported custom types produce per-item, per-field findings with full
   source path and line where available. Import neither drops them nor guesses success.
   The owner chooses their resolution before the authoritative cutover.
4. **Freeze and switch once.** Stop old writes, settle/export all pending operations,
   take Git and operational snapshots, import one committed mapping batch, reconcile
   counts and hashes, then activate the new authority. Update all callers in that
   same release. Retire legacy task create/close/run mutation routes and direct status
   writes, retaining their responsibilities in the shared service. Preserve stable
   links via identity mapping, not a parallel mutable compatibility tracker.
5. **Rollback without two writers.** Before new writes begin, restore the source and
   disable the new authority. After new writes begin, freeze again and replay/export
   all accepted new operations under a reviewed reverse mapping before re-enabling an
   old writer. If the reverse mapping loses meaning, use forward repair; never restore
   an old snapshot over newly accepted work. Keep old snapshots read-only for evidence.

A graph rebuild or reset is never the migration/rollback mechanism for reservations,
accepted operations or time. Back up that state and rehearse recovery separately.

## Acceptance coverage and evidence

- **Behavior:** C01-C08/C11 of the design through real human/agent commands, including
  concurrency and failure inputs; shared conformance runs for every adapter.
- **Visual/interaction:** H01-H16 on actual implemented screens at desktop and 360 px,
  light/dark where the wiki supports them, 200% zoom, keyboard and click/tap alternatives.
  The static mockup in this PR is layout evidence only.
- **Scale:** 10,000 work items with deep/wide decomposition and dependencies; maximum
  page 100. Measure latency/memory and enumerate the whole snapshot without omissions.
- **Security:** spoofed actors, expired/revoked credentials, cross-product IDs/cursors,
  forged owner generation, restricted evidence, unsafe paths/URLs and UI injection.
- **Durability:** fault injection at the journal/Git/store seams, duplicate delivery,
  offline reconnect, restore with an old owner, and one authority after recovery.
- **Cutover:** every legacy field mapped or explicitly refused, no lost history and no
  remaining mutation path outside the service; C12/C13 and architecture checks.
- **Review:** independent architecture review before production implementation; then
  behavior tests, bounded mutation checks on critical guards and end-to-end acceptance
  according to the repository's existing policy. No check is marked passed by a plan.

The final acceptance record must name actual revisions, fixture sizes, commands,
rendered surfaces, outcomes and remaining limits. No delivery date or effort forecast
is promised here: the prototype is what establishes the unknown coordination cost.
