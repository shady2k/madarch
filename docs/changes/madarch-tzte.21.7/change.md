# The modules stage clusters the dependency graph into modules and ranks files, symbols and modules by PageRank

Change: madarch-tzte.21.7
Base: 5f912df70a5ce25c1f6609f0219ee2eb53ff72f3
Tasks: madarch-tzte.21.7
Kind: no-behavior

## Intent

Decision 0026 makes the fill a graph built in stages. Stages 1 to 4 land the
repository whole and flat: the inventory writes a file per path, the build and
configuration stage the packages and their dependencies, the syntax stage the
symbols a file declares, and the semantic resolution the calls, references and
inheritance between symbols. Nothing in madarch answers what that graph is *made
of* at a scale a person or an agent unit can read: there is no module between the
repository and its thousands of files, and no ordering that says which of them
matter. Every later stage that works in bounded units needs both — 0026's
"product → repository → package/build target → cluster → sub-cluster, split until
a unit's estimate fits", its fan-in bound of about fifty children, and its
"ranked symbols without bodies" in a unit's packet.

This change lands stage 5: one registered stage `modules` that clusters one
repository's dependency graph recursively into `module` facts, holds them with
`contains` edges, and writes every file's, every symbol's and every module's
importance from one PageRank over the repository's own resolved edges.

- **`src/fill/stages/modules.ts`**, stage 5: one unit per repository, its four
  tracked reads of the published graph, the recursive clustering, the ranking,
  and the facts it writes — the modules, the containment, the ranked files and
  symbols, and one coverage fact per repository.
- **`src/fill/stages/index.ts`**, the one place a stage is registered: one import
  and one `.register(...)`.
