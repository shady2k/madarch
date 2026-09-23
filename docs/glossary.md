# Glossary

What madarch's words mean. Specs, issues, code and conversations use these
names; a word under _Avoid_ is not used for the concept.

## Domain terms

**Graph**:
The complete state madarch keeps for one organisation's system: the intended
model, every fact from every source with its times, and the relations derived
from them. One server holds one graph.
_Avoid_: landscape, workspace, model (for the whole)

**Intended model**:
What people and agents declare the architecture to be: elements, interfaces,
relations, zones, data categories, rules and flows, written as YAML in git.
_Avoid_: authored model, design model

**Element**:
A part of the system with a stable id: a person or role, an external system, a
domain, a system, a service, a store, a broker. Elements nest through a parent.
_Avoid_: node (reserved for the storage graph), component (a C4 level)

**Interface**:
A capability an element offers to others: an API, a topic, a table, a gRPC
service. Identified by its contract id.
_Avoid_: endpoint (that is where an interface is reachable)

**Contract id**:
The normalized identifier of an interface, such as `http::GET::/api/orders/{}`
or `topic::order-placed`, on which providers and consumers from any repository
and any tool meet.

**Relation**:
A dependency of one element on another, declared by its initiator, at any level
of detail. Views collapse relations to the elements they show.
_Avoid_: link, arrow, connection

**Interaction**:
A relation made concrete: a node with its own id that carries data transfers and
is referred to by flows, decisions and evidence.

**Data transfer**:
Data moving within an interaction in one direction, forward or reverse, with its
data categories.

**Confidentiality**:
How restricted data is (for example public, internal, confidential). Separate
from its categories.

**Data category**:
What kind of data it is (for example personal, payment-card). Data can have
several.
_Avoid_: classification (ambiguous between the two dimensions)

**Zone**:
A boundary elements belong to other than their parent: a network segment, a
trust boundary, a regulatory scope. An element may be in several zones of
different kinds.

**Environment**:
A deployment of the system (production, test) in which interfaces have concrete
bindings.

**Binding**:
How an interaction reaches its interface in one environment: the variable the
consumer reads and the value it has there (topic name, host, port).

**Flow**:
An ordered sequence of interactions that tells one scenario end to end.

**Rule**:
A constraint the graph must satisfy, such as "payment-card data does not leave
the PCI zone"; evaluated on every change.

**View**:
A query over the graph that frontends render: a scope, a depth, filters and a
grouping, or a flow.
_Avoid_: diagram (a view rendered)

## Facts, sources and time

**Source**:
Where facts come from: a repository at a ref, read by one plugin at one version.

**Fact**:
One atomic statement a plugin makes about what it sees (`provides`, `consumes`,
`binds`, `resolves`, `observed`, `coverage`), with its source and times.
_Avoid_: observation (reserved for runtime facts), evidence (the facts behind a
derived relation)

**Evidence**:
The facts, with their files and lines, from which a derived relation was joined.

**Proposal**:
An assertion inferred by an AI agent or a heuristic that is not accepted yet.

**Coverage**:
What a plugin read and what it could not; without complete coverage, a missing
fact is "not enough data", never absence.

**Valid time**:
When an assertion is true in the world. Each fact states its basis (commit time,
deployment time, observation window).

**Recorded time**:
When the graph held an assertion. Nothing is overwritten; a change closes one
version and opens another.

**Ingest**:
Reading one source at one ref and replacing everything that source asserts,
idempotently; the one operation that changes the extracted part of the graph.

**What-if overlay**:
A temporary replacement of one source's facts, used to check a pull request
without changing the graph.

## The system's own parts

**Core**:
The logic that joins facts, derives relations, evaluates rules and answers
queries; it knows no source, transport or storage.

**Extraction plugin**:
A separate process that reads a source and emits facts over the plugin protocol.

**Output plugin**:
A separate process that reads the compiled model and renders it (Mermaid,
LikeC4, a graph database).

**Fact log**:
The append-only, bitemporal store of all assertions; the server's source of truth.

**Query engine**:
The store built from the fact log to answer traversals and ad-hoc queries;
rebuildable at any time.

**Compiled model**:
The normalized JSON the server publishes (`model.json`); the contract every
frontend and agent reads.

## Open

- The name of the file that lists the repositories composing the graph and
  their pinned refs.
- The kinds of zones and the exact inheritance operations (0014).
