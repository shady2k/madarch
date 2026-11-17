# Atomic graph storage cutover

Change: madarch-64o5.74
Base: 46de49f39b3a622a92dcf2f8cd3e0a357338821b
Tasks: madarch-64o5.74, madarch-64o5.141
Kind: behavior

## Intent
Replace the old graph storage and every dependent reader in one atomic cutover against origin/foundation/madarch-64o5.141. The base supplies reusable value types, the catalogue changes and additive assertion prerequisites. Decision 0039 governs references as edges, parent-edge identity, typed per-source assertions, lineage, valid and recorded time, and value-pinned disputes and resolutions. There is no supported intermediate storage shape, retired API alias or wide-row read projection.

This change is work in progress and unaccepted. The working tree contains the whole cutover; neither this record nor earlier targeted checks establish final acceptance. The proposed graph-storage capability specifies endpoint checks, item-25 assertion selection, writer-owned judgements and the two-query page budget. Whole-cutover acceptance still includes the remaining surface below.

## Out of scope
- Migration of existing product data: current products are refilled after the cutover, rather than migrated from retired storage.
- Cross-server federation transport, onboarding and completeness scoring.
- Exhaustive graph filling, a real agent run or a production fill as part of preparing this record.

References, parent keys, assertion storage, source grants, immediate-operation receipts and fencing, disputes, mentions, catalogue relations and replacement readers are not deferred out of this atomic change.

## Preserved contracts
None.

## Coverage
- graph-storage/edge-endpoints: test, mutation
- graph-storage/assertion-selection: static, test, mutation, review
- graph-storage/writer-judgements: static, test, mutation, review
- graph-storage/page-query-budget: static, test, mutation, review

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
- SQL admission and deferred constraints select existence directly from typed assertions under item 25, including recursive parent cutoffs. There is no dispute-selection projection or refresh API. Scalar false values and missing required relations are enforced by final constraints, not only hidden by a reader.
- The catalogue and shipped producers publish relations as edges; replacement readers traverse those edges. Mentions use the declared token grammar and assertion-owned occurrences; plain names return hints, not guessed edges.
- The root lockfile's 591 resolved dependency URLs were normalized to the public registry under the owner's 2026-11-16 rule. This does not authorize dependency-version changes or private registry references.
- Test bounds are not raised to make this cutover pass. The new bounded 100-entry metadata regression must demonstrate that metadata queries remain bounded rather than conceal work behind a larger timeout.

## Acceptance evidence
This existing coverage entry is narrower than the whole cutover. Complete capability requirements and their coverage, current-revision checks and stage acceptance remain owed; the entry must not be read as coverage of all decision 0039 requirements.

### Current status: unaccepted work in progress
The atomic cutover is preserved in normal hooked local checkpoint commits, beginning with merge checkpoint a699a96a against f438fd54. No reset, discarded recovery stash, hook bypass, task closure or acceptance approval is claimed.

Current integration evidence (2026-11-16):
- Root `bun run check` run 34 passed: TypeScript, architecture 874/874, UI 0, catalogue 501 kinds/117 page-or-member kinds, four workflows and zero quarantined cases. The required-base architecture comparison has 1,241 entries; the current baseline gains zero entries.
- All 312 original root test files were attempted serially in fresh `bun --smol test <file>` processes: 215 files exited zero, 97 exited nonzero, including four processes killed with exit 137. The logs report 2,144 passing and 313 failing cases; timeout and cleanup cascades mean those are not counts of independent defects. This pass spans checkpoint changes and is not a passing suite of the final revision. The preceding single-process whole-suite attempt was killed by earlyoom and is incomplete.
- Current focused disputes, immutable scalar keys and public resolution coverage passed 9 tests and 106 assertions. Late-write forced constraints and savepoint rollback remain covered. Architecture gates passed 38 tests; strict record selectors passed six tests; subject/source/author/operation lineage passed three tests.
- The wiki app's full native suite passed 124 tests with 587 assertions; its check and build passed. These do not establish root-suite acceptance.
- The path registry now accepts valid POSIX whitespace while rejecting NUL, empty and non-string values; its native regression passed. Original relation, disk and fill time limits were not raised.

