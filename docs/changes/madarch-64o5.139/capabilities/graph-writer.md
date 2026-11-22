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

## Requirement: door-contracts — Catalogue fields close the request contract
MCP value and key schemas shall be generated per kind from the published
catalogue, with closed envelopes. The runtime shall refuse undeclared fields,
wrong types and malformed read selectors with SCHEMA_INVALID arguments.
HTTP command envelopes shall be validated before effects. The wiki shall format
schema refusals in the reader's locale; MCP shall preserve their arguments.

### Scenario: catalogue-door
- Given: a declared integer field and a malformed MCP request carrying text
- When: the request reaches the tool boundary
- Then: no product write occurs and SCHEMA_INVALID names the value

### Scenario: read-selector
- Given: an unknown kind or malformed cursor in a graph read
- When: the read executes
- Then: a coded refusal is returned without partial data

### Scenario: reader-refusal
- Given: an English or Russian reader and a coded HTTP 400 GraphQL refusal
- When: the wiki reads the answer
- Then: it preserves the code and arguments and formats the reader-facing text
