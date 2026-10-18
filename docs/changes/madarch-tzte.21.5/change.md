# The build and configuration stage writes packages, dependencies, deploy units, environment variables and declared entry points

Change: madarch-tzte.21.5
Base: 16f7567b55ba11e9cb01722b7de96695ceead18f
Tasks: madarch-tzte.21.5
Kind: no-behavior

## Intent

Decision 0026 makes the fill eight deterministic stages that read a pinned tree
and write the product graph, from the general to the particular, and stage 2 is
the one that reads what a repository is *made of* before its code is parsed: the
packages a product ships, the dependencies between them, the units it deploys,
the environment it is configured by, and the ways in it declares. Nothing in
madarch answered that: the landed `src/product/fill-index.ts` recognises a
manifest by extension and never reads it, so the graph's first run had no
package, no dependency and no deploy unit at all.

This change lands that stage:

- **`src/fill/stages/build-configuration.ts`**, stage 2: one unit per manifest
  file, whose id is the word `manifest`, the repository and the path, joined by
  `:`, writing a `package` node per package a `package.json`, a `go.mod` or a
  `Cargo.toml` declares, a `dependency` edge
  between two of those packages where one manifest's declaration names the
  other, a `deploy-unit` node per Dockerfile and per compose service, an
  `environment-variable` node with the `consumes` edge from the file that
  declares it, an `entry-point` node per declared binary, script, container
  command and library, and one `coverage` node per manifest saying what was read
  and what was not.
- **`src/fill/stages/manifest-format.ts`**, the readers those facts are read
  with: JSON as the ecosystem's own reader takes it (a comment or a trailing
  comma is a gap naming its line), the TOML subset a Cargo manifest is written
  in, the go.mod directives, the Dockerfile instructions, and the compose
  services. Every reader answers where it stopped — a 1-based line and what
  stood there — and reports the notes it took while it read: a JSON member, a
  TOML key or table or a YAML key a file declares twice is named in the unit's
  coverage, and the first declaration stands.
- **`src/fill/stages/index.ts`**, the one place a stage is registered: one
  import and one `.register(...)`.
- **`src/fill/facts.ts`**: the `entry-point` kind's `stages` list gains
  `2-build-and-configuration` (below).

Nothing runs: no command constructs the stage registry, and the stage's facts
are drafts the publication of madarch-tzte.20.2 will apply.

## Out of scope

- The fact store, the checked write path, publication and staleness: this change
  writes drafts into the context and leaves their application to
  madarch-tzte.19.5, 20.2, 20.3 and 20.4.
- What a run pins, and the run's inputs seam: a unit's own input digest is the
  wiring's (madarch-tzte.21.8). This change states the unit id and the scope that
  wiring hashes, and the read this stage's plan makes.
- The API endpoints, tables and columns a stage 2 extractor could also read from
  those manifests (`provides`, `api-endpoint`, `table`, `column`, `binds`): the
  task names packages, dependencies, deploy units, environment variables and
  entry points, and this change writes those and no more.
- Stage 5's clustering and PageRank, which consume the `package` nodes and the
  `dependency` edges this stage writes (madarch-tzte.21.7).
- The React/UI side and the wiki: no page renders these facts yet.
- The fill's capability text: the requirement this stage serves is proposed by
  `fill-pipeline-monday`, not current, and the rebuild's own requirement text
  lands with the stage that closes decision 0026.

## Preserved contracts

- product-wiki/pages: a page stays the product's Markdown in git (0017); this stage writes graph facts, no page reads them, and no command constructs the registry.
- product-repository/manifest: the manifest's own reader is unchanged; nothing here reads the product's manifest, and the pins are the run wiring's (madarch-tzte.21.8).
- release-binary/installers: nothing new is bundled and no dependency is added — the readers are this repository's own code and the `yaml` reader the model already ships; the stage is loaded by no command.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

`no-behavior`: the change adds a stage module, a readers module, one
registration line and one declaration list, and no command, page or contract
reads any of them. The product does exactly what it did before.

## Blocking questions

None.

## Design and decisions

