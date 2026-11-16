# Atomic graph storage cutover

Change: madarch-64o5.74
Base: f438fd54a15b664d97e502f8de50e6118a7fcf9b
Tasks: madarch-64o5.74, madarch-64o5.141
Kind: behavior

## Intent
Replace the old graph storage and every dependent reader in one atomic cutover against origin/foundation/madarch-64o5.141. The base supplies reusable value types, the catalogue changes and additive assertion prerequisites. Decision 0039 governs references as edges, parent-edge identity, typed per-source assertions, lineage, valid and recorded time, and value-pinned disputes and resolutions. There is no supported intermediate storage shape, retired API alias or wide-row read projection.

This change is work in progress and unaccepted. The working tree contains the whole cutover; neither this record nor earlier targeted checks establish final acceptance. The proposed graph-storage capability file currently describes endpoint checks only and does not yet specify the whole acceptance surface below.

## Out of scope
- Migration of existing product data: current products are refilled after the cutover, rather than migrated from retired storage.
- Cross-server federation transport, onboarding and completeness scoring.
- Exhaustive graph filling, a real agent run or a production fill as part of preparing this record.

References, parent keys, assertion storage, source grants, immediate-operation receipts and fencing, disputes, mentions, catalogue relations and replacement readers are not deferred out of this atomic change.

## Preserved contracts
None.

## Coverage
- graph-storage/edge-endpoints: test, mutation

## Where it is seen
Kind: request
Place: The graph API and MCP read/write commands, and the wiki pages that read the same graph.
- Write a declared entity with its required parent edges, typed values and evidence through an authenticated producer.
- Observe immediate accepted facts with assertion source, author, operation, valid and recorded time, and evidence; malformed input or an unauthorised grant is refused atomically.
- Read the entity and its relations, filters, ordering and counts through the same effective assertion selection.
- Compare disagreeing source values, resolve a question, then repeat an observation or change its value or justification and inspect whether the resolution still applies.
- Write explicit mention tokens or plain entity names and inspect checked backlinks or non-binding candidate hints.

## Blocking questions
None.

## Design and decisions
The remaining issues are implementation and validation blockers under the recorded design, not unresolved owner choices.

- References are declared graph edges. Required parent edges and the entity's own typed scalar keys determine identity; parent deletion policy and final effective cardinality are checked as one operation.
- Every writer door requires a real opaque, host-issued ProducerBinding, not structural WriteSource principal metadata or a serialized copy. Its retained principal, source, product, context, contract, action and graph scope constrain admission. Descriptive producer scope is separate from the permission scope; activation must not silently widen either.
- Scalar keys are typed assertions with ordinary source, author, evidence, operation and mention ownership. Immutable identity requires those values to agree with the canonical birth tuple; a changed key creates a new identity. node.key is not a fallback source of facts. Any identity lookup projection must be checked and rebuildable from statements.
- Assertions retain typed values, source streams, valid intervals, recorded sequence and context-parent cutoffs. Readers select the same current values and relations; disagreement does not by itself replace the displayed value with null. Semantic resolution pins survive repeated equal observations but not changed values, scope or invalid justification.
- SQL admission and deferred constraints use the canonical selected-existence projection, carried in a transaction-local PostgreSQL setting (GUC). Its transaction identity, graph revision, temporal selectors and context coverage must match; it is a rebuildable projection, not a second durable fact store or a stale-cache fallback. Scalar false values and missing required relations must be enforced by final constraints, not only hidden by a reader.
- The catalogue and shipped producers publish relations as edges; replacement readers traverse those edges. Mentions use the declared token grammar and assertion-owned occurrences; plain names return hints, not guessed edges.
- The root lockfile's 591 resolved dependency URLs were normalized to the public registry under the owner's 2026-11-16 rule. This does not authorize dependency-version changes or private registry references.
- Test bounds are not raised to make this cutover pass. The new bounded 100-entry metadata regression must demonstrate that metadata queries remain bounded rather than conceal work behind a larger timeout.

## Acceptance evidence
This existing coverage entry is narrower than the whole cutover. Complete capability requirements and their coverage, current-revision checks and stage acceptance remain owed; the entry must not be read as coverage of all decision 0039 requirements.

### Current status: unaccepted work in progress
No final green backend, architecture, wiki, mutation or whole-stage acceptance is claimed. Concurrent implementation reports and older targeted results do not establish the current working tree's result. The coordinator must validate the final integrated tree serially and retain every failure and limitation.

Verified intermediate recovery milestones reported by the coordinator:
- A normal hooked local WIP checkpoint commit succeeded: a699a96a. The privacy hook is no longer blocking this checkpoint; no hook bypass occurred. This is a recovery checkpoint, not an accepted cutover or stage closure.
- Root static and architecture check run 24 passed with 874 of 874 findings matched and zero gained findings against the 1,241-entry baseline comparison.
- Resolved-false public/core coverage passed 8 tests with 91 assertions, including restart, person, plugin, session and standalone fill paths. The bounded metadata regression passed 30 of 30 checks. These are targeted results, not full-suite evidence; no test timeout was increased.
- The actual first fill completed within its unchanged 120-second bound, at about 79 seconds, but failed: git output classified an ensure-only vertex as a removal. The implementation fix is in progress; this run is not a passing fill.

At this update, the following checks remain pending:
- The git-output correction and a passing actual first fill under the original bound.
- Complete integrated validation of typed scalar keys without node.key fact fallback; grants and permission scope at all writer doors; context and language selection; disputes, evidence invalidation, mentions and all effective readers.
- Whole-cutover capability specifications and coverage, the full backend suite, final integrated wiki validation, relevant bounded mutation checks, independent review and stage acceptance. Targeted intermediate results do not replace these obligations.

The coordinator retains the checkpoint and refreshes the patch series against f438fd54. This document update creates no commit and changes no source or test file. No task is closed or labelled accepted by this record.

### Historical endpoint increment only
The following results belong to the earlier endpoint-only increment, not the present whole cutover or its current revision:
- Bun 1.4.2; PostgreSQL suites ran as an ordinary non-root account.
- bun run check passed with 1,229 then-listed architecture findings and no added debt.
- bun test test/graph-edge-endpoints.test.ts test/graph-write.test.ts test/plugin-agent-reference.test.ts reported 44 passed, zero failed and 202 assertions.
- wiki/app frozen install, check and tests reported 129 passed tests, zero failures and 622 assertions.
- Four bounded manual mutations disabled the declared-kind, uid-kind, context and removed-end guards individually; each failed the endpoint suite and was restored.

These historical results must not be reused as current acceptance receipts. Full backend suites, full-cutover mutation evidence and final stage acceptance were not established by that endpoint increment.
