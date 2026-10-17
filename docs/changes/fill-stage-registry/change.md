# Fill stages: a declared registry, a derived stage graph and the product's stage configuration

Change: fill-stage-registry
Base: 82d5edbb1e716df722497d0ccc1ef5a2724448ed
Tasks: madarch-tzte.19.3
Kind: behavior

## Intent

Decision 0027 makes the fill's flow a configuration rather than code: a stage is
one module plus its registration, and the graph the stages run in is derived from
what they declare. Nothing of that exists: the landed fill pipeline has fixed
stage names in `src/product/fill-runtime.ts`.

After this change a stage declares its id and version, the capabilities it
consumes and the fact kinds it produces, an optional ordering, a configuration
schema with defaults, and how it plans, executes and validates its units. A
registry holds those declarations and derives the stage graph from the
capabilities: a required capability draws an edge from every enabled producer to
its consumer, ties are broken by code point order, and a cycle is refused by its
own path. The product's manifest decides which stages run: its `fill.stages`
entry for a stage enables, disables and limits it, and disabling a producer
the fill needs is
reported as the exact starvation path consumer → capability → producer, saying
whether no stage produces the capability or every producer of it is disabled. A
full registry whose required capabilities are produced derives cleanly, and each
run can snapshot the configuration it resolved.

Adding a stage costs one module and its registration, which a test proves with a
fake stage that arrives as a file and nothing else.

## Out of scope

- The fill's own stages: the deterministic stages 0–7 and the agent stages 8–13
  of decision 0026, and the units they plan. They arrive with the orchestrator
  and the crash-injection suite (madarch-tzte.19.5, madarch-tzte.19.6).
- The orchestrator: admission, leases, splits and joins, publication, the unit and
  run state machines and the queue (madarch-tzte.19.4, 19.5, 19.6).
- The landed fill pipeline under `src/product/fill*.ts`, which later tasks
  replace; nothing here registers, calls or reads it.
- Running a stage: `plan`, `execute` and `validate` are declared and typed, and
  nothing in this change calls them.

## Changes to requirements

Added capability `fill-stages` against an absent baseline, its complete proposed
text in `capabilities/fill-stages.md`, with the requirements `registry`, `graph`,
`order`, `configuration`, `starvation`, `cycle` and `snapshot`.

## Preserved contracts

None.

## Coverage

- fill-stages/registry: test, madarch-tzte.19.3
- fill-stages/graph: test, madarch-tzte.19.3
- fill-stages/order: test, madarch-tzte.19.3
- fill-stages/configuration: test, madarch-tzte.19.3
- fill-stages/starvation: test, madarch-tzte.19.3
- fill-stages/cycle: test, madarch-tzte.19.3
- fill-stages/snapshot: test, madarch-tzte.19.3

## Design and decisions

- **The configuration file is the product's manifest.** `workspace.yaml` is the
  product's own configuration file (decision 0021), versioned in the product's
  git as decision 0027 asks; its reader ignores a field it does not know, so a
  product declaring `fill.stages` still opens in a madarch older than the fill.
  `docs/kinds.yaml` is not the place: it is the skill set's document contract
  whose stage list names the wiki's lifecycle stages, which decision 0027 keeps
  apart from the fill's processing stages.
- **Two readers, one file.** `readFillStageConfiguration` reads the manifest
  through the manifest's own parser, so the two can never disagree about what
  the file says; every refusal names the file, the 1-based line and the field's
  path. A stage's own `config` is judged by the registry, which is the only
  holder of the stage's `configSchema`, and it names the same file and the line
  of the field inside the configuration.
- **A refusal carries every fault at once.** The derivation answers a clean
  graph or all of it: the configuration's refusals, the stages' declaration and
  configuration problems, the cycles and the starvation paths. A configuration
  that does not read refuses the graph before anything is derived from it, since
  its defaults stand for nothing the product agreed to.
- **A stage is not its own producer.** A stage consuming the capability it
  produces reads what its own earlier run published, so no edge runs from it to
  itself; otherwise every incremental stage (the history stage of decision 0026
  among them) would starve or cycle.
- **A pair is ordered once.** An `after` draws an edge only where no capability
  edge already orders the same pair, so the graph says an ordering once.
- **The snapshot is a digest.** `snapshotStageConfigurations` digests every
  stage's id, version, enabled flag, concurrency, limits and own configuration
  canonically, which is what decision 0027 asks a run to keep beside its
  resolved configuration and stage versions.

## Rationale

The stage contract is the seam the whole orchestrator stands on: decision 0027
trades fixed stage names for declarations, and the graph, the starvation
diagnostic and the product's stage configuration are what make that trade
usable. It lands before the orchestrator so that the state machines, the queue
and the crash-injection suite all plan against one derived graph.

## Acceptance evidence

Owner approval pending (coordinator). Static, test and review receipts are
recorded on task madarch-tzte.19.3; mutation is left to the stage's assembled
mutation run, as the owner decided.
