# The semantic resolution stage resolves a file's imports and references to the symbols they name

Change: madarch-tzte.21.6
Base: 397415b4a89cf5b3b634e11074ad94c5db107412
Tasks: madarch-tzte.21.6
Kind: no-behavior

## Intent

Decision 0026 rebuilds the fill as deterministic stages that read a pinned tree
and write the product graph. Stage 3 (madarch-tzte.21.3) landed the syntax
stage: one unit per source file, writing the symbols a file declares, the
occurrence at each definition, its comments, entry points, tests, and the files
it imports. What a file's *names mean* is stage 4 — which symbol a mention of a
name names — and nothing in madarch answers it: the graph holds the declarations
and the file-to-file import edges, and no edge between a symbol and the symbol it
calls, mentions, extends or implements. Every later stage that needs the code's
own dependency graph — the modules stage's clusters and PageRank (madarch-tzte.21.7),
the agent stages' module understanding — has nothing to read.

This change adds the resolution stage, in four modules and one registration line:

- **`src/fill/stages/resolution-extract.ts`**, the pure per-file reading: one
  repository path and one file's bytes go in, and the names the file binds from
  other modules (a named, aliased, default or namespace import; a Go package
  import) and the places it mentions a name — a call, a mention, an `extends` or
  an `implements` clause, with the access the mention makes — come out. It walks
  the same tree stage 3 parses, through the one parse both readers share
  (`readSyntaxTree`).
