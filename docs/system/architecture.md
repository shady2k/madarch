# Architecture

What madarch is made of, and how a model flows from a repository to a view.
Decisions are named by number; they live in `docs/decisions/`.

## The parts

**Model** (`src/model/`): reads a repository's intended model — YAML files the
repository holds — and compiles it to the one normalized JSON, the compiled
model, that everything else reads (`src/model/compile.ts`). The intended model
and the compiled model are each checked against their TypeBox schema
(`src/model/schema.ts`, `src/model/compiled-schema.ts`); every id is sorted by
code point, so the same model compiles to the same bytes everywhere
(`src/model/order.ts`).

**Check** (`src/check/`, `scripts/check-model.ts`): checks a repository's
model against the repository itself — evidence resolves, every file is
assigned, the recognised problems are looked for — and renders the model's
views into a folder when asked. It is the gate a model passes before anything
is sent anywhere.

**History** (`src/history/`, `src/adapters/sqlite-history.ts`): keeps every
version of every source's compiled model as a bitemporal fact log in SQLite:
each assertion carries when it was true (the commit's time) and when the
history held it. Nothing is overwritten; a store is idempotent, orders a
source's commits by time, not arrival, and is refused when a commit comes
back with another model or time. One history holds any number of sources.

**Query engine** (`src/query/`, `src/adapters/ladybug-engine.ts`): the store
built from the history's assertions to answer what views and agents ask —
children, views with collapsed relations, dependents and dependencies, as of
any time on either axis. It is derived state: `rebuild` builds it from a
history's assertions, `update` applies one store's own report, and it is
rebuildable at any time (decision 0009). LadybugDB 0.20.4 carries it.

**Renderer** (`src/render/`): turns views into text a reader sees — the view
set's Mermaid pages and LikeC4 workspace (`src/render/view-set.ts`,
`src/render/mermaid.ts`, `src/render/likec4.ts`), and one view on request
(`src/render/one-view.ts`), which the server answers with.

**Wiki** (`src/wiki/`, `scripts/wiki.ts`): the static site generated from a
repository's compiled model and its own documents, each view offered as
LikeC4, Mermaid and archify.

**Server** (`src/server/`, `scripts/serve.ts`): keeps the models repositories
send and answers requests about them. It never reads a repository (decision
0007); what it shows is what was sent, at the commit it was sent for.

## From a repository to a view

A repository's intended model is compiled, the check passes on it, and the
compiled model is sent to the server with the source's name, the commit id
and the commit time. The server checks it against the compiled model's
schema and stores it in that source's history. Whoever can reach the server
asks for a view of that source; the server's query engine answers, and the
renderer renders the answer as Mermaid or LikeC4 text.

## The server

The server is started with a data folder, which it refuses to start without
(`bun scripts/serve.ts --data <folder>`), and listens on `127.0.0.1` unless
told otherwise; there is no authentication in this milestone (decision 0012),
and the HTTP layer is one route table so authentication can be added as one
layer in front of the handlers.

`POST /models` stores a sent model — idempotently for the same commit and
model, refusing with 409 the same commit sent with another model or time —
and `GET /sources` lists what it holds, in code point order of the names.
Every refusal is JSON naming the request field at fault and what it accepts.
One line per request goes to the log; no model content ever does.

The data folder holds one SQLite history file per source
(`src/server/sources.ts`), its name derived from the source's name by
encoding every byte a file name should not carry, and a small sidecar beside
each history naming its source and its head, so a restart knows every file's
source and answers the same as before it stopped.

A graph is a named set of sources, and each graph has one query engine built
from the assertions of every source the graph lists
(`src/server/graphs.ts`). In this milestone every graph lists exactly one
source and is named after it (decision 0013, amended), so repositories
declaring the same id never refuse each other. Joining a product's
repositories adds graphs that list several sources, where a clashing id is
reported when the graph is built (decision 0003); how a source is sent and
stored does not change. The engine is built lazily on first use and kept in
step with each store's own report; a test builds a graph from two sources'
histories and gets the union's view.

A view of a sent source is answered by the same renderer the check and the
wiki use (`src/render/one-view.ts`); the server's route table takes that way
in beside the present ones.
