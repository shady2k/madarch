# Avoid graph capability setup for plain SQL history fixtures

Change: ALX-33
Base: 58c4b67e2a0511c344bd0a02a34571e8ded7bafc
Tasks: madarch-64o5.74
Kind: no-behavior

## Intent
Keep plain SQL temporal history fixtures off the graph capability setup path. Both branches of createTestHistory explicitly disable fixture authentication. Direct createTestDatabaseOwner callers retain their existing authenticated writes.

## Out of scope
- Product code, graph contracts and the one writer.
- Changing test workloads or deadlines.
- Caching graph identities across transactions.

## Rationale
Only test fixtures change. Plain SQL history does not call the graph writer; direct graph fixture owners retain their current capability binding.

## Preserved contracts
- model-history/store-version: SQL history retains the same store and read operations.
- model-history/lossless: temporal history reads remain unchanged.

## Coverage
- model-history/store-version: test
- model-history/lossless: test

## Where it is seen

Kind: internal
Place: test/test-database.ts
Reason: test fixture cost changes, not product behaviour.

1. Run test/history-change-report.test.ts alone with its original 60 second bound.
2. Run the helper callers alone, preserving graph writer authentication coverage.

## Blocking questions
None.

## Design and decisions
Decision 0039 item 26 requires capability binding for graph writes, not unrelated SQL temporal history. Reuse the existing authenticated option; do not change its default or skip binding for graph fixtures.
