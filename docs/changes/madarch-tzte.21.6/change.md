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
  `call`, `reference` and `inherits` edges the mentions fold into, each with its
  **precision** (`compiler` where a compiler's index named the symbol,
  `syntactic` where this fill's own reading did) and, for `call` and `reference`,
  the count of their sites; and the file's `coverage`.
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
- **Stage 3's own plan keeps its older answer** (filed as madarch-tzte.21.9). The plan's rules 3 and 4 read
  stage 3's published gaps and import edges, which stage 3 re-writes only when the
  importing file's bytes move (`src/fill/stages/syntax.ts`): after this stage
  resolves a specifier that appeared or moved, stage 3's gap for it and its
  `import` edge still say the older thing until that file's bytes move. This
  stage's own facts are the newer truth, its reads are what keeps it from
  re-planning forever, and the stage-3 half is filed as madarch-tzte.21.9.
- **A method of an object literal is stage 3's to name** (filed as madarch-tzte.21.10). Stage 3 publishes
  `const handlers = { save() {} }`'s `save` at the file's own scope, so a bare
  `save()` anywhere in the file resolves to it. The resolution follows the graph
  it is given; the naming is stage 3's, and it is filed as madarch-tzte.21.10.
- A default import resolves to the target file's `default` symbol, and stage 3
  publishes that symbol only for an *anonymous* default export (`export default
  class {}`). A default export that names itself (`export default function
  named() {}`) is the symbol `named`, so an `import x from './that.js'` is written
  as unresolved at each use, with its place, until a resolver reads the export
  clause. Two tests hold the two shapes: the anonymous default export resolves,
  and the named one is a gap with its place.
- A Go qualified type (`http.Client`) is read by neither part: its package is one
  this reader does not follow and its type belongs to that package, so neither is
  a mention — and a same-named type of the file is never mistaken for it.
- Go's package imports resolve to no symbol: an import path names a directory of
  another package, and mapping it to this repository's files needs the module path
  stage 2 reads. Their names are the file's coverage gap, and Go's own file-scope
  names resolve as any other file's do.
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
  what "resolved" means in the graph. Said plainly: **this change writes no
  `resolves` edge at all**, and it writes `inherits`, a kind the DONE WHEN does
  not name but the schema declares stage 4's. The reading is asked of the owner at
  acceptance, as madarch-tzte.21.3's `contains`/`defines` reading was.
- **A resolution is an occurrence, and a relation is an edge.** Every mention the
  stage resolves writes an `occurrence` at the mention's own place, whose
  `symbol` is the symbol it names and whose one role is `read-access` or
  `write-access`: the finest statement the schema can hold, one fact per place.
  The aggregated edges (`call`, `reference`, `inherits`) state the relation
  between two symbols, with the provenance of the earliest site in the file's own
  bytes and, for `call` and `reference`, `count`; `inherits` carries its form and
  no count, an `extends` clause being one statement about one pair of types. The schema asks for exactly this division: "Calls are
  aggregated per pair of symbols (not one edge per call site …)".
- **What the resolver resolves.** A mention names a symbol of this repository
  when the name is bound (1) by a declaration of the file the mention stands in —
  the nearest one that is *in scope* at the mention and stands before it, else a
  top-level one, and a declaration that stands after the mention only where it is
  of the mention's own scope and the language hoists it
  (`function run() { create(); function create() {} }` is the file's own
  `create`, never the import of that name) — all as stage 3 published them; (2) by an import of the file whose specifier is a
  relative one this stage can tie to a file of the repository — a named import, an
  aliased one, a default import (the target's `default` symbol) and `ns.name`
  through a namespace binding; (3) by a compiler's index, where the wiring has
  one, which answers the symbol at the mention's place **before** anything this
  file binds — an index's answer is the one name a parameter or a package
  shadows, which is exactly where a syntactic reader is weakest.
  A *bare* mention of a namespace binding (`f(ns)`, `return ns`) names a module,
  and the schema holds no symbol for a module: it is out of the claim rather than
  an edge to the target's default export, which is a different symbol with a
  different meaning.
  **Only a lexical scope shadows a name.** A function, a method, a module and a
  namespace hold the names a bare mention of their bodies reaches; a class, an
  interface, an enum and a struct hold *members*, which no bare name reaches
  (`total()` inside a method is the file's own `total`, never the method beside
  it), so their members never shadow an import or a top-level declaration.
  **A block is not a scope this reader can see**: stage 3 names a declaration
  inside a block by the declaration that holds it (`f.c`) and publishes no block,
  so a mention outside a block may bind to a declaration of another block of the
  same function. That is the price of resolving locals at all: the alternative —
  never resolving one — loses every local call, and a name that two blocks of one
  function declare is not something the graph can tell apart today.
- **What it deliberately does not resolve, and how that is said.** A mention
  whose name a parameter of an enclosing declaration binds names that parameter:
  the syntax stage reads declarations, not parameters, so the mention is out of
  the claim rather than an edge to the outer import of the same name. A name
  nothing in the file binds (a global, a built-in, Go's predeclared types, an
  ambient type) is out of the claim too. An import of a package outside the
  repository is named **once, in the file's coverage** (`src/a.ts imports
  "lodash", which names a package outside this repository`) rather than as one
  gap per use: the fact is about the import, and a page that showed a gap per
  `react` call would drown the useful ones.
- **Unresolved is written, never dropped.** A mention the resolver claims and
  cannot tie to a symbol is a coverage gap naming the name and its own place
  (`missing at src/a.ts:4:2`), with the reason. Three ways of failing are told
  apart, because they are three different facts:
  1. a relative specifier that names no file of the repository — the import is
     named once (`src/a.ts imports "./missing.js", which names no file of this
     repository`, so a specifier no name of which is ever used is still no
     silence), and the names it binds are this reader's claim that it cannot tie
     down, so **each use of one is a gap at its own place** (`create at
     src/a.ts:4:2, the specifier "./missing.js" names no file of this
     repository`);
  2. the target file declares no such name (a named import of a name it does not
     declare, a default import of a file with no `default` symbol) — a gap at the
     mention's place naming what the file does not declare;
  3. the mention stands in no symbol of the file, so no edge can name a caller —
     a gap at its place saying exactly that.
  The file's coverage is therefore the honest statement of what this reading did
  and did not tie down, which is 0005's "not enough data", never absence.
- **Precision is a field of the edge, and the compiler's answer wins where both
  exist.** `call`, `reference` and `inherits` carry `precision: 'compiler' |
  'syntactic'`; a relation whose sites were resolved both ways keeps `compiler`,
  because the stronger reading of the same two symbols is the one a reader of the
  graph should weigh. The kinds' value shapes move to version 2 under the
  schema's own rule ("a kind whose value changes moves alone"). `precision` is
  **required** of the value's type, because decision 0026 makes the precision part
  of what such an edge *is* — an edge whose reading weight nobody knows cannot be
  written — and every producer of the three kinds writes it; the schema refuses a
  field it does not define and does not refuse an absent one that no identity part
  reads, for this kind as for every other, and the record says so rather than
  implying a check the schema does not make. The fixtures that build call edges by
  hand (test/fill-fact-store-scenario.ts, test/fill-graph-reads.test.ts) write
  `syntactic`, the reading every stage-4 edge has today; `GraphEdgeRef`
  (src/fill/graph-reads.ts, madarch-tzte.20.3) answers a neighbour's `precision`
  beside its `count`, so a reader weighs a name-based call below a compiler's.
- **An aggregating edge says what it counted.** `call` and `reference` fold their
  sites into one edge with `count`, and `inherits` carries its form and no count
  at all — an `extends` clause is one statement about one pair of types — with the
  provenance of the earliest site in the file's own order — which retires the doc's older "code-point-smallest call
  site", since code points put line 10 before line 3 — and `inherits` carries no
  `count` at all: an `extends` clause is one statement about one pair of types,
  and the schema holds no count for it.
- **The stage's plan re-resolves what a commit moved, and what read it.** Four
  tracked reads answer it: the published tree (which files' blobs moved, and
  which published paths the commit no longer holds), the `import` edges stage 3
  published (which files' resolution read another file's symbols), and the gaps
  of stage 3's coverage (a specifier it could not tie to a file, whose mentions
  are the ones a file that appears would let this stage resolve). So a run plans
  1. a source file whose blob moved or that is new,
  2. a source file that imports (per the published edges) a file whose blob
     moved **or that the commit no longer holds** — a target that vanished takes
     the symbols its importers read with it,
  3. a source file whose published gap names a specifier that names a file of the
     pinned tree now — a file that *appears* under a specifier an unchanged file
     already wrote is a symbol that file reads now and did not read before,
  4. a source file whose published `import` edge names a file its specifier no
     longer names — a `./x.js` written beside the `x.ts` it resolved to is the file
     that specifier answers now,
  5. a published source path the commit no longer holds, whose unit publishes
     nothing and so retracts what an earlier run wrote there,
  and nothing else. Rules 3 and 4 are answered against this stage's own last
  reading (`stage-4-published-reads`, its own coverage's `read`): a target it
  already read is one its edges already name, so a specifier whose meaning moved
  plans a file once and not on every later run of an unchanged commit. A graph
  that answers the gaps read with nothing has no gap for rule 3 to fire on; a
  graph that answers the own reading with nothing leaves rule 4 unbounded — it
  re-plans on every run of an unchanged commit, which is a re-plan and never a
  wrong edge — so a wiring for this stage answers it. The unit makes the same relation a *dependency*: it reads the
  symbols of the file itself and of every file its imports name, so the
  orchestrator's recheck of a published unit's reads (§0027) invalidates exactly
  the units whose reading moved. A source path stage 3 read but this stage did
  not (a `.py` file) has a unit all the same: it publishes its coverage, which
  names why.
- **The plan's two newer reads need no capability of their own.** It reads stage 3's
  `coverage` facts, and `consumes` names `file`, `import` and `symbol` as its
  required capabilities: both `import` and `symbol` are stage 3's, so a run that
  disabled stage 3 starves this stage by name (0027's starvation path) before the
  gap read could answer nothing. The capability table matches by kind, and
  `coverage` is produced by five stages, so declaring it would draw five ordering
  edges for one read.
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
exact SHA and two independent review rounds. Mutation is not run as a Stryker
job: the owner's rule runs it once per assembled stage, and a bounded manual
sample of three mutants (each killed) is recorded on the task instead.

The first review round (a fresh `deepseek-v4.1-flash-auto` session over
`git diff origin/main...HEAD`) answered `fix-before-ship` with two defects, six
should-fix items and eight nits; all of them are answered with the test that
holds each. The plan's second rule read the published import edges alone, so a
target the commit deleted left its importers' edges standing and a file that
appeared under a specifier an unchanged file already wrote was never resolved:
the plan now reads stage 3's coverage gaps as well, counts a vanished published
source path as a moved target, and re-plans an importer whose published specifier
names another file of the pinned tree now. A bare mention of a namespace binding
fell into the default-import path and could name the target's default symbol; it
now names a module, which the schema holds no symbol for, and stays out of the
claim. A compiler index is consulted before anything the file binds. A relative
specifier that names no file is a gap at the import and at each use; a package
outside the repository stays one gap for the import, worded for what it is, and
the index's absence is named per file rather than claimed of the repository.
`nearestDeclaration` replaced the containment-only rule: a declaration of a
lexical scope shadows a name from its own line on, a hoisted one does too, a
class member never does, and a declaration of another function is unreachable.
The two readers measure spans through one `spanFactory`, Go's member access is
the node Go writes, and two facts of one id that say different things are refused — named by the file
and the place of each — rather than one of them folded away, which the syntax
stage still does for its own facts.

The second round verified all sixteen of the first round's findings and answered
`fix-before-ship` with twelve of its own, two of them defects: a class member
shadowed a bare name (a wrong edge, and the first round's own test had enshrined
it), and a specifier that already resolved kept its stale resolution when a file
appeared beside its target. Both are fixed — the lexical-scope rule above, and
the plan's comparison of each published specifier with what it names at the
pinned commit — with tests that fail without them, and the record's rule (1), its
count wording, its "both shapes of a default export" claim and the block-scope
limit are corrected to what the code does. Its fourth round confirmed the eleven
answers and found two defects of its own in them: the test the third round asked
for did not discriminate (it planned against a graph that held no stale gap or
stale edge, so both new rules were quiet either way, and it now plans the second
commit's tree against the first commit's stage-3 facts), and the record's "a
graph that answers either read with nothing makes the rules a no-op" was false
for the second rule, which now says what it does.

The third round verified the second round's twelve and answered `fix-before-ship`
with eleven, two of them defects: the hoisted fallback looked only at the
mention's own innermost declaration, so a declaration of an *enclosing* scope
that stood after the mention fell through to the import of that name (a wrong
edge); and the plan's two rules about a specifier whose meaning moved fired again
on every later run of an unchanged commit, because stage 3's own plan keeps its
older gap and import edge. Both are fixed: the fallback runs over every in-scope
declaration, deepest first, and the two rules are bounded by this stage's own
last reading, with a test that a second run of one commit plans nothing. Stage
3's half of the second — its plan's own staleness — is filed as
madarch-tzte.21.9, and stage 3's naming of an object literal's method, which a
bare name anywhere in the file resolves to, as madarch-tzte.21.10.
