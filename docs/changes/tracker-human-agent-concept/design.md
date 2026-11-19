# Tracker design, existing boundaries and proof obligations

Status: revised proposal, not implementation acceptance.
The [concept](concept.md) records the maintainer's decisions; the
[model contract](model-contract.md) proposes the first manifest/table agreements.
ADRs [0034](../../decisions/0034-human-and-agent-work-interfaces.md) and
[0035](../../decisions/0035-work-reservations-and-operation-sync.md) explain the design.

## Current source inventory

Inspected against main at `ef37484d` during this revision. These are source observations,
not runtime acceptance of either the present tracker or the proposal. The PR's original
inventory at `ad6c2f9d` is superseded here; notably it must no longer name the removed
`src/loop/task-run.ts` as the implementation seam.

| Existing responsibility | Source evidence on that revision | Treatment |
| --- | --- | --- |
| Product Markdown tasks and scoped references | `src/loop/tasks.ts`: `TASKS_FOLDER = docs/tasks`, `PlannedTask` with `open/closed`, rendered YAML front matter | Import identity/scope/origins; replace this work-instance authority with PostgreSQL at cutover. Its two states do not define the new manifest. |
| Human task surface and mutations | `wiki/app/src/knowledge/loop.tsx`; `src/server/http.ts` still exposes `/api/k/task-create`, `/api/k/task-close`, `/api/k/task-run`; handlers in `src/server/knowledge.ts` | Extend this surface with free intake, planning, comments/time and policy-driven actions. Move existing callers to the shared service and remove obsolete writers when cutover occurs. |
| Product kinds and entity catalog | `src/knowledge/kinds.ts`, `src/knowledge/catalog.ts`: `madarch/kinds.yaml`, data-declared kinds, attributes, relations and catalog schema | Extend the common catalog; do not create an independent tracker registry. Catalog implementation status is not an item's workflow status. |
| Workflow registry and host | `src/knowledge/starter-workflows.ts`, `src/fill/orchestrator-host.ts`: product workflow stage references and owner-hosted execution | Agree one manifest rule and shared guard/effect engine. Existing fill stage declarations do not prove arbitrary work-item transitions are already implemented. |
| Database ownership | `src/adapters/database-owner.ts`: one owner boundary, PGlite serializes transactions and bare runs; PostgreSQL pool permits overlapping transactions | Add work stores behind this interface, never SQL in UI/MCP adapters. Measure fill/tracker contention before selecting physical co-location. |
| Graph storage being replaced | `src/graph/schema.ts` still contains numeric identities and temporal `node_version`/`edge_version` rows; `work_item` is an internal fill queue | The maintainer's target is current as-is plus multiple to-be and age-thinned snapshots. New work links use stable keys/context, not those temporal-row IDs. Do not describe the target as already landed. |
| Agent knowledge access | `src/mcp/server.ts`, `src/mcp/tools.ts` | Add work operations through the existing server boundary and shared command implementation, retaining knowledge reads. |
| Engine-development backlog | `.shady2k/integration.md`, `.shady2k/tracker.mjs`, br store outside branches | Build an early importer. Its source records are not automatically authenticated principals or new reservations; actual cutover is explicit. |

The current task-closure path uses commit evidence. In the proposed tracker a matching
commit is result evidence, not automatic satisfaction of the configured lane. Historical
closures retain their provenance rather than gaining an invented reviewer.

## Common execution boundary

The wiki, CLI and MCP invoke one work service; HTTP is another adapter to the same
contract, not a prerequisite for the first local process. It uses the existing catalog,
one workflow engine and owner-side storage interfaces. There is no parallel task
workflow engine, second graph writer, or executor fleet. External agents execute the
work; madarch validates its ordering, ownership and results.

Within a local PostgreSQL transaction, a checked operation records its work changes,
journal/outbox entry and events together. No SQL transaction remains open during human
input, an agent run or Git network I/O. A local commit of an outbox entry does not imply
a confirmed shared reservation. Online arbitration and recovery determine when the
same operation is globally acknowledged; the transport contract is ADR 0035's.

Priority changes update work data in PostgreSQL immediately in local mode and are
synchronized as operations where shared. They do not edit a task document or require
a definition commit. Git transport may later serialize those operations into files;
that is delivery, not a second authored definition store.

## First model agreements and integration with fill

M0 reviews the [manifest/table contract](model-contract.md), including active
configuration installation, stable keys and graph-context references. Existing
`workspace.yaml`, kinds and fill workflows are inputs to that agreement; an
illustrative JSON block is not a new loader beside them. Work-specific optional fields
extend catalog entities rather than duplicating their identity or taxonomy.

The tracker can start local intake and planning without completing a full product
fill. It needs the agreed catalog/storage seams and can show unresolved graph links
honestly. Shared ownership cannot ship before the concurrent Git-transport proof.
This separates genuine dependencies from a false requirement to finish all fill work
before beginning the tracker.

Snapshot references preserve the context in which work/evidence was produced: current
as-is, a named to-be, or a retained historical snapshot. Snapshot thinning and paid
agent-result transfer are shared graph concerns; tracker retention pins required
references and detects unavailable ones. A snapshot of the graph is not a backup of
reservation fences, operation deduplication, comments or time.

