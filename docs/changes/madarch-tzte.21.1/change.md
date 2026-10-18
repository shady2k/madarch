# The snapshot reader and the two stages the deterministic fill starts from

Change: madarch-tzte.21.1
Base: 5c712dea9b05a1993ffe6ed8fd0035c985350df8
Tasks: madarch-tzte.21.1
Kind: no-behavior

## Intent

Decision 0026 replaces the landed fill with deterministic stages that read a
pinned tree and write the product graph, and every one of them reads the same
bytes the same way. Nothing in madarch answered that before: the old
`src/product/fill-index.ts` walks a checkout with its own git calls, its own
language table and its own idea of a tree, and its tree-sitter walk, its
inventory and its estimates all begin again from scratch.

This change lands the reader the eight deterministic stages read through, and
the first two of those stages:

- **`src/fill/snapshot.ts`**, the snapshot reader: one repository bound to one
  commit, its tree listed in code point order (each entry's mode, form, object
  id and size) and a file's bytes answered by repository path. It answers what
  `git ls-tree -r` and `git cat-file` answer at that commit — a test compares
  the two — and it refuses what it cannot answer, naming the repository, the
  commit and the path: a folder that is no repository, a commit the repository
  does not hold, a path outside the tree, a path that is no repository path, a
  submodule's commit (whose tree stands in another repository), an entry mode it
  does not know and bytes that do not match the size the tree states. Nothing it
  runs writes to the checkout.
