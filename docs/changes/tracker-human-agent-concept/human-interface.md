# Human work interface — concept for review

## Status and boundary

The owner requires **two first-class surfaces: a human interface for working with and decomposing tasks, and an agent interface**. Neither is a substitute for the other. The human must be able to plan, structure, authorize and review work without a chat conversation, a terminal or manually editing repository files.

Everything below is a **proposed mechanism**, not accepted architecture or an implemented feature. This documentation does not activate the tracker milestone or approve implementation. The companion [agent interface](agent-interface.md) describes access to the same work items, not a second queue. [mockup.html](mockup.html) is a self-contained static composition using fictional Atlas product data; it makes no API calls, changes no state and proves no behavioral or performance claim.

The proposed structured editor is an explicit, narrow exception to [ADR0033, decision 28](../../decisions/0033-one-workflow-by-entity-kinds.md). It edits authored work definitions and invokes authorized work operations through the shared service. It **does not edit generated wiki prose or graph facts**. Those remain read-only with source links and the existing correction/intent path. An authored task description is not a generated wiki page. A scope reference to a generated statement selects an affected subject; it does not grant permission to rewrite the statement. ADR0033's amendment must be accepted before implementing this exception.

## Existing surface and proposed continuity

Observed in the current source:

- `wiki/app/src/knowledge/loop.tsx` has `TasksPage`, `TaskPage`, `ProposeTaskForm` and `TaskBody`: a product task list/detail, answer-derived proposals, editable titles and scopes, impact preview, confirmation, task-limited page refresh and manual closure. It already distinguishes loading, missing data and refused writes. Reuse the list/detail, named scope links, preview-before-confirm and visible failure patterns.
- `src/loop/tasks.ts` stores scoped tasks in `docs/tasks`, with `open | closed`, question/answer grounds and typed section, line, file, symbol and statement scopes. This is not the proposed lifecycle, reservation or decomposition model.
- `src/loop/task-run.ts` plans a refresh over the generated pages reached by a task's grounds. It is not a development executor or a general work-item scheduler.

The proposal extends the human task surface to planning and review rather than adding an unrelated tracker application. Existing generated-page refresh actions must remain distinguishable from authorizing external development work. Migration and removal of obsolete task contracts belong to the parent design; this concept does not silently reinterpret today's `closed` as evidence-backed `accepted`.

## One work set, three views

The wiki gains a product-level **Work** destination. A persistent header shows product, search, active filters, view, connection state and snapshot freshness. The same stable IDs, query, permissions and selected task survive a view switch. Selecting a task opens its permalink and detail; browser Back restores the list position and filter state. Filter chips state their effect, including hidden cancelled work and hidden completed work.

| View | Human purpose | Proposed behavior |
| --- | --- | --- |
| Backlog | Triage and order work | Bounded list with title/ID, type, priority, responsible person, lifecycle, readiness reason, parent and milestone. Sort by priority or explicit list choice; bulk edits preview individual affected items and do not silently skip failures. Create is available even when the list is empty. |
| Tree | Decompose and understand scope | Expandable hierarchy, children counts and parent breadcrumbs. Show filtered-out ancestors as labeled context, not matching results. Dependencies appear as named links, not falsely as containment. Expansion loads bounded child pages; a visible “Load more” is not a claim that the branch is complete. |
| Board | Follow delivery and review | Columns are `draft`, `open`, `in_progress`, `submitted`, `accepted`, with a separately accessible cancelled view. `blocked` and `ready` are badges/filters, never extra lifecycle columns. Containers are clearly marked non-executable. Counts state whether they refer to the loaded page or all matching accessible items. |

Board movement is a **request for a named transition**, never a direct status-field write. Moving a submitted card to accepted opens review; moving an accepted card back to open requires reopen authority and a reason. Unsupported transitions are unavailable with an explanation. Every drag action has the same keyboard-accessible action menu and confirmation flow. A dropped card stays at its authoritative position until the operation succeeds.

Proposed review target: 10,000 product work items, pages of at most 100. This is a future fixture size, not a measured capacity. No view assumes the entire product or dependency graph is in the browser. Search and counts must remain permission-scoped.

## Task detail and authorship

Detail has a stable identity/title header and four named sections, reachable by anchors on narrow screens:

