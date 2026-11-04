# The architecture check runs in bun run check, and today's violations are listed

Change: madarch-8bdc.1.2
Base: 4c2e932c86b401d87035c0aaf5d9b27dd0a93d80
Tasks: madarch-8bdc.1.2
Kind: no-behavior

## Intent
Decision 0033 (items 3, 4 and 6) keeps one writer per store, one storage layer and
one entry point per job by static checks over the whole architecture, run in `bun
run check` and so in CI: dependency rules over the import graph, a rule about the
names a module imports, and no code or export unreachable from the declared entry
points. This change lands that gate, the configuration that names its rules, and
the list of the violations the code holds today.

The rules, each named for what a reader has to be able to say about the code:

- `graph-single-writer`: only the graph store's own modules (`src/graph`) and the
  storage layer (`src/adapters`) import the graph's publication API
  (`src/graph/publish.ts`);
- `sql-only-in-storage-layer`: no module of the product outside `src/graph` and
  `src/adapters` imports the database connection, the query interface a module
  runs statements through, or a database client (PGlite, its vector extension,
  the PostgreSQL driver, the queue);
- `one-fill-entry`: only the orchestrator host (`src/fill/orchestrator-host.ts`)
  starts a fill — no other module imports the extract driver's `fillGraph`, the
  knowledge fill worker's `runFillWorker`, the product CLI's `startFill`, or the
  stage registry's `driveRun`;
- `no-unreachable-code`: knip, from the entry points `knip.json` declares (the
  scripts, `src/index.ts`, the test files, and the wiki app's entries), reports a
  module or an export no entry reaches.

The tools are dependency-cruiser over the import graph, swc for the names a
module imports, and knip for reachability. TypeScript 7 has no JavaScript API, so
dependency-cruiser parses this repository through swc; `@swc/core` is a dev
dependency beside it.

## Rationale
No requirement changes and no user-visible behaviour of the product changes: the
gate reads the code the product already has, and a violation that is not fixed is
written down rather than allowed. The alternative the decision rules out — a rule
that fails on a body of code it cannot pass — would have been switched off on its
first day, so the debt is listed in `.architecture/violations.json` (1246
entries: 45 modules that hold the connection or run a query outside the storage
layer, 6 further fill entry points, 1195 unreachable files and exports) and the
list can only shrink: the check fails on a violation the file does not list and on
an entry no rule finds any more, and CI compares the list with the branch's merge
base and refuses an entry gained without the owner's decision.

Two readings of the rules are placed here rather than left to the reader. The
rules govern the product — the modules of `src/` and the programs of `scripts/` —
and not `test/`, where a test holds a database and starts a fill to exercise the
product, nor `.shady2k/` (the tracker's tooling) or `wiki/app/` (a package of its
own); knip covers all of them, because dead code is waste wherever it lies. And
the storage rule names the modules that hold a connection or run a statement, not
the type named `DatabaseOwner` on its own: a module that creates an owner to lend
it is a host, and what the decision forbids is a module running a statement of
its own through one.

The preserved references below are the requirements whose code the rules now read
— the ones that say "one store", "one owner", "one host" or "one registry" — and
each of them keeps exactly the behaviour it had: the change adds a gate, it does
not move, rename or rewire a module of the product.

## Out of scope
- Fixing the violations. The debts decision 0033's later stages delete stay where
  they are: no second surface is deleted and no module moves into the storage
  layer here.
- Decision item 5's capability boundary (a static stage holds no whole-tree
  reader): an import rule does not see algorithmic cost, and that check is a
  later one.
- The storage rule's remaining hole: a module that receives an executor typed by
  something other than the query interface could still run a statement without
  importing one of the named modules. TypeScript 7 has no JavaScript API, so a
  type-aware check is not available; the import rule is what the code allows.
- The 1195 unreachable exports' own merits: they are written down, not removed.
- Decision 0033's requirement text, which lands with the stages that delete the
  debt (item 6), not with this change.

## Changes to requirements
None. The product's requirements and their behaviour are what they were; what
lands is a build gate over the code that implements them, and the list of what
that gate finds today. No proposed capability file is part of this change.

