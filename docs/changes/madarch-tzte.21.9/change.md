# The syntax stage re-reads a file whose published gap or import edge its specifiers no longer name

Change: madarch-tzte.21.9
Base: b5a232b9eba0ea0f92cf55015fdd9dde00ece3ef
Tasks: madarch-tzte.21.9
Kind: no-behavior

## Intent

Stage 3 (madarch-tzte.21.3) plans one unit per source file and re-reads a file
only when its blob moved at the pinned commit. Two of the facts it publishes are
about the *specifiers* a file wrote, and a specifier's answer can move without
any byte of the file that wrote it moving:

- a specifier the stage could not tie to a file is a gap of the file's coverage.
  When a file appears under it, stage 4 resolves that specifier and writes the
  edges for it (madarch-tzte.21.6), and stage 3's gap never goes away: the graph
  holds a resolution newer than the gap that contradicts it.
- an `import` edge the stage wrote names the file its specifier resolved to. When
  a file appears beside that target (`./x.js` written beside the `x.ts` it
  resolved to), the specifier answers the new file, stage 4 re-resolves the
  importer, and stage 3's edge keeps naming the old file — the two stages'
  answers to one specifier disagree. The same holds when the file an edge named
  is gone from the tree: the edge keeps naming a file the graph no longer holds.

This change gives stage 3's plan the two rules stage 4's plan already applies,
and makes the two plans call one helper for them, so neither can answer
differently about a specifier:

- **`src/fill/stages/syntax-specifiers.ts`** — the new module: the two reads
  those facts are answered by (`publishedImportsRead`, `publishedGapsRead`, whose
  names do not move), the row readers for the two answers (moved out of
  `semantic-resolution.ts` so both stages read one shape), and
  `movedBySpecifiers`, the helper.
- **`src/fill/stages/syntax.ts`** — a plan that reads the `import` edges and the
  coverage gaps it published, and names a unit for a file whose published answer
  no longer matches what its specifiers name at the pinned commit. The stage's
  version moves to 2 here and to 3 with madarch-tzte.21.10, which lands on this
  branch after this change: what the stage plans changed here, what it writes
  there.
- **`src/fill/stage-reads.ts`** — the read of the published `import` edges now
  filters by the edge's *importer* and by its target being a file fact's id,
  where it required a `file` fact to stand at each end. Without that, a run that
  retracted a deleted file before its importers were read again leaves an edge
  no plan can see, and the repair this change lands would never reach it. A
  target that is no file fact's id — a `module:` or `package:` end, which the
  schema allows for an `import` though stage 3 writes none — is still no row,
  because the two plans that read this answer plan file units and would refuse
  such a row by name; a damaged `file:…` id is a row, and the row reader names
  it.
- **`src/fill/stages/semantic-resolution.ts`** — its plan's two specifier rules
  are the helper's now, bounded as before by its own last reading
  (`publishedReadsRead`); its own rows keep their readers, which read the shared
  helpers the new module and this one both import.
- **`src/fill/stages/draft.ts`** — the four row readers these two plans read
  every answer with (`refuseRow`, `rowRecord`, `unknownKeys`, `fileIdIn`): one
  copy for the two stages that read the same two facts, where the stages' shared
  reading of a write already lives. The modules stage keeps its own copy of three
  of them, which is the one the next stage's change should fold in.

What the two rules plan is what replaces the stale answer: stage 3's re-read
writes the edge the specifier names now, or the edge it could not write before,
and its coverage stops naming the gap. A second run of an unchanged commit
therefore plans nothing in either stage — in stage 4 because its own reading is
the bound, and in stage 3 because the facts it publishes are the two facts the
rules read.

## Out of scope

- The syntax stage's naming of a declaration (what a symbol is called and what
  qualifies it) is madarch-tzte.21.10, the other finding of stage 4's review.
- A stage's own version of the fact schema, the stage registry, the orchestrator
  and the store: this change moves a plan's reads and no fact's shape. The
  `import` and `coverage` values stage 3 writes, their ids and their provenance
  are the landed ones.
- The agent stages 8 to 13 of decision 0026, and the pages: nothing here renders
  what the graph holds.

## Preserved contracts

- fill-orchestrator/plan: a unit's id is still `file:<repository>:<path>` and carries no run id, so a publication under one identity is the same unit whatever planned it; the orchestrator's own planning, admission, staleness and publication are untouched, and the plan simply names more units of the same shape.

## Coverage

- fill-orchestrator/plan: test

## Rationale

The kind is `no-behavior` because no requirement of this repository changes: the
fill's own stages are not described by a current capability (`fill-stages` fixes
the stage contract, and the stage modules are madarch-tzte.21.1 to 21.7's), and
what this change fixes are two answers of one stage against decisions 0026 and
0027 already accepted — a unit re-reads what the commit moved (0026), and a fact
a publication replaces is the whole set of the unit that publishes (0027). The
one contract a reader could think changed — the id and shape of a planned unit —
is the preserved one below. That is also why no approval is owed: nothing here
decides something a person has not already decided.

The seam is one helper rather than two copies because the two plans answer one
question: what does this specifier name at the pinned commit, and is the answer
the graph holds still that one? A copy per plan is exactly how the two stages
came to disagree in the first place, and the review of madarch-tzte.21.6 found
that disagreement by reading both plans side by side.

## Design and decisions