1. **Definition:** type, description/outcome, parent, priority, milestone/release, estimate, responsible person, included/excluded scope, criterion IDs and linked entities with source revisions. The active adopted Git revision and any pending proposal are shown separately. A draft may be incomplete; each missing readiness field is listed.
2. **Work structure:** children, gating prerequisites, reverse dependants, scope overlaps and criterion coverage. Parentage explains decomposition; a prerequisite explicitly gates readiness. Neither is inferred from the other. Dependencies are satisfied only by accepted work, not submitted or cancelled work.
3. **Execution and evidence:** lifecycle, readiness reasons, execution approval, actual executing principal/session, reservation generation, attempt, last-seen timestamp, submitted evidence and recorded time. Technical identifiers can be disclosed without dominating the primary title. Last seen is an observation, not “running” or an expiry countdown.
4. **History and decisions:** authored proposal diffs, adoption, progress, submissions, acceptance/return/reopen decisions, transfer reasons and sync outcomes, with actor, time and revision. Preserve previous acceptances after reopen. Distinguish reported evidence from checks independently observed by the reviewer.

**Responsible person** is the human accountable for the outcome. **Executor** is the authenticated human or agent principal/session holding the current reservation. Changing responsibility does not claim, release or transfer execution. “Approve execution” authorizes work but does not launch an agent. “Claim for myself” uses the same reservation rules as an agent. No model picker, agent launcher, process monitor or executor fleet is introduced.

A ready badge requires an open executable leaf, an active definition, complete criteria and scope, accepted prerequisites, no current reservation and execution approval. In the first release a person supplies that approval. The detail explains every failed condition, with an action only when the viewer is allowed to resolve it. Containers may be open but never ready for execution. Accepting all children does not automatically accept the container; a reviewer assesses its own outcome and evidence.

## Planning actions, without conversation

| Action | Human input and preview | Adoption/result |
| --- | --- | --- |
| Create | Title, type, outcome, optional parent, responsible person, scope and criteria. Save incomplete work as draft; show exact missing fields instead of inventing defaults. | Stable product-scoped ID and retained shared draft through definition adoption. Supplied fields must be structurally valid; incomplete scope/criteria are allowed only while draft. Opening requires a complete definition and is separately accountable; neither saving nor opening implies execution approval. |
| Edit definition | Structured fields with old/new values, active base revision and actor. Add/remove/reorder individually identified criteria; source-backed scope picker shows both readable names and exact references/revisions. Include explicit exclusions. | Authorized adoption goes through the Git publication and operational activation path. A “saved proposal” is not an active definition. Reopen accepted work before adopting any acceptance-basis change, including new criteria or children; show the previous acceptance as historical. |
| Split into siblings | Select which criterion IDs and scope parts move to each new sibling, identify residual work on the original and preview incoming/outgoing dependency treatment. | Original identity/history remain. Original becomes explicitly defined residual work or is explicitly cancelled with a reason if wholly replaced. Dependants are not silently redirected. Replacement links explain the split; cancellation alone never satisfies a prerequisite. |
| Decompose into children | Add editable child rows with outcomes, criteria, scopes, responsible people and explicit dependencies. Map each parent criterion to child evidence or parent-level review. Mark newly needed scope or overlap for deliberate review. | Parent keeps its identity and becomes a non-executable container; all child definitions and affected relationships are adopted together or none are. Children are not claimed or approved implicitly. |
| Reparent | Search for an allowed destination by ID/title; inspect old/new ancestry and affected context, scope/criteria coverage and dependencies. | Reject self/descendant parents. Preserve stable IDs, evidence and explicit dependencies. Do not silently inherit a different scope, responsible person or approval. |
| Add/remove prerequisite | Select gating item, explain direction as “this work waits for …”, inspect reverse impact. Distinguish a non-gating reference. | Reject cycles. Permission-sensitive relationships show an authorized explanation without leaking inaccessible item titles. Removing a gate is a definition change, not a shortcut past review. |
| Replan active work | Review current executor, reservation and attempt, affected basis and dependent work; enter a reason. | A proposed change does not overwrite active scope. Authorized adoption invalidates the old basis. The executor must explicitly acknowledge/revalidate for a new attempt; no stale result becomes current by accident. |

The scope picker must not widen a line/section/symbol reference into a whole file because resolution fails. Show unresolved references, old and current source revisions and a repair choice. Criterion coverage helps a person judge completeness; a count of mapped criteria does not prove that a decomposition preserves meaning. Split/decompose on reserved work first requires an explicit authorized replan/ownership resolution; no planner silently turns a running leaf into a container.

