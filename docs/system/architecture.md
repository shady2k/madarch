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

**Architecture check** (`scripts/check/architecture/`, `scripts/check-architecture.ts`):
the static gate of decision 0033 — dependency rules over the import graph, the
fill's one entry point, no code unreachable from the production entries, and no
import of the retired surfaces. `bun run check` runs it.

**History** (`src/adapters/sql-history.ts`, `src/history-types.ts`,
`src/history-assertions.ts`): keeps every version of every source's compiled
model as a bitemporal fact log in PostgreSQL: each assertion carries when it was
true (the commit's time) and when the history held it. Nothing is overwritten; a
store is idempotent, orders a source's commits by time, not arrival, and is
refused when a commit comes back with another model or time. One history holds
any number of sources; `src/history-assertions.ts` rebuilds their union.

**Query driver** (`src/sql-driver.ts`, `src/query-types.ts`): the storage
layer's interfaces — `SqlExecutor` for one statement, `SqlQueryDriver` for a
transaction, and the asynchronous query types the server routes name — through
which the graph store (`src/graph/`) and the adapters read and write. The graph
store owns the temporal tables; the record store (`src/graph/records.ts`) writes
the tree and history records the fill publishes.

**Database owner** (`src/adapters/database-owner.ts`): one
PostgreSQL database per process — a store's own server locally (installed into
the madarch home at a pinned version and hash, `src/adapters/postgres-install.ts`,
started by `src/adapters/postgres-cluster.ts`), a server a connection string
names otherwise — opened once and lent to the history store, the graph store and, by decision
0027, the queue and the orchestrator's tables. A
lent owner outlives the adapters that borrow it, and every operation of either
adapter takes one of the owner's transactions, so a history write and a graph publication commit or roll back together. The owner runs its own
transactions one at a time; other processes reach the same store through
connections of their own, and their snapshots overlap.

**Renderer** (`src/render/`): turns views into text a reader sees — the view
set's Mermaid pages and LikeC4 workspace (`src/render/view-set.ts`,
`src/render/mermaid.ts`, `src/render/likec4.ts`), which the check and the
wiki use, and one view on request at any depth (`src/render/one-view.ts`),
built from the same parts, which the server answers with.

**Wiki** (`src/product-wiki/`, `wiki/app/`, `src/wiki/archify.ts`): the
served product wiki — its pages read from the product's working tree and its
graph pages from the fill's record store — and the archify renderer the
architecture pages use.

**Server** (`src/server/`, `src/product/cli.ts`): one process that serves the
product wiki, its HTTP API, its MCP tools and the built web files
(`src/server/http.ts`, `src/server/knowledge.ts`); `madarch serve` runs the api
role and one fill child, and `madarch start` runs one background server for the
products home. The model routes remain for a caller that injects a data folder
and a query database; no CLI starts that mode.

**Product repository** (`src/product/`, `scripts/madarch.ts`): one product's
knowledge as Markdown and YAML in a git repository of its own. The
repository's lifecycle is madarch's own code (decision 0021, revising the
clause of 0019 that took the set's program: the commands
`madarch new`, `rename`, `repo add`, `bootstrap`, `remote` and `clone` sit
on `src/product/draft.ts`, `src/product/lifecycle.ts` and
`src/product/git.ts`), with the products home `~/madarch/products`, moved by
`MADARCH_HOME` or `--home`. The product's identity — its id and name — is
read from its manifest, `workspace.yaml`, by the contract's own reader
behind `src/product/manifest.ts`; the consumer tests hold that reader to the
contract's manifest cases and example products (`examples/contract/`).

**Served wiki** (`src/product-wiki/`, `wiki/app/`): a product's pages, read
fresh from the working tree at every ask (`src/product-wiki/pages.ts`) — every
Markdown file under `docs/` and `README.md` — shown by madarch's own app
(`wiki/app/`, React built by Vite) and served by the server's product mode:
started with a product folder it answers the app's built files, the page
addresses `/p/<path>` and the wiki's API (`/api/product`, `/api/pages`,
`/api/page?path=…`).

