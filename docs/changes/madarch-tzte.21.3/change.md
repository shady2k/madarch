# The syntax stage reads each source file of a pinned repository with tree-sitter

Change: madarch-tzte.21.3
Base: 5c712dea9b05a1993ffe6ed8fd0035c985350df8
Tasks: madarch-tzte.21.3
Kind: no-behavior

## Intent

Decision 0026 rebuilds the fill as deterministic stages that read a pinned tree
and write the product graph. Stage 0 (the snapshot) and stage 1 (the inventory)
land with madarch-tzte.21.1; what the *code* of a file says — which symbols it
declares, where each definition stands, what its comments, its entry points, its
tests and its imports are — is stage 3, and nothing in madarch answers it after
the rebuild began. The landed `src/product/fill-index.ts` walks a checkout with
its own git calls and its own idea of a tree, and writes JSON files under the
run's output folder rather than facts with ids.

This change adds the syntax stage, in three modules and one registration line:

- **`src/fill/stages/syntax-extract.ts`**, the pure per-file extraction: one
  repository path and one file's bytes go in, and the symbols the file declares,
  the position of each declaration, its comments, its entry points, its tests
  and the modules it imports come out, each with the byte span and the line span
  it stands at. The grammars are the four `src/product/fill-index.ts` reads
  (`tree-sitter-wasms` over `web-tree-sitter`), so the rebuild parses what the
  landed fill parsed.
- **`src/fill/stages/syntax-facts.ts`**, what those findings become: the facts
  of `src/fill/facts.ts` — `symbol`, `occurrence`, `comment`, `entry-point`,
  `test`, the `defines` and `import` edges, and one `coverage` node per file —
  each with its place, its layer and the id the schema computes from what the
  fact is about.
- **`src/fill/stages/syntax.ts`**, stage 3: a unit per source file, planned from
  what the previous runs published and read at the pinned commit through
  `SnapshotSource` (`src/fill/snapshot.ts`, stage 0).
- **`src/fill/stages/index.ts`** gains one line, which is what registering a
  stage costs (decision 0027).

A file in a language no grammar of this stage reads is a coverage gap with its
reason, never a silence: the stage's own tests prove it for a `.py` file, for
bytes that are not UTF-8 text, for a file the parser could not read whole and
for a specifier it cannot tie to a node.

## Out of scope

- The stages beside it: semantic resolution (stage 4), modules and PageRank
  (stage 5), the document index (stage 6), history (stage 7) and the agent
  stages 8–13 (madarch-tzte.21.4 to 21.7 and madarch-tzte.24).
- The fact store, the bounded graph reads and the checked write path
  (madarch-tzte.20.2, 20.3, 20.4): this change writes drafts into the stage
  context's draft set and leaves publication to them. The write path's check
  that an edge's both ends exist is what refuses a `defines` edge whose file fact
  the graph does not hold.
- The orchestrator (madarch-tzte.19.5) and the wiring of a real run
  (madarch-tzte.21.8): what a product's pins are, and which reader answers a
  plan's read. This change uses the read `src/fill/stages/inventory.ts` states
  and its own tests answer it.
- The calls and references a resolver names (`call`, `reference`, `inherits`):
  stage 3 reads declarations, not uses of them.
- Replacing the landed fill pipeline under `src/product/fill*.ts`: nothing here
  calls it, and nothing calls this.
- The fill's capability text: the requirement these stages serve is proposed by
  `fill-pipeline-monday`, not current, and the rebuild's own requirement text
  lands with the stage that closes decision 0026.

## Preserved contracts

- product-wiki/pages: unchanged — a page stays the product's Markdown in git (0017); the syntax stage writes graph facts, no page reads them yet, and no command constructs the registry.
- product-repository/manifest: unchanged — nothing here reads the manifest or names a product's repositories; a run's pins are its wiring's, and this stage asks for them through `SnapshotSource` alone.
- release-binary/installers: unchanged — no dependency is added: `web-tree-sitter` and `tree-sitter-wasms` are already dependencies and the landed walk already imports the same four grammars, so the compiled binary bundles exactly what it bundled before.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