Known blockers remain:
- The original two-pass Git-fill case still times out at 120 seconds. A persisted first-fill trace recorded about 79,000 SQL statements; repeated metadata selection and forced constraints dominate aggregate span time. Batching preserves sequence allocation and rollback in two focused passing tests but has not solved this bound. Many full-catalogue fills also fail with stale queue attempts or excessive memory.
- A faithful schema-reader fixture now fails explicitly because forced migration blocks on the reader-held typed key table. It no longer hangs while waiting for a removed dictionary table.
- Canonical typed reader pagination does not meet its unchanged two/one-query budgets. Evidence fixtures, public identity/naming paths, internal lineage visibility, cancellation journaling and remaining failed integration fixtures still require work. No alternate resolver, hidden pre-query work, retired table or weaker assertion was introduced to make them pass.
- Consistency atomic/hook limits, a clean final-revision root suite, current-source mutation coverage, whole-cutover capability coverage, independent review and stage acceptance remain owed. Historical mutation survivors and unrun scopes remain gaps, not acceptance evidence.

Detailed per-file results, focused reruns, diagnostic reports, patch application proof and the exact delivered revision are retained with the patch series in `/tmp/madarch-64o5.74-patch-series`. The tracker-free document check still reports missing task/approval records; none is fabricated.

### Historical endpoint increment only
The following results belong to the earlier endpoint-only increment, not the present whole cutover or its current revision:
- Bun 1.4.2; PostgreSQL suites ran as an ordinary non-root account.
- bun run check passed with 1,229 then-listed architecture findings and no added debt.
- bun test test/graph-edge-endpoints.test.ts test/graph-write.test.ts test/plugin-agent-reference.test.ts reported 44 passed, zero failed and 202 assertions.
- wiki/app frozen install, check and tests reported 129 passed tests, zero failures and 622 assertions.
- Four bounded manual mutations disabled the declared-kind, uid-kind, context and removed-end guards individually; each failed the endpoint suite and was restored.

These historical results must not be reused as current acceptance receipts. Full backend suites, full-cutover mutation evidence and final stage acceptance were not established by that endpoint increment.


### ALX-39 binding amendment follow-up (2026-11-16)

Implementation base: `b067470173d85f56f0e2b6a2f3a78524865ae822`. The main-line Base header names the revision on the target history for the document gate; it is not the implementation diff base.

Resolutions are ordinary typed assertions from a stable source per principal, separate from ordinary edits. Writer reconciliation appends retractions and question-state assertions. Invalid or revoked justification closes the whole resolution scope. Merely stale evidence leaves the resolution active and appends a problem linked to its explanation. No judgement table, stored selection pointer or answer cache is permitted. Evidence display does not decide whether a resolution stands.

Read selection uses recursive context cutoffs, the nearest layer, per-stream newest recorded assertion and newest valid start/sequence in SQL. Equal observations retain their assertion header and append operation, unit and evidence lineage. Pinned children retain their snapshot; unpinned children follow parent writes and reconcile their persisted question state when affected.

Final ALX-39 implementation and validation are reported in `/work/reports/ALX-39.md` and its bundle hand-in; acceptance remains the coordinator’s stage decision. This record does not close the parent atomic cutover task or claim acceptance of unrelated integration failures.


### ALX-104 lineage test correction (2026-11-17)

Decision 0039 items 25–26 and amendment item 2 require one operation per
stating pass, not exactly one operation for an assertion's lifetime. Only the
record test changes. Its independent tree/history fixture states the same
vertices and edges in two explicit passes, compares the complete operation
sets, and reads the creator operation and unit through `loadAssertions`.
Subject, source, author, context and recorded time checks remain required.

Bounded manual mutations removed reuse lineage and reversed scalar lineage
order; each made the rewritten case fail, and both production files were
restored. The final focused case passes (1 test, 102 assertions); static checks
pass. The full touched file still fails at the unchanged 120-second two-fill
budget and other cases; the broader `0039.25` filter includes an unrelated
language-history failure. No deadline or production implementation changes.
Exact commands and counts are in the ALX-104 hand-in report. No stage
acceptance or tracker receipt is claimed.
