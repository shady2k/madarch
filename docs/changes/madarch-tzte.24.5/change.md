# Stage 12 understands modules bottom-up, parents from their children's bounded summaries

Change: madarch-tzte.24.5
Base: 24ec77f2
Tasks: madarch-tzte.24.5
Kind: no-behavior

## Intent

Decision 0026, "Stages": "12 module understanding bottom-up (leaves first, parents
from children's summaries)". Its "Scale" bounds what a parent reads of its children:
"Summaries are bounded (~2K tokens) and fan-in is bounded (~50 children, else an
intermediate grouping level), so every level, the product overview included, fits a
unit." The stage lands on the agent-stage shape of madarch-tzte.24.1 and declares
exactly what the shape holds: the fixed part, the per-unit sections, the plan, the
places, and the kinds it may write.

- **`src/fill/stages/understanding.ts`** — stage 12, registered as `understanding`.
  The plan (`moduleUnits`) names one unit per module the deterministic stages
  published, deepest first, the more important first within a depth; each unit's
  scope is its repository, where its members' bytes stand. The plan verifies the
  fan-in bound where it reads the tree and refuses a module past it by name: the
  grouping the bound asks for ("else an intermediate grouping level") is the tree's
  own shape — the modules stage groups a wide folder's children into `part-1`,
  `part-2` clusters by the same rule — and a parent of many children reads groups,
  whose units are modules like any other and are planned bottom-up with the rest.
- **A parent waits for its children's publication** on the orchestrator's own
  dependency mechanism (0027): a unit whose module has child modules splits into
  them before it reads anything, stands down at `waiting_children`, and the run
  joins it when every sealed child has published and is fresh. The wrapper never
  reads the children's claims: a read is recorded as the generation's dependency,
  and an empty answer a child's later publication turns non-empty would refuse the
  unit's own publication at the recheck (0027 rechecks every read the generation
  ever recorded). The children are named by the split, never discovered by a read
  that moves.
- **`src/fill/stage.ts`, `src/fill/orchestrator.ts`** — the attempt hands the
  stage the set its generation sealed (`StageContext.sealedChildren`, absent when
  it sealed nothing): the one store answer that tells the attempt that follows a
  join from the first attempt, without a graph read that moves.
- **What a module gets.** One `summarizes` claim whose text is the module's bounded
  summary — the ~2K tokens its parent reads instead of reading it again;
  `responsible-for` claims for its responsibilities; a `serves-as` claim for its
  role; `rule` facts for the business rules its code carries, each with the evidence
  span of the lines that carry it. All at 0005's `inferred` layer, always
  `proposed`, at self-filling's `meaning` level.
- **The `childrenSummaries` packet section** — one bounded row per child module in
  code point order of their ids, each holding the child's `summarizes` claim cut to
  the summary bound, or `null` where the child published none: a missing summary is
  a child that did not finish, never an empty one. The section is built only where
  the sealed set covers every child, so the summaries it reads are present and do
  not move again before the unit publishes.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's stage 12 and its
"Scale" bounds; 0027's split, join and staleness; 0005's layers and statuses;
self-filling's outcome 4) without moving a requirement of the product. The fill's
capability is proposed by `fill-pipeline-monday` and is not closed, so the rebuild's
own requirement text lands with the stage that closes decision 0026, as
madarch-tzte.24.1 recorded. No served surface moves: the daemon's fill wiring names
no agent (`src/product/fill-stages.ts`), so a run registers no agent stage today;
the registry's change is visible to a run that wires one, which is what the tests
do.

## Out of scope

- **Stages 9, 10, 11 and 13** (madarch-tzte.24.2 to 24.4, 24.6): they declare
  themselves on the shape as 24.1 planned.
- **A stage-synthesized grouping unit.** 0026's intermediate grouping level is a
  level of the module tree, which the deterministic stages publish already grouped;
  the agent stage reads the tree as it stands and refuses one that skips the bound,
  rather than sealing units whose id names no node of the graph.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and its declaration is still pure data; stage 12 registers beside stage 8 where 24.1 registered it.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest; the numbers a unit is held to are the limits its stage resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; stage 12's plan reads the module tree and nothing else.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence; the attempt now names the generation's sealed set, which the store held already.
- fill-orchestrator/split: a split still seals its child set and its parent's checkpoint in one transaction and suspends its parent; stage 12's ordering split names children that are units of its own plan, not scopes below them.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it.
- server/protocol: the unit tool route, its refusals and its order are unchanged.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test
- server/protocol: static

## Blocking questions

None.

## Design and decisions

- **The ordering is the orchestrator's split and join, not the answer.** A parent
  that waited because its agent said `partial` would order nothing: the split would
  rest on the agent's word. The wrapper splits before any session opens, so a
  parent is never prompted before its children have published, and spends no agent
  run on the attempt that waits.
- **No recorded read before the join.** 0027's staleness recheck judges every read
  the generation ever recorded, so a summary read that answers empty on the
  waiting attempt and non-empty after the join would refuse the parent's
  publication for good. The parent's reads before the join are the module tree's,
  which do not move while the run runs; the summaries are read once, on the joined
  attempt, where the join's own freshness check has already settled them.
- **The summary is one claim of a fixed predicate** (`summarizes`), so a parent
  reads one bounded summary per child and not the child's whole reading; the
  child's responsibilities and role stand beside it on its own page.
- **The plan refuses an over-wide module instead of synthesizing groups.** A
  grouping unit would have no node of the graph to stand on: its id would name no
  fact, its packet would have no scope read, and its writes would cite no bytes of
  its own. The tree's grouping is the deterministic stages' contract, and the
  refusal names the module, its count and the rule, so a tree that skips it is
  heard at plan time rather than read short at run time.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch is one commit
over `origin/main` `24ec77f2`.

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - `test/fill-understanding-stage.test.ts` — 5 pass, 0 fail, exit 0.
  - `test/fill-stages.test.ts`, `test/fill-registry.test.ts`,
    `test/fill-agent-stage.test.ts`, `test/fill-overview-stage.test.ts`,
    `test/fill-agent-unit.test.ts`, `test/fill-agent-packet.test.ts`,
    `test/fill-orchestrator.test.ts`, `test/fill-crash-suite.test.ts`,
    `test/fill-graph-reads.test.ts` — 213 pass, 0 fail, exit 0.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.5 --candidate worktree --target origin/main`): named
  below with its own exit status at hand-over.
- CI on the exact SHA of the branch: named in the queue entry.
- The independent review: one fresh read-only session over the diff
  (`glm-5.3-flash-auto`), told not to run anything on this machine; its verdict
  and the answers to its findings are named below.

## DONE WHEN

- The plan names the leaves first, one unit per module, and holds 0026's two
  bounds: a summary read at ~2K tokens, the fan-in at ~50 with the tree's own
  intermediate grouping level, and a named refusal for a module past the bound.
- A parent waits for its children's publication on the orchestrator's split and
  join, reads their bounded summaries on the joined attempt only, and writes its
  own summary claim, responsibilities, role and business rules with evidence
  spans; every module of the fixture tree ends with them.
- Tested end to end with the fake ACP agent on a fixture graph of three levels:
  the leaves publish first, each parent splits before it reads anything and is
  joined when its children have published, a parent of nine children rounds
  through the split bound, a failed child under the run's accept-partial policy
  joins into a parent that publishes no complete coverage, and no real agent
  prompt is used.