- **One unit is one manifest file.** The id is the word `manifest`, the repository and the path, `:`-separated
  and the scope is the repository and the path, the same shape the inventory stage's
  units use, so the run's wiring hashes the manifest's blob as the unit's own
  input and a one-file commit replans that manifest and no other. The plan names
  a unit per manifest the pinned tree holds, and one per manifest path an
  earlier run published that the commit no longer holds; the second kind writes
  nothing, which is how a deleted or renamed manifest asks for its facts to be
  retracted (madarch-tzte.20.2's publication semantics; this change states the
  request, not the mechanism).
- **The plan makes one tracked read per repository** — the JSON document
  `{"read": "stage-2-published-manifests", "repository": "…"}` — answered with
  the manifest paths this stage has already digested. Its rows are read
  strictly: another repository's row, a kind this stage does not hold, a path
  that is no repository path, or a key the read does not name (a run id among
  them) refuses the plan, naming the read, the row and the field. That row shape
  is the contract this change hands madarch-tzte.21.8.
- **A dependency edge holds only between packages the graph holds.** An edge's
  ends are nodes, so a declared dependency becomes an edge exactly where it
  names a package another manifest of the same repository declares: by a
  `file:`/`link:` specifier, by a Cargo `path`, or by the package's own name.
  Everything else — a registry package, a module outside the pinned
  repositories — is a coverage gap naming the file, the line and the
  dependency, never an edge with an invented end. `basis` is `manifest`.
- **The packages of one repository are indexed once per reader.** Resolving a
  dependency by name needs the other manifests' declarations, so the stage
  reads every `package.json`, `go.mod` and `Cargo.toml` of the repository once
  per reader and caches what package each path declares. The cost is linear in
  the number of manifests and is paid only when a unit runs; a manifest this
  index cannot read simply declares nothing there, and the unit whose dependency
  named it reports the miss.
- **A manifest this stage cannot read is coverage, never a silence.** A parse
  failure, a declaration outside a reader's subset, a dependency that resolves
  to no node, a lock file (whose content this stage reads not at all), an
  `env_file`, a Dockerfile with no `FROM`, a compose file with no services: each
  is one `coverage` fact whose `scope` is the manifest path and whose `unread`
  names the path, the line and what stood there, with its reason. A manifest that
  stopped at a line carries that line as its own place, so a reader of the graph
  opens the file where the reader stopped. A unit that cannot read its manifest
  writes its coverage and no other fact, which also retracts what an earlier run
  read from a version that did parse.
- **The place of a fact is the line that declares it.** Every dependency edge,
  entry point, deploy unit and environment variable stands at the line its
  declaration is written on — the JSON key's line, the TOML key's line, the
  Dockerfile instruction's line, the compose key's line — so the evidence of a
  fact is a place a person can open, and the coverage's `read` list names the
  declarations that were read, in code point order, each once.
- **The environment variable's place is the file that declares it.**
  `EDGE_END_KINDS` lets a `consumes` edge start at a file, a package or a
  symbol. A Dockerfile's `ENV` and `ARG` and a compose service's `environment`
  are read by the file that declares them, so the edge starts at the file node
  stage 1 published for that path (its id is computed here from the file's
  identity — its repository and its path — so the node is the one stage 1
  wrote). The container or the service a compose variable belongs to is not an
  end the schema allows.
- **A package is named by what its manifest calls it.** `package.json` →
  ecosystem `npm`, form `workspace` where it declares workspaces and `package`
  otherwise; `go.mod` → ecosystem `go`, name the module path; `Cargo.toml` →
  ecosystem `cargo`, form `package`. A manifest that declares no package name
  writes no package node and names that in its coverage, since a package's
  identity is its repository, its form and its name: a Cargo manifest that
  declares a workspace and no package (a virtual manifest) is one such, and the
  form `workspace` stands for the npm manifest that declares workspaces.
- **A Dockerfile's `ENV` and its `ARG` both declare a variable.** The
  `environment-variable` kind carries a name and no scope, so a variable the
  image's environment holds and one the build reads stand as the same kind of
  declaration, each with the file as the place that reads it; a later policy or
  stage can tell a build-time name from a runtime one, and naming an `ARG` as a
  gap would put a permanent hole in every Dockerfile that takes a build
  argument.
