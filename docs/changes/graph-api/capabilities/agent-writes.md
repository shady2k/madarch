# Agent writes

Capability: agent-writes

## Purpose
The MCP surface through which an agent states what it read into the product's one graph (decision 0036, section 8: the
authored and agent writes stay): one product session offering `graph_schema` and `graph_query` (capability graph-queries)
beside `put_entity`, `put_edge` and `retract`. Every value an agent states is an opinion with its evidence, and nothing an
agent wrote is removed but by the agent itself.

## Requirement: tools — One product session offers the reads and the three writes
The product's MCP server shall offer one session whose tools are `graph_schema`, `graph_query`, `put_entity`, `put_edge` and
`retract`; a tool it does not offer shall be refused naming the tool, and no write shall reach the graph through any other
route. The session shall be the product's, opened for the graph the server serves.

### Scenario: unknown-tool
- Given: one product MCP session
- When: a tool it does not offer is called
- Then: the call is refused naming the tool, and nothing is published
  Checked by test/graphql-writes.test.ts

### Scenario: one-session
- Given: one product session
- When: the schema, a query and a write are asked in it
- Then: the schema is the product's SDL, the query answers through the executor, and the write is read back by the next query
  Checked by test/graphql-writes.test.ts

## Requirement: entity — An entity opinion states its values and its evidence
`put_entity` shall publish one opinion of a vertex of a declared kind: its values are fields the kind declares, its
evidence is at least one tagged place — a file with its repository, commit or digest, path and lines, a URL with its time,
a conversation with its id, speaker, time and words, or another opinion — and the values and evidence together are
compared with the producer's open opinion, so an unchanged value with new evidence updates the row's evidence rather than
opening a second opinion. A kind whose key a value repeats, an unknown field, or an opinion with no evidence shall be
refused naming the field or the rule, and nothing is written.

### Scenario: values-and-evidence
- Given: a term kind keyed by its title, and a conversation as the agent's evidence
- When: `put_entity` states the term and `graph_query` reads it back
- Then: the entity answers its title and definition, its opinion names the agent's producer and the conversation, and the label is the title
  Checked by test/graphql-writes.test.ts

### Scenario: refused-fields-and-evidence
- Given: a draft naming a field the kind does not declare, and one stating no evidence
- When: each is sent
- Then: each is refused naming the field or the evidence rule, and the graph holds no such opinion
  Checked by test/graphql-writes.test.ts

## Requirement: edge — An edge is published between declared ends
`put_edge` shall publish one opinion of an edge of a declared edge kind whose ends are entities of the kinds the edge
declares (or of any kind where it declares `any`), with a discriminator where the edge repeats so two edges between the
same ends stay apart, its attribute values held against the edge's declaration, and its evidence required as for an
entity. An edge whose end kind the declaration does not allow, or whose attribute takes no null, shall be refused naming
it.

### Scenario: edge-with-record
- Given: two entities and a `mentions` edge kind that repeats by place
- When: the edge is written at a discriminator and read forwards and backwards
- Then: each direction answers the edge with its discriminator, its opinions and its attribute, and the far entity's backlinks names it
  Checked by test/graphql-writes.test.ts

### Scenario: edge-ends-and-attributes
- Given: an edge whose end kind the declaration does not allow, and an edge attribute declared non-null given null
- When: each is sent
- Then: each is refused naming the end or the attribute, and nothing is published
  Checked by test/graphql-writes.test.ts

## Requirement: retract — Only the agent's own open opinions are closed
`retract` shall close the producer's own open opinions of one entity — all of them or the named fields — or of one edge,
with the evidence it states, and shall never close another producer's opinion. The journal shall keep the stated words and
the evidence with the retraction.

### Scenario: own-opinions-only
- Given: a plugin's opinion and an agent's opinion of the same entity
- When: the agent retracts the field
- Then: the agent's opinion is closed, the plugin's still answers, and the journal holds the retraction's words and evidence
  Checked by test/graphql-writes.test.ts

## Requirement: producer — The client's name and the session name the producer
The producer an opinion is said by shall be the MCP client's name and the session, not a name the agent supplies; two
sessions of the same client shall therefore be two producers of their own, and a stated producer shall stand beside the
value with its version, language and time.

### Scenario: producer-from-client
- Given: an MCP client named in `initialize`, in one session
- When: the client writes an entity
- Then: the opinion's producer is the client's name, and the same value written by a plugin stays a second opinion
  Checked by test/graphql-writes.test.ts

## Quality requirements
- Every write answers with the entity's uid, its kind and its written count, so the agent reads back what it wrote.
- A write to a kind with no fields and no plugin producer is accepted, and its label is read back.
- An unknown tool, an unknown field or missing evidence costs the graph nothing.

## Context
Decision 0036, section 8 (the MCP tools of the record layer and `read_entity` are replaced by `graph_schema` and
`graph_query`, and the writes stay); decision 0035 (every value is an opinion).

## Coverage limits
No write removes another producer's opinion, and the MCP surface holds no page and no listing.
