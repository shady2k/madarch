# Validate declared field types at the graph writer

Change: madarch-64o5.139
Base: 46459a319240b88b5a218c07ee0646ba0ef28856
Tasks: madarch-64o5.139
Kind: behavior

## Intent
Decision 0039 items 3 and 7 require the agent answer to meet the same declared
field types as other producers. The writer now checks all vertex and edge
attribute values before the first publication mutation. The MCP draft builder
shares the type predicate. A wrong type or undeclared field returns the item 30
SCHEMA_INVALID refusal body with a JSON Pointer, expected type, actual value and
retryable: false. This is partial work, not completion of items 7 or 30.

The predicate checks PostgreSQL integer ranges, nullable fields, reference
objects and JSON values. Manifest encoding drops absent optional object members
and encodes absent map values as null, rather than passing undefined to JSON
storage. The schema reconciliation fixture now uses a typed reference, not a
scalar pretending to be a reference. No new storage table is introduced.

## Out of scope
Catalogue-generated input schemas at all MCP/API doors; closed read selectors;
uniform errors and locale rendering; graph-dependent source, evidence, target
and cardinality checks; assertion storage; immediate writes without unit drafts;
mandatory JSON Schema and reusable catalogue value types. These remain required
by the full task and depend in part on the new catalogue/assertion contracts.
This branch is not ready for task closure.

## Changes to requirements
- graph-writer/field-types: add writer-boundary type validation for vertex and edge attributes.

## Preserved contracts
None.

## Coverage
- graph-writer/field-types: static, test, mutation, review

## Where it is seen
Kind: internal
Place: the graph writer called by a scripted agent answer
Reason: this increment closes a writer bypass; it changes no screen.

1. Publish a scripted agent vertex with a number in a text field.
2. Receive SCHEMA_INVALID with /values/title and the offending value before SQL.
3. Publish a batch with a valid first and invalid second vertex; neither reaches SQL.

## Blocking questions
None.

## Design and decisions
The base still has old opinion storage and reference representation. The full
task remains unfinished; these are limitations of this increment, not an
approval request to retain the old design.

## Acceptance evidence
- Root bun run check: passed; architecture debt shrank from 1229 to 1228 entries.
- Writer, generated-write and new validation suites: 83 passed, 0 failed.
- Related authored, producer and agent-boundary suites: 36 passed, 4 skipped,
  0 failed. No real agent was started.
- Wiki app check and tests: passed; 129 passed, 0 failed across 24 files.
- Bounded manual mutation: disabling the field type rejection killed four
  writer-boundary cases. Restored immediately; not a full Stryker run.
- No screen changes; no mockups.
