# The eight deterministic stages are wired to a product and started by `madarch fill-stages`

Change: madarch-tzte.21.8
Base: fad2419e6bc996c37403e1ea2998caafeb5ccd5d
Tasks: madarch-tzte.21.8
Kind: no-behavior

## Intent

Decision 0026's eight deterministic stages are landed modules (madarch-tzte.21.1
to 21.7) and the orchestrator, the fact store, the bounded graph reads and the
checked write path are accepted (madarch-tzte.19, 20), and nothing connects them:
the orchestrator host refuses every run ("nothing wires the fill"), no reader
answers the named reads a stage's plan and its units make of the graph, and no
command starts a run. Decision 0026's third stage is therefore unprovable — the
first point at which anyone can see whether the eight stages, over a real
repository, build the graph the decision promises and whether a commit recomputes
only what it affects.

This change lands the missing seam and walks it over a madarch checkout:

- **`src/fill/stage-reads.ts`** — the reader that answers every named read of the
  eight stages from the fill's own fact store. A stage's plan and its units ask
  the graph in their own words (`{"read":"stage-1-published-tree","repository":
  "orders-api"}`, madarch-tzte.21.1's contract, and eleven more: twelve in all),
  and every stage's
  row reader refuses a row that is not exactly the shape it defined: the reader
  answers each read with the rows that reader accepts — the facts of the kind the
  read names, of the repository it names, with the fields the fact's value and
  provenance carry and no key a stage would refuse. The graph-read grammar
  (madarch-tzte.20.3) and a stage's own SQL still pass through the same seam, and
  the `fact` view the reader creates is what the history stage's three queries
  read.
- **`src/product/fill-stages.ts`** — one product's wiring: the pins (the product
  repository and the code repositories its manifest declares, each at its
  checkout's HEAD), the run's snapshot record, the product's fill configuration,
  the graph a unit's reads answer from, and the named inputs a unit's facts stand
  on.
- **`src/product/cli.ts`** — `madarch fill-stages`, the way a run is started. It
  builds the wiring, runs the eight stages through the orchestrator the process
  owns, and prints what the run did — the units it planned, executed and
  inherited — and the facts the graph holds afterwards, by kind.
- **`src/fill/orchestrator-host.ts`** — `ProductFillWiring.graph` takes the
  transaction a publication's recheck already holds. Without it a wiring's reads
  would open a second transaction on the process's one connection, which that
  owner refuses, so every publication of a unit that read anything would fail.
- **`src/fill/fact-store.ts`** — `countPublishedFactsByKind`, the counts the
  command reports.
- **`src/fill/orchestrator.ts` and `src/fill/state-store.ts`** — the two costs the
  walk measured, fixed: admission opens one transaction per planned unit on every
  pass (26.8 s of a 27.6 s unit on a 2786-unit run), and `readRunUnits` reads a
  unit with three queries each (1.7–3.4 s per call, several calls a pass).
- **`src/fill/stages/history.ts`** — two defects the walk found on a real
  checkout, fixed:
  - a history unit wrote only the facts the graph did not hold yet, and decision
    0027's publication replaces the facts of the unit that publishes, so the facts
    it skipped lost their holding and their row. The read that follows such a
    publication then answered something else, the orchestrator's recheck read that
    as a read that moved, and the unit went stale and was worked again — for ever:
    the walk's second run span 1000 passes without settling. A unit now writes its
    whole set every time, which is what 0027's replacement requires, and the run
    settles after one bounded replacement.
  - the plan named its units from the graph's `snapshot` facts, which stage 0
    publishes *after* every stage of a run has planned (decision 0027's one
    planning epoch): so the eighth stage published the previous run's commit, and
    on a product's first run nothing at all. The plan now names one unit per
    repository the run pins, at the commit it pins, from the run's own
    `SnapshotSource.pins()`.

Apart from those two fixes nothing here changes what a page is, which stages
exist or what a stage writes: the eight stages, the registry, the schema and the
store are the landed ones, and the change is the wiring between them, the command
that starts it, and the stage bugs the wiring made visible.

## Out of scope

- **The agent stages 8 to 13** (0026): they are registered nowhere, this change
  registers none, and no command reaches an agent. The kinds registry at
  `docs/kinds.yaml` is still read by nothing here, which is why the run's
  `registryHash` names the declared stages instead (see "Design and decisions").
- **The background server's own orchestrator.** It is still built with no stage
  and no wiring (`daemonFillOrchestrator`), because nothing starts a run over it:
  the server has no route for one, and the route the agent stages need arrives
  with them. A daemon-hosted run is therefore refused by name, as it is today.
- **Pages and the wiki.** The command writes graph facts and no page; no page
  renders one yet.
- **Replacing the landed fill pipeline** (`src/product/fill.ts`, `madarch fill`).
  It is untouched, and the two fills share nothing but the fill-runtime shapes
  decision 0027 keeps.

## Preserved contracts

- product-repository/manifest: the manifest's reader is the landed one, unchanged; this change reads a product's identity and the code repositories it declares through it, and refuses a manifest that does not read with that reader's own file and line.
- fill-orchestrator/host: the host's contract is unchanged — it still refuses a run whose wiring is not given, opens nothing before one is asked for, and stops the queue with the service; this change gives a caller the wiring it asks for, in the shape it already declares.
- fill-stages/configuration: the product's `fill.stages` is read by the landed reader and judged by the landed registry, unchanged; a stage the product enables, disables or limits behaves exactly as madarch-tzte.19.3 fixed.
- release-binary/installers: no dependency is added and nothing new is bundled; the subcommand is this repository's own code, and the compiled binary carries it as it carries every other command.

## Coverage

- product-repository/manifest: test
- fill-orchestrator/host: test
- fill-stages/configuration: test
- release-binary/installers: test

## Rationale

The kind is `no-behavior` because no requirement of this repository changes: the
fill's own requirement text is proposed by `fill-pipeline-monday` and is not
current, `fill-orchestrator/host` already says a host gives the wiring and refuses
a run without one, and the two defects this change fixes in the history stage are
defects against decisions already accepted (0027's publication rule and its one
planning epoch), not new behaviour. That is also why no approval is owed: nothing
here decides something a person has not already decided.

The seam is the whole change because it is where every earlier task's contract
meets: twelve named reads whose row shapes each stage fixed, a host that refuses
to guess a wiring, and a run that must be started by something. Landing them
together is what makes the walk possible at all; landing them apart would leave
each unprovable, since a reader nobody calls and a command over a registry nobody
answers are exactly the state this stage found.

## Design and decisions

- **A read is answered by the stage's own row reader, not by a shape invented
  here.** Every read's rows are built so that the consuming stage's own reader
  (`publishedTreeRows`, `fileRows`, `edgeRows`, …) accepts them: a key the fact
  does not carry is left out rather than written as null, a fact of another
  repository is no row of this one's read, and a stored path that is no repository
  path refuses the read by name instead of being answered. The stage modules stay
  the one place a row's shape is defined.
- **A stage's own SQL keeps working.** The history stage does not use the JSON
  grammar: it passes `SELECT … FROM fact …` (madarch-tzte.21.2's proposal for the
  fact storage). The reader creates a view named `fact` over `fill_fact` carrying
  the columns those three queries read, so the stage's text stands as it wrote it.
  The view is created once, before any run: a read may not create it, because a
  publication's recheck reads inside a transaction the caller already opened.
- **A read made inside a transaction runs on it.** `ProductFillWiring.graph`
  takes the transaction the publication's recheck holds and the wiring answers
  through it: the process's owner serves one connection, and a read that opened
  its own transaction there would deadlock against the publication that asked for
  it.
- **The pins are the product's manifest, and a run reads them when it plans.** The
  run stands on the product repository and on every code repository the manifest
  declares, each at its checkout's HEAD. The orchestrator asks the wiring for the
  run's snapshot before any stage plans, and the pins are read there, so one run
  stands on one commit of each repository however often its stages ask, and a
  second run in one process reads them again rather than standing on the first
  run's commit. A declared repository whose folder is no checkout is refused by
  name rather than guessed at, and a checkout connected as a link — what `madarch
  init` and `madarch repo add` do by default — is the checkout it links to (the
  two folders are compared with their links resolved).
- **`registryHash` names the declared stages.** `RunSnapshot` is fill-runtime's
  shape, and the landed fill put the kinds registry's digest there. A stages run
  reads no kinds registry (the page kinds arrive with the agent stages), so the
  field names what decides what this run writes: the stages this madarch declares
  and their versions, in code point order.
- **A unit's inputs are its own reading.** The declared stages, and then the blob
  the pinned tree holds at the path its scope names — or, where its scope names no
  path, the pin of the one repository it names (the snapshot and modules stages'
  scope is the repository's id, the history stage's is its own
  `repository:<name>@<commit>`), so a commit in one repository of a product with
  several leaves the others' readings alone. So a one-file commit inherits every
  unit whose bytes did not move, including the manifest units stage 2 plans for
  every manifest in the tree, and computes again the units of the file that moved,
  of the folders it stands in and of the repository-wide readings. The resolution
  stage's units are the one exception: their facts stand on the symbols of the
  files they read, which the wiring cannot name before they run, so their input is
  the run's pins — a run on another commit re-resolves what its plan names rather
  than inheriting edges that may name symbols the new publication no longer holds.
- **A unit writes its whole fact set; the history stage did not.** The walk's
  second run never settled: the history stage wrote only what the graph did not
  hold, its publication replaced its own facts with fewer, the next recheck read
  the loss as a moved read, and the generation was replaced again — the loop
  decision 0027 names as a risk ("self-triggered staleness, loops"). The fix is
  the stage's: it writes its whole set and reports how much of it the graph
  already agreed with. The store and the orchestrator are unchanged, and the
  walk's own evidence shows one replacement per history unit, not a loop.
- **A pass costs what a pass must, not what the plan holds.** Admission counts the
  slots a run holds once and stops walking when they are full (the ordered
  candidates left out wait for the next pass), and a run's units are read in one
  join. Both were measured on a 2786-unit run: 26.8 s per unit in admission
  transactions that found no slot, and 1.7–3.4 s per read of the unit list. The
  command also holds sixteen units in hand (`--workers`, 8 in the walk) so a pass
  is not spent on one unit.
- **A stage plans from what the run stands on, not from what its producer published
  in the same run.** The history stage's plan read the graph's `snapshot` facts,
  which stage 0 publishes after every plan of the run is made, so it named the
  previous run's commit and, on a first run, nothing. It now reads the run's own
  pins; the graph's snapshot facts are that same reading once stage 0 has
  published them.

## Acceptance evidence

**The walk.** One walk over a madarch checkout, run on the pod (SkyPilot, the
AVX2 recipe, 2 vCPU / 4 GB), at the commit `4f67fc2710807d28f75bab8d77351c8fb7f5bc1b`
(194 tracked files; the clone is shallow — the history stage names the shallow
boundary as a coverage gap — and it carries the product's `workspace.yaml` on top
of that commit). The command is this checkout's `bun scripts/madarch.ts
fill-stages --product <the clone> --home <a scratch home> --run <id> --workers 8`.

- **Run one**: `succeeded`, 409 passes, `529` units planned and `529` executed in
  **84.1 s**. Its units per stage: snapshot 1, inventory 393, build-configuration
  2, syntax 49, semantic-resolution 49, modules 1, document-index 33, history 1.
  The facts the graph held afterwards, by kind: call 691, comment 1150, commit 2,
  contains 2674, coverage 136, defines 1986, directory 198, document 33,
  document-link 4, entry-point 147, file 195, import 77, inherits 1, module 100,
  occurrence 7304, package 1, reference 2047, repository 1, section 301,
  snapshot 1, symbol 1986, task-key 12, test 338 — 23 kinds, every one of them
  written by a stage of this change's run.
- **The one-file commit** (`src/model/order.ts`, one appended comment line),
  which the repository's own modules import and which the resolution stage
  re-resolves for its importers.
- **Run two**: `succeeded`, 9 passes, `13` units planned, `13` executed and `2`
  inherited in **12.1 s**: `inventory/file:madarch:src/model/order.ts` and the
  two folders it stands in (`inventory/directory:madarch:src`,
  `:src/model`), `syntax/file:madarch:src/model/order.ts`,
  `semantic-resolution/file:madarch:src/model/order.ts` and its five dependants
  (`src/model/compile.ts`, `src/adapters/ladybug-engine.ts`,
  `src/adapters/sqlite-history.ts`, `src/history/assertions.ts`,
  `test/order.test.ts`), the repository-wide readings the commit moves
  (`snapshot/madarch`, `modules/modules:madarch`, and `history/madarch@<the new
  commit>`), and no other unit of the 194-file tree. The two inherited units are
  the build-configuration stage's manifest units, which its plan names for every
  manifest and whose bytes the commit did not move. The facts count moved by
  three: one comment, one commit, one coverage.

**What the walk found, and what it cost.** The first walks did not finish, and
the measurements of why are the point of running one:

- The admission pass opened one transaction per planned unit on every pass, so a
  run of 2786 units paid 26.8 s of a 27.6 s unit for the candidates that found no
  slot. Fixed in `src/fill/orchestrator.ts` (`admitUnits` counts the slots it
  holds once and walks no further when they are full; a test in
  `test/fill-orchestrator.test.ts` holds a 60-unit plan to twelve transactions).
- `readRunUnits` read a unit with three queries each — 2786 units, 8358 round
  trips per call, 1.7–3.4 s — and the orchestrator makes that read several times
  a pass. Fixed in `src/fill/state-store.ts`: one join, the same records.
- After both fixes the same 2786-unit run took 301 s for 1000 passes instead of
  hours, and the walk above runs 529 units in 84 s.
- **PGlite's memory is the next limit, and it is not this change's**: the store
  of the current madarch tree (1090 files, ~2800 units) reached 1 GB — 550 MB of
  tables and 475 MB of WAL — and the pod's 4 GB killed the process (`exit 137`,
  twice, at 789 and 1090 files). The walk was therefore pinned to a commit whose
  tree the pod can hold. Recorded for the integrator rather than fixed here: a
  fill of the current tree needs a pod with more memory (or a store that prunes
  what a run no longer reads, which is not this task).
- ### The checks

- `bun run check` (`tsc --noEmit`): exit 0 on this revision.
- The focused suites on the SkyPilot pod (`test/fill-stages.test.ts`,
  `test/fill-stage-reads.test.ts`, `test/fill-history-stage.test.ts`,
  `test/fill-orchestrator.test.ts`, `test/product-cli.test.ts`,
  `test/fill-state-store.test.ts`): all pass, exit 0.
- The document gate (`--phase feature --change madarch-tzte.21.8`): clean.
- CI on the exact revision: green (the pull request's checks).
- Mutation is not run: the owner's rule runs Stryker once per assembled stage, and
  acceptance escalates per `mutationFallback`.

### The independent review and its answers

Two read-only rounds by a fresh `prime-agent --provider shady2k-gateway --model
deepseek-v4.1-flash-auto` session. Round one returned `fix-before-ship` with five
must-fix findings, and it was right on all five: a repository connected as a link
(what `madarch init` does) was refused — the folders are now compared with their
links resolved, and the test connects its fixture by a symlink; the inputs seam
was coarser than the landed stages' contract — a unit's input is now the blob of
the path its scope names, or the pin of the repository it reads whole; the history
stage planned from the graph's snapshot facts and so published one run behind and
nothing on a first run — its plan now reads the run's own pins; two end-to-end
expectations could not fail — they now assert the first run's `commit` and
`task-key` kinds, the second run's inherited manifest unit, and that its history
unit names the run's own commit; the record's evidence was a placeholder — it is
this section. Its notes were taken where they were defects: the command's exit
status now says a run that did not settle, its run id keeps the milliseconds, the
counts are in code point order, the symbol read filters its file in SQL, the dead
`?? ''` default is a refusal, a duplicated help line and an orphaned doc comment
are gone, and a constant that shadowed a landed one is renamed.
Round two confirmed the five as closed and found five more: the walk's kind count
(23, not 25), the record's out-of-scope paragraph still describing the replaced
seam, a repository-wide unit's input digesting every pin rather than its own, three
doc comments citing the `PINNED_SNAPSHOTS_QUERY` this change deleted, and the read
count stated two ways. All five are fixed in the commit this record describes.

**Open points for the integrator**, in the order they matter:
  - the embedded store's footprint per unit (~200 KB of tables per unit in the
    measurement above) is the limit on how large a repository a 4 GB pod can fill;
  - the background server's own orchestrator still declares no stage and no
    wiring, because no route starts a run over it yet (the agent stages need one);
  - `test/fill-stages.test.ts` runs the eight stages over a fixture product, and
    the walk above is the one-time check on a real repository (AGENTS.md).
  - `madarch fill-stages` opens the process's fill database itself and does not
    refuse a home whose database a running `madarch start` already holds open: the
    server owns that owner (decision 0027), and a named refusal is what a second
    process needs rather than whatever the embedded engine does.

## DONE WHEN

On a madarch checkout the eight deterministic stages run through the orchestrator
without an agent and publish their facts, the run's counts per kind are recorded,
and a second run after a one-file commit recomputes only what that file affects,
with the planned and executed units listed and matched against that file's
dependants.
