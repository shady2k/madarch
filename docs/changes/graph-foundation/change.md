# Store the graph on a sound foundation

Change: graph-foundation
Base: c59db20b253b79f6530e76d3eed25ccfac6ba378
Tasks: madarch-ozp.4, madarch-ozp.5, madarch-ozp.6, madarch-ozp.7, madarch-ozp.8, madarch-ozp.9, madarch-ozp.10, madarch-ozp.11
Kind: behavior

## Intent
Today madarch has decisions and documents but no code: nothing can read an
architecture model, keep its history or answer a question about it. Everything
the MVP shows (the large invented system, a repository's diagrams, a view on
request) stands on three things that do not exist yet.

After this change a model written in YAML inside a repository is read and
checked strictly, with every error pointing at its file and line; it compiles
into `model.json`, the contract every view and agent reads; every version of
every source's model is kept with both time axes, never overwritten; and
LadybugDB answers what is inside an element, what a view at a scope and depth
shows with relations collapsed to what is visible, and what depends on what,
transitively, at any past time. The format already carries environments and a
chain of architecture states, though views of them come later.

Stories:
- As an architect, I write the model across several YAML files and get every
  mistake at once, each with its file and line.
- As an architect, I let a service grow modules or move to another domain, and
  nothing that pointed at it breaks.
- As a security engineer, I say that one call sends card data out and a status
  back, and the two directions stay apart.
- As a view (outcome 2) or the server (outcome 4), I ask for a scope and a
  depth and get the boxes and the collapsed arrows, as of any time.
- As an agent, I ask what depends on the event bus, transitively, and what that
  looked like on an earlier day.

## Out of scope
Rendering views (Mermaid, LikeC4): outcome 2. The HTTP server, `POST /sources`
and the view on request: outcome 4. The agent skill: outcome 3. Extraction
plugins and facts, rules, flows, views per environment or state, ad-hoc Cypher
for agents, logging conventions (set with the server, the first component that
logs).

## Changes to requirements
Four capabilities are added against an empty baseline, their complete proposed
text in `capabilities/`: intended-model (reading and checking the model),
compiled-model (`model.json`), model-history (versions with both time axes)
and graph-queries (LadybugDB answers).

## Preserved contracts
None.

## Coverage
- intended-model/strict-yaml: test
- intended-model/schema: test
- intended-model/files: test
- intended-model/ids: test
- intended-model/references: test
- intended-model/nesting: test
- intended-model/moves: test
- intended-model/relations: test
- intended-model/transfers: test
- intended-model/contracts: test
- intended-model/zones: test
- intended-model/environments: test
- intended-model/states: test
- intended-model/evidence: test
- compiled-model/shape: test
- compiled-model/deterministic: test
- compiled-model/effective-zones: test
- compiled-model/presence: test
- model-history/store-version: test
- model-history/replace: test
- model-history/idempotent: test
- model-history/order-by-commit: test
- model-history/sources: test
- model-history/lossless: test
- graph-queries/as-of: test
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/dependencies: test
- graph-queries/rebuild: test

## Blocking questions
None.

## Design and decisions
See `design.md` for the format on an example and the mechanism. Decided with
the owner on 2026-09-24: LadybugDB in the foundation; environments and a chain
of states in the format and storage, their views later; no rules or flows; the
model folder `madarch/` in a repository. Taken from the decisions: YAML in git
(0002), layers (0005), bindings by variable name (0006), the bitemporal log and
LadybugDB (0009, amended), format principles (0014: flat stable ids, followed
over 0003's namespaced example), states (0015), TypeScript on Bun with
Bun-specific APIs in adapters (0008). Checked before writing: LadybugDB 0.20.4
answers a time-filtered transitive path query correctly under Bun 1.4.2 and
ships prebuilt binaries for macOS and Linux.

Checks watch the library's public interface: load a model folder, compile,
store a version, read as of a time, and the queries. Fixtures are small
hand-written models with expected answers written from the requirements, not
produced by the code. Errors are values with the file, line and path; the
library does not log.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stage's
acceptance record.

## DONE WHEN
Conformance tests pass for the review's scenarios (a service gains internal
elements; a service moves to another domain; one request carries different
data categories each way; two environments differ in endpoints and zones; a
general relation and its refinement are not counted twice); a model using
environments and states compiles and is stored without loss; as-of reads on
both time axes through the query engine return the expected graph. Where it is
seen: nowhere a person looks yet. The outcome is a library; it is observed
through its tests and the `model.json` it writes, and becomes visible with
outcomes 2 and 4.
