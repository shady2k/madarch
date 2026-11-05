# Tracker design proposal and implementation boundaries

Status: proposed, not an implementation authorization. The
[concept](concept.md) owns the behavioral model;
[0034](../../decisions/0034-human-and-agent-work-interfaces.md) and
[0035](../../decisions/0035-work-reservations-and-operation-sync.md) own the proposed
architectural choices. Current capability specs are intentionally unchanged.

## Inventory before change

Inspected on main at ad6c2f9d. This is source evidence, not a fresh runtime acceptance.

| Existing responsibility | Evidence in the repository | Proposed treatment |
| --- | --- | --- |
| Scoped tasks from answers/problems, Markdown persistence and `open/closed` | `src/loop/tasks.ts`, `src/knowledge/product.ts` | Reuse stable origins, scope and links; migrate to work definitions and the operational lifecycle. Retire independent status writes at cutover. |
| Human task list/detail, task proposal, manual closure and limited page refresh | `wiki/app/src/knowledge/loop.tsx`, `src/server/knowledge.ts`, `src/loop/task-run.ts` | Extend the existing surface with planning/decomposition/review. Keep the bounded page-refresh responsibility, but authorization/result reporting use the same work service. |
| HTTP task entry points | `src/server/http.ts` (`/api/k/task-create`, `/api/k/task-close`, `/api/k/task-run` and related routes) | Migrate their UI callers in the replacement feature; retire redundant mutation routes, not a permanent shim. Read-only links resolve stable identities. |
| Seven repository MCP knowledge tools | `src/mcp/tools.ts`, `src/mcp/server.ts` | Retain reading; add the proposed work contract through the existing MCP server rather than a second agent server or copied answer logic. |
| Reader role/identity display | `docs/decisions/0031-madarch-wiki-first-roles-and-identity.md`, `wiki/app/src/knowledge/role-ui.tsx` | Reader perspective is not authentication. Add verified principal/session permissions at the shared service, never trust a selected role or name as a grant. |
| Database ownership, fill orchestration and temporal graph | ADRs 0027, 0028 and 0033; `src/fill/orchestrator-host.ts`, `src/graph/` | Extend storage-owner interfaces. Product work reservations differ from fill leases and verifier hints; no second graph writer or job runner. |
| Engine development tracker | `.shady2k/integration.md`, `.shady2k/tracker.mjs`, br store outside branches | Continue using it to build the proposal. A later explicitly approved migration imports its records; this PR does not replace it. |

The simple task feature already closes tasks when a qualifying commit names them and
changes their scope. The full tracker changes this deliberately: such a commit is
candidate evidence; it does **not** automatically accept the criteria. Migration must
preserve legacy closures with their provenance, not invent retrospective reviews.

## Building blocks and authority

One application service validates the operations. Wiki forms, CLI and MCP are adapters,
not lifecycle engines. The service calls the existing storage owner for operational
transactions and the existing product Git boundary for authored definitions. The
publication journal bridges these different durability domains (0035); there is no
transaction spanning a user conversation, an agent run and Git.

The service can read context from the graph, but readiness and acceptance read its
active definitions and operational state. A delayed graph projection cannot admit
stale work. Operational events update both interfaces with an explicit revision and
cursor. A missed or unauthorized cursor triggers a fresh permission-scoped snapshot.

The first prototype should run through the storage owner boundary without requiring
a complete product fill. Task ownership does not need inferred code facts; a scope
may name an immutable document or code revision directly. A missing graph result is
shown as missing context, not fabricated evidence. Integration with the in-flight
0033 storage refactor is an explicit prerequisite where it changes the owner API,
not a reason to fork that API or postpone all design until the entire epic finishes.

### Definition publication detail

A proposal commit is built from the preceding adopted definition tree, with an
expected parent/ref and a bounded set of changed item IDs. A bundle updates hierarchy
and dependencies atomically in the operational active view. Unrelated proposal
commits may exist but are not merged into the active plan implicitly. The authority
adopts a validated immutable tree/revision; a durable publisher advances the designated
work publication ref by compare-and-swap. Any affected item whose publication is
pending stays unclaimable. A subsequent proposal must compare against the active tree,
not an older working copy. A failed ref advance is not proof of publication and is
never replaced by a force push.

The journal binds each publication's operation identity, request digest, adopted tree,
affected definition revisions and expected predecessor to an immutable manifest in
its target commit. The managed ref advances only along this validated publication
chain. After a lost completion, recovery inspects the current ref: the exact target,
or a descendant on that chain containing the matching target/manifest, proves the
publication already occurred. Recovery records that operation's completion without
moving the ref backwards or overwriting later active definitions/state. An arbitrary
merge ancestor or mismatched manifest is not proof; retain pending status and report
the conflict for explicit recovery.

Thus, if A publishes R0 → R1 and crashes before its journal completion, then B publishes
R1 → R2, A's recovery recognizes the exact R1 publication in R2's validated chain.
It finalizes A once, leaving R2 current; replaying A's old compare-and-swap is neither
required nor sufficient. Affected items become claimable only when their current
active definition has verified publication and all other readiness predicates hold.

