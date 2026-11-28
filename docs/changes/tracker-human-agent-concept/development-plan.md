# Development plan: local work alongside fill, then proved shared coordination

Status: revised proposed sequence after the [maintainer's review](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890).
This document replaces the initial P0–P4 sequence. It does not start implementation,
create ready implementation tasks or execute a live migration.

## Direction and first agreements

The maintainer directs the tracker to start alongside fill, local first, with catalog
entities/configurable fields, comments, time and br import. Do not wait for all fill
work or a server before beginning that useful slice. Equally, do not call an isolated
local claim a distributed guarantee: taking shared work requires the proved online
remote protocol.

First agree **the uniform manifest rule and the table structure** in
[model-contract.md](model-contract.md). Review them with the catalog/storage/fill
interfaces and stable-key graph direction. These are M0's two substantive approvals;
writing this PR is not their acceptance. Q2 holder/handoff, Q3 lane composition and Q4
transport/trust/retention decisions are settled before the checkpoints that consume
them, not reopened as alternatives to the maintainer's twelve requirements.

## Independently acceptable checkpoints

| Checkpoint | Observable result | Prerequisites | Evidence boundary |
| --- | --- | --- | --- |
| M0 — One manifest rule and table agreement | Maintainer agrees the uniform declaration/install rule and logical/physical table responsibilities, integration seams and retained open decisions. | Revised concept, mature-model comparison, current source inventory. | Recorded agreement, field/identity/permission matrix and concrete fixtures; no fake passing runtime proof. |
| L1 — Local usable work catalog | Person creates and decomposes work in madarch, reads original text, comments and time through human and agent views; kind fields/workflow definitions are configurable; local br export imports with reconciliation. | M0 and its shared catalog/storage interfaces, not completion of all fill or G1. | Real PostgreSQL-compatible local storage, actual browser and CLI/MCP reads/planning commands, isolated import fixture. No production shared grants or automatic agent execution before G1. |
| G1 — Serverless coordination proof | Independent clients sharing a real Git remote cannot both take overlapping work, bypass ordered taking or revive obsolete grants after reconnect/pruning. | M0; Q2 holder/frontier/cap mapping; explicit Q4 trust/credential/protection candidate. Runs alongside L1 and fill. | Real Git remote and separate PostgreSQL client stores, crash/reconnect/host-protection evidence; a negative result returns the mechanism for agreement. |
| I1 — Ordered human-agent work and policy acceptance | Human intake is triaged at its turn; suitable work is taken, executed externally, submitted and accepted/merged according to configured lanes; manual recovery and Problems work. | L1, accepted G1 guarantees, Q3 lane agreement. | Full UI/CLI/MCP scenario with real authenticated participants and reviewer/model evidence; all guards applied through one contract. |
| O1 — Operational use and chosen cutover | Product-scale work remains responsive during fill; snapshots/checkpoints restore correctly; chosen legacy source migrates with reconciled data and no competing writer. | Applicable L1/G1/I1 evidence, retention and cutover agreement. | 10,000-item fixture, measured contention, restore/pruning, frozen-source import and rollback/recovery rehearsal. |

An optional server transport follows the same contract later. It is not a prerequisite
hidden in G1 and is not required to close the first serverless outcome. If selected,
its fenced cutover must pass A25 before use. It must not add a new workflow engine,
change identifiers or turn PostgreSQL/Git replicas into two writable authorities.

L1 is useful local planning, not a renamed implementation stub: both interfaces,
comments/time and a real import path work. Ordered autonomous triage/execution remains
I1 work because it consumes G1's grant proof. Local records and pending proposals can
exist before that; no provisional reservation may be presented as ownership.

## Worker-sized packages after the relevant agreement

These are proposed work packages, not claimed/ready tracker tasks. The eventual tasks
name their actual stage, scope and evidence. Only refine a later checkpoint when its
inputs are known; no inventory of invented downstream implementation tasks is opened
by this documentation PR.

| Package | Independently observable criterion | Actual dependency |
| --- | --- | --- |
| M0-A — Common model contract | One reviewed mapping joins catalog identity, work extension, original capture, comments/time, roles/policies and manifest transitions; Jira/YouTrack reuse and deliberate differences are explicit. | Revised concept and current-main inventory. |
| M0-B — Agreement and compatibility | Maintainer accepts manifest/table rule; invalid-declaration cases, state evolution and current as-is/to-be stable-key seam are specified without temporal-row foreign keys. | M0-A. |
| L1-A — Local entity/field storage | Create/read/update work and original capture through owner interfaces; configurable values persist without a work-file/definition-commit path. | M0. |
| L1-B — Human planning plus agent read/commands | Actual wiki intake/tree/detail/decomposition and CLI/MCP planning resolve the same keys; no mandatory agent, criteria or execution approval for human creation. | L1-A; one shared operation contract. |
| L1-C — Comments and attributed time | Human/agent comments and corrected time survive restart/replay; old records are preserved and effective totals do not double-count. | L1-A; can proceed with L1-B. |
| L1-D — Early br importer | Immutable source export maps identities, custom data, comments, time and histories; dry run explains every rejected mapping and repeat import is idempotent. | L1-A and agreed mapping; can proceed with L1-B/C. |
| G1-A — Transport/trust fixture | Two isolated clients, protected dedicated remote ref, authenticated participant/policy basis and deterministic validated prefix; unsupported host enforcement is a visible design failure. | M0 and Q4 candidate, independent of L1 UI. |
| G1-B — Subtree and queue contention | Parent/child/reparent races, priority/cap races and executor replacement have the specified one-grant outcomes; nothing executes before remote confirmation. | G1-A and agreed Q2/frontier rules. |
| G1-C — Delivery, checkpoints and recovery | Lost replies, remote success before local commit, duplicate operations, pruning, old client and unsafe restore preserve outcomes and fences. | G1-A; develop alongside G1-B. |
| G1-D — Mechanism verdict | Repeatable evidence covers positive and negative authorization, remote durability, confidentiality and recovery limits. Admit production claims only if the whole promised contract holds. | G1-B/C. |
| I1-A — Ordered intake and work | Agent triages at queue position; ready/take applies areas, dependencies, inherited priority, caps and owner-only order exceptions. | L1 and G1. |
| I1-B — Policy review and merge | Actual C/B/A evidence and verified actors/models govern transitions/merge, including criticality and agreed sole-developer/correction rules. | I1-A and Q3. |
| I1-C — Recovery surfaces | Executor replacement, explicit subtree release, stale-sync Problems and investigated manual unlock are usable through both surfaces; rejected evidence remains reconcilable. | L1/G1; can proceed alongside I1-B. |
| O1-A — Scale and fill coexistence | Full fixture, pagination, narrow/zoom/keyboard UI and concurrent fill measurements meet agreed bounds without opening another uncontrolled database writer. | L1/G1/I1 behavior needed by each measured path. |
| O1-B — Rehearsal and authority switch | Reconcile chosen real source, rehearse freeze/switch/restore, then retire old writers in the accepted cutover. | Import/recovery evidence and explicit migration approval. |

## Scenario-to-checkpoint allocation

Scenario IDs describe future observable behavior, not results claimed by the docs.
A cross-cutting scenario is split explicitly below so a later behavior cannot make an
earlier checkpoint circular. The full scenario must still pass at its final stage.

| Checkpoint | Required scenario scope |
| --- | --- |
| M0 | M01–M07 specify contract/fixtures; executable manifestations are proved in L1/G1/I1. A02/H08 require the shared-rule design, not a claim of a running engine at agreement. |
| L1 | M01–M07 as applicable to local behavior; H01–H02, H04–H06 local preview/apply, H08–H09 local configuration/owner ordering, H24 local comment/time correction, H28 import, H30 rendered local paths; A01 creation only, A02, A06 local atomicity, A23 bounded local reads, A24 initial fill-contention measurement. |
| G1 | A03–A08 (including structure/priority/cap races), A11, A16–A20, A22; H04–H07 concurrent/inherited-scope parts, H13–H16, H19 transport/consent fences, H26–H27 protocol recovery. No dependency on completed I1 review UI. |
| I1 | Full H03, H07 and H09–H27, H31–H32; full A01, A06–A15 and A21 with human/agent interaction. H30 covers the added triage/review/Problems surfaces. G1's mechanism is reused, not replaced by a mock arbiter. |
| O1 | H28 live-source rehearsal, H29–H30 full-scale/all-surface walk; A19–A20 restore at scale, A23–A24 full fixture, all C01–C14 constraints on the assembled candidate. A25 only if optional server transport is selected. |

## Early import and safe retirement

Two sources remain distinct: product Markdown tasks and the br development backlog.
An importer may support both, but one is not silently substituted for the other.
Develop the br path in L1; switching a live source is O1's separately approved action.

1. **Capture and map.** Read an immutable export/snapshot. Map source system + source
   ID to stable work keys; retain original descriptions, authors, times, hierarchy,
   link types, labels/custom fields, comments, corrections, time entries and evidence.
   An imported actor/model string is historical attribution, not current credentials
   or verified different-model review.
2. **Respect configured workflows.** Map source statuses into the agreed target kind
   manifest, not a hard-coded draft/open enum. Unmapped values remain explicit
   reconciliation findings. Legacy closed work retains its actual historical outcome;
   it is not assigned a newly fabricated acceptance lane or live reservation.
3. **Do not lose records.** Duplicate identities, bad links, unsupported fields,
   missing referenced objects and cycles produce source record/key, field and full
   file/line where available. Preserve rejected material and report counts/checksums;
   never call a smaller successful subset a full import.
4. **Rehearse and repeat.** Run the importer twice against the same snapshot. Target
   identities and effective time totals are unchanged; comments/history do not
   duplicate. Resolve discovered mapping decisions before cutover, with an explicit
   report rather than a new implicit default.
5. **Freeze and switch once.** Stop the chosen source's writes, reconcile its final
   export and pending operations, take PostgreSQL/transport backups, apply the final
   mapping and activate the new authority. Retire the old Markdown/status mutations
   and migrate their callers in this cutover. Preserve stable links through mapping,
   not a second mutable tracker or bypass alias.
6. **Recover without two writers.** Before new writes, rollback can restore the source
   while disabling the new authority. After new writes, freeze again and use an agreed
   lossless reverse mapping/replay or forward repair. Never overwrite new comments,
   time or accepted decisions with an old snapshot, and never operate two writable
   epochs during recovery.

## Fixtures, evidence and truthful admission

- Use repositories and records held/generated by the project, not a required private
  checkout. Fixture both deep and wide hierarchy, different SQL IDs per machine,
  blockers outside a feature and participants in different areas.
- G1 uses a real remote with the deployment's actual ref/authentication protections,
  separate PostgreSQL-backed clients, deterministic concurrency barriers and process
  crash points. A local bare remote proves only its own supported threat model; it is
  not evidence that an arbitrary hosted remote enforces product rules.
- Exercise both sides of lost CAS replies: accepted operation beneath a later prefix
  and an unaccepted local candidate. Prune covered segments, reconnect an old client,
  replay accepted time and obsolete executor output, and verify no duplicate or
  resurrected ownership. Preserve local rejected results.
- At scale use **10,000 work items**, bounded pages (proposed maximum 100), deep/wide
  trees, concurrent priority/structure changes and restricted records. Enumerate the
  snapshot without omission, not just its first page.
- Measure task interaction during actual fill: create/edit/comment/time/priority/ready,
  queue wait, transaction time, latency and memory. Agree the responsiveness bound
  before claiming acceptance; this proposal invents no measured SLA.
- UI acceptance renders every changed surface at desktop and 360px, keyboard and
  200% zoom, with click/tap alternatives to drag. Static mockup screenshots are not
  proof of working controls or runtime accessibility.
- Acceptance records name the exact source/configuration revision, fixture, steps,
  output, failure cases, limits and independently verified evidence. A protocol that
  fails returns to Q4; it is not narrowed to make a test green. Documentation checks
  in this PR are recorded only as documentation checks.

The tracker work proceeds beside fill through the agreed seams. This plan adds no
executor fleet, model-selection UI, whole Jira clone or requirement to deploy a server
before the initial local/serverless outcome.