- **`src/fill/stages/resolution-facts.ts`**, what those findings become: one
  `occurrence` per mention that resolves, tied to the symbol it names; the
  `call`, `reference` and `inherits` edges the mentions fold into, each with the
  count of its sites and its **precision** (`compiler` where a compiler's index
  named the symbol, `syntactic` where this fill's own reading did); and the
  file's `coverage`.
- **`src/fill/stages/semantic-resolution.ts`**, stage 4: a unit per source file,
  planned from what the previous runs published, read at the pinned commit
  through `SnapshotSource`, and resolved against the symbols the graph holds —
  the file's own, and the files its imports name, each through a tracked read.
- **`src/fill/stages/index.ts`** gains one line, which is what registering a
  stage costs (decision 0027).
- **`src/fill/facts.ts`** gains `RESOLUTION_PRECISIONS` and the `precision`
  field of the `call`, `reference` and `inherits` edges, whose value shapes
  therefore move to version 2 — the schema's own rule that a kind whose value
  changes moves alone.
- **`src/fill/stages/syntax-extract.ts`** exports the one parse both readers
  share (`readSyntaxTree`, `spanFactory`) and is rewritten over it, so stage 3
  and stage 4 cannot drift apart on the tree, the language or the counting of a
  position.

## Out of scope

- The stages beside it: the build and configuration stage (madarch-tzte.21.5),
  the modules stage (madarch-tzte.21.7), the document index and history stages,
  and the agent stages 8–13 (madarch-tzte.24).
- **A SCIP or compiler indexer is not installed.** The stage asks the wiring for
  what a compiler resolved for a file (`stage-4-compiler-index`, declared as the
  optional capability `scip-index`); where it answers, the edges it names carry
  precision `compiler`. No run of this madarch has such a wiring today, so every
  edge this change writes is `syntactic` and the file's coverage names the index
  it did not have. Building the indexer (its own extraction, its adapter to the
  graph's symbol ids) is later work.
- A member of an access is not resolved: `order.total` mentions `order`, never
  `total`. Which member of which type a name reaches is a type checker's answer,
  and a syntactic reader that guessed it would draw edges nothing calls.
- A re-export (`export { a } from './x'`) is not followed: the name is not bound
  in the file that re-exports it, so an importer of that file finds no such
  declaration and the mention is written as unresolved, with its place.
- CommonJS bindings (`const x = require('./x')`) are not followed; the file's
  coverage names the `require` rather than leaving it a silence.
- The fact store, the bounded graph reads and the checked write path
  (madarch-tzte.20.2, 20.3, 20.4): this stage writes drafts into the stage
  context's draft set and leaves publication to them.
- The orchestrator (madarch-tzte.19.5) and the wiring of a real run
  (madarch-tzte.21.8): which wiring answers a read is that task's.
- The fill's capability text: the requirement these stages serve is proposed by
  `fill-pipeline-monday`, not current, and the rebuild's own requirement text
  lands with the stage that closes decision 0026.

## Preserved contracts

- product-wiki/pages: unchanged — a page stays the product's Markdown in git (0017); the resolution stage writes graph facts, no page reads them yet, and no command constructs the registry.
- product-repository/manifest: unchanged — nothing here reads the manifest or names a product's repositories; a run's pins are its wiring's, and this stage asks for them through `SnapshotSource` alone.
- release-binary/installers: unchanged — no dependency is added: the stage parses through stage 3's own `web-tree-sitter` and `tree-sitter-wasms`, which the compiled binary already bundles.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

Stage 4 is what turns a graph of declarations into a graph of code: without it
the fill knows which file imports which, and nothing about which symbol calls
which. The two edges a later stage reads most — the call graph and the import
graph — are written here, and the resolution's precision is written *on the edge*
rather than left to the reader's guess, because the difference between a
compiler's answer and a name-based one decides which links a page may present as
fact.

Nothing here changes what the product does: no command constructs the registry,
no stage runs, and `src/product/fill*.ts` is untouched.

## Design and decisions

- **The task's `resolves` edge, read against the landed schema.** The DONE WHEN
  names `resolves`, `call` and `reference` edges. The schema landed by
  madarch-tzte.20.1 gives `resolves` one meaning — stage 2's "an endpoint belongs
  to a deploy unit instance" (`EDGE_END_KINDS.resolves` is `api-endpoint →
  deploy-unit`) — and gives stage 4 the three kinds `call`, `reference` and
  `inherits` (each declared `stages: ['4-resolution']`). This change therefore
  reads the task's "resolves" as the *act* of resolving: the stage writes the
  `call`, `reference` and `inherits` edges of its stage, and the `occurrence`
  fact that ties a mention at its own place to the symbol it names — which is
  what "resolved" means in the graph. The reading is asked of the owner at
  acceptance, as madarch-tzte.21.3's `contains`/`defines` reading was.
- **A resolution is an occurrence, and a relation is an edge.** Every mention the
  stage resolves writes an `occurrence` at the mention's own place, whose
  `symbol` is the symbol it names and whose one role is `read-access` or
  `write-access`: the finest statement the schema can hold, one fact per place.
  The aggregated edges (`call`, `reference`, `inherits`) state the relation
  between two symbols, with `count` and the provenance of the earliest site in
  the file's own bytes. The schema asks for exactly this division: "Calls are
  aggregated per pair of symbols (not one edge per call site …)".
- **What the resolver resolves.** A mention names a symbol of this repository
  when the name is bound (1) by a declaration of the file the mention stands in —
  the nearest declaration whose own span holds the mention, else a top-level one,
  as stage 3 published them; (2) by an import of the file whose specifier is a
  relative one this stage can tie to a file of the repository — a named, an
  aliased, a default and a namespace import, and `ns.name` through a namespace
  binding; (3) by a compiler's index, where the wiring has one, which answers the
  symbol at the mention's place whatever this file binds.
- **What it deliberately does not resolve, and how that is said.** A mention
  whose name a parameter of an enclosing declaration binds names that parameter:
  the syntax stage reads declarations, not parameters, so the mention is out of
  the claim rather than an edge to the outer import of the same name. A name
  nothing in the file binds (a global, a built-in, an ambient type) is out of the
  claim too. An import of a package outside the repository is named **once, in
  the file's coverage** (`src/a.ts imports "lodash", whose symbols are not in
  this repository`) rather than as one gap per use: the fact is about the import,
  and a page that showed a gap per `react` call would drown the useful ones.
- **Unresolved is written, never dropped.** A mention the resolver claims and
  cannot tie to a symbol — the specifier names no file of the repository, the
  target file declares no such name (a default import of a file that exports
  none), or the mention stands in no symbol of the file, so no edge can name a
  caller — is a coverage gap naming the name and its own place
  (`missing at src/a.ts:4:3`), with the reason. The file's coverage is therefore
  the honest statement of what this reading did and did not tie down, which is
  0005's "not enough data", never absence.
- **Precision is a field of the edge, and the compiler's answer wins where both
  exist.** `call`, `reference` and `inherits` carry `precision: 'compiler' |
  'syntactic'`; a relation whose sites were resolved both ways keeps `compiler`,
  because the stronger reading of the same two symbols is the one a reader of the
  graph should weigh. The kinds' value shapes move to version 2 under the
  schema's own rule ("a kind whose value changes moves alone").
- **The stage's plan re-resolves what a commit moved, and what read it.** One
  tracked read of the published tree answers which files' blobs moved; one of the
  published `import` edges answers which files' resolution read another file's
  symbols. So a run plans the moved files, their importers, and a retraction for
  a published source path the commit no longer holds — and nothing else. The unit
  makes the same relation a *dependency*: it reads the symbols of the file itself
  and of every file its imports name, so the orchestrator's recheck of a
  published unit's reads (§0027) invalidates exactly the units whose reading
  moved. A source path stage 3 read but this stage did not (a `.py` file) has a
  unit all the same: it publishes its coverage, which names why.
- **A unit is a file, and an absent path publishes nothing.** The unit id is
  `file:<repository>:<path>` — the same file unit stage 3 plans, over the same
  scopes — so the incrementality is per file and a rename leaves no stale fact:
  the vanished path's unit publishes an empty set, which the publication retracts.
- **Errors name the read, the row and the field.** Every row of every read this
  stage makes is read strictly (a key the read does not define, a symbol row for
  another file, a place standing twice in one index answer, an id that is no fact
  id) and a refused row names the read, its number, the repository and what was
  wrong with it — a row read past would plan a wrong unit or resolve a mention to
  a symbol the graph does not hold, in silence.
- **One parse, one counting.** Stage 3 and stage 4 share `readSyntaxTree` and
  `spanFactory`: the same four grammars, the same UTF-16 column counting, and one
  place a file is decoded and refused. A test holds the two readers together from
  the other side: no mention this stage reports stands at a position stage 3
  published as a declaration.

## Acceptance evidence

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.6:
`bun run check`, the focused suites on the SkyPilot pod (`--avx2`: the
tree-sitter wasm grammars need it), the feature document gate, green CI on the
exact SHA and one independent review round. Mutation is not run: the owner's
rule runs Stryker once per assembled stage.