- **`src/fill/stages/snapshot.ts`**, stage 0: one unit per pinned repository,
  writing the `snapshot` node (repository, commit, tree id, file and byte
  counts), the `repository` node (its form and default branch) and a `coverage`
  node saying what the reading could not read (a submodule's tree) — every id
  from `src/fill/facts.ts`, so the same repository at the same commit is the
  same fact on every machine and in every run.
- **`src/fill/stages/inventory.ts`**, stage 1: a unit per file and per folder,
  writing a `file` node (its roles, its language, its size and the blob its
  bytes stand under), a `directory` node, and the `contains` edge from each
  node's container — the folder above it, or the repository node at the root.
- **`src/fill/stages/index.ts`**, the one place a stage is registered: a worker
  adding a stage adds its module and one line.
- **`src/fill/facts.ts`** gains one field on the `file` kind, `blob`, and that
  kind's schema version moves to 2 (below).

The stages are built over a `SnapshotSource` — the run's pins, and one reader
per repository — so a stage never reaches a checkout by itself: `plan` and
`execute` take their bytes from what the wiring hands them, and the tests hand
them a repository they make. Every test runs the stages through `plan` and
`execute` with a fake context; the orchestrator (madarch-tzte.19.5) is not
needed and not used.

## Out of scope

- The other six deterministic stages (build and configuration, syntax, semantic
  resolution, modules, document index, history) and the agent stages: they read
  through this reader and register beside these two (madarch-tzte.21.2 to 21.7).
- The orchestrator, the fact store, the bounded graph reads and the checked
  write path (madarch-tzte.19.5, 20.2, 20.3, 20.4): this change writes drafts
  into the context's draft set and leaves publication to them.
- The wiring of a real run: what a product's pins are, how its repository set is
  read from its manifest and its `repos/`, and which reader answers a plan's
  reads (madarch-tzte.21.8). This change states the read and its row shape, and
  its tests answer it themselves.
- Replacing `src/product/fill-index.ts` and the landed fill pipeline: nothing
  here calls them, and nothing calls this.
- The fill's capability text: the requirement these stages serve is proposed by
  `fill-pipeline-monday`, not current, and the rebuild's own requirement text
  lands with the stage that closes decision 0026.

## Preserved contracts

- product-wiki/pages: a page stays the product's Markdown in git (0017); the stages write graph facts, no page reads them yet, and no command constructs the registry.
- product-repository/manifest: the manifest's reader is unchanged, `fill.stages` included; nothing in this change reads the manifest or names a product's repositories — the pins are the run wiring's (madarch-tzte.21.8).
- release-binary/installers: nothing new is bundled and no dependency is added; the reader runs the machine's own `git`, which the binary already needs, and the stages are loaded by no command.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

The reader is the seam every later stage inherits, so it lands first and alone:
a stage written against it (syntax, documents, build and configuration) needs
only `SnapshotReader.open` and `read`, and cannot disagree with its neighbours
about what a commit holds. The two stages that need nothing but the tree prove
the seam end to end: they read every entry of a repository and write the facts a
reader of the graph starts from.

Nothing here changes what the product does: no command constructs the registry,
no stage runs, and `src/product/fill*.ts` is untouched. The one change to a
landed module is the `file` kind's `blob` (below), which no producer wrote
before this change.

## Design and decisions

- **The `file` kind gains `blob`, and only that kind moves.** Stage 1 must write
  the blob a file's bytes stand under — the task says so, and stage 3, stage 6
  and stage 2 all read a file again *per blob* ("a file whose blob id did not
  change is not re-planned"), which is impossible from a fact that does not carry
  it. `FileValue` had roles, language and size and no blob. The field is
  optional and not part of the identity: a file whose bytes changed is the same
  file with the same id, and the blob is what tells one reading of it from the
  next. The field's form is git's own object id, which the reader answers from
  `git ls-tree`; the schema's own check names the kind's keys and, like
  `commit.commit` before it, does not re-read a 40-hex field's letters. The
  kind's `version` moves to 2 alone, as `facts.ts` says a kind whose value changes
  moves; the schema version stays 1. `test/fill-facts.test.ts`'s "every kind
  carries the schema version" gains the one kind that has moved, and names why.
- **A tree's path is never folded, and a path the fill cannot name is unfiled.**
  A tree's name has no machine separator in it — git separates with `/` on every
  machine, so a backslash in a name is a byte of that name — while
  `repositoryPath` folds a separator and a leading `./` for a *caller* that
  writes a machine path. Filing a tree's name through that fold renames it: two
  files become one path, one file's bytes are answered for the other, and a fact
  id is shared by two files. So the reader files a tree's name **as it stands or
  not at all**: a name the fold would change (a backslash, a leading `./`) and a
  name that is no repository path of a fact (a name that looks like a machine's
  drive, an empty or dotted leg) are listed as **unfiled** — not in `entries()`,
  nothing read for them, and never dropped in silence: this stage's coverage
  names each of them, so a reader of the graph sees the hole and not a smaller
  repository. The rest of the tree reads as usual: one unusual name does not cost
  the repository, and a name git's own tools refuse to write is covered by a test
  that writes the tree object by hand.
- **A draft write's `fact` value is a whole envelope.** `StageDraftWrite` says
  `value: unknown` and the write path checks it with `checkFact`, which reads an
  envelope (kind, schema version, id, provenance, layer, status, value). So a
  stage builds its facts with `makeNodeFact`/`makeEdgeFact` and writes what those
  return: the id is the one the store will hold, and `validate` reads the same
  envelope back with the same check. A unit that writes no fact is how this
  stage asks for a retraction — and that is a request, not a property of this
  change: that an empty set replaces the unit's earlier facts with none is
  madarch-tzte.20.2's publication semantics, which nothing landed defines today
  (`fsm.ts`'s `retract-draft` covers unpublished generations only). Recorded as
  an open point in the acceptance evidence below.
- **A file's place is the whole file.** The schema requires a place of a `file`
  fact, so stage 1 reads a file's bytes to state it: one `git cat-file` per file
  the unit writes, and the range a reader counts — from the first line's first
  character to the last line's end, a trailing newline ending a line rather than
  starting an empty one, and the columns counted in UTF-16 code units of the
  bytes decoded as UTF-8 exactly as `readText` decodes them (the byte order mark
  is a character of the text, and a byte sequence that is not UTF-8 reads as
  replacement characters, which is what a reader shows). So stage 1 is not byte-free: a first
  run of a large repository pulls every file through `cat-file` once, and its
  steady state reads only the files that changed. A blob past the reader's own
  buffer fails that file's unit loudly, naming the path and the blob, although
  the tree already stated its size.
- **A stage reaches no checkout itself.** `SnapshotSource` is the stage's
  dependency: `pins()` names the run's repositories (a function read per run, so
  a run pins its own commit) and `open(id)` answers one reader, refusing an id it
  does not hold. `createGitSnapshotSource` is the real one; the pins are judged
  before they are sorted (a pin that is no pin is named, never thrown out of by
  the sort), a duplicate id, a name that is no repository name, a form that is no
  repository form, a folder without a name and a commit without one are refused
  naming the pin, and one reader stands per repository, commit and folder while a
  run fills — the tree of a commit never changes, and a unit's `execute` must not
  list a large tree again for every file it writes.
- **The inventory's plan reads what the previous runs published.** A plan names
  its units from a tracked read per repository — one JSON document,
  `{"read": "stage-1-published-tree", "repository": "…"}`, answered with the
  `file` and `directory` rows the graph already holds. A graph that answers
  nothing plans the whole tree, which is a first run; a plan that answered
  nothing because nothing changed plans nothing. The rows are read strictly: a row
  for another repository, a kind stage 1 does not hold, a path that is no
  repository path, a blob that is no blob id, a folder carrying a blob, one path
  in two rows, or a key the read does not name (a run id among them) refuses the
  plan, naming the read, the row and the field — a row read past plans a wrong
  unit in silence, and a row dropped leaves a stale fact behind.
- **A unit is one file or one folder, and a plan is linear.** The id is
  `<kind>:<repository>:<path>` and the scope `<repository>:<path>`, so the run's
  wiring can hash a unit's own input: per-file granularity is what makes a second
  run after a one-file commit write that file's facts and no other's. The plan
  walks maps and sets only, so its cost is what the repository holds and not its
  square — 0026 asks the fill to be complete on any repository size, and a plan
  that scanned the tree once per published path would be minutes on the sizes
  that decision names.
- **A rename leaves no stale fact, as far as this change can prove it.** The plan
  holds, for a published path the pinned commit no longer holds, a unit of that
  path; its `execute` writes nothing (the path is not in the tree, or it holds a
  submodule's commit), and its folder is planned the same way when the folder
  itself no longer stands in the tree. What a test proves is that the vanished
  path is planned, that the unit writes nothing, and that no write of the run
  names the old path; that the old fact then *goes* is the publication's
  business, not this change's (see the open point on madarch-tzte.20.2).
- **The `contains` edge is drawn from the container to the node, by the node's own
  unit.** A file's unit writes its `file` node and the edge from the folder (or
  the repository) it stands in; a folder's unit writes its `directory` node and
  the edge from its own container. The repository node's id is stage 0's: its
  identity is the repository's name alone, so a file at the root joins the node
  the earlier stage published at whatever commit it was pinned at. A stage
  declares the ownership scope of what it produces, and this stage declares `file`
  at the file and the folder and the edge at the repository: the scope vocabulary
  has no scope for one folder.
- **The roles and the language come from the path.** Stage 1 reads no bytes to
  place a file (its bytes are read for the place, above): a file's language is the
  extension stage 3 parses it as (the same four grammars `fill-index.ts` walks), a
  file's roles come from the folders it stands in and the name it carries (a
  `test/` leg or a `*.test.ts` name is a test, a `fixtures/` leg is a fixture,
  `vendor/` is vendored, `migrations/` is a migration, `dist/` and `*.gen.ts` are
  generated, an extension names source, document, configuration, build, asset,
  schema), and a file whose path places nothing at all carries the one role
  `asset`, which claims no more than that the repository ships it. `source` is
  claimed only for a file whose extension is code: the schema's own rule.
- **A cancelled unit raises, and publishes nothing.** An aborted signal is
  checked before and after the reader opens; the unit raises rather than return a
  draft, because a unit that writes nothing asks for a retraction, and a
  cancellation must never retract in silence. The run's own cancellation is what
  accounts for the attempt.
- **Order is the project's own.** The reader and the stages order by
  `byCodePoint` (`src/model/order.ts`), which is UTF-16 code-unit order — the
  order every list of the schema is read in — and the same order git's own
  `ls-tree` answers for every name of the basic plane. A test pins it with a
  supplementary-plane name, so the two orders cannot be confused later.
- **A symbolic link is a file of the tree.** Its bytes are the path it points at,
  it counts in the snapshot's file and byte counts, and the coverage names its
  kind (`symbolic-link`) beside `file`. A submodule's commit is not read here (its
  tree stands in the repository it names) and is named in the coverage.
