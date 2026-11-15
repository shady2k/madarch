# Graph writer

Capability: graph-writer

## Purpose
Check declared attribute types at the one graph publication boundary, including
scripted agent answers (decision 0039 items 3 and 7).

## Requirement: field-types — The writer refuses invalid attribute values before publication
The writer shall check every vertex and edge attribute against its declared
field type and nullability before the publication issues its first mutation.
An undeclared field or invalid value shall return SCHEMA_INVALID with a JSON
Pointer path, expected type, actual value and retryable: false (0039 item 30).
The MCP draft builder shall use the same type predicate. Integer values shall
fit the storage type's range. JSON values shall contain no undefined members.

### Scenario: agent-answer-wrong-type
- Given: a scripted agent answer containing a number for a declared text attribute
- When: the answer reaches the graph writer
- Then: it is refused with SCHEMA_INVALID before any SQL is issued

### Scenario: invalid-later-value
- Given: a publication with a valid vertex followed by an invalid vertex
- When: the publication reaches the graph writer
- Then: neither vertex is declared and the invalid value is named in the refusal

### Scenario: edge-value
- Given: an edge with a string in a declared integer attribute
- When: the publication reaches the graph writer
- Then: it is refused before any SQL is issued