### Decomposition preview is a reviewable operation

The editor is a structured table/form, usable entirely by keyboard; an optional agent proposal can populate it but is never required. The preview includes:

- Before/after hierarchy; new stable IDs; added, changed, cancelled and unchanged items.
- Each child's scope and criterion IDs, the parent coverage map, residual parent review and explicit scope overlaps/exclusions.
- Added/removed prerequisites and affected dependants, current ownership, lifecycle and readiness impact.
- Base definition/state revisions for every affected item, proposal author, any edited agent attribution and permission/refusal reasons.
- A named confirmation such as **Adopt decomposition · 2 children**, separate from **Approve execution**.

Any edit invalidates its previous preview. A server-side change to a relevant definition, state or ownership invalidates the preview too. Refreshing the preview preserves the local proposal and shows a three-way comparison (reviewed base, current authority, proposed change); it never silently overwrites another author. The person resolves conflicting fields and confirms a newly validated preview. Cycle and permission checks run at adoption, not just when a picker opens.

“Adopting” stays visibly pending through proposal-commit retention, transactional activation of all affected definitions and publication of the adopted revision on the designated work ref. A durable journal reconciles the Git/store crash windows described in [0035](../../decisions/0035-work-reservations-and-operation-sync.md). The UI never exposes half the child set as active and never offers affected items for claim while publication is pending, even if adoption already committed. Retrying the same uncertain operation looks up its identity rather than creating another set of children. Failed proposals stay inspectable and editable.

## Reviewing proposals and results

The **Review** filter/inbox separates two kinds of decision:

- **Definition/decomposition proposal:** compare with the active definition, inspect grounds and scope impact, edit structured fields or return with a reason using `definition.return`, then adopt a fresh preview. Return records an attributed, version-checked decision on the proposal, not a work-item lifecycle transition; amendments create a new linked proposal. Attribution records the agent's proposal and the person's amendments. Adoption does not execute work, accept an implementation result or edit generated text.
- **Submitted result:** show immutable submission, attempt, pinned definition/source revisions, changed artifacts, criterion-to-evidence mapping, reported checks with outputs/limitations and recorded time. Submission has already ended execution ownership atomically; the executor shown here is the historical submitter, not a current reservation. A reviewer accepts or returns to open with a reason. A missing criterion, stale basis or inaccessible required evidence prevents a misleading claim of completion. The acceptance decision identifies the reviewed submission and definition; it is not a generic “done” checkbox.

A reviewer can open linked code or evidence without accepting it. Evidence is untrusted content, rendered inert, with secrets/credentials excluded from submissions. Acceptance authority is separate from authorship and from the responsible-person field. The service evaluates permissions at operation time; the UI cannot grant authority by changing a visible name. The proposed default prohibits self-review; a product may explicitly allow it for a principal that independently holds review permission.

A forced transfer, force-cancel or reopen shows current owner, affected basis/dependants and irreversible history effects, then requires an authorized reason. Reservations do not expire with last-seen age. Reopening accepted work immediately invalidates dependants' readiness; already-running dependants show `basis_changed`, not silent cancellation. Old-generation results remain rejected artifacts available for reconciliation, never replace the current submission and are not eligible for ordinary acceptance without explicit reconciliation onto a valid basis.

Transfer additionally requires the target authenticated session's acknowledgement of the current basis; an administrator cannot fabricate that consent. When no target is available, **Revoke reservation** ends the old attempt and returns the item to open so a replacement can claim later. An open container has **Submit for review**, with evidence for its own integration criteria, not an execution claim. Acceptance remains a separate decision; child completion alone triggers neither operation.

## Desktop, mobile and accessibility

On desktop, a bounded work list/tree sits beside a readable detail/editor panel; the review inbox is reachable without losing selection. No infinite graph canvas or mandatory tiny overview is needed. Inline editors expand for scope and criteria rather than compressing their text into narrow cells.

On mobile, the same route presents list, detail and decomposition as sequential full-width panels, with a persistent breadcrumb/back action restoring filters, selection and position. Child rows become labeled cards; preview becomes ordered before/after blocks. Board columns stack or are selected from a labeled column chooser, never require horizontal drag to reach accepted work. Confirmation names the number of changed items and the operation even when its preview spans several screens.