- **Every error names what it is about.** A reader refusal names the repository,
  the commit and — where a path is what the refusal is about — the path, as
  fields and in the message, and its refusal kind says what was refused (a
  missing repository, a commit the repository does not hold, an unreadable tree,
  a path that is no repository path, a path not in the tree, a submodule, an
  object git could not answer, bytes that do not match the tree's size, a mode
  the reader does not know); a plan's refusal names the read, the row's place and
  the field; a draft's refusal names the write's place in the draft, what it
  cites, and the fact's own path and place. Two of the reader's refusals cannot
  be reached with real git — a tree entry's mode and a blob's size are git's own,
  and modern git refuses to write a tree it did not make — and they stay as what
  the reader answers an answer it did not expect, rather than as silence or a
  guess.
## Acceptance evidence

Open points for the integrator, in the order they matter:

- The retraction this stage asks for (a unit that publishes nothing) needs
  madarch-tzte.20.2's publication to replace the unit's facts with none. Nothing
  landed defines that: `fsm.ts`'s `retract-draft` covers an unpublished
  generation only, and 0027 says a publication applies a unit's fact set within
  its scope without saying what an empty set applies. Until 20.2 says so, a
  rename's old fact stays in the graph, and the test's claim is the one stated
  above: the vanished path is planned and no write of the run names it.
- The plan's read (`publishedTreeRead`) is the contract this change hands
  madarch-tzte.21.8: the wiring of a run must answer it from the graph's `file`
  and `directory` facts. Its row shape is strict, and a graph that answers
  nothing plans the whole tree, which is what a first run is.
- Mutation is not run (the owner's rule runs Stryker once per assembled stage);
  acceptance escalates per `mutationFallback`.
- A first inventory run reads every file once (for its place, above), one
  `git cat-file` at a time; a repository of hundreds of thousands of files would
  want the reader's batched read, which is not this task's.
- 0027's rule that a publication replaces *only the unit's* facts must be
  applied literally by madarch-tzte.20.2 and by the run's wiring
  (madarch-tzte.21.8): this stage declares the folder and the `contains` edge at
  the repository's scope, because the scope vocabulary has no scope for one
  folder, and a publication that read the declared scope as "replace everything
  the stage owns" would take every other folder of the repository with one
  unit.

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.1:
`bun run check`, the focused suites on the SkyPilot pod, the feature document
gate, green CI on the exact SHA and one independent review round. Mutation is
not run: the owner's rule runs Stryker once per assembled stage.
