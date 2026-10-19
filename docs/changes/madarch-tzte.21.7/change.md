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
  `FACT_RANKED_FIELDS` — the fields of a fact a later publication replaces.
- **`src/fill/fact-store.ts`**: the one place that rule is honoured — a
  publication of a fact id whose kind declares a ranked field replaces exactly
  those fields of the stored value, and leaves every other field the way
  madarch-tzte.20.2 fixed it.

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
observation of that kind: decision 0026 makes it one measurement of the whole
repository, so a re-ranking must move the value a row already holds, or every
rank in the graph would be the one the first run measured, for ever. The
declaration `FACT_RANKED_FIELDS` says which fields those are, and the store
applies exactly those and nothing else.

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
  stage 4, each with the site count stage 4 folded into it. Every row of every
  read is read strictly: a key the read does not define, a kind the read does not
  answer, a value that names another file or another repository, an id that is not
  the digest of its value, a place that is no ascending range, an end that is no
  fact id, a count on an edge that folds no sites, and a pair of ends answered
  twice are each refused naming the read, the row, the repository and the field.
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
  files standing directly in the cluster's folder stay in it. A cluster still
  over the threshold with no folder left to split by — a folder of fifty-one
  files — is kept whole and named in the coverage with the reason `too-large`:
  the fill is never silently smaller than the graph it read, and a boundary the
  tree does not have is never invented.
- **Fan-in is bounded by an intermediate grouping level.** A cluster with more
  children than `maxFanIn` (50 by default, 0026's "fan-in is bounded (~50
  children, else an intermediate grouping level)") groups them, in code point
  order of their names, into intermediate modules of at most the bound each,
  named `part-1`, `part-2` and so on among their parent's children — the name is
  the group's own ordinal and never depends on how many groups the folder happened
  to need. A group of groups is grouped again, so no module holds more than the
  bound of children at any depth; the modules the folders became keep the names
  they had.
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
  1e-12, and it stops after 100 turns at the most. A rank is written with twelve
  decimals: two nodes' values stay distinguishable, and the same graph answers the
  same numbers on every machine.
- **A module's importance is the share its members hold** — the sum of the ranks
  under it over the sum of every node's — which is why the modules of one
  repository sum to one and every rank is a number in [0, 1], the range the schema
  gives the field. The module's `members` counts the files and symbols under it
  for the same reason: a page that shows a module shows what is inside it, and a
  fan-in group with nothing directly in it still says how large the part it
  groups is.
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
- **The coverage names what was read and each cluster that could not be read
  whole.** One `coverage` fact per repository, its scope the repository's own fact
  id, its `read` the seven scopes the four reads cover, and its `unread` every gap
  the clustering named — a workspace, a package with no manifest, a seed whose
  folder holds no file, a cluster too large to split further — each with 0004's
  reason. A complete coverage is the only ground for a claim of absence (0005).
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
assembled stage, and a bounded manual sample of mutants is recorded on the task
instead.
