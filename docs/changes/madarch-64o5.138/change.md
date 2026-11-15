# Shared value types and mandatory JSON schemas

Change: madarch-64o5.138
Base: 46459a319240b88b5a218c07ee0646ba0ef28856
Tasks: madarch-64o5.138
Kind: behavior

## Intent
Decision 0039 items 3, 4 and the value-type/JSON Schema portion of 29: fields reuse catalogue value types and JSON values always have an executable Draft 2020-12 schema.

## Out of scope
Reference-to-edge conversion, mention extraction, graph-dependent value-set membership and the remaining foundation architecture gates. No UI change.

## Changes to requirements
- Catalogue fields name shared value types. JSON fields declare a schema, including its dialect.
- Installation refuses invalid schemas and unresolved references without network access.
- The writer refuses invalid keys, vertex values and edge attributes before publication SQL, naming the field, expected type and value with VALUE_TYPE_MISMATCH.
- Field schemas use shared type refs rather than inline patterns. Git remote values retain the recorded lexical C string: any string without NUL, including empty, newline-containing, helper, scp-like and local forms. This is not URL parsing or a connectivity check. Recorded Git identity strings, including empty or malformed email text, remain accepted; strict email/URL types remain available for person-entered values.

## Preserved contracts
None.

## Coverage
- value-types/validation: test static

## Where it is seen
Kind: request
Place: catalogue installation and graph writer

1. Read a field with no type or a JSON field with no schema; observe a full-path and line finding.
2. Install shared type refs and write malformed values; observe VALUE_TYPE_MISMATCH before publication SQL.
3. Read the starter catalogue with the same validator used by products.

## Blocking questions
None.

## Design and decisions
Merged catalogue head c0b2ada8, which includes the foundation gates. The checks pass without gained gate entries: the storage vocabulary is declared once in the manifest reader, Draft vocabulary IDs remain literal IDs, and the stale writer regex entry was removed. Existing natural-key reference objects remain pending the edge task. Operations schemas follow declaration semantics because no operations producer exists in this checkout. See conversion.md for assumptions and exact contracts.

## Acceptance evidence
- Updated on coordinator request `/tmp/f5b.md`, based on coordinator commit `3ae5de48` and catalogue merge `c0b2ada8`.
- `bun run check`: passed; 1,311 architecture entries matched, no gained entry and one stale regex entry removed. UI architecture zero; 498 catalogue kinds; four workflows; no quarantined cases.
- Eleven focused suites: 139 passed, 677 assertions. Git tree/history plus value-type suites: 15 passed, 117 assertions, including absent versus recorded empty remote. Wiki app check and 123 tests passed, 581 assertions.
- Narrow mutation of the Git remote format: five killed, one survived (format `type` empty string: Ajv defaults to string); 83.33%. No claim of whole-change mutation coverage.
- Git remote admission follows Git 2.43.0 `builtin/remote.c` lines 194–207: it writes the remote URL argument without URL validation. `git remote add` and offline `git ls-remote --get-url` both accept an empty value. Transport dispatch and reachability are not stored-value validation.
- `recorded-identity` does not restrict string content. Existing producer decoding/representation is unchanged; this schema introduces no rejection or byte conversion.

### Original delivery evidence (historical)
- `bun run check`: passed, 35 existing architecture violations matched; UI architecture zero; catalogue 498 kinds, 117 page/member; 4 workflows; no quarantined cases.
- Nine focused suites: 120 passed, 622 assertions. Scripted-agent MCP suite separately passed all three cases within a five-suite run of 65 passed cases.
- Wiki app check passed; 120 tests passed, 564 assertions.
- Mutation of value-types.ts changed ranges: 41 killed, 17 survived, 70.69%. Survivors were inspected: malformed registry guards can still throw downstream (equivalent refusal but less specific diagnostics), diagnostic strings, optional chaining, and cache recompile paths. This is a narrow mutation run, not whole-change mutation coverage.
- Full root suite was interrupted after more than five minutes; its earlier failures led to fixture schema updates and the disk producer URL fix. It is not claimed green. Additional fixture checks and environment limitations are in the hand-in.
- Independent review findings: bigint strings, unsupported vocabularies, property names mistaken for patterns, UID addressing and scalar enum example were addressed.
- Document gate reports only untracked-change and missing-approval, expected in this coordinator-owned tracker environment. No approval or stage acceptance is asserted.