Every later stage of the deterministic fill reads what this stage wrote: the
resolver resolves the symbols and imports it named, the modules stage clusters
the dependency graph its `import` edges draw, the document index links documents
to the symbols it found, and the agent stages read its symbols, comments and
entry points. So the extraction is written pure — one function of a path and
bytes, with its own tests — before anything depends on where the bytes come
from, and the stage around it stays a thin plan and execute over the reader the
snapshot stage landed.

The stage reads no working tree and no file path of its own: its bytes come from
`SnapshotSource`, its unit identity is a repository and a path, and its ids come
from `src/fill/facts.ts`, so the same source file read on another machine, in
another run, at another commit is the same set of facts.

Nothing here changes what the product does: no command constructs the registry,
no stage runs, and `src/product/fill*.ts` is untouched.

## Design and decisions

- **The extraction is pure, and it is a function of the path and the bytes.**
  `extractFileSyntax(path, bytes)` reads nothing else — no clock, no file
  system, no network, no database, no run — so the same bytes at the same path
  answer the same findings on every machine, and a test proves it by extracting
  twice. The tree-sitter runtime is initialized once per process and the four
  grammars are loaded lazily, one per language; a parser is made per file and
  deleted with its tree.
- **What is a symbol, and what is not.** This stage reads *declarations*: a
  function, a generator, a class, a method, a class field, an interface, a type
  alias, an enum and its members, a namespace or module, a constant, a variable,
  a named function or class expression, and the names a destructuring pattern
  binds; and, in Go, a function, a method, a struct or interface or named type, a
  struct member, an interface's method set, a constant and a variable. What is
  *not* read is a parameter, a property access and a call: those are stage 4's
  symbols, where a resolver names them precisely. A declaration inside a body is
  read and qualified by what holds it (`f.inner` for a function declared inside
  `f`), which is the same rule as above. A declaration's qualified name
  is its container's names and its own (`OrderService.create`), the container
  being the class, interface, enum, module or function it stands in — and, for a
  Go method, the type its receiver names, which is what makes it a method.
  A declaration this walk cannot name (a computed class member) is no symbol,
  and the file's coverage names the place with the reason rather than leaving
  the file complete over a dropped declaration. A *declaration* is read wherever
  it stands in the file, a function's own body included, qualified by the
  declarations around it (`f.inner` for a function declared inside `f`,
  `f.y` for a constant declared inside it); what is not read is a parameter, a
  property access and a call. A destructuring declaration binds the names its
  pattern writes (`const { a, b: c, ...rest } = order` declares `a`, `c` and
  `rest`). A module declaration names itself by the string it names (`declare
  module 'x'`), and its members are qualified by it; a class's initializer is
  the `constructor` the schema names, not a method; a Go interface's method set
  is read (`Handler.Serve`); and an anonymous default export — written in the
  statement's `value` field, not its `declaration` — is the symbol `default`. A member signature is read where
  it stands in one of the declarations that *name* their members — an interface,
  a type alias, a class, an enum, a namespace — and not where it stands in an
  anonymous type (`{ name: string }` in a parameter's annotation): a bare `name`,
  or a misleading `View.name`, beside a real symbol's name is worse than the
  silence of a member nothing can reach.
- **A name is an identifier in the language's own alphabet.** The name a
  declaration binds is read against Unicode's identifier rule (`\p{ID_Start}`,
  then `\p{ID_Continue}`, with `_`, `$` and a private member's `#`), so a
  declaration named `café` or `Ω` is a symbol rather than a hole in a file this
  stage would otherwise call complete. A declaration of a kind this stage reads
  whose name it cannot read — a computed class member (`[Symbol.iterator]() {}`)
  — is not invented and not dropped in silence: the file's coverage names the
  place with the reason `unsupported`, and `complete` stops claiming the file
  was read whole. A Go declaration that binds several names (`var a, b = 1, 2`,
  a struct's `x, y int`) declares every one of them.
- **A definition is one occurrence at the name.** Every symbol carries its
  declaration's span — where the symbol stands — and the name token's span,
  where the schema's `occurrence` node stands with the one role `definition`.
  The finer roles (`read-access`, `write-access`, `import`, `test`) and the
  mentions of a name elsewhere in a file are stage 4's, as decision 0026 orders
  the two stages.
- **`defines`, not `contains`.** The task names `contains`, `defines` and
  `import` edges. The schema's own edge-end table (`EDGE_END_KINDS`) gives
  `contains` the sources `directory`, `module` and `repository`, and a file's
  symbols are joined by `defines`, whose stages are `3-syntax` and `4-resolution`
  — so a file's symbols are the `defines` edge here, and a `contains` edge from a
  file would be a fact the schema refuses once a write path checks its ends. The
  edges name the file's own `file` fact as their `from` end and the symbol or the
  imported file as their `to` end.
- **The file fact's id is computed from what a file fact is.** The schema's rule
  is that an id is the digest of what a fact is about and of nothing else, and a
  file fact's identity is its repository and its path (`FACT_KINDS.file`): the
  roles, the language, the size and the blob are not what the file is. So the
  stage names the id the inventory published for a file from the two parts it
  knows, and a test proves it by running the inventory stage over the same file
  and comparing the ids — including for an import's target. A write path that
  checks the nodes its edges name refuses a drifted id loudly rather than joining
  a file that is not there.
- **An import edge is as fresh as the file that wrote it.** A file whose bytes
  did not move is not read again, so an importer keeps the target it resolved
  to: a file that *appears* and can win a resolution (an `x.ts` beside the
  `x.cjs` an import of `./x.js` resolved to) changes what that import should
  point at only when the importing file's own bytes move. That is the price of
  reading per blob, it is the inventory's own rule for the edges it draws, and
  stage 4's resolution replaces these edges with a resolver's reading of the
  repository's own packages rather than a path's competition.
- **One reader of the published tree.** Both stages that plan from the inventory's
  read (`publishedTreeRead`) read its rows through one function
  (`publishedTreeRows`): a copy of that rule drifted apart within one rebase —
  a duplicate path and a folder carrying a blob were refused by one stage and
  accepted by the other — so the rule lives in one place.
- **An import edge only where a specifier names a file of this repository.** A
  relative specifier resolves against the repository's paths in one documented
  order — as written, then with each source extension in its place (a TypeScript
  `./x.js` is the `x.ts` a reader edits), then with each extension appended, then
  as a folder's `index` file — and the first path that exists wins, so the same
  tree always answers the same file. Among the replacements the importing file's
  own extension comes first, so a repository holding both `x.ts` and `x.cjs`
  reads a TypeScript file's `./x.js` as the `x.ts` beside it. A bare specifier (a package outside the file
  tree) and a relative one that names no file are the scope's coverage gap, which
  is what the schema asks for where a resolver could not tie an import to a node:
  a Go import names a package path and never a file, so a Go file's coverage
  names its imports as gaps. Stage 4 ties them to packages and modules.
- **A byte offset is measured once, and the cursor follows it.** The line index
  holds each line's first character and first byte, and a walk that moves forward
  measures only the distance it moved. A span *behind* the cursor (a name inside
  a declaration whose own end was read first) is measured from the start of the
  line it stands on, and the cursor moves back to it, so a walk that steps in and
  out of nested declarations pays for where it stands and not for the file again.
  The record measured this: `change.md`'s claim of linear time held for flat
  declarations and not for nested ones until the cursor followed the walk back.
- **Every fact carries its place, and the extraction carries the byte span too.**
  A fact's place is the schema's `FactPlace`: the repository path and a range of
  lines and columns (`FactRange` carries no byte offset). The task asks for a
  byte and a line span, so the *extraction's* findings carry both — the byte span
  is read from the line index in one pass, the columns are UTF-16 code units as
  the schema counts them — and a fact carries the range the schema gives it. A
  test pins both counts apart with an emoji above the declaration.
- **The plan reads what the previous runs published, and a file whose blob did
  not move is not planned again.** The plan makes the read the inventory's own
  plan makes (`publishedTreeRead`, one JSON document per repository) and reads
  the `file` rows the graph holds; a source file is planned when it is new or its
  blob moved at the pinned commit, and a *published* source path the commit no
  longer holds is planned as a retraction whose execute publishes nothing. So a
  one-file commit reads that file and no other, and a rename leaves no stale
  fact: what the vanished path's unit published is replaced by an empty set. A
  graph that answers nothing plans the whole tree of source files, which is what
  a first run is; a plan whose tree holds no source file says `nothing-found`
  rather than `planned`.
- **Which files are this stage's.** The inventory's own rule: a path whose roles
  include `source` (its extension is code) is read here, and a file that is no
  code is another stage's business. The extraction keeps its own language table,
  so the pure module depends on nothing but the schema; the stage asks the
  inventory for the roles, and a test asserts the two tables agree on each of the
  nine extensions this stage parses, and that a sample of the extensions the
  inventory calls code (`.py`, `.rs`, `.sh`) is planned here as a file no grammar
  reads, as the task and the change intend. The four grammars themselves are
  pinned by a test: a `.tsx` file's JSX parses (and the same text in a `.ts` file
  is the parser's own error), a `.jsx` file's JSX parses, and a `.go` file's
  declarations are read, so no grammar can be silently swapped for another. The
  version every fact's provenance names is checked against the installed
  runtime, since a literal that drifted would mislabel every fact.
- **A unit's id is the file, and it carries no blob and no run.** The id is
  `file:<repository>:<path>`, the scope `<repository>:<path>`: a file's unit is
  the same unit at every commit, so the run's own inputs digest (the blob) is
  what tells a changed file from an unchanged one. A unit id this stage never
  plans, a read row for another repository, a kind this stage does not read, a
  path that is no repository path and a blob that is no blob id are all refused,
  naming the unit or the read, the row and the field.
- **A symbolic link and a submodule are coverage, not silence.** A link's bytes
  are the path it points at and a submodule's tree stands in the repository it
  names: neither is a source text, so the file's unit publishes a coverage node
  whose `unread` names it with the reason `unsupported`, and no symbol is
  invented from bytes that are not code.
- **A walk the machine cannot finish is the file's gap.** The walk is recursive,
  so a file nested past the call stack's depth raises a `RangeError`; that one
  error is caught where the unit reads the file and published as its coverage gap
  with the reason `error`, so one pathological file loses neither the unit nor
  the run. Every other error still travels: a defect is not a silence.
- **A name that is no name is the file's gap, not a failed unit.** The schema
  refuses a fact whose identity part is empty — *after* trimming and collapsing
  its whitespace (`identityName`), so a name of spaces is as empty as an empty
  one — and a unit that raises over one file's oddity loses the whole file. So a finding the schema cannot hold is a coverage gap naming the
  question and the place, and the file's other facts are still made.
- **A coverage gap says a question, a path or a kind of file.** A dropped
  declaration's gap is the question the reader could not answer, naming the
  place (`the name of the declaration at src/x.ts:2:2`), so two drops on one
  line stand apart and a gap is what the schema says it may be.
- **Order is the project's own comparator.** `byCodePoint` compares strings with
  `<`, which orders UTF-16 code units: a name above the BMP sorts after U+E000.
  The whole project sorts this way (the inventory's tree and the registry
  included), so this stage is consistent with it; where an astral name must sort
  as a reader expects, the comparator is the place to change, not this stage.
- **What one fact can and cannot tell apart.** The schema decides a fact's
  identity, and two declarations the schema gives one identity are one fact: two
  TypeScript overloads of one function are one `symbol` (a `disambiguator` is
  stage 4's, SCIP's own), two same-named tests in one file are one `test`, and a
  method of an object literal is a symbol of its own name rather than of the
  object's (an object literal is no container). Occurrences do not collapse: each
  declaration keeps its own place, so three overloads leave three definitions of
  one symbol. The change states this rather than pretending the graph holds what
  the schema's identities do not.
- **A call named `test` or `it` is read as a test.** `test('name', …)`,
  `it('name', …)`, the runner's own modifiers (`it.only`, `test.each`) and a
  runner reached through a namespace a file imported (`runner.test(…)`) are test
  facts; the framework is named where the file imports the runner from a package
  this stage knows (`bun:test`, `jest`, `@jest/globals`, `vitest`), and left
  unnamed where the file says nothing about which one it is — a call of a local
  function named `test` is therefore read as a test, which is the price of
  reading a global runner's tests at all, and stage 4's resolver is where the
  distinction is drawn precisely.
- **An error names what it is about.** A reader refusal names the repository, the
  commit and the path (the reader's own words); a plan's refusal names the read,
  the row's place and the field; a unit's refusal names the unit id; a cancelled
  unit raises rather than publishing an empty draft, which would retract what its
  earlier generation wrote.

## Acceptance evidence

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.3:
`bun run check`, the focused suites on the SkyPilot pod (`--avx2`: the
tree-sitter wasm grammars need it), the feature document gate, green CI on the
exact SHA and one independent review round. Mutation is not run: the owner's
rule runs Stryker once per assembled stage.

The first review round (a fresh `deepseek-v4.1-flash-auto` session over
`git diff origin/main...HEAD`) answered `fix-before-ship` with thirteen findings
and no defect in the facts' ids, the stage contract or the plan's
incrementality. Fixed here: a declaration the walk could not name made the
file's coverage say `complete` while the declaration was dropped (the name rule
is Unicode's now, a Go spec's every name is read, and an unnameable declaration
is the file's coverage gap); the Go test rule did not match what `go test` runs
(`Test`, `Test_x` and `Benchmark_Helper` are tests and `TestMain` is not); the
two deviating acceptance criteria — `contains` versus the schema's `defines`,
and the byte span a fact has no field for — are stated above as the readings
they are and asked of the owner at acceptance; the byte offset is measured by a
forward cursor rather than by rescanning a line, so a minified single-line file
is read in linear time; a specifier replacement tries the importing file's own
language first; the two dead exports are gone; the plan refuses a published-tree
row holding a key the read does not define, as the inventory's own reader does;
and the record's design section states what the schema's identities do and do
not tell apart, and how a call named `test`/`it` is read. The tests the review
found missing are there: a `.tsx` and a `.jsx` case, a non-ASCII identifier, a
Go spec binding two names, the Go runner's own name rules, a namespace import's
runner, and the provenance version against the installed package.

The second round answered `fix-before-ship` again, with eight findings and seven
nits: the commit's own claim — "every dropped declaration is named" — was false
in three measured ways, and one of them was a regression from the first fix
round. Fixed here: an anonymous default export was dropped in silence (the
grammar writes it in the statement's `value`, which the code never read); a
module's own `function_signature` was dropped by the rule that keeps an
anonymous type literal's members out (the rule now judges the *holder*, and a
`function_signature` is exempt as the ambient grammar's own declaration form);
a non-ASCII enum member with no initializer was dropped while the coverage said
`complete`; a member of an anonymous type literal nested inside a named one was
published as that named type's member; the two readers of the published tree had
already drifted apart after one rebase (one reader now); an empty test name
raised out of the facts instead of becoming a gap; and the local-binding reading
the record denied. The two research findings are stated rather than changed: an
import edge is as fresh as the importer's own bytes, and the project's
`byCodePoint` orders UTF-16 code units. The tests the round asked for are there:
the four anonymous default shapes, the ambient declarations, an enum member in
another script, the nested anonymous types, a member of an exported value, a
destructuring pattern, a constructor and a Go interface's method set, an empty
test name, an aliased runner import, and the specifier order beside an `x.cjs`.

The third round verified fifteen of the second round's items as fixed and found
the class it had graded should-fix still open in three measured ways, plus nits.
Fixed here: a *whitespace-only* name still killed the whole unit through the
schema (the extractor now applies the schema's own emptiness rule — trim,
collapse — wherever it decides a name is no name, so a test, a command, a module
and a specifier of spaces are the file's coverage gap); a *named* function or
class expression was dropped in silence and its members took a container name
that exists nowhere (`const C = class Named { m() {} }` gave `C` and `m`; it now
gives `C`, `Named` and `Named.m`, and an anonymous expression is no declaration
and no gap); a parenthesized default export (`export default (class {})`) yielded
nothing, which the walk now reads through the parentheses and defines at the
statement's own `default` keyword; the byte cursor now follows the walk *back*
as well as forward, so a nested file no longer re-pays for the line it already
measured; a walk that cannot finish (a file nested past the call stack) is that
file's coverage gap rather than a unit that raises; the two row refusals the
shared reader gained are pinned in the syntax suite too; the unreachable branch
of a module's name reading is gone; and the record's own contradiction about
local bindings is gone with it.
