# Reversible same-kind duplicate resolution

Change: madarch-64o5.143
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.143
Kind: behavior

## Intent
Implement decision 0039 items 20 and 32 through graph-native merge records, immutable original subjects and endpoints, declared candidate signals, host-issued resolver authority, human questions and explicit post-merge assertion allocation.

## Out of scope
No real agent runs, new storage tables, product-specific kind names or screen changes. This is an incomplete foundation hand-in, not an acceptance claim. Automatic human-question closure, exhaustive temporal allocation validation and full GraphQL acceptance remain pending.

## Changes to requirements
- graph-queries/duplicate-resolution: same-kind duplicate candidates and reversible membership.

## Preserved contracts
- graph-queries/as-of: immutable assertion timestamps and pinned context ancestry remain in storage.

## Coverage
- graph-queries/as-of: static, test
- graph-queries/duplicate-resolution: static, test, mutation, review

## Where it is seen
Kind: internal
Place: host-authorized manual operation handler and graph read projections
Reason: no screen or external agent tool is added.

1. A host-issued merge grant submits a checked pair through the operation handler.
2. Uncertain or name-only pairs create system.merge-question vertices.
3. A sure pair with shared declared relation signals retains both original identities and redirects current non-key memberships.
4. Unmerge restores original memberships; survivor-only later assertions require explicit allocation.

## Design and decisions
Implementation base: foundation/cutover-snapshot at d9a0d32904ec6d033177de9f53f3af9ee66f9788. The document baseline is the shared main-line ancestor, not the cutover snapshot.

Schema revision changes from 9 to 10. SQL projection functions read system.merge records; there is no merge table. Required relations validate projected endpoints and retain key-edge endpoints. Survivorship prefers nonempty natural keys, then creation order; imported/canonical priority is not yet a separately declared policy. Signals use NFC/case-insensitive names and synonyms and shared declared relation endpoints, with a score equal to the number of observations. No score is treated as confidence. The manifest declares duplicate-subject-edge; semantic term kinds require that boundary before candidates can be returned. Callers cannot override it.

The graph assertion stream distinguishes original members, including when the same source asserted both before merge. Losing names are written as synonym assertions. Alias-addressed later vertex edits keep their immutable subject. Survivor-only later vertex and edge edits block unmerge and can be explicitly allocated to original members; edge allocations name the endpoint direction. Relation conflicts currently refuse atomically rather than opening an allocation question. Active merge links form equivalence components; undo removes one link, not the other links in the component.

## Acceptance evidence
- Root bun run check passed: 874 baseline architecture findings, zero new; UI architecture zero; catalog and workflow checks passed.
- Original foundation suite: four store-backed cases, 25 expectations, covering candidate signals, authority, uncertain/name-only escalation, cross-kind refusal, cardinality rollback, synonym retention, immutable assertion memberships, unmerge, explicit allocations and later alias edits.
- Related disputes: seven passed. GraphQL writes: 23 passed. Relation properties: timed out at 20 seconds both here and on the unmodified cutover base.
- GraphQL executor: 39 passed, five failed and two asynchronous errors. The undeclared-kind label failure reproduces on the unmodified base; other large-fixture failures and timings are not accepted as green. A filtered base run of inverse key reference passed; the full changed suite returned 53 versus 3 after the earlier fifty-record fixture, so full base comparison is still owed.
- Wiki app frozen install, check and tests passed: 124 cases, 587 expectations.
- Bounded manual mutation sample: disabling uncertainty escalation was killed by the same-kind test; disabling allocation blocking was killed by the later-survivor-edit test. Both changes restored. Full Stryker was not run.
- Independent review not run. No task closure or acceptance requested.


**Acceptance evidence (follow-up, 2026-11-16)**
- Added store-backed cases for chained equivalence sets, directional edge allocation, compulsory subject-field boundaries, recorded snapshots, inherited allocations, dispute membership and future edits. The final handoff report records the latest run, including any failure.
- Root check passed after follow-up: 874 existing architecture findings, zero new.
- Independent source review found and prompted fixes to dispute subject filtering, allocation candidate context/direction filtering, inherited edit fences and chained survivor attribution. Review report: /tmp/madarch-143-merge-review.md. This is not acceptance approval.
- Full cutover-base executor comparison: 39 passed, five failed and two errors. Changed full run: 41 passed, five failed and three errors before focused reruns. The diagram write exceeds 60 seconds in both and queues later database operations. Do not describe either full run as green.
- Follow-up manual mutants disabling name-only escalation and edge-allocation blocking were killed; both restored. Full Stryker remains unperformed.


**Final local handoff checks**
- Merge suite: 10 passed, 51 expectations. An added chained prior-allocation regression passed separately (one case, four expectations); it was added after that full merge run.
- Graph disputes: seven passed alongside the previous nine-case merge suite (16 passed, 111 expectations). Standalone dispute-resolution suite also passed.
- Executor diagnostic subset excluding the explicitly named preexisting large diagram: 44 passed, one filtered, 588 expectations. This does not replace the failing full-suite result above. Alias lookup mutation killed and restored.
- Independent review follow-up found no remaining concrete defect in its bounded source review after fixes. It did not execute tests. Chained allocation regression was then added and passed.
- No performance bound or sample size was reduced. Schema revision remains 10 (from 9). Term subject boundary is a manifest declaration, not a hardcoded product kind. The undeclared-kind label expectation assumes the existing uid fallback contract.
- Human-question closure and exhaustive temporal/context and full mutation acceptance remain outside this handoff. No acceptance, push or task closure is claimed.