Without an app folder named, the built app of the
checkout (`wiki/app/dist`) is served; a checkout whose app was never built
refuses to start, saying what to build. The server runs in three modes: with
a data folder only it answers the model routes alone; with a product folder
only it serves the wiki alone; with both, each is answered beside the other.

**The knowledge wiki's processes** (madarch-8bdc.9). One binary runs in a
role per instance. `madarch --role api` (`src/server/http.ts`,
`src/server/knowledge.ts`) serves HTTP, MCP and the built web files and reads
the product's store directly through the storage layer; a page's consistency is
its own read's transaction (`REPEATABLE READ READ ONLY`). `madarch --role fill`
(`src/knowledge/fill-role.ts`) claims pressed fills from the store's queue
(`src/fill/run-jobs.ts`, decision 0027) and runs the one orchestrator's run
(`src/knowledge/fill-run.ts`). The two speak only through PostgreSQL: the job,
the run's state, its end and a person's pause or stop. `madarch serve` runs the
api role in its process and one fill as a child at nice 10, which ends with the
server that started it; on a server several of each can run against one store.

## From a document to a reader

A product's document reaches its reader without a send or a build: `madarch
new` or `madarch serve` serves the product of the given or the current folder,
the server reads the pages from the working tree at every ask, and the app
shows them at `/p/<path>`; a file saved under `docs/` changes its page within
two seconds, the open page refetching when the wiki's revision (a digest of
the pages' paths and contents) changes.

## From a repository to a reader

A repository is filled by `madarch fill` or the wiki's fill button: the fill
runs the tree and history record passes of `src/fill/steps.ts`, reads git
through `src/fill/stages/repository-facts.ts`, and publishes the rows through
the record store (`src/graph/records.ts`). The server, the MCP server and the
wiki read those records through the storage layer. The engine's mechanism tables
are `src/graph/one-graph.ts`, and each kind's attribute table is generated from its
contract by `src/graph/contract.ts` (decision 0034). A product's intended model is still
compiled and checked against its TypeBox schema (`src/model/`), and its pages
are read from the product's working tree (`src/product-wiki/pages.ts`).

## The server

The server is started with a product folder for the wiki
(`bun scripts/madarch.ts serve --product <folder>`, which builds the wiki app
on first use and opens the address in the browser), or as the products home's
background server (`madarch start`). The model routes are reached by a caller
that injects a data folder and a query database; no CLI starts that mode. It listens on `127.0.0.1` unless told otherwise; there is no authentication in this milestone (decision 0012),
and the HTTP layer is one route table so authentication can be added as one
layer in front of the handlers.

`POST /models` stores a sent model — idempotently for the same commit and
model, refusing with 409 the same commit sent with another model or time —
`GET /sources` lists what it holds, in code point order of the names, and
`POST /views` answers one view of a source (an element or the landscape, a
depth, Mermaid or LikeC4) as text, explaining a request it cannot answer: a
source never sent names the send command. Every refusal is JSON with a
message; a refusal about a request field also names the field and, where it
can, what is accepted.
One line per request goes to the log; no model content ever does.

The machine-local state folder holds one PostgreSQL data directory
per source (`src/server/sources.ts`), outside the product repository. Its name
is derived from the source's name by encoding every byte a file name should not
carry. A small sidecar beside each database names its source and head, so a
restart answers the same as before it stopped. The local source store serializes its HistoryStore operations on its owner
(decision 0024). A legacy `.sqlite` history is not migrated; resend source
models to rebuild the fact log.

A graph is a named set of sources (`src/server/graphs.ts`); the graph routes
read through the storage layer's asynchronous query interface
(`src/query-types.ts`, `src/sql-driver.ts`). In this milestone every graph lists
exactly one source and is named after it (decision 0013, amended), so
repositories declaring the same id never refuse each other. Joining a product's
repositories adds graphs that list several sources, where a clashing id is
reported when the graph is built (decision 0003).

A view of a sent source is answered from its graph's SQL facade by the one-view
renderer (`src/render/one-view.ts`), at the current time and the first state;
a LikeC4 answer lists, as comment lines, the relations LikeC4 cannot draw.
