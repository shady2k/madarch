# Human work interface — revised concept for review

## Status, authority and boundary

This documentation-only proposal responds to [the maintainer's twelve constraints](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890). Those requirements constrain this revision; the UI composition and Q1–Q4 mechanisms in [concept.md](concept.md) and [model-contract.md](model-contract.md) remain proposals, not implemented or approved architecture. The original PR was contributor-initiated, not a record of maintainer approval. No implementation or milestone activation follows from this document.

Humans and agents work on **one PostgreSQL-backed work set**, locally and later server-side. Text, structure, priorities, workflow state, comments, time, reservations and reviews are work data, not Git-authored definitions. Editing a priority does not require a commit. Before a server exists, Git only transports the segmented operation log on a dedicated ref outside working trees; madarch performs semantic reconciliation. A locally pending request is not a confirmed shared reservation. A later server changes transport, not these human-visible rules.

The human surface supports capture, planning, decomposition, ordering and review without chat, CLI or repository-file editing. The [agent interface](agent-interface.md) addresses the same stable work keys and operation contract. Structured work editing is the proposed narrow amendment to [ADR0033 §28](../../decisions/0033-one-workflow-by-entity-kinds.md): generated wiki prose and graph facts remain read-only here. Source links are evidence, not authority for task text.

[mockup.html](mockup.html) is a self-contained static composition of fictional Atlas data. It illustrates the work set below; disabled controls perform no operations. Status labels, priority labels, people, estimates, revisions and evidence are examples. The page proves neither concurrency nor an implemented accessibility contract.

## Continuity and initial delivery

The earlier concept identifies `TasksPage`, `TaskPage`, `ProposeTaskForm` and `TaskBody` in `wiki/app/src/knowledge/loop.tsx`, scoped task storage in `src/loop/tasks.ts`, and generated-page refresh planning in `src/loop/task-run.ts`. Reuse the existing list/detail, readable scope links, preview and explicit failure patterns. Do not reinterpret the current task store or generated-page refresh as a general execution coordinator. The parent design owns migration and retirement of old contracts.

Start the usable tracker alongside fill: catalog entities and configurable fields, human intake, agent access, comments, time and early `br` import. Local capture and planning do not wait for shared-claim transport. Import previews stable-key mapping, source identity, duplicate/collision findings and unmappable fields; the original text survives. An import does not invent a reservation or accepted review. Local machine SQL row IDs never become cross-graph links. Borrow familiar Jira-style list/detail, hierarchy and workflow concepts without reproducing the entire product.

The first agreement is Q1: a uniform manifest rule and table structure. Workflow, permissions and configurable fields are product configuration/data, not a demand that participants edit Git task files. Concurrent fill must not make the work UI unusable; PGlite single-connection responsiveness is a prototype obligation, not a performance result asserted here.

## One work set, linked views

The product's **Work** destination retains product, search, filters, selected stable key, snapshot time and connection state across views and browser Back. Detail has a permalink. Permission-scoped search and counts never reveal restricted titles. Proposed sizing fixture: 10,000 items, bounded pages of at most 100; this is a future check, not a measured capacity. Counts distinguish loaded items from all accessible matches.

| View | Purpose and visible information |
| --- | --- |
| Intake | Create from a person's own words; show ordered agent-triage queue, position, current worker, latest proposal and unresolved questions. Triage position is not delivery priority. |
| Backlog / ready | Put features and debt on one priority-level scale. Show owner-set base level, effective level and cause, eligibility, blockers, reservation coverage and any people-per-feature cap. Equal levels permit parallel work; row order is not a secret priority tie-breaker. |
| Tree | Decompose at any useful level; show ancestors, descendants, dependencies as separate links, reservation root/holder and inherited lane floor. Filtered-out ancestors are labeled context. Child pages have an explicit Load more; a partial branch is not shown as complete. |
| Board | Project statuses declared for the selected entity kind by the product manifest. An example task board may say Queued / Doing / Evidence; an example discovery board may say Investigating / Findings. Neither is a canonical enum or a separate engine. |
| Review | Separate triage/decomposition proposals from submitted implementation evidence; show the lane, mandatory checks, reviewer identities and missing obligations. |
| Problems | Surface actionable observations, including no synchronization beyond the configured threshold. Show why, since when, investigator and reservation; inactivity never means permission to steal. |

Board movement requests an allowed `workflow.transition`, not a raw status write. The single engine applies the same transition/guard rule for every kind. Show the named target and semantic guards before confirmation. Unsupported transitions explain why; the card stays in its authoritative column on refusal. Every drag action has a keyboard action-menu equivalent. Readiness, ownership, review obligations and Problems observations are not additional universal workflow states.

## Free intake, visible triage

Any human product participant can create work from free text. No planner role, agent conversation, complete scope, criteria, estimate or particular status is a prerequisite. The original words are retained verbatim, including paragraph breaks, separately from any later structured summary or proposal. Optional title, kind, parent, links and attachments can help; their absence is not grounds to refuse ordinary intake. Participant identity, stable work key and creation order make the saved request traceable.

An agent triages in queue order. The UI shows who is being served and what is next, rather than silently skipping an inconvenient request. Duplicate candidates link both requests; contradictions quote the conflicting requirements; discovery questions stay visible; decomposition and acceptance criteria are explicit proposals. A blocked triage entry shows its unresolved question and recorded disposition before the queue advances according to the agreed queue rule, never silently disappears. A person may accept, amend or return a proposal with a reason. Applying it retains the original request, proposal provenance and human amendments. Neither triage nor a duplicate suggestion silently rewrites or closes the request. Any eventual closure must be an explicit authorized workflow decision with a reason.

People may also edit structure directly. Agent help is optional and does not own the entrance to the tracker. Triage and an estimator may suggest initial priority placement; only the product owner's ordering or explicit exception authorizes queue policy. There is **no per-task execution-approval step**: the owner-managed queue grants permission to start when shared eligibility and reservation guards pass.

## Detail, hierarchy and atomic planning

Detail uses labeled sections that become stacked anchors on narrow screens:

1. **Request and definition:** verbatim intake, current structured text, kind/custom fields, parent, scope/exclusions, criteria and stable-key links to current as-is or a selected to-be graph. Show `item_revision`, not a Git definition SHA. Source snapshots/commits may pin evidence without becoming task authority.
2. **Structure and order:** children, residual parent outcome, explicit prerequisites/dependants, priority base/effective levels and their causes, inherited criticality and proposed/effective lane. Containment alone is not a dependency.
3. **Responsibility and execution:** responsible human, replaceable executor, reservation root and covered subtree, last synchronization and Problems link. Stable holder authorization, reservation generation and executor/session/attempt tokens are available in technical disclosure, not a mandatory third assignment field.
4. **Discussion, time and review:** comments, recorded time/corrections, proposals, immutable submissions, lane evidence, decisions, relevant revisions and operation history with actor/time. Reported evidence is distinguishable from independently observed checks.

| Action | Preview and authoritative outcome |
| --- | --- |
| Edit work | Compare current and proposed PostgreSQL fields at expected revisions. Preserve original intake. Show affected review/attempt basis and reason for any active-work replan; stale evidence cannot become current silently. |
| Decompose | Editable child rows include optional early detail, scope/criteria coverage when available, dependencies and residual parent work. Preview new stable keys, all affected items, ownership inheritance, priority and lane impact. One atomic apply changes all items or none; incomplete planning is allowed, but execution guards explain any missing evidence/fields required by the configured workflow. |
| Split | Keep the original identity/history, explicitly describe residual work or a proposed replacement/closure, and review every dependency redirection. No cancellation or replacement link silently satisfies a prerequisite. |
| Reparent | Show old/new ancestry, inherited reservation, priority, lane floor and dependent work. Reject self/descendant cycles and ownership conflicts. Do not silently move work out of another holder's protection or weaken an applicable lane floor. |
| Add/remove prerequisite | Describe “this work waits for …”, reverse impact and inherited urgency. Reject dependency cycles. A reference is not automatically a gate. Gate satisfaction follows the manifest's semantic rule, not a hardcoded status string. |
| Replan active/reviewed work | Name changed basis, affected reservations/attempts/dependants and previous review. Require the relevant configured authority and explicit reason. Preserve historical evidence; invalidate/revalidate affected current eligibility rather than laundering stale evidence through a text edit. |

A parent remains reservable work, not an inherently non-executable container. Children inherit an existing enclosing reservation. A new child is not a new permission grant to another holder. Finishing children does not prove the parent's integration criterion; the parent's workflow and acceptance obligations still apply.

The preview binds item, structure and policy revisions for affected work. Editing the proposal invalidates it. A concurrent relevant change requires a refreshed preview with base/current/proposed comparison and a new confirmation; permitted local edits survive. Applying is a PostgreSQL/domain operation, not Git definition adoption. In shared mode, distinguish locally recorded/pending from durably accepted operations; never show a partly accepted child set. Unknown outcomes use the same operation ID and `operation.status`, not a second create. An unresolved mandatory source reference is shown as such, never widened from a symbol/line to an entire file.

## Owner ordering and useful ready results

Features and technical debt share one configurable scale. For illustration, Atlas calls its levels L1 (highest), L2 and L3. These labels are not a universal enum. Several items can have L1; suitable people can work in parallel. Moving a feature moves its work consistently under the common effective-level policy, with a descendant-impact preview. A configured estimator such as WSJF suggests initial placement only. Agent `priority.propose` never overwrites the owner's `priority.set`.

`work.ready` filters by requester areas, unblocked work, free reservation scope and the optional people-per-feature cap, then groups/orders by effective level. Detail explains exclusions: a prerequisite, overlapping holder, area mismatch, cap or configured guard. A work item with descendants is not excluded merely for being a parent. A final take rechecks current policy and revisions; a cached ready result is not a grant.

Taking lower suitable work while higher suitable work is free is refused with the higher work's stable keys, readable authorized reasons and a next action: take higher work or request a product-owner exception. The owner can record an explicit, scoped exception with reason and policy basis; an agent, executor, responsible human or administrator does not gain this power merely from that role. Stale or mismatched exceptions are rejected rather than treated as permanent queue bypasses.

Blockers inherit urgency from blocked work without permanently replacing owner-set base levels. For example, AT-50 debt is base L3 but effective L1 because it blocks L1 feature AT-40; removing that dependency removes this inherited urgency. A ready requester sees AT-50's cause, not an unexplained reordered backlog. If another blocked item still contributes L1, that cause remains. A feature move recomputes descendants and blockers consistently; it is not a series of best-effort row edits.

## Whole-subtree reservation and replaceable executor

A taker chooses the subtree level. A confirmed take protects that node and descendants, including later children; ancestor and descendant reservations participate in exclusion. A subtree containing another holder's work cannot be taken. Online access and durable confirmed remote arbitration are required for new shared takes. The UI distinguishes requesting, uncertain, refused and confirmed; only confirmed ownership permits execution. A lost acknowledgement is recovered by operation identity. Do not turn a timestamp or a successful local write into a grant.

**Q2 — tentative recommendation:** refuse overlapping reservations even for different sessions of the same holder; continue under the existing ancestor grant instead. To let another holder take a child, explicitly release/restructure the enclosing reservation first. Preview the now-unprotected scope and re-arbitration risk; this is not an implicit delegation or a promise that the child will still be free. An explicit delegation protocol could be agreed later. These refinements are not presented as maintainer-set rules.

Responsible human and executor agent are separate. The responsible-person field is editable planning data, not holder authorization; changing it does not transfer a reservation or grant mutation permission. Stable holder authorization identifies the authenticated taking participant/work subject; an agent acts through explicit holder delegation. The exact human/agent holder mapping remains part of Q2. Replacing an executor keeps holder authorization and the subtree grant; rotate executor/session/attempt authorization and reject obsolete executor writes. The replacement explicitly receives the current scope/basis. A human need not release an entire feature to replace a failed agent. No agent launcher or fleet-control UI is implied by the assignment field.

Reservations never expire. Authorized product roles—configured administrator, CTO, head of development or equivalent—investigate and explicitly unlock/revoke with a reason, or use an authorized transfer with the target acknowledgement required by the shared contract. An unavailable target is not fabricated consent: retain ownership or explicitly unlock. Release/revoke/transfer must show the whole protected scope and affected attempts. An old executor cannot regain authority by reconnecting. Submission of one child's evidence never silently frees the rest of the reserved subtree; release is an explicit ownership operation, not a board-column side effect.

## Acceptance lanes, not a self-review switch

Agent-proposed lanes are visible recommendations; a person can correct the lane with an audited reason. Graph-node criticality inherits downward and imposes the relevant mandatory lane. Human correction cannot silently bypass that floor. The product manifest supplies configuration and the one engine evaluates it.

| Lane | Maintainer-required obligations |
| --- | --- |
| C | Green merge request plus review by another agent on another model; an agent may merge after these requirements pass. |
| B | The same technical/independent-agent requirements as C, plus human merge approval. |
| A | Human participation is mandatory plus another responsible reviewer; the sole-developer exception applies to the second responsible reviewer. |

**Q3 — tentative recommendation:** compose multiple touched/inherited criticalities using the strictest applicable lane, and retain C's technical evidence requirements for A as well. The exact composition, who may authorize any criticality/policy exception, and sole-developer qualification need agreement. Do not mistake this recommendation for a settled additional maintainer minimum. Until a required exception is explicitly configured/authorized, the interface must not offer a silent bypass. A universal “allow self-review” toggle is not an alternative to lane obligations.

Result review names immutable submission, item/source/policy basis, criterion-to-evidence links, MR/check status, reviewer actor and model, human approvals and missing obligations. A reported green check is not independent review. Wrong-model/same-agent review, stale evidence, missing human approval or an ineligible sole-developer claim explains the refusal and the missing recovery action. Accept/return/merge are distinct capabilities governed by the configured workflow; no fixed “return to open” transition is assumed. Evidence renders inert and excludes credentials. Prior decisions remain historical when a basis changes. A successful merge or all children finishing does not silently prove unrelated parent criteria.

## Comments, time and Problems

Comments are first-class attributed work data, with author, time and stable work key; agents and people see the same discussion. A correction is explicit and attributable, never a silent replacement of someone else's words. Time records name actor/executor, item and recorded interval/duration; `time.correct` preserves the original and correction reason. These are actual recorded observations, not an estimate or a claim that last synchronization equals hours worked. Duplicate reconnect delivery must not duplicate comments or time.

No synchronization for **more than 24 hours by default** creates or updates a Problems entry. The product default is configurable; a per-item override supports leave, with visible effective threshold and reason. For an inherited subtree reservation, the warning names the observed synchronization source and affected reservation rather than inventing a separate holder per child. Repeated checks update the same unresolved observation, not a flood of duplicate incidents. A later synchronization refreshes the observation/history; it does not erase an investigator's decision or silently release/reassign work. Investigation and explicit unlock are separate actions; product roles are data, not hardcoded usernames.

## Offline, conflict and recovery presentation

Local-first planning remains available without a server: catalog, intake, structured proposals, comments and time can be recorded locally in PostgreSQL. In a shared product, unsynchronized mutations are clearly pending; local storage alone does not claim globally accepted priority, review, transfer or reservation changes. Existing reservations do not expire during disconnection, but an old local view cannot prove no remote revocation occurred. Retain local evidence for reconciliation; remote acceptance still checks holder generation, executor and basis. Never start new shared work from cached ready results.

Every refusal includes an operation ID where applicable, stable affected keys, a safe reason and a usable next step. The same conflict must be visible through both human and agent surfaces. A failure never discards unrelated successful operations.

| Situation | Visible response and recovery | Checks |
| --- | --- | --- |
| Empty / filtered / inaccessible | Distinguish no work, no matches and denied access; show Create or Clear filters only where appropriate. | H01, H02, H29 |
| Loading / failed refresh | Keep known snapshot with its time; show stale/refresh failure instead of an empty success. | H29 |
| Stale edit or preview | No partial changes; preserve permitted proposal; compare reviewed/current/proposed fields and reconfirm. | H04, H05 |
| Invalid hierarchy, scope or policy | Explain affected keys/fields; reject the atomic change and repair the specific cause. | H05, H06, H18 |
| Higher-priority work / ineligible / cap | Name safe reasons and higher suitable keys; owner exception is separate from take. | H10–H12 |
| Overlapping reservation | Show authorized reservation root/holder and covered scope; use existing grant or explicit ownership resolution, not another claim. | H13, H14 |
| Revoked permission / obsolete executor / stale basis | Recheck authority at mutation; preserve allowed rejected edits/evidence separately; refresh authority or explicitly reconcile. | H15, H18, H25 |
| Offline / unknown result | Mark pending and show operation ID; reconnect/query status before replay using the same identity. | H16, H26 |
| Event cursor/history gap | Re-snapshot accepted authority before presenting coordination state as current. Pruned transport history must not revive an old grant. | H27 |
| Lane requirements unmet | Explain exact obligation, evidence basis and eligible correction/reviewer path; no generic bypass. | H20–H23 |
| Inactivity / transfer target unavailable | Open/update Problems; investigate and explicitly unlock or retain ownership. Never expire or invent consent. | H17, H19 |
| Import collision / bad record | Show exact source mapping and reason; preserve original text; resolve or explicitly exclude before applying a fresh import plan. | H28 |

## Concrete walkthrough: Atlas, one human and agent work set

All keys, people, labels and artifacts here are fictional and are also used in the mockup.

1. Participant Jo saves AT-60 verbatim: “Exports lose my rows. Please stop that.\nI don't know which export option causes it.” No criteria or planner approval are required. Intake shows AT-59 first and AT-60 second. For the current entry AT-59, the agent's duplicate candidate linking AT-40 is a proposal, not automatic closure or a rewritten request; AT-60 has not been silently taken out of order.
2. Owner Mira places feature AT-40 Reliable export at L1. AT-41 Export contract has satisfied its configured prerequisite guard. AT-42 Export implementation is reserved under AT-40 and has submitted evidence awaiting lane B human merge approval. AT-43 Validate export still waits for AT-42 to satisfy the configured dependency rule.
3. Mira previews AT-44 Invalid-row coverage and AT-45 Large-export coverage under AT-43. Parent criteria C1/C2 map to the children; C3 remains parent integration review. Both inherit AT-40's existing reservation, effective L1 and applicable lane floor. Apply is one PostgreSQL/domain operation; no Git definition publication or separate execution approval appears.
4. AT-40's responsible human is Mira, executor agent-21, with stable holder authorization disclosed in ownership details. Replace agent-21 with agent-22 without releasing AT-40; old executor tokens are fenced. Q2's tentative rule would refuse a second overlapping grant even for the same holder.
5. Debt AT-50 Export parser repair is base L3/effective L1 because it blocks AT-40. AT-51 Export diagnostics is free at the same effective L1 and demonstrates equal-level parallelism where area/cap policy permits. Taking free L2 AT-70 Report polish is refused while those higher suitable items are free; only Mira acting as product owner can authorize the scoped priority exception.
6. AT-42's lane B review shows green MR and another agent on another model, but missing human merge approval. An inherited criticality floor explains why a proposed correction to C cannot bypass B. Q3's composition remains visibly tentative; no merge happens in this mockup.
7. A comment on AT-43 explains a failing fixture; a 35-minute record has an attributed correction to 30 minutes. AT-40 has not synchronized for 27 hours: Problems shows a 24-hour effective threshold and still-reserved ownership. Separate AT-80 Leave coverage shows a 72-hour item override, not a lease extension. An authorized investigator—not a timer—decides whether to unlock.

## Observable acceptance scenarios for future implementation

These are proposed checks, not executed results. Scenario IDs are stable references for the parent development plan; R01–R12 refer to the numbered maintainer constraints in the shared concept.

| ID | Given / action | Observable result |
| --- | --- | --- |
| H01 | An ordinary product participant creates from free text with no criteria, planner role or agent interaction, including paragraphs and punctuation. | A stable work key and verbatim original text are saved in PostgreSQL; intake is visible immediately. No mandatory draft/open lifecycle or execution-approval gate is introduced. (R01, R04, R05) |
| H02 | Filter/select a key, switch list/tree/board and navigate Back; inspect empty results. | Query, key and position survive; context ancestors and bounded counts are labeled; no matches differs from empty product. Human and agent views resolve the same work. (R12) |
| H03 | Agent triages queued requests, finds a duplicate and contradiction, proposes discovery, criteria and children; person returns then amends the proposal. | Queue position and explicit disposition are visible. No silent skip, rewrite or closure occurs; original words, both authors, return reason and linked amended proposal survive. (R04) |
| H04 | Parent, policy or ownership changes after a two-child preview. | Apply rejects the stale preview atomically, retains local input and shows base/current/proposed before renewed confirmation. No partly active children. (R01, R03) |
| H05 | A multi-item plan includes a cycle, denied relationship or unresolved mandatory scope reference. | Entire apply is refused with safe field/key reasons; no hidden relationship details, partial apply or widened scope. Repair requires a fresh preview. (R03, R12) |
| H06 | Split work with dependants; attempt to reparent beneath itself/descendant or across conflicting reservations. | Preview preserves identity, residual outcome and explicit dependency treatment; invalid moves are refused and the previous hierarchy remains. (R03) |
| H07 | Add children beneath a reserved feature, then complete the children. | New children inherit its reservation and applicable priority/lane policy. Parent remains reservable under policy; child completion alone does not satisfy its unmet integration criterion. (R03, R06, R10) |
| H08 | Configure two kinds with different status identifiers and guarded transitions. | One engine and rule run both; board labels match each manifest. Unsupported transition explains its guard, changes no state and has a keyboard alternative. No canonical status enum is required. (R11) |
| H09 | Owner moves a feature's level; an estimator and an agent suggest conflicting placement. | Descendant-impact preview and atomic policy application keep feature work consistent. Suggestions remain proposals; no commit or task-by-task approval is required. (R01, R05, R06) |
| H10 | Two free suitable items have equal highest effective level; lower suitable work is requested. | Highest-level work can be taken in parallel subject to cap/exclusion. Lower take is refused naming higher suitable keys, not an arbitrary tie-break. A valid scoped product-owner exception permits the lower take. (R06, R07) |
| H11 | Non-owner attempts an exception, or a recorded exception no longer matches current policy/scope. | Refused with authorized reason and owner/revalidation route; responsible-person/executor/admin fields alone cannot grant ordering authority. (R07) |
| H12 | Ready requester is outside an area, prerequisite is unmet, scope is held, or people-per-feature cap is full. | Each exclusion is explained safely; ready contains only currently suitable free work. Take rechecks changed facts, not cached eligibility; clearing one reason does not clear the others. (R07) |
| H13 | Holder A owns a child; holder B takes its ancestor. | Refuse the ancestor with the conflicting protected scope; no partial grant. Conversely an ancestor grant excludes later descendant takes and covers later children. (R03) |
| H14 | Same holder requests overlapping grants from two sessions, or wants another holder to take a child. | Under tentative Q2, refuse overlap and offer existing ancestor authorization; release/restructure is explicit with scope/race warning before another take. No implicit delegation. (R03; Q2 proposed) |
| H15 | Change responsible human, then replace executor under one confirmed reservation. | First change does not transfer ownership; replacement preserves holder/subtree and fences old executor writes. New executor sees current basis; rejected old evidence is retained for reconciliation, not accepted as current. (R09) |
| H16 | Two participants race to take; winner's acknowledgement is lost; loser is offline. | Only durable arbitration winner can execute. Status lookup with the same operation ID recovers the grant; loser sees conflict, offline requester sees pending/refused, never ownership from a local write. (R02, R03) |
| H17 | No sync for 27 hours with default 24-hour threshold; repeat observation; configure leave override to 72 hours. | Default creates/updates one Problems entry without releasing ownership; effective override and reason are visible. Later sync updates observation/history, not the reservation or investigator decision. (R08) |
| H18 | Replan reserved/reviewed work or change a prerequisite's satisfaction while a dependant executes. | Current-basis impact is explicit; old review stays historical, readiness recomputes, affected attempts require revalidation. Stale submission/merge is refused, not silently accepted under the new basis. (R03, R10, R11) |
| H19 | Authorized role investigates and unlocks, or attempts transfer to an unacknowledged target. | Unlock requires reason and shows subtree/attempt impact; obsolete grants are fenced. Transfer cannot fabricate consent; retain or explicitly revoke instead. Unprivileged unlock is refused. (R08, R09) |
| H20 | Lane C result has green MR but review from the same agent or same model. | Evaluation refuses missing independent-agent/different-model obligation; after valid evidence an authorized agent may merge without human merge approval. (R10) |
| H21 | Lane B satisfies C's evidence but has no human merge approval. | Merge is refused; authorized human approval is recorded against the actual basis before merge eligibility changes. (R10) |
| H22 | Lane A lacks human participation or second responsible reviewer; sole developer requests the exception. | Human obligation remains mandatory; second-reviewer exception is accepted only under the explicitly agreed qualification/policy, with reason/history. No generic self-review toggle bypasses obligations. (R10; Q3 qualification open) |
| H23 | Agent proposes a weaker lane; inherited graph criticality requires stronger treatment; person corrects it. | Show proposal, floor, reason and audited correction; no silent floor bypass. Tests for strictest composition and A retaining C evidence are explicitly conditional on Q3 agreement. (R10) |
| H24 | Human and agent add comments/time; correct a 35-minute entry to 30; replay after reconnect. | Same work-key history contains both actors; original plus attributed correction survive; effective total is 30, not 65, and replay produces no duplicate. (R01, R12) |
| H25 | Permission is revoked after preview, or required review evidence is inaccessible/untrusted. | Mutation/evaluation rechecks authority, fails with safe actionable reason and preserves allowed local content. Evidence is inert; no inaccessible title/credential disclosure or false completion. (R10, R12) |
| H26 | Disconnect, create local planning/comment/time records, then reconnect with accepted, rejected and dependency-pending operations. | Local PostgreSQL data survives and pending state is clear; no new shared grant from cached ready. Report each operation's outcome with identity and reason; preserve rejected edits/evidence and unrelated successes. No duplicate children/comment/time after unknown replies. (R01, R02, R12) |
| H27 | Event cursor is behind retained transport history, then old executor replays operations. | UI labels snapshot refresh, replaces coordination view from accepted authority and never revives old grants. Pruning/server cutover does not change accepted operation identity or permissions. (R02, R09) |
| H28 | Preview early `br` import with duplicate key/unmapped field; retry a resolved import and link graph subjects across machines. | Show collision and mapping before apply; preserve original request and import identity; retry does not duplicate records. Shared references use stable keys, never local numeric IDs; import invents no grant/review. (R12) |
| H29 | Browse a 10,000-item fixture during fill, with failed refresh and restricted work. | Pages stay bounded to 100, known snapshot remains labeled stale and restricted labels stay hidden. Concurrent-fill responsiveness is measured by the prototype's agreed target, not asserted by this document. (R12) |
| H30 | Use 360 CSS pixels, 200% zoom and keyboard navigation for intake, tree, preview, lane review and Problems. | No page-wide horizontal overflow, clipped operation labels or drag-only actions; labeled controls, visible focus, approximately 44-pixel targets and linked field-error summary preserve context. Static screenshots alone do not prove implemented interaction. |
| H31 | Base L3 blocker inherits L1 from two blocked items; remove one dependency, then the last, or move the blocked feature. | Effective urgency and its causes recompute consistently; remaining cause is retained; base L3 is never overwritten. Human and ready-agent views agree. (R06, R07) |
| H32 | Submit one child's result under an ancestor reservation, then explicitly release that reservation. | Submission leaves other descendants protected. Release names the entire scope and is independently authorized/recorded; board movement never silently releases it. (R03, R09) |

## Accessibility and review boundary

On desktop use bounded list/tree beside readable detail, not a mandatory graph canvas. On mobile use sequential full-width panels and labeled before/after child cards. Native headings, labels, lists and buttons convey structure; status/error text never depends on color alone. In the eventual implementation focus returns to the invoking row, error summaries link to fields, and updates announce without stealing focus. Keyboard alternatives cover reparent, reorder and board moves.

The static mockup keeps local section links and disclosures functional but all business controls disabled, with no scripts or external assets. Visual/browser checks belong to parent validation and cannot establish semantic correctness. Q1 manifest/table agreement, Q2 overlap/delegation refinement, Q3 lane composition/exception qualification and Q4 arbitration/retention/authentication proof remain review decisions in the shared contract. This document does not independently settle them.