Use actual headings, labels, lists/tables and buttons; status and errors have text, not color alone. In implementation, expand/collapse and action menus are keyboard operable, focus returns to the invoking row, forms link error summaries to fields and updates announce success/conflict without stealing focus. Reparenting and reordering have explicit “Move to parent / before / after” alternatives. Visible focus, readable text at 200% zoom, no horizontal page overflow at 360 CSS pixels and a roughly 44-pixel touch target are proposed accessibility acceptance targets. Only rendered browser evidence can establish them.

## State and failure vocabulary

| Situation | What the person sees and can do |
| --- | --- |
| Empty product / empty filter | Distinguish “No work yet” with Create from “No matches” with Clear filters. An inaccessible work set is not presented as an empty product. |
| Initial load / later refresh | Skeleton or progress label initially; keep the previous snapshot on refresh with its time. Never replace known work with an empty list on failure. |
| Not ready | All concrete reasons: draft, unpublished definition, missing scope/criteria, prerequisite not accepted, reservation, missing approval or container. “Blocked” is an explanatory badge. |
| Permission denied / revoked | Explain the unavailable operation and permitted next step; preserve the user's unsaved proposal where policy permits. Do not disclose restricted work details. Server rechecks after confirmation. |
| Stale preview / stale result | Display reviewed/current revisions and affected items; preserve the proposed edit or rejected result. Require explicit reconciliation and a new preview, not last-writer-wins. |
| Validation failure | Field-level explanation plus operation-level summary. A cycle, invalid parent or unresolved mandatory scope prevents adoption of the entire decomposition. |
| Retryable outage / unknown outcome | Show operation ID and last known status. Retry only a classified retryable request using the same identity; unknown outcome asks the service for status. No repeated child creation or blanket retries. |
| Offline | Clearly label cached snapshot and time; do not call cached readiness current. Permit local proposals and records only for already-reserved work, not new globally valid claims, transfers, acceptances or readiness assertions. |
| Reconnect | Show per-operation accepted/rejected/pending_dependency results and dependent operation ordering. A decomposition is one atomic operation. Preserve rejected edits and lost-ownership evidence for reconciliation; unrelated successful operations stay successful. |
| Event cursor gap | Show “Refreshing authoritative snapshot”; re-snapshot before displaying current coordination state. Do not infer unseen transitions. |
| Publication pending / failed | Separate locally saved proposal, Git publication and active adopted definition. Retain operation/proposal identity; display recovery status rather than claiming success from a committed file alone. |

## Concrete walkthrough: Atlas export work

All IDs and evidence below are illustrative, not existing repository tasks.

1. In Work / Backlog, Mira creates `AT-40 Reliable export` as a container with a parent outcome, scope and review criteria. In Tree she adds `AT-41 Export contract`, `AT-42 Export implementation` and `AT-43 Validate export`; each has its own definition. AT-42 depends on AT-41, and validation depends on AT-42. The three views show those same IDs.
2. Mira opens AT-43, writes its two criteria (“invalid rows identify the source row” and “large exports retain every row”), excludes format changes from scope and chooses **Decompose**. She adds `AT-44 Invalid-row coverage` and `AT-45 Large-export coverage`, assigning each one criterion and its test scope. Both explicitly depend on AT-42. Parent AT-43 retains an integration review criterion; its existing prerequisite remains visible.
3. The preview shows two proposed children, parent conversion to container, exact coverage, unchanged AT-42 and no execution approvals. A concurrent scope edit would make this preview stale and block adoption. After fresh review, Mira adopts the complete operation; publication status completes before any child appears active. She can do all this without asking an agent to interpret prose.
4. AT-41 is accepted. With a complete definition and Mira's execution approval, AT-42 becomes ready. An already-running external agent claims it through the agent interface. Mira sees herself as responsible and the agent session as executor. She cannot acquire a second reservation, and an old last-seen timestamp never frees it.
5. The agent submits AT-42 with its pinned revisions and evidence; the task becomes submitted and the reservation ends. Mira's Review inbox shows the submission. She inspects the criterion-to-evidence mapping and accepts it, or returns it to open with a reason. The two validation children can become ready only after acceptance, complete definitions and their own execution approval; they still each need a reservation.
6. After both validation children are accepted, AT-43 remains unaccepted. Mira reviews the parent integration criterion and explicitly accepts the container. Its acceptance does not automatically accept AT-40.

The mockup presents the planning preview from steps 2–3 and an explicitly separate result-review item from step 5. It is not a simulation that advances either task.

## Observable acceptance scenarios for future implementation

