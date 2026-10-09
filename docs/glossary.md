# Glossary

What madarch's words mean. Specs, issues, code and conversations use these
names; a word under _Avoid_ is not used for the concept.

## Domain terms

**Graph**:
The complete state madarch keeps for one organisation's system: the intended
model, every fact from every source with its times, and the relations derived
from them. A graph is built from the sources it lists. In the MVP a server
holds one graph per repository sent, each listing that one source; a graph
listing a product's several repositories comes with `live-graph` (decision
0013, amended 2026-09-30).
_Avoid_: landscape, workspace, model (for the whole)

**Intended model**:
What people and agents declare the architecture to be: elements, interfaces,
relations, zones, data categories, data entities, scenarios, environments and
architecture states (rules later), written as YAML in a repository's `madarch/`
folder.
_Avoid_: authored model, design model

**Element**:
A part of the system with a stable id: a person or role, an external system, a
domain, a system, a service, a module, a store, a broker. Elements nest through
a parent.
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
A relation made concrete: one that names an interface or carries data
transfers. It has its own id (the relation's), by which flows, decisions and
evidence refer to it; the query engine keeps it as a node.

**Action**:
How the initiator of a relation through a topic or queue uses it: `send`
(publishes to a topic, sends to a queue) or `receive` (subscribes to a topic,
receives from a queue). The relation still goes from its initiator to what it
depends on, usually the broker; views label it by that role and draw it
dashed.
_Avoid_: direction (a data transfer's), publish or subscribe as its values

**Data transfer**:
Data moving within an interaction in one direction, forward or reverse, with its
data categories and the data entities it carries.

**Confidentiality**:
How restricted data is (for example public, internal, confidential). Separate
from its categories.

**Data category**:
What kind of data it is (for example personal, payment-card). Data can have
several.
_Avoid_: classification (ambiguous between the two dimensions)

**Data entity**:
One named piece of data that crosses a relation (a session id, a user's name),
classified by the model's data categories. `categories: []` is an answer: the
entity carries nothing sensitive.
_Avoid_: data field (a column of one table), attribute

**Zone**:
A boundary elements belong to other than their parent: a network segment, a
trust boundary, a regulatory scope. Its kind is a free word (`network`,
`trust`, `regulatory`). An element may be in several zones of different kinds;
it is in its parent's zones unless it adds, excludes or replaces them.

**Environment**:
A deployment of the system (test, preprod, production) in which interfaces have
concrete bindings; it may differ in zones and in which elements it has.
_Avoid_: stand (use environment)

**Architecture state**:
One point in a chain of states of the intended model, such as as-is, a
transition stage or to-be, ordered by `after`. An element or relation may start
or end at a state; with none given it exists in all of them.
_Avoid_: version (that is a commit of the model)

**Binding**:
How an interaction reaches its interface in one environment: the variable the
consumer reads and the value it has there (topic name, host, port).

**Flow**:
An ordered sequence of steps over the model's relations that tells one scenario
end to end. A scenario's main flow and each of its alternatives are flows; a
step runs over any relation, a bare dependency or an interaction.

**Scenario**:
One use case written in the model as an ordered walk over its relations: an
actor, the capability requirements it realises, a main flow of steps and
alternative flows that replace it from a step on. The model check resolves the
requirements it names; its diagrams, data flows and status are to be computed
from it rather than written, which the wiki's use-case pages bring.
_Avoid_: use case (the words around it, not the model's construct), user story

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
In the MVP, a repository whose compiled model is sent to the server, named by
its `origin` remote as host and path (`github.com/shady2k/nocx`).

**Fact**:
One atomic statement a plugin makes about what it sees (`provides`, `consumes`,
`binds`, `resolves`, `observed`, `coverage`), with its source and times.
_Avoid_: observation (reserved for runtime facts), evidence (the facts behind a
derived relation)

**Evidence**:
The facts, with their files and lines, from which a derived relation was joined;
in the intended model, the text an agent read to write an element, an
interface, a relation or a data entity: a file, its lines, and the commit and
blob it was read at.

**Stale**:
Said of evidence or a claim whose file has changed since the blob it names; the
text read then may no longer say what was written from it.

**Claim**:
One architectural statement a repository's document makes, with its verdict
from the code: confirmed, contradicted, stale, planned or unconfirmed.
_Avoid_: finding (a problem the model check reports)

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

**Renderer**:
The in-process code that turns views, computed by the query engine and named
from the compiled model, into text a frontend reads (Mermaid pages, a LikeC4
workspace). The server calls the same renderer for a view on request.

**Output plugin**:
A separate process that reads the compiled model and renders it (Mermaid,
LikeC4, a graph database). Not built yet; the renderer does this in process.

**Fact log**:
The append-only, bitemporal store of all assertions; the server's source of truth.

**Query engine**:
The store built from the fact log to answer traversals and ad-hoc queries;
rebuildable at any time.

**Compiled model**:
The normalized JSON the server publishes (`model.json`); the contract every
frontend and agent reads.

**Model check** (`scripts/check-model.ts`):
The local command that checks a repository's intended model against the
repository: it compiles, its evidence resolves, every file is assigned, what is
stale, the problems recognised methods find, and its views.

**Review report** (`madarch/review.md`):
The Markdown beside a repository's intended model that says where it came from:
the claims and their verdicts, what no document mentions, the assignment table
and the problems.

**Assignment table**:
The review report's table that gives every tracked file of the repository to an
element, or excludes it with a reason; the deepest row covering a file decides.

**The write-intended-model skill** (`skills/write-intended-model`):
The agent skill that writes and updates a repository's intended model and review
report, documents first and confirmed in the code.

**Layer**:
A module element grouping a core's groups of modules when one page would hold
too many of them; a modelling choice, not a kind of element.

**Wiki** (`src/product-wiki/`, `wiki/app/`, `scripts/wiki.ts`):
A product's wiki and a repository's static site. The served wiki is madarch's
own thin app (`wiki/app/`), served by a local madarch through the `madarch new`
and `madarch serve` commands (`src/product-wiki/`), showing the product's pages
read from its working tree; the static export (`scripts/wiki.ts`) is the
read-only site generated from a repository's compiled model and its own
documents, built by one of two engines, Zensical or Starlight (the Starlight
template is `wiki/starlight/`). (Decision 0018.)

**Product repository**:
One product's knowledge kept as Markdown and YAML in a git repository of its
own, apart from the product's code; before it has a name it is a draft.

**Draft product**:
A product repository created by `madarch new`: a folder `idea-YYYY-MM-DD`
under the products home, with a stable id, an empty `docs/`, and its wiki
served from the working tree.

**Products home**:
The folder holding the product repositories (`~/madarch/products` by default),
moved by `MADARCH_HOME` or `--home`.

**Manifest**:
The `workspace.yaml` of a product repository, carrying its `schemaVersion`,
`id` and `name`; how madarch recognises a product and reads its identity.

**Wiki app**:
Madarch's own React app built by Vite from `wiki/app/`, served by the local
madarch server to show a product's wiki.

**Page**:
One Markdown file under a product's `docs/`, or its `README.md`; shown at the
address `/p/` plus its path within the product.

**Diagram tab**:
One format of a wiki page's view: LikeC4 (interactive), Mermaid, or archify
(drawn by the renderer kept in `vendor/archify/`, at LikeC4's positions).

## Open

- The name of the file that lists the repositories composing the graph and
  their pinned refs.