## Preserved contracts
- graph-queries/rebuild: the query engine is still rebuilt from the model history alone and answers the same queries; the storage rule adds no interface and moves no query, it only names the modules that would otherwise run SQL of their own.
- fill-orchestrator/host: the background server still creates the orchestrator over the process's one database owner, opens nothing before a fill is asked for, and stops it with its own shutdown; the fill rule confirms the host is the one module that starts a fill.
- fill-orchestrator/publish: a publication is still one short transaction of the process's one owner, fenced and exactly once; the graph rule keeps the publication API's importers inside the graph store and the storage layer.
- fill-stages/registry: a stage is still registered once by its module and the plan is still derived from the declarations; the fill rule names `driveRun` as the stage registry's runner and the host as its only starter.
- server/store: the server still stores each sent model in the one graph store and restart still loses nothing it stored; the storage rule leaves every module of the server reading through a store.
- product-wiki/live: the wiki still answers from the product's own store through the reader that owns it; the storage rule names the modules of `src/knowledge` that still reach the connection, and none of their answers change.

## Coverage
- graph-queries/rebuild: test
- fill-orchestrator/host: test
- fill-orchestrator/publish: test
- fill-stages/registry: test
- server/store: test
- product-wiki/live: test

## Where it is seen
Kind: command
Place: `bun run check` in a checkout, and the `checks` job of CI

1. A person runs `bun run check`; the type check runs first, then the architecture
   check, which prints `architecture: 1246 violations found (graph-single-writer
   0, no-unreachable-code 1195, one-fill-entry 6, sql-only-in-storage-layer 45);
   1246 listed in .architecture/violations.json` and exits 0.
2. A person adds a module that imports the graph's publication API from outside
   the store, or starts a fill from anywhere but the host, and runs it again: the
   check prints the rule's name, the module's full path and the line, and exits 1.
3. A person fixes one of the listed violations and runs it: the check names the
   entry of the list that no rule finds any more and exits 1 until the entry is
   deleted in the same change.

## Blocking questions
None.

## Design and decisions
`.dependency-cruiser.mjs` holds the two import rules as dependency-cruiser's own
configuration, named as a reader says them; `src/check/architecture/` holds the
check itself (the rules over the connection and the names of the imports, the
knip run, the comparison with the list, the messages, the merge-base guard) and
`scripts/check-architecture.ts` runs it. `bun run check` is `tsc --noEmit` and
`bun run check:architecture`; `bun run check:architecture-base` is the CI step
that holds the list to its merge base. The check reads the list's entries by rule,
file and symbol and not by line, because a line moves with the code above it.

## Acceptance evidence
Measured in the SkyPilot pod (`madarch-sky-test`), 2026-11-02:

- `bun run check` (`tsc --noEmit` and the architecture check) exit 0; the check's
  own line names the 1246 violations above, each of them listed.
- `MADARCH_SKIP_PERF=1 bun test test/architecture-check.test.ts
  test/architecture-repository.test.ts`: 15 pass, 0 fail, exit 0.
- StrykerJS 9 (command runner `bun test test/architecture-check.test.ts`,
  `coverageAnalysis: off`, run from a scratch folder outside the repository with
  `typescript@5` beside it) on the new `src/check/architecture/` modules:
  447 mutants, 325 killed, 2 timed out, 120 survived — 73.15% (violation.ts
  87.77%, fill-entry.ts 73.21%, imports.ts 65.92%, sources.ts 63.01%). The
  survivors are refusal message text, the folder names a walk skips, and the
  fallbacks of the code point comparator where both sides are equal.
- The whole suite is CI's: five shards on the pod (the way CI runs it) gave
  shard 2 at 1088 pass and 0 fail, and shard 1's three failures in
  `test/status-work.test.ts` pass alone on the same pod (3 pass, 8.2 s) — pod
  load, in a file this change does not touch.
- The independent review is the acceptance record's: it is not run by this
  change.

## DONE WHEN
`bun run check` runs `tsc --noEmit` and the architecture check and passes on the
code as it stands; each of the four rules fails on a violation planted in a
throwaway fixture project, with the rule's name, the module's full path and the
line, and passes when the plant is removed; the list refuses an entry no rule
finds and a violation it does not list; CI refuses an entry the branch gained
without the owner's decision; and CI runs it on every push.