These are proposed checks, **not checks run for this document**. They also define what a later interactive prototype must not pretend to demonstrate with a screenshot.

| ID | Given / action | Observable result |
| --- | --- | --- |
| H01 | A person with planning authority starts from an empty product, using keyboard only. | Save an incomplete shared draft and see its missing fields; opening it is refused until complete. Create, enter scope/criteria, make two children and inspect preview/adoption are reachable without chat, CLI or file edits; stable IDs appear in all views. |
| H02 | Apply a responsible-person filter and select a task, then switch backlog → tree → board and use Back. | Same query and selected ID survive; ancestor-only rows are labeled; Back restores location. Board counts do not imply unreturned items are loaded. |
| H03 | Propose two children; another person changes the parent's scope before confirmation. | Adoption conflicts, no child becomes active, local proposal survives, and base/current/proposed fields are compared before a new confirmation. |
| H04 | A decomposition has a cycle or one unauthorized relationship. | Whole operation is rejected with a specific authorized explanation; no partial activation. A crash after Git commit shows pending publication, not active children. |
| H05 | Split a task with dependants and reparent another beneath its own descendant. | Split may preserve the original as a residual leaf; preview names residual work and exact dependency treatment. Descendant move is refused; no stable ID/history is lost. |
| H06 | An open leaf lacks approval and its prerequisite is submitted, then that prerequisite is accepted. | Both initial reasons are shown. Acceptance removes only the prerequisite reason; the task remains unready until person approval. |
| H07 | A reserved task has an old last-seen timestamp; change the responsible person and attempt a second claim. | Responsibility changes do not transfer execution; second claim is refused; no timed automatic release occurs. |
| H08 | An agent proposes decomposition; a person returns it with a reason, then amends a linked replacement and adopts it. | Return is retained with actor and proposal revision without changing the work lifecycle. Both authors' provenance and the exact adopted diff remain; no execution starts and generated text stays read-only. |
| H09 | Review a submitted result with criterion evidence. | Acceptance records the selected submission/definition and reviewer; return requires a reason and restores open. Evidence is rendered inert. No current reservation is displayed after submission. |
| H10 | Add a criterion to accepted work, then reopen an accepted prerequisite while a dependant runs; old attempt later submits. | Acceptance-basis editing first requires explicit reopen. Prior acceptance remains historical; readiness is recomputed. Running dependant shows basis_changed; stale mutation is refused and evidence retained separately, not accepted as current. |
| H11 | Adopt a scope change on reserved work. | Current ownership/basis and reason are explicit; a new attempt requires acknowledgement/revalidation. No old scope is silently overwritten. |
| H12 | Disconnect with cached ready tasks and an already-reserved task. | Offline banner/time are visible; no new global claim/accept/transfer works. Local child proposals remain non-executable. Reconnect displays each sync outcome and preserves rejected evidence. |
| H13 | Permission is revoked after preview; a network timeout follows another request. | Revocation refuses adoption without losing allowed local work; timeout uses operation status/idempotency instead of issuing a second logical operation. |
| H14 | All children are accepted; the parent still has an unmet integration criterion. | Parent is not automatically accepted or executable. It remains a separate review decision. |
| H15 | Use a 360-pixel viewport, 200% zoom and keyboard-only navigation. | No page-wide horizontal scrolling, clipped action labels or drag-only operations; focus/error handling preserves context through detail, edit, preview and review. |
| H16 | Browse a 10,000-item fixture with a failed refresh, hidden restricted items and an event gap. | Requests/pages stay bounded to 100; retained snapshot is labeled stale; no restricted labels leak; a gap triggers resnapshot rather than fabricated current state. No speed threshold is claimed here. |

## Review choices and proof boundary

The recommended composition is list/tree plus detail and an explicit atomic preview, with board as another projection. A chat-only surface fails the agreed human planning requirement; a separate human-only task store breaks shared coordination; a graph-only canvas hides form-level scope and review decisions. These are not equivalent alternatives.

PR review should settle the narrow ADR0033 exception, proposed field/permission granularity and the balance between visible detail and progressive disclosure. No such choice is represented here as already approved. The [concept](concept.md) owns the shared lifecycle and the proposed ADRs own authority decisions. The mockup can be opened directly in a browser; only its local section links and disclosures work, and all business controls are deliberately disabled. Browser inspection can establish visual readability, not successful publication, concurrency, accessibility of an implemented editor or running backend behavior.
