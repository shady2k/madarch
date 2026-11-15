# Graph storage

Capability: graph-storage

## Purpose
Checked identities and relations in the graph's common writer.

## Requirement: edge-endpoints — Edges obey their declared and stored endpoint kinds

The common writer shall refuse an edge when an endpoint kind is not allowed by its declared edge kind. A supplied uid shall belong to the kind the endpoint names. A resolved endpoint shall be active and in the write context. Refusal shall roll back the operation transaction, including other vertices and journal entries. The endpoint lookup shall lock nodes against concurrent retirement and carry an observability span.

### Scenario: endpoint-kind
- Given: an edge kind from parent to child
- When: an edge names other as either end's kind
- Then: the write is refused with the end, declared expectation, full writer path and line

### Scenario: uid-kind
- Given: a stored other vertex and an edge from parent to child
- When: either endpoint claims the other vertex's uid belongs to the allowed kind
- Then: the write is refused and the transaction leaves no new vertex, edge or journal row

### Scenario: inactive-end
- Given: a removed endpoint or an endpoint in another context
- When: an edge names it
- Then: the write is refused

### Scenario: valid-edge
- Given: active parent and child vertices in the write context
- When: the edge names their actual identities and kinds
- Then: the writer creates the edge