The graph indexer consumes adopted, published definitions selected by the service,
not every `docs/tasks` file found on arbitrary proposal branches. The initial
implementation specification must name the work publication ref and manifest binding;
its name is a reviewable format detail, not a reason to invent a second task model.
Manual edits on a code or product branch enter as proposals with explicit bases.

### Security and trust boundaries

Authenticate at the service boundary, then scope every query, cursor, mutation and
evidence lookup to product and permission. The web adapter uses same-origin/CSRF
protection appropriate to its authentication; remote transport requires authenticated
TLS. Local process identity or a displayed reader role is not remote authorization.
Credentials are neither task fields nor CLI arguments. MCP content and evidence are
untrusted input, never instructions granting extra permissions.

A task scope containing a path/symbol is data: it cannot become an unchecked filesystem
path or command. Resolve source identities under the connected repository boundary,
reject escapes, render evidence inert and never execute a submitted command string.
The API does not fetch arbitrary evidence URLs with server credentials; the first
profile allows approved repository/report resolvers only. Rejected secret-bearing
material is not copied into a globally visible audit log.

Product-specific authentication-provider choice is an implementation prerequisite:
prototype identities must be clearly test-only, and production multi-user access is
not accepted on mocked principals. No new executor process management is in scope.

## Constraints and observable checks

These are proposed requirements of the tracker, not claims about today's behavior.
Human check IDs refer to [H01-H16](human-interface.md#observable-acceptance-scenarios-for-future-implementation).
Agent conformance scenarios are in [section 11](agent-interface.md#11-conformance-scenarios-for-a-future-implementation).

| ID | Constraint and source | Check / observation |
| --- | --- | --- |
| C01 | Two first-class surfaces, owner's 2026-11-04 request | H01/H08/H09 plus one human-to-agent-to-human run; no chat or manual file edit required for planning. |
| C02 | One model/authority per field, 0022/0023 and proposed 0035 | Same item through UI, HTTP, CLI and MCP has identical active revisions; no adapter writes state directly. |
| C03 | Atomic decomposition, no hierarchy/dependency cycles | H03-H05; concurrent opposite edge insertions cannot both commit; crash/adoption fixture shows all or none. |
| C04 | Exclusive durable ownership, source offline scenario | Two clients racing claim, restart while reserved, revocation and old-worker submit; at most one accepted owner. |
| C05 | Work is tied to criteria/source revisions | H10/H11; change source or reopen prerequisite during execution/submission and refuse obsolete acceptance. |
| C06 | Result is not acceptance; containers need their own review | H09/H14; commit/evidence/accepted children alone never close a parent or leaf. |
| C07 | Offline work is retained but cannot grant shared authority | H12 and per-entry sync/replay cases; offline child proposals remain unclaimable. |
| C08 | Authenticated identities, permission-scoped data and inert evidence | H13, cross-product queries, spoofed actor/session, revoked access and unsafe evidence cases; no leaked labels or credentials. |
| C09 | Operable without dragging, narrow screen and keyboard | H15; click/tap and keyboard alternatives, focus/error recovery, 360 px and 200% zoom inspection. |
| C10 | Bounded behavior at the source's approximately 10,000 entities | H16 and agent pagination: fixture with 10,000 work items, page cap 100, no omissions/duplicates. Record observed latency, no invented target. |
| C11 | No lost/double operation after uncertain reply or crash | Original operation ID replay/status, payload mismatch, permission change, journal compaction and Git/store fault injection. |
| C12 | Existing task history survives the one-writer cutover | Rehearsal on held fixtures of simple Markdown tasks and br records; ID/comment/time/evidence mapping and exact reconciliation report. |
| C13 | No new storage owner, graph writer or development executor | Architecture check plus source inventory at each cutover; no product client starts a runner or runs SQL directly. |

Kept principles: one graph/entity catalog (0022), one authority per field (0023),
product Git for authored definitions (0029), one storage owner (0033), external
execution boundary (0022/0033). Proposed exceptions are explicitly in ADRs 0034/0035;
none is hidden in a UI requirement.

## Operational failure behavior

A conflict is a visible domain refusal with operation/item identity, the authorized
current revision and a recovery action. Unknown outcome is not success or permission
to issue a new operation ID. Durable pending Git publication is visible to people and
agents; operators can inspect the journal and retry its idempotent publication step.

Expected conflicts/validation failures are classified without logging document text
or credentials. Storage/publication failures include a request ID, operation ID, the
failed phase and causal error; permission-filtered UI explanations do not expose
restricted task data. Counters distinguish pending publication, rejected stale writes
and event catch-up gaps. No alert SLO is invented by this concept: the implementation
runbook must cover a stuck publication and authority recovery before shared deployment.

## Review status

This document is ready to be argued about, not an accepted architecture. The prototype
has not run; the human mockup is static. Review must settle the explicit ADR exceptions,
non-expiring reservations, the publication protocol and the first delivery boundary.
The development plan names what turns each claim into evidence before production work
is admitted. The present capability specs stay true until that work is accepted.