## PGlite single-connection risk

The existing owner explicitly queues PGlite operations on one connection. Moving a
caller to another process does not by itself prove that a shared database queue can
serve interactive edits during a long fill transaction. Conversely, opening another
independent writer to the same PGlite files is not a concurrency solution.

The local delivery proof must run fill and human/agent task operations together,
record latency and queue/transaction duration, and agree a responsiveness bound from
those measurements. Begin with bounded owner-side transactions and admission that
does not starve interactive operations. If that cannot meet the agreed bound, decide
physical isolation behind the same storage interface before co-locating production
work. Separate stores would need an explicit stable-key/event consistency boundary,
not an accidental cross-database transaction promise. Neither topology is claimed
proven by this documentation.

## Security and trust

Authenticate every product participant and executor. Roles, permissions, area mappings,
queue exceptions and lane policies are product data, but editing a visible role/name
never grants authority. Free human intake means no planner/agent gate for authenticated
participants; it does not grant anonymous public administration.

A Git author string is not actor proof. Before G1 can authorize production grants,
the proposed transport must establish actor-to-credential binding, policy validation
for every accepted operation, protection of its dedicated ref and the behavior after
revocation, unauthorized ref replacement or divergent prefixes. Trusted-client
assumptions must be explicit; a local two-client race alone is not an adversarial
security proof. A later HTTP transport must pass the same authorization and outcome
cases rather than weaken them.

Scope paths, entity keys, evidence links and comments are untrusted data. Resolve
references within authorized repositories, reject path escapes, render text inert,
and never execute commands or fetch arbitrary URLs from a result manifest with server
credentials. Verified immutable artifacts and reviewer/model identity are required
for lane evidence. Secret-bearing rejected uploads need not be replicated into audit
history; clients retain allowed local work for safe reconciliation.

## Constraints and observable acceptance

The exact scenario catalogs live in the human/agent contracts and model agreement.
These constraints bind them to the delivery checkpoints; they are future checks, not
passing receipts for a running implementation.

| ID | Required invariant | Check and checkpoint |
| --- | --- | --- |
| C01 | One catalog, uniform manifest rule and workflow engine; no hidden fixed status enum. | M01/M05/M06: two unrelated kind workflows, rejected invalid install/transition; M0 then L1. |
| C02 | Free human request, verbatim provenance and explicit triage decisions. | M02 and human intake/triage scenarios through actual UI and agent commands; L1. |
| C03 | All work values in PostgreSQL; no task-file/definition-commit write path. | M04 plus reprioritization/custom-field/comment round-trip; L1. |
| C04 | Stable cross-machine identity and graph-context/evidence links. | M03 with deliberately different SQL IDs, as-is/to-be and retained snapshots; L1/O1. |
| C05 | One reservation covers its subtree; no ancestor/descendant race grants two holders. | Two independent clients take overlapping roots, create offline children, reparent and recover; G1. |
| C06 | Executor replacement is not reservation transfer; stale actors cannot mutate current work. | Replace executor, preserve holder/root, reject old generation, retain allowed late evidence; G1/I1. |
| C07 | Queue order, suitability, inherited blocker urgency, owner exceptions and caps are enforced at take. | Competing claims, reprioritization, role/area change and blocker/cap races; G1/I1. |
| C08 | Non-expiry plus meaningful manual recovery and Problems observations. | Configured 24-hour boundary/override, offline holder, authorized unlock and stale reconnect; I1. |
| C09 | A/B/C rules and inherited criticality govern acceptance and merge, not a universal self-review toggle. | Real identity/model evidence, insufficient lane reviews, mixed scope and sole-developer cases after Q3; I1. |
| C10 | Git transports operations outside worktrees; lost replies/pruning cannot duplicate effects or revive old grants. | CAS contention, duplicate delivery, crash windows, checkpoint resnapshot and old epoch; G1/O1. |
| C11 | Authenticated, permission-scoped shared operations and inert untrusted content. | Spoofed actor, unauthorized priority/role changes, ref tamper, hidden item and malicious evidence cases; G1/I1. |
| C12 | Early import preserves actual records and retires old writers only on explicit cutover. | M07, repeated import, full reconciliation, freeze/switch and rollback; L1/O1. |
| C13 | Work remains usable alongside fill at agreed scale. | Real concurrent fill plus create/comment/time/priority/ready operations; 10,000 items with deep/wide trees and bounded pages; L1/O1. |
| C14 | Both interfaces are usable, not a machine-only backend with a later human UI. | Browser create/decompose/comment/review plus CLI/MCP on same work; 360px, keyboard, 200% zoom and non-drag controls; L1/I1/O1. |

## Cutover and compatibility

The old Markdown task writer, manual close route and its direct UI callers are migrated
as one authority cutover, not retained as mutable aliases. Preserve any legitimate
page-refresh responsibility behind the appropriate shared workflow boundary. No
compatibility shim may bypass ordered ownership or lane policy.

The br importer is early work; using it against an immutable export is not permission
to switch the development backlog. Freeze the chosen source only at the agreed
cutover, reconcile every record, then disable the old writer before new authority is
activated. Keep rejected/ambiguous mappings explicit and source snapshots read-only.
No change in this PR performs that cutover or upgrades the repository's workflow tools.