- **A deploy unit is named by what declares it.** A Dockerfile's container is
  named by the folder it stands in, or by the repository at its root — a
  Dockerfile carries no name of its own — and a compose file's services are
  named by their service names. The forms `chart`, `function`, `job` and
  `stack` stand unused: no manifest in this stage's set declares one.
- **The `entry-point` kind names stage 2 as well.** The task requires declared
  binaries and scripts as `entry-point` facts, and the schema's list named only
  `3-syntax`, where the code's own ways in are found. The kind now names both
  stages, as `dependency`, `consumes` and `provides` already name the two they
  are written by; a manifest declares the way in before the code implementing
  it is parsed. The kind's shape, identity and version are unchanged.
- **What a key that carries no fact of this stage's kinds does.** The stage's
  kinds are the limit of what it claims: a `package.json`'s `main`, a compose
  file's `volumes`, a service's `ports`, a Dockerfile's `RUN`, a go.mod's
  `replace` are read (the manifest parsed) and carry no fact of the seven kinds
  this stage writes, so they are named in the coverage's `read` where the stage
  read them as a declaration and by no gap: the alternative is a permanent gap
  on every real manifest, which teaches a reader to ignore gaps. What the DONE
  WHEN does not name stands in the open points below.
- **Every error names what it is about.** A reader's refusal names the path, the
  1-based line and what stood there; a unit id this stage never plans is refused
  naming the id and the id's own shape; a plan's refusal names the read, the row
  and the field. Nothing is dropped in silence and nothing is read past.

## Acceptance evidence

Open points for the integrator, in the order they matter:

- The retraction this stage asks for (a unit that publishes nothing) needs
  madarch-tzte.20.2's publication to replace the unit's facts with none. Until
  that lands, a deleted manifest's facts stay in the graph, and what the test
  proves is that the vanished path is planned and its unit writes nothing.
- The unit's own input is the run wiring's (madarch-tzte.21.8): a manifest's
  blob. What one unit writes is *not* a function of that blob alone: a
  dependency's resolution reads the packages the repository's other manifests
  declare (the index below), so a run that wants a changed package name to move
  the unit whose edge names it must name those manifests in the unit's inputs
  too. The unit's id and scope name its own manifest, and the read the plan
  makes is the published-manifests read; the wiring's inputs seam is where the
  index's manifests belong, and that is an open point below.
- A first run of one changed manifest reads every manifest of its repository
  once, for the package index (above). A repository of many thousands of
  manifests would want the index read from published `package` facts instead;
  the read's row shape is what would have to grow.
- A `package.json`'s `main` and `exports`, and a go.mod's `replace` and
  `exclude`, declare ways in and resolution rules that no kind of this stage
  carries: the task names declared binaries and scripts, and the schema's
  entry-point forms name a command, a route, a job, a library export or a main.
  Stage 3 and stage 4 read the code's own ways in; a later change that wants a
  package's `exports` as facts needs a kind for it.
- A lock file is a declared gap: its resolved versions and its workspace map are
  read by nothing here, because no fact kind of this stage carries a version and
  an edge's end must be a node the graph holds. The coordinator decided this for
  the run ("lock files: read none for edges in this task", 2026-10-18) and the
  decision is recorded on the task itself, so the DONE WHEN's `bun.lock` is
  narrowed by an owner-side decision and not by this record's prose.
- The dependency edge's far end is a `package` node another unit of this stage
  writes: the plan orders units by id, so a workspace's member may be digested
  after the manifest that depends on it. 0026's checked write ("referenced nodes
  exist") and the run's wiring (madarch-tzte.21.8) must accept an edge whose far
  end is published by the same run, or a first run of a workspace would refuse
  the very fixture the DONE WHEN names.
- A dependency that resolves to no node is a coverage gap with reason
  `unsupported`. A reader of a page will see many such gaps on a real product
  (every registry dependency). The alternative — an edge to a node nobody wrote
  — is what 0026 forbids.
- Mutation is not run (the owner's rule runs Stryker once per assembled stage);
  acceptance escalates per `mutationFallback`.

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.5:
`bun run check`, the focused suite on the SkyPilot pod, the feature document
gate, green CI on the exact SHA and one independent review round. Mutation is
not run: the owner's rule runs Stryker once per assembled stage.
