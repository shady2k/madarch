# Correct cutover fixture contracts

Change: cutover-fix-B
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: cutover-fix-B
Kind: no-behavior

## Intent
Align six fixtures with decision 0039 items 2, 13, 24, 25 and 31. Keep immediate operations, producer outcomes, parent-edge identity and immutable evidence visible to assertions.

## Rationale
Only fixture wiring and expectations change. Production contracts are unchanged.

## Out of scope
Production assertion storage and completion of the remaining assigned suites. This change is a partial handoff, not stage acceptance.

## Preserved contracts
- fill-orchestrator/publish

## Coverage
- fill-orchestrator/publish: test

## Where it is seen
Kind: internal
Place: test fixtures only; no visible UI change.
Reason: Only test wiring and expected graph contracts change; no production behavior changes.

1. Run the changed test files to verify operation authority, parent-edge identity, outcomes and immutable evidence.

## Blocking questions
None.
