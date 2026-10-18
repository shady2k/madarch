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
  next. The kind's `version` moves to 2 alone, as `facts.ts` says a kind whose
  value changes moves; the schema version stays 1. `test/fill-facts.test.ts`'s
  "every kind carries the schema version" gains the one kind that has moved, and
  names why.
- **A draft write's `fact` value is a whole envelope.** `StageDraftWrite` says
  `value: unknown` and the write path checks it with `checkFact`, which reads an
  envelope (kind, schema version, id, provenance, layer, status, value). So a
  stage builds its facts with `makeNodeFact`/`makeEdgeFact` and writes what those
  return: the id is the one the store will hold, and `validate` reads the same
  envelope back with the same check. An empty draft is a fact of life, not a
  defect: it is how a stage retracts what an earlier run wrote for a path the
  pinned commit no longer holds.
- **A stage reaches no checkout itself.** `SnapshotSource` is the stage's
  dependency: `pins()` names the run's repositories (a function read per run, so
  a run pins its own commit) and `open(id)` answers one reader, refusing an id it
  does not hold. `createGitSnapshotSource` is the real one; the pins are judged
  where they are read (a duplicate id, a name that is no repository name, a form
  that is no repository form, a folder without a name, a commit without one).
  A stage therefore holds a checkout only as an open reader, and `StageContext`
  keeps its promise of never being a database or a path.
- **The inventory's plan reads what the previous runs published.** A plan names
  its units from a tracked read per repository — one JSON document,
  `{"read": "stage-1-published-tree", "repository": "…"}`, answered with the
  `file` and `directory` rows the graph already holds. A graph that answers
  nothing plans the whole tree, which is a first run; a plan that answered
  nothing because nothing changed plans nothing. The rows are read strictly: a row
  for another repository, a kind stage 1 does not hold, a path that is no
  repository path or a blob that is no blob id refuses the plan, naming the read,
  the row and the field — a row read past plans a wrong unit in silence, and a row
  dropped leaves a stale fact behind.
- **A unit is one file or one folder.** The id is `<kind>:<repository>:<path>`
  and the scope `<repository>:<path>`, so the run's wiring can hash a unit's own
  input: per-file granularity is what makes a second run after a one-file commit
  write that file's facts and no other's.
- **A rename leaves no stale fact.** The plan holds, for a published path the
  pinned commit no longer holds, a unit of that path; its `execute` writes
  nothing (the path is not in the tree, or it holds a submodule's commit), and an
  empty draft is a publication that replaces the unit's facts with none. A folder
  is planned the same way when it vanished from the tree, and it is planned too
  when it holds a file this run writes, so a changed file's folders are published
  with it.
- **The `contains` edge is drawn from the container to the node, by the node's own
  unit.** A file's unit writes its `file` node and the edge from the folder (or
  the repository) it stands in; a folder's unit writes its `directory` node and
  the edge from its own container. The repository node's id is stage 0's: its
  identity is the repository's name alone, so a file at the root joins the node
  the earlier stage published at whatever commit it was pinned at.
- **The roles and the language come from the path.** Stage 1 reads no bytes: a
  file's language is the extension stage 3 parses it as (the same four grammars
  `fill-index.ts` walks), a file's roles come from the folders it stands in and
  the name it carries (a `test/` leg or a `*.test.ts` name is a test, a
  `fixtures/` leg is a fixture, `vendor/` is vendored, `migrations/` is a
  migration, `dist/` and `*.gen.ts` are generated, an extension names source,
  document, configuration, build, asset, schema), and a file whose path places
  nothing at all carries the one role `asset`, which claims no more than that the
  repository ships it. `source` is claimed only for a file whose extension is
  code: the schema's own rule.
- **A cancelled unit raises, and publishes nothing.** An aborted signal is
  checked before and after the reader opens; the unit raises rather than return a
  draft, because an empty draft retracts what the unit wrote before, and a
  cancellation must never do that in silence. The run's own cancellation is what
  accounts for the attempt.
- **Every error names what it is about.** A reader refusal names the repository,
  the commit and — where a path is what the refusal is about — the path, as
  fields and in the message; a plan's refusal names the read, the row's place and
  the field; a draft's refusal names the write's place in the draft, what it
  cites, and the fact's own path and place.

## Acceptance evidence

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.1:
`bun run check`, the focused suites on the SkyPilot pod, the feature document
gate, green CI on the exact SHA and one independent review round. Mutation is
not run: the owner's rule runs Stryker once per assembled stage.
