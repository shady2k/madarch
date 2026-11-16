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
Graph-dependent source, evidence, target
and cardinality checks; assertion storage; immediate writes without unit drafts;
mandatory JSON Schema and reusable catalogue value types. These remain required
by the full task and depend in part on the new catalogue/assertion contracts.
This branch is not ready for task closure.

## Changes to requirements
- graph-writer/field-types: add writer-boundary type validation for vertex and edge attributes.
- graph-writer/door-contracts: generate closed catalogue requests, reject malformed reads, and format coded schema refusals.

## Preserved contracts
None.

## Coverage
- graph-writer/field-types: static, test, mutation, review
- graph-writer/door-contracts: static, test, mutation, review

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

The follow-up is based on the coordinator's accepted writer increment 823c37ff.
MCP advertises catalogue-generated, closed per-kind value/key contracts and parses
calls with the same Zod declarations. HTTP workflow commands have closed typed
protocol envelopes. Person-authored values use all declared fields, including
natural keys. GraphQL validates declared fields, kind selectors, variables,
cursors and bounds and returns no partial data for a schema refusal.

SCHEMA_INVALID crosses HTTP and MCP with path, expected, actual and retryable
arguments. The wiki formats that refusal in the reader's English or Russian
locale, including GraphQL errors returned with HTTP 400. The expected argument
retains schema vocabulary; this does not translate every legacy domain message.
The fill answer still goes through the central writer preflight and shared fits.

### Named TODOs after assertion storage lands
- GRAPH-DEPENDENT-READ/WRITE-CHECKS: target existence, cardinality, owner/source
  and evidence validity depend on foundation/madarch-64o5.74. No interim checks
  were added for these properties.
- LEGACY-DOMAIN-REFUSALS: non-schema domain/security/content-type/LoopRefusal
  failures retain existing messages and some existing mappings. This increment
  does not claim every old failure has locale-ready arguments.
- SCHEMA-ERROR-PRECISION: static GraphQL failures use /query, variable coercion
  uses /variables; they do not identify every nested argument position.
- CROSS-FIELD-SCHEMA: standard JSON Schema cannot express a file evidence
  lineEnd >= lineStart comparison. Runtime validates it. Generated schemas do
  carry representable identity, revision, URL and decimal range constraints.

### Follow-up evidence
- Root bun run check: passed, architecture debt 1228 -> 1227 (obsolete authored
  integer regex removed, no gained entry).
- Focused writer/authored/door/GraphQL suites: 118 passed, 0 failed, eight files.
- Wiki final run: 139 passed, 0 failed after HTTP 400 fix; check and build
  passed (existing bundle-size warning).
- Independent same-model review found keyed authored values, HTTP 400 GraphQL
  handling and advertised constraints issues. All three were addressed with
  regression tests and a scratch AJV 2020 parity walk (12 inputs).
- Bounded manual mutation replacing the integer door type with unknown killed
  two door tests; restored immediately, focused 118 tests passed. Not a full
  Stryker run.
- Existing numeric bounds were preserved. Over-bound selectors now refuse
  instead of silently clamping. No new tables or screen layout changes.

## Acceptance evidence
- Root bun run check: passed; architecture debt shrank from 1229 to 1228 entries.
- Writer, generated-write and new validation suites: 83 passed, 0 failed.
- Related authored, producer and agent-boundary suites: 36 passed, 4 skipped,
  0 failed. No real agent was started.
- Wiki app check and tests: passed; 129 passed, 0 failed across 24 files.
- Bounded manual mutation: disabling the field type rejection killed four
  writer-boundary cases. Restored immediately; not a full Stryker run.
- No screen changes; no mockups.


### Snapshot integration, 2026-11-16

Ported generated doors and coded refusals onto typed assertions and parent-key edges; retained exact dispute approvals, contract versions, checked preconditions and source evidence. No reference columns, legacy evidence format or delayed drafts restored.

Conflicts resolved:
- `.architecture/violations.json`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/graph/authored.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/graph/graph-writes.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/graph/graphql-read.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/graph/manifest-publication.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/graph/write.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/knowledge/product.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `src/mcp/authored.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `test/authored.test.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `test/graph-write.test.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `test/graphql-executor.test.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `test/graphql-writes.test.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `wiki/app/src/client.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `wiki/app/src/components/command.ts`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `wiki/app/src/locales/en.json`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.
- `wiki/app/src/locales/ru.json`: kept snapshot storage/reader/UI contracts and ported the incoming generated-door and coded-refusal behavior.

Validation: bun run check passes, 560 inherited entries, zero I/O span debt and no gained entries. Door suites: 38 pass, zero fail. Writer suite after fixture correction: 14 pass, one first-case 10-second timeout; earlier incorrect fixtures now publish required immutable key assertions and expect structured refusals. Authored suite passed nine cases in the combined run; multi-file run exceeded default deadlines elsewhere. No acceptance claimed.
