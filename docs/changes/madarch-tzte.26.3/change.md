# The first fill plans the stages whose plans read the graph once its producers have published

Change: madarch-tzte.26.3
Base: e28dda37b3c5e9198494729eae37c52f6085a58e
Tasks: madarch-tzte.26.3
Kind: behavior

## Intent

Decision 0026 makes the fill a set of stages that read and write the product
graph, and 0027 makes the run plan those stages from the declared registry. The
run plans once, before anything publishes: a stage whose plan names its units
from the graph its producers write — every agent stage of 0026 — plans no unit
there, and the agent work of a new product began only in the run after the graph
was filled. Measured in `test/fill-impact.test.ts` on the training repository
(madarch-tzte.26.1's own measurement): the first run of the product planned 41
units, none of them an agent stage's; the second run planned the agent units and
inherited the deterministic ones. A product's first fill needed a second run, a
person or the watcher to start it.

After this change the run plans such a stage again, once its producers have
published: the re-planning is one reopened planning epoch of the same run (0027:
"completion needs a closed planning epoch"), taken when the run is quiet —
nothing runnable, in flight or waiting — and a stage is due only when the run
has published past that stage's attempt what a producer of its inputs makes. A
stage that planned no unit at its latest attempt is the only one due, so a
product whose every stage answered plans nothing again. The first fill does its
agent work once, and the run after it with no change plans none.

## Out of scope

- **Which stages the run re-plans beyond the empty ones.** A stage whose last
  attempt named units is never planned again by the run that recorded it; its
  staleness is 0026's cache key and 26.1's sweep, unchanged.
- **The deterministic stages' own incrementality.** Their plans read what the
  previous runs published and are planned up front as before; the re-planning
  touches a stage only where the run has published past its attempt. A commit's
  update run (26.1) still reruns only what it reaches.
- **The real agent, its model and its cost.** Every agent unit in the
  measurement is the fake ACP agent of `test/fixtures/acp-fake-agent`; the walk
  that spends tokens is madarch-tzte.11's.
- **The watcher.** The run needs no second run and no one to start one; what
  starts a run after a commit is 26.2's, unchanged.

## Changes to requirements

Changed capability `fill-orchestrator` (proposed whole, on the newest proposal
the base held — madarch-tzte.26.1's — so its `update` requirement and its
staleness extension stand beside the `plan` text this change moves):

- `plan`: a run whose stage's plan reads what its producers write plans no unit
  there; the run shall plan such a stage again once its producers have
  published — one reopened planning epoch, taken when the run is quiet, a stage
  due only when the run has published past its attempt — so a first fill does
  the work of the stages whose plans read the graph, and a run whose stages all
  answered reopens nothing. Scenarios `first-fill-plans-the-empty-stages`,
  `crash-before-the-reopened-planning` and `a-filled-product-re-plans-nothing`
  are added.
- `staleness` and `update`: madarch-tzte.26.1's requirements, carried whole by
  the proposed copy — the copy is the complete proposed specification, so the
  base's newest proposal is what it extends — and changed by no line of this
  change: the re-planning adds no rerun of a stage whose plan answered (a stage
  it re-plans for nothing names no unit).

## Preserved contracts

- fill-orchestrator/completion: a run still ends only under a closed planning epoch with nothing runnable, in flight or waiting, its required coverage met and no pending publication.
- fill-orchestrator/cancel: a cancellation still revokes the authority of everything the run planned, its re-planning included.
- fill-orchestrator/recovery: a lost attempt's recovery is unchanged, and the re-planning itself is resumed from the stage records, never replanned from nothing.

## Coverage

- fill-orchestrator/plan: test
- fill-orchestrator/staleness: test
- fill-orchestrator/update: test
- fill-orchestrator/completion: test
- fill-orchestrator/cancel: test
- fill-orchestrator/recovery: test

## Blocking questions

None.

## DONE WHEN

- One run of a new product plans each stage's units after the stages it
  consumes from have published, so the first fill does its agent work once,
  without a second run, a person or the watcher; a run whose stages all
  answered reopens no planning epoch.
- Measured on the training repository with the fake ACP agent
  (`test/fill-impact.test.ts`): the first run plans and publishes the agent
  stages' units — the overview of the product among them — and a second run
  with no change plans none. A run crashed between a producer's publication
  and its consumer's planning plans the consumer when it is driven again, to
  the same result (`test/fill-orchestrator.test.ts`).

## Design and decisions

- **A second planning epoch, not planning deferred.** The task named two
  shapes: a stage's planning deferred until its producers settle, or a second
  planning epoch. Deferred planning was built first and measured wrong: the
  deterministic stages' plans are incremental against what the previous runs
  published — the syntax and resolution stages read the published tree — so a
  stage planned after its producer's publication diffs this run's own output
  against the reader and plans nothing; on the training repository the first
  fill lost the syntax and resolution stages whole. The second planning epoch
  keeps the first planning exactly where it was (before the run publishes
  anything, which is what the incrementality diffs against) and plans the
  answered-nothing stages again when the run is quiet, which is when the facts
  their plans read stand.
- **The watermark is a count, not a moment.** A stage is due when the run has
  published past its attempt: the attempt records how many publications the
  run had made, and the re-planning compares counts. A timestamp comparison
  would miss a publication of the same clock instant as the attempt (a scripted
  run moves in seconds) and, with `>=`, would re-plan a stage for ever on a
  clock that stands still; a count that the re-planning itself updates can only
  move forward, so a stage whose re-planning answered nothing is asked again
  only when the run publishes something new.
- **What the re-planning costs.** The due check reads the run's publications
  (two aggregate queries over `fill_publication` joined to the run's
  generations) once per quiet pass; a stage whose parent published earlier in
  the run is re-planned once per publication batch that lands after its own
  last attempt, each costing its plan call and naming no unit when the plan is
  answered. The number is bounded by the run's publications; a server that
  feels it would add a run-scoped counter or index, and the queries are the
  store's to keep flat.
- **The next run of the product is accepted.** Stage 23's acceptance record
  names a limitation (madarch-tzte.23.5's open point): a run that stopped stood
  in the store non-terminal, and the next run of the same product was refused
  with the chain active. On this change's shapes that hole does not reproduce:
  a run the loop would otherwise stop stands either `running` — where a quiet
  pass settles it, because its planning epoch is closed — or `planning` — where
  the re-planning answers it whatever it holds, closing the epoch and driving
  on — and the resumed run settles whole, so the next run of the product is
  accepted (`test/fill-orchestrator.test.ts`, the crash test's own second run;
  `test/fill-impact.test.ts`, whose second run is accepted and settles).
- **Quiet is when the re-planning runs.** The run takes the reopened epoch when
  nothing is runnable, in flight or waiting — the same quiet the staleness
  sweep runs at — and a run that stands `planning` (a crash between the
  re-planning step and its planning, or a resumed pause) closes its epoch
  whatever it holds. A crash between a producer's publication and the
  consumer's planning therefore lands on the resume: the stage records and the
  publications are the store's, and the first quiet pass of the resumed run
  plans the consumer. Measured by reopening the world over the same database
  (`test/fill-orchestrator.test.ts`): the consumer publishes once, and the
  journal names the reopened epoch.
- **What the first fill's measurement now holds.** On the training repository
  the first run plans the deterministic fill and, after it publishes, the seven
  agent stages this build holds: the product's overview (stage 8), the
  boundary refinement (9, two units), the intent from documents (10), the
  intent from comments and commits (11, nine units), the module understanding
  (12), the system recovery (13) and the pages (25.1, the first twenty-four
  pages). The second run with no change inherits everything and plans none.
  The update run after the one-file commit keeps 26.1's deterministic rerun
  list whole (the changed file's units, its folders, the repository's three
  whole readings, the resolution units' pins-input, the overview and the
  recovery) and the pages it reaches are asserted by the rule, not by a copied
  list: every page the update reruns stands on the span read the commit moved,
  and the run's own progress names that read for each.