- **A specifier's answer is nobody's property, so one helper states both rules.**
  `movedBySpecifiers` takes the pinned tree's paths, the graph's `import` edges
  and stage 3's coverage gaps, and answers the files whose reading moved: the
  writer of a gap that ties to a file now, and the importer of an edge whose
  specifier names another file than the edge's `to`. The path of each file fact
  id is read back with `fileFactIdOf` — the same digest the inventory published —
  so an edge is read as the two files it joins and nothing else.
- **The bound is the caller's own reading, where it needs one.** Stage 4 passes
  `answered` — what its own coverage says it read — so a target it already read
  is not planned again on every run of an unchanged commit. Stage 3 passes none,
  and that is not a hole: its published gap and edge *are* the two facts the
  rules read, so the reading the rule plans is what makes the rule quiet on the
  next run.
- **The two facts keep their read names.** `stage-4-published-imports` and
  `stage-3-coverage-gaps` are texts a wiring answers and a run records its reads
  by; a name does not move with the code that reads it, and two plans read these
  two answers now. Their readers moved to the module that states the rules, so
  both stages validate the same rows: a row of another kind, a key the read does
  not define, a file that is no repository path and an id that is no file fact id
  are refused by name, with the read and the row.
- **A gap that names no file is no move.** The gaps of a file's coverage are not
  only specifiers (`syntax-facts.ts`): a language with no grammar, a declaration
  the walk could not name and an unreadable file are gaps too. The rule asks
  `resolveSpecifier` of each gap's `what`, which answers only a relative
  specifier that ties to a file of the pinned tree, so a gap of any other kind
  stays quiet however the tree changes.
- **A retraction is not a move of the importing file's own unit.** A published
  source path the commit no longer holds is still planned by the plan's own rule
  (a unit that publishes nothing), and `movedBySpecifiers` never names it: it is
  not a path of the pinned tree, so no rule can plan it. The file that *imported*
  it is a move, though: the edge stage 3 wrote names a file the pinned tree no
  longer holds, so the specifier answers no file, the importer is read again, and
  its coverage names the specifier it cannot tie.
- **The edge is answered although its target is gone.** The read of the published
  `import` edges used to require a `file` fact at each end, so an edge whose
  target the graph had already retracted was answered to nobody — and a run that
  retracts a deleted file and stops before its importers are read again leaves
  exactly that state: the tree holds no target, the graph holds no `file` fact
  for it, and the edge is the only witness of what the importer imported. The
  read now filters by the edge's importer and by its target being a file fact's
  id, so that state is repaired on the next run instead of standing. One
  consequence for stage 4's plan: it plans such an importer under the same rule
  now, where it plans it for a vanished *source* target already, and the unit
  stage 3 reads in that run removes the edge.
- **The stage's version moves.** `SYNTAX_STAGE_VERSION` is 2 here (3 with
  madarch-tzte.21.10, which lands on this branch after this change): what the
  stage plans changed, and the version enters a publication's identity
  (`publicationDigest`, `orchestrator.ts`). What that means, said plainly,
  because the number reads as if a graph migrated: a plan compares no stage
  version and a unit's reuse is decided by its `inputsDigest`, which names the
  declared stages and their versions, so an existing product's facts are replaced
  when a unit is computed again — the version is what makes the identity of the
  next publication differ, not a sweep of what a store already holds.

## Acceptance evidence

The evidence is recorded on task madarch-tzte.21.9: `bun run check`, the focused
suites on the SkyPilot pod (`--avx2`, the tree-sitter grammars need it), the
feature document gate, green CI on the exact SHA, and one independent read-only
review round by a fresh `deepseek-v4.1-flash-auto` session.

The tests that hold the two rules, in `test/fill-syntax-stage.test.ts`:

- a file that appears under a specifier stage 3 could not tie is read again: the
  plan names the importer and the file that appeared and no other, the re-read
  publishes the `import` edge with the specifier as written and a coverage with
  no gap left in it, and a second run of that commit plans nothing;
- the state a run resumes in after it retracted a deleted target and stopped
  before its importers were read again — the tree holds no target and the graph
  answers no `file` fact for it — still plans the importer, whose re-read writes
  the specifier as a gap;
- an `import` edge whose specifier names a file that appeared beside its target
  is read again: the plan names the importer and the new file, and not the target
  whose blob stood; the re-read's edge names the file fact the inventory
  published for the new file, and a second run of that commit plans nothing;
- an `import` edge whose target the commit no longer holds is read again — beside
  the vanished path's own retraction — and its re-read writes no edge and names
  the specifier as a gap, after which a second run of that commit plans nothing;
- the plan makes exactly three reads of one repository — the published tree and
  the two facts about specifiers — and refuses a row of either of the two that is
  not the shape its reader defines, naming the read, the row and the field;
- `test/fill-stage-reads.test.ts`, over the real store: the read of the published
  imports answers an edge whose target the store holds no `file` fact for, and
  leaves out an edge whose target is no file at all (the fixture's `package:`
  end).

Mutation is not run as a Stryker job: the owner's rule runs it once per assembled
stage, and acceptance escalates per `mutationFallback`.

## DONE WHEN

Stage 3's plan re-reads a file whose published coverage gap or `import` edge no
longer matches what its specifiers name at the pinned commit, through the one
helper stage 4's plan applies the same two rules with, and a second run of an
unchanged commit plans nothing in either stage — with a test for each.
