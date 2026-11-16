# Plugin-side source reconciliation

Change: madarch-64o5.142
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.142
Kind: behavior

## Intent
Decision 0039 items 18–19: writing plugins reconcile their source with their own graph facts. Item 31: current evidence applicability is checked without rewriting history.

## Out of scope
Reference-field conversion to edges, immutable assertion spans, graph-dependent sets and UI changes.

## Changes to requirements
- The wire protocol is madarch.plugins/3 only; plugin-turns stage version advances from 10 to 11 to invalidate old cached wire behavior. Writing SDK plugins reconcile automatically. Read-only SDK plugins set readOnly and declare readOnly in plugin.json.
- The SDK reads its producer's open facts and emits only add, update and remove writer requests. The result wire carries completion and problems, never mutation lists.
- Partial extraction and extraction problems cannot delete unseen facts.
- The host authorizes the active unit, selected output fields and edges, repository revisions, paths and partitions. Read-only declarations prohibit all mutation requests.
- Starter conformance exercises actual source extraction with added, changed, removed and unchanged facts.
- Current evidence applicability problems are distinct from historical validity.

## Preserved contracts
None.

## Coverage
- reconciliation/deltas: test
- reconciliation/read-only: test
- reconciliation/evidence: test

## Where it is seen
Kind: request
Place: plugin fill and mechanical problems

1. Fill a source after adding, removing and changing an item. Observe exactly the corresponding explicit writes.
2. Fill unchanged source at a new revision. Observe no value rewrite just to refresh evidence.
3. Supply partial source or declare a read-only plugin. Observe no destructive reconciliation.
4. Remove current supporting source. Observe an applicability problem; closed historical opinions remain unchanged.

## Blocking questions
None.

## Design and decisions
Semantic comparison ignores evidence-only changes and top-level absent versus null database values. Nested JSON nulls and array order remain significant. Own-fact reads are reconciliation state, not tracked source dependencies: tracking prior output makes a publication invalidate itself. Source reads remain tracked; unit leasing serializes publication of the same output. Removal evidence names the current source revision; it does not reuse the old commit as proof of absence. Existing graph opinion and journal tables carry writes and withdrawals; there is no new table or runtime data file.

## Acceptance evidence
- `bun run check`: passed with 1,311 existing architecture entries matched and no new entries. UI architecture zero; 498 catalogue kinds; four workflows; no quarantines.
- Final fifteen focused suites: 140 passed, 34 confinement-dependent skips, zero failures, 585 assertions. Includes six real-source starter conformance fixtures, producer isolation/history, writer authorization, fragment completeness and 8 MiB accounting, and current-evidence problems.
- Unconfined fill scenarios: six passed, 56 assertions, including 2,603 fully covered files, independent multi-output branches, undeclared access refusal, and unavailable/old system Git.
- Unconfined output partitions: five passed, 47 assertions, including over-8-MiB total partitioned content without raising unit bounds, failed-partition atomicity, immutable snapshots across an unchanged rerun, empty-plan retraction, and exact-key refusal.
- Wiki app: frozen dependency installation, check and 123 tests passed, 581 assertions.
- Bounded writer transport tests preserve single-value fragmentation and the existing per-unit byte cap. Manual narrow mutation checks killed comparison, removal and partial-guard mutants (3/3), missing evidence-path predicate (1/1), and decoded writer-byte accounting (1/1). This is not a whole-change mutation score.
- Document gate reports only coordinator-owned task tracking and approval findings.
- Default confinement cannot run here without cgroup delegation. The first unconfined attempt stalled on a handshake-rejection bug, now fixed and covered. The rerun integration suites above pass. No full root-suite success is claimed.

See capabilities/reconciliation.md for scope and limitations.

### Foundation integration resolution

This branch is merged onto the decision 0039 typed-assertion snapshot after the generated writer doors. The native immediate writer remains the only writer; incoming legacy publication replay and draft history are not restored. Removal evidence is carried through retractions, cascading removals and edge removal. Own-fact reads admit the authenticated source before temporal selection and reconstruct declared parent-key identities. Reconciliation is bounded by an explicit generic parent identity, rejects foreign desired facts and leaves existing foreign facts untouched. Partial source reads cannot remove unseen facts. Null remains a value, distinct from an omitted field.

Current evidence applicability reads immutable retained targets and declared support roles without rewriting historical citations. The wire and SDK use typed evidence targets. Real source conformance keeps native blob reads and explicit key-edge roles; its fixture uses `code.file-repository` because that is the role declared by those plugin contracts, not the unrelated `repository` role of the separate snapshot-reader fixture. Glossary declarations use their JSON contract as one source and retain usages as well as native usage edges.

Validation on the integration tree: `bun run check` passes, with the same 560 active inherited architecture findings and zero I/O-span findings (`/tmp/integrate-merge3-check5.log`). Seven protocol, access, reconciliation, producer-fact and current-evidence suites pass: 75 tests, zero failures (`/tmp/integrate-merge3-accept-tests.log`), including actual disk, git, imports, database-schema, glossary and quarantine source readers. Reader refusal localization tests pass: 10 tests. Earlier malformed fixtures and schema-render drift were corrected; the final run above supersedes those runs. This is integration validation, not proposal or stage acceptance. The document-gate baseline-history limitation recorded in madarch-64o5.74 still applies.