- **`src/fill/facts.ts`**: `FileValue.importance` and `SymbolValue.importance`
  (the module kind's own field already exists), the `file` kind's value shape to
  version 3 and the `symbol` kind's to 2, the stage list of both kinds gaining
  `5-modules`, a value check that an importance is a number in [0, 1], and
  `FACT_MEASURED_FIELDS` — the fields of a fact a later publication replaces.
- **`src/fill/fact-store.ts`**: the one place that rule is honoured — a
  publication of a fact id whose kind declares a measured field replaces exactly
  those fields of the stored value, leaves every other field the way
  madarch-tzte.20.2 fixed it, and moves the row's schema version with the value.
- **`src/fill/orchestrator-store.ts`**: a tracked read's membership digest leaves
  the measured fields out, so a re-ranking makes no unit that read the node stale.

Nothing runs: no command constructs the stage registry, and the stage's facts are
drafts the publication of madarch-tzte.20.2 applies.

## Out of scope

- **The stages beside it**: the document index and the history stage, and the
  agent stages 8–13 (madarch-tzte.24), whose module-boundary refinement (stage 9)
  and module understanding (stage 12) read what this stage writes.
- **A compiler's or SCIP index's resolution.** Every edge this stage ranks is the
  one the graph holds, at the precision stage 4 wrote on it; this stage never
  re-resolves a name.
- **Any clustering a person or an agent refines.** Stage 5's clusters are the
  packages' folders and the size threshold's split of them, computed without an
  agent (0026: "modules by recursive clustering of the dependency graph"); a
  refined boundary is stage 9's.
- **A dependency edge between modules.** The schema gives `dependency` to stage 2
  and to stage 5, and the DONE WHEN names modules, contains edges and importance;
  the module-level rollup of the graph's dependencies is not written here, and a
  reader follows a module's files to the edges between them.
- **The wiring a real run needs** (madarch-tzte.21.8): which wiring answers the
  four reads, and what a unit's own input digest is. This change states the reads
  and the unit's scope; the orchestrator of madarch-tzte.19.5 and the host that
  wires it are the task that runs it.
- **The React/UI side and the wiki**: no page renders a module or a rank yet.
- **The fill's capability text**: the requirement this stage serves is proposed
  by `fill-pipeline-monday`, not current, and the rebuild's own requirement text
  lands with the stage that closes decision 0026.
- **A pinned repository that holds no file.** It is no cluster and no rank, so the
  plan names no unit for it and this stage writes nothing about it; stage 0's
  coverage already records what that tree held, so the absence is attributable and
  not a silence of this stage.
- **A rank that outlives the publication that measured it.** A rank is written
  onto a fact the inventory and the syntax stage hold, so a row stays when the
  modules unit that measured it drops its facts, and the graph keeps the last
  measurement with no holding naming who measured it. That is a known limit of
  writing a stage's measurement onto another stage's fact; the fix would be a
  per-field record of the writer, which the holding table does not have.
- **A migration of facts published before this change.** A stored `file` or
  `symbol` row keeps the schema version it was published with, and no run of this
  fill has published one (nothing constructs the registry), so there is nothing
  to migrate; the first run under madarch-tzte.21.8 writes version 3 and 2.

## Preserved contracts

- product-wiki/pages: a page stays the product's Markdown in git (0017); this stage writes graph facts, no page reads them yet, and no command constructs the registry.
- product-repository/manifest: nothing here reads a product's manifest or names its repositories; a run's pins come from `SnapshotSource` alone.
- release-binary/installers: no dependency is added; the PageRank and the clustering are this repository's own arithmetic.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

`no-behavior`: the change adds one stage module, one registration line, two value
fields with their versions, one rule in the fact store and one declaration. No
command, page or contract reads any of them, and the product does exactly what it
did before.

The two schema fields are what makes the stage's result a fact of the graph at
all: a rank belongs to the node it ranks, and a page or an agent packet reads it
off that node. The fact store is where such a field can be lost — madarch-tzte.20.2
keeps the row of the publication that put a fact there first, because two units
that publish one fact are two readers' observations of it. A rank is not an
observation of that kind, and neither is the size of the cluster a rank belongs
to: decision 0026 makes both one measurement of the whole repository, so a
re-ranking must move the values a row already holds, or every rank — and every
module's member count — would be the one the first run measured, for ever. The
declaration `FACT_MEASURED_FIELDS` names exactly those fields, and the store
applies them from the publication that carries them, moving the row's schema
version and — where the publisher is the reader the row already cites — its
provenance with them, so a module fact of a later commit does not go on citing
the commit of a measurement its value no longer holds. A publisher of another
reader leaves the row's own provenance alone: stage 5 ranking stage 1's file fact
is not the reader that read the bytes. A read that answered a *rank* leaves it out
of the digest publication rechecks (`readMembership`, over `FACT_RANK_FIELDS`): a
read that answered a node was about the node, not about the number a later run
gave it, so a re-ranking makes no unit that read a file or a symbol stale —
neither stage 5's own nor stage 4's, whose symbol read would otherwise be
invalidated by every re-ranking. A module's `members` is not left out: it moves
when the tree moves, which is what a read of that module is about. The price of
the merge is that a ranked row is written where it used to be left alone, so
stage 1's republish and stage 5's ranking of one file take a row lock on each
other; publication order is by fact id, so the two cannot deadlock.

## Blocking questions

None.

## Design and decisions

- **A unit is one repository.** Clustering is not a per-file computation: a
  cluster's boundary depends on every other cluster of the repository and a rank
  on the whole graph's edges, so one unit is one repository, named
  `modules:<repository>` with the scope `<repository>`. That is 0026's own
  hierarchy taken at the coarsest level that computes the same answer twice;
  whether it must split further is a question of a unit's *estimate*, and a
  stage 5 unit reads no bytes at all — it reads facts the graph already holds —
  so there is nothing to estimate. The plan makes no read and compares no blob,
  the seam madarch-tzte.21.5's plan already leaves to the run's own input digest
  (madarch-tzte.21.8): a commit that moves no fact this stage reads replans
  nothing, and a commit that moves one re-clusters its repository and no other.
- **Four reads, each the unit's dependency.** The `package` facts stage 2
  published (the seeds), the `file` facts stage 1 published (what a cluster holds,
  with the value and the place each stands at), the `symbol` facts stages 3 and 4
  published (a file's symbols, and the nodes a rank is written on), and the
  resolved edges — `import` from stage 3, `call`, `reference` and `inherits` from
  stage 4, each with the site count stage 4 folded into it. The read asks for the
  imports *between files*: the schema also lets an import end at a module or a
  package, and those ends are no node of the rank, so a row naming one is refused
  and named rather than dropped. Every row of every read is read strictly: a key
  the read does not define, a kind the read does not answer, a value that names
  another file or another repository, an id that is not the digest of its value, a
  place that is no ascending range, an end that is no fact id of the kind the edge
  joins, a count on an edge that folds no sites, and a row answered twice are each
  refused naming the read, the row, the repository and the field.
- **A file belongs to the seed whose folder is the longest prefix of its path.**
  A package's folder is the folder its manifest stands in, so the innermost
  package holds its own files; two seeds claiming one folder (a `package.json`
  beside a `go.mod`) are told apart by their manifest's path in code point order.
  A `workspace` is no seed — `MODULE_SEEDS` names `package` and `build-target`,
  and a workspace holds the packages of its folders — and a package that names no
  manifest stands for no folder: both are named in the coverage. A repository
  with no seed at all is one cluster named after the repository itself. A seed
  whose folder holds no file seeds no module, and the coverage says so: a module
  of nothing is a boundary no later stage could refine.
- **Split by folder while a cluster is over the size threshold, and keep its own
  files in it.** A cluster holding more files than `sizeThreshold` (50 by
  default, 0026's "a size threshold" from the stage's own defaults) takes each
  folder below it as a cluster of its own and splits those by the same rule; the
  files standing directly in the cluster's folder stay in it. Two cases are over
  the threshold and cannot be split: a folder of fifty-one files with no subfolder
  beneath it — the cluster is kept whole and named in the coverage with the reason
  `too-large` — and a folder of fifty-five files beside a subfolder it did split
  off — the subfolder becomes a module, the fifty-five files stay in the cluster,
  and the coverage names them too, counting the files standing directly in it. The
  fill is never silently smaller than the graph it read, and a boundary the tree
  does not have is never invented.
- **Fan-in is bounded by an intermediate grouping level, at the top too.** A node
  with more children than `maxFanIn` (50 by default, 0026's "fan-in is bounded
  (~50 children, else an intermediate grouping level)") groups them, in code point
  order of their names, into intermediate modules of at most the bound each,
  named `part-1`, `part-2` and so on among their parent's children; a group's name
  one of the parent's folders already carries takes `.2`, `.3` … after it, so two
  clusters of one parent are never one fact. A group of groups is grouped again, so
  no module holds more than the bound of children at any depth, and the
  repository's own top level is bounded the same way — two hundred packages are
  grouped, not two hundred siblings. The modules the folders became keep the names
  they had. A bound below two groups one child into one group and never ends, so
  the stage's schema and its own configuration reader refuse it by name.
- **The repository holds its top-level modules.** A `contains` edge runs from the
  repository node to every top-level module, so a page or an agent unit walks from
  the repository down and a repository of one package is as reachable as one of
  fifty. `module.parent` stays absent at the top: a module's parent is the module
  that holds it, and the repository is no module.
- **Importance is one PageRank over the repository's own graph.** The nodes are
  every file and every symbol the reads answered, in code point order of their
  ids, so the walk is the same arithmetic in the same order in every run. The
  edges are the resolved ones — an `import` between two files, a `call`, a
  `reference` or an `inherits` between two symbols, weighted by the sites stage 4
  folded into it — and the declaration that a file holds its symbols, so a file's
  rank reaches the symbols it declares and the calls of those symbols carry it on.
  Damping is 0.85, a node with no outgoing edge spreads what it holds over the
  whole graph (PageRank's own dangling rule, which keeps the vector a
  distribution of one whole), the walk stops when no node moved by more than
  1e-12 — about 160 turns at that damping — and it stops after 500 turns at the
  most. A rank is written with twelve decimals, and the same graph answers the same
  number on every machine: the walk is the same arithmetic in the same order, so
  the turn it stops at and the vector it holds there are the same in every run.
- **A module's importance is the share its members hold** — the sum of the ranks
  under it over the sum of every node's — which is why the modules of one
  repository sum to one and every rank is a number in [0, 1], the range the schema
  gives the field. The module's `members` counts the files and symbols under it
  for the same reason: a page that shows a module shows what is inside it, and a
  fan-in group with nothing directly in it still says how large the part it
  groups is. Both are measurements of the cluster, so both are measured fields: a
  re-clustering moves the size with the rank it is computed beside.
- **`file` and `symbol` are written here and not declared in `produces`.** A rank
  is written onto the fact it is about — the file and symbol facts stages 1, 3 and
  4 published, one id each, with `importance` added — because a rank belongs to
  that node and every later reader already holds the node. That kind cannot be
  named in this stage's `produces`: a second producer of `file` would draw an edge
  from this stage to every stage that consumes `file`, the syntax stage among
  them, while this stage consumes the syntax stage's `import` and `symbol` — a
  cycle in the derived stage graph (decision 0027), which the registry refuses.
  `produces` names the capabilities a consumer of a stage waits for, and what this
  stage is the producer of is the modules and their containment; the ranked facts
  are the same nodes, and the stage's `validate` holds every write of them to the
  schema and to this stage's own list of kinds.
- **The coverage names what was asked and each cluster that could not be read
  whole.** One `coverage` fact per repository *and commit*: its scope is the
  snapshot fact of the commit the unit read (a snapshot's identity is the
  repository and the commit), so a second run at a later commit is a second
  coverage of a later tree rather than a row the store already holds — the same
  reason stage 0 writes one coverage per commit. Its `read` names the seven scopes
  its four reads asked for, and its `unread` every gap the clustering named — a
  workspace, a package with no manifest, a seed that holds no file, a cluster whose
  files are too many to split further — each with 0004's reason. A complete
  coverage is the only ground for a claim of absence (0005), and `read` names what
  the unit asked, not what a producer published: a run whose optional build stage
  is disabled asks the packages read and is answered nothing, which the graph's own
  stage order shows rather than this fact. Its reader is this stage,
  `fill-stage-5`, and not git: a coverage's identity is the repository, the scope
  and the reader, so a stage that named git's reader would compute stage 0's
  coverage id for the same scope and lose every gap it found to the row the store
  already holds. A stage that reads the graph and no bytes names itself, which is
  the same rule that makes stage 0's coverage and a compiler's two coverages of one
  repository.
- **Two modules of one name under one parent are one fact, and are refused
  rather than published once of the two.** Two package seeds may carry one package
  name: each top-level module of a shared name then says which manifest it came
  from (`@acme/web (packages/web/package.json)`), with the repository's own root
  cluster naming itself the same way. Every other collision — a unit that computed
  two facts of one id — is refused by name, since an id is a fact's identity.

## Acceptance evidence

Owner approval pending (coordinator).

The checks and the independent review are recorded on task madarch-tzte.21.7:
`bun run check`, the focused suites on the SkyPilot pod, the feature document
gate, green CI on the exact SHA, and the review rounds with their answers.
Mutation is not run as a Stryker job here: the owner's rule runs it once per
assembled stage, and a bounded manual sample of four mutants is recorded on the
task instead — damping 0.85 to 0.5, the dangling-node spread removed, the size
threshold's `<=` narrowed to `<`, and the code-point sort of the draft removed.
Three of the four were killed by the suite on the first run; the threshold one
survived, because no test held a cluster of exactly the threshold's size, and the
test the answer added kills it.

The first review round (a fresh `deepseek-v4.1-flash-auto` session over
`git diff origin/main...HEAD`, read-only) answered `fix-before-ship` with two
defects and six should-fix items, all of them answered here with the test that
holds each:

- **The coverage fact had stage 0's id, and its gaps were lost.** A coverage's
  identity is the repository, the scope and the reader; this stage passed the
  repository's own scope with `provenanceOf(reader)`'s git reader, so it computed
  stage 0's coverage id for the same repository and the store kept stage 0's row.
  The stage now names its own reader (`madarch-fill`, a stage that reads the graph
  and no bytes), and a test holds that the two ids differ.
- **A module's `members` was frozen while its `importance` moved.** The member
  count is stage 5's own measurement of the cluster, the same kind of value as the
  rank, so `FACT_MEASURED_FIELDS` names it and a re-clustering moves it; the
  scenario holds both fields moving and a publication that carries no rank leaving
  the rank it does not name.
- **A fan-in bound of one recursed for ever.** `maxFanIn` is `2` or more in the
  stage's schema, and its own configuration reader refuses anything below it by
  name, with a test.
- **The `too-large` gap was narrower than the record.** A cluster that split off
  its subfolders and kept files that were still over the threshold said nothing;
  it now names them, and a test holds the fifty-five-files-beside-a-subfolder
  case in miniature.
- **The stage's own publication invalidated its own tracked read**, and stage 4's
  symbol read with it: the membership digest now leaves the measured fields out,
  with a test that a rank moving is not a read moving and that another field still
  is.
- **A rank outlives the publication that measured it**: named as a limit of
  writing a stage's measurement onto another stage's fact, in Out of scope.
- **Tests that did not discriminate**: the seed rules (longest folder, the
  one-folder tie-break by manifest path), the name-collision rename, an edge's
  site count as a rank weight, the value check on a rank and a publication that
  names no rank each have a test now.
- **The file-to-file restriction of the imports read** is named in the read's own
  declaration and in this record; the module header's grouping names, the "twelve
  decimals" claim and `rangeIn`'s ascending check on one line are corrected.

The second round verified all fourteen and answered `fix-before-ship` with one
defect of the same class one level down, and eleven more items:

- **The coverage could never move after its first publication.** Its id carried
  the repository, the scope and the reader and no commit, so a second run at a
  later commit wrote the same id and the store kept the first row: a repository
  that grew a folder of three thousand files kept the first run's gaps and its
  `complete: true` for ever. The scope is now the snapshot fact of the commit the
  unit read, which makes a later commit a later coverage — the same thing stage 0
  does per commit — and the record says so.
- **The coverage named scopes no producer had answered.** `package`, `call`,
  `inherits` and `reference` are optional consumes and a unit cannot see which
  producers ran: `read` now says what the unit *asked* for, in the record and in
  the code, and which answer was empty is the run's stage order to show.
- **The membership digest dropped a measurement that is not a rank.**
  `members` moves when the tree moves, which is what a read of that module is
  about, so only `FACT_RANK_FIELDS` (the ranks) is left out now; and the digest's
  own doc says it reads a name from the schema and not a kind, so a future kind
  that declares a rank is the one place that says so.
- **A module row's provenance was frozen while its value moved.** A publisher
  that measures a row it already cites — the same reader as the row's own
  provenance — moves the row's provenance with the value; a publisher of another
  reader leaves it alone, so stage 1's file row keeps git's reader.
- **The top level had no container and no fan-in bound.** A `contains` edge now
  runs from the repository node to every top-level module, and the repository's
  own children are grouped by the same bound: two hundred packages are grouped,
  not two hundred siblings. `module.parent` stays absent at the top, the
  repository being no module.
- **A group's name could collide with a folder's.** A group whose ordinal a
  sibling already carries takes `.2`, `.3` after it, so two clusters of one
  parent are never one fact.
- **The merge was tested only from one publisher.** The scenario now publishes a
  file fact from an inventory unit, ranks it from a modules unit, publishes that
  unit again with no rank, and holds that the rank lands, stands, and that the row
  keeps the reader that read the bytes.
- **The tie-break test did not discriminate**: it answers the two seeds of one
  folder in the order that is *not* the rule's now.
- The summation order of a module's share, a `members` shape check (a whole number
  from zero), the reader's name (`fill-stage-5`, the schema's own convention for a
  stage), the evidence line of a fact about a file, the too-large rule's two cases,
  the turn bound the walk really reaches, the row lock the merge takes and a gap
  sentence that named a package for another seed's file are each answered here.
