# 0034. People plan and decompose work in the wiki; agents use the same work contract

Status: proposed
Date: 2026-11-04

Proposed amendments to 0022 and 0033, not effective until the owner accepts them.
Companion: [0035](0035-work-reservations-and-operation-sync.md).
Scope and review questions: [tracker concept](../changes/tracker-human-agent-concept/concept.md).

## Context and problem

The owner explicitly requires a human interface for working with tasks and
_decomposition_, plus an agent interface. A chat or a status monitor does not satisfy
the first requirement. The same work must not exist in two independent task catalogs.

Today the product has simple scoped tasks from questions/problems, persisted as
Markdown and shown by the wiki. The repository MCP tools read knowledge; they do not
provide work-item ownership or submission. The engine repository's br tracker is its
development workflow, not the proposed product feature. The detailed inventory and
retirement boundaries are in the [design](../changes/tracker-human-agent-concept/design.md).

0022 puts external execution behind a replaceable agent API. 0033 point 28 says all
wiki edits go through an agent. Direct structured planning would contradict that
wording; this proposal makes the exception explicit instead of adding a hidden path.
0033's internal graph-verification reservations are advisory and its worker leases
expire. Neither is the exclusive work-item reservation specified by 0035.

## Decision drivers

- A person can create an outcome, decompose it, authorize work and judge results without
  chat, a CLI or hand-editing Git; see human scenarios H01, H03, H08 and H09.
- Both interfaces obey the same readiness, permission, version and ownership checks.
- Product entities keep one identity. A work item links to a requirement or code scope;
  it does not copy the requirement into a second product model.
- A human controls execution approval; agents are already running outside madarch.
- Planning remains usable at the proposed 10,000-item fixture size and on a narrow
  screen; no full graph download or drag-only control is required.

## Considered options

1. **Chat as the only mutation interface.** Preserves 0033 point 28 literally and
   minimizes UI forms. Rejected as the recommendation: structured comparison of
   children, dependencies and criteria becomes a conversation transcript, and a
   person cannot reliably plan without an available agent.
2. **Separate human project manager and agent queue.** Familiar specialized surfaces,
   but two status/ownership authorities and synchronization between copies. Rejected:
   users could approve one scope while the agent executes another.
3. **A shared application service with human and machine adapters** (recommended).
   Human backlog/tree/board/detail/review are views over the same items the versioned
   HTTP/CLI/MCP operations address. Costs one explicit domain contract and real UI work,
   but neither interface can bypass the other's invariants.
4. **Only an external tracker adapter.** Avoids building a tracker; useful for teams
   already using one. Not sufficient for the requested offline ownership and integrated
   decomposition model without proving that external system's guarantees. External
   adapters remain separate future work, not a second authority by default.

## Proposed decision

Choose option 3. Extend the existing product Work/Tasks surface and checked write
boundary; do not introduce an independent application, duplicate entity registry or
agent-only queue of product tasks.

The human UI supports list, tree and board views, detailed criteria/scope, planned
relationships, atomic decomposition preview, responsibility, execution approval,
results and recovery. A drag is a named guarded transition, with keyboard **and**
click/tap alternatives. Agents discover capabilities, read eligible work and context,
propose changes, claim a leaf, report work and submit evidence. Planning and review
permissions are separate from execution, for humans and agents alike.

The [concept's lifecycle](../changes/tracker-human-agent-concept/concept.md#shared-lifecycle)
is normative for this proposal. Ready and blocked are derived. Containers are not
executable, and accepted children never automatically accept a parent. The common
service validates both hierarchy cycles and dependency cycles, including concurrent
changes. Only 0035's authority can grant or revoke execution ownership.

### Proposed amendment to 0033 point 28

Replace its universal prohibition, **for structured work-item data only**, with:

> People may create, edit and decompose work through structured wiki controls or
> through an agent proposal. Both use the same authenticated, version-checked work
> operations. The original command/proposal, its author and its adopted changes are
> auditable. Conversational input is still retained verbatim before interpretation.
> Generated wiki prose and raw graph facts remain unavailable for direct editing;
> corrections to them still follow the established agent-mediated path.

This does not authorize arbitrary mutation from a form. A preview, adoption, execution
approval, claim and acceptance are distinct operations. Selecting a responsible person
neither assigns a live session nor starts a process. Agent proposals can be edited or
rejected by a person and never imply execution approval.

### Proposed clarification of 0022's executor boundary

Madarch owns the product's work definitions, authoritative work lifecycle and
reservations. External executors own their process queues and run mechanics. A run ID
is evidence linked to an attempt, not a second task status authority. Lifemodel is a
possible client of the published contract; it is not required for either interface.
MCP exposes tool operations. A2A, if later chosen for delegation, maps to this same
contract and does not invent another lifecycle.

## Consequences

- Two first-class surfaces require acceptance of the complete human-agent-human
  scenario, not independent screenshots and mock API responses.
- Structured planning differs from agent-mediated knowledge editing; navigation and
  help must say what can be edited and why.
- The old simple-task UI and endpoints must move to the shared service in the same
  cutover that makes the replacement authoritative. No dual writer is retained.
- Tree restructuring can invalidate running work. Preview and explicit recovery cost
  more interaction than silently changing a parent or status, but preserve intent.
- Full tracker execution remains outside the fill orchestrator; this does not weaken
  the single storage-owner boundary or add another graph writer.

## Validation and revisit

Walk human H01-H16 and the agent conformance cases against the same fixture and
principal permissions, then perform the end-to-end checkpoint in the development
plan. The HTML mockup proves only layout, not those behaviors.

Revisit if users cannot perform decomposition without chat, if an external tracker
becomes the chosen lifecycle authority, or if a client needs a mutation outside the
shared contract. A request for a second writer is a design change, not an adapter fix.

## Sources

- [Owner's tracker discussion, 2026-10-13](../vision/tracker-discussion-2026-10-13.md),
  especially human visibility, existing entities and the no-executor boundary.
- [0022](0022-architecture-extension-points.md), [0029](0029-knowledge-in-markdown-graph-as-index.md),
  [0033](0033-one-workflow-by-entity-kinds.md).
- [W3C WCAG 2.2, Understanding Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html):
  a keyboard alternative alone is not the required non-drag pointer alternative.
