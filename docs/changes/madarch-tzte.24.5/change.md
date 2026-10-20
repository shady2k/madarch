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
  attempt, where the join's own freshness check has already settled them. The
  stage declares no consume of the claims it reads: a consume names a kind the
  packet reads from an earlier stage, and every agent stage writes claims — the
  declared consume beside its siblings' would draw the stage graph into a cycle of
  agents each waiting for another's claims (the cycle madarch's stage-8 fix
  removed for the same reason).
- **The ordering split follows the shape's own conventions at the run's bounds.**
  Each named child carries the shape's own estimate of one sealed child — one
  bounded span of reading, as `memberPlaces` and the product's places name
  theirs — because what the split seals here is the dependency itself: the
  children are units of the plan already, each budgeted by its own estimate and
  its own limits, and no new work is created by naming them. A module deeper than
  the shape's own plan depth runs unordered rather than nesting the split past
  what a plan and a split nest alike: its packet reads what its children have
  published and holds `null` for the rest, and the fixed part's own rule has the
  unit answer `partial` over what it did not read — a named gap in the graph,
  never a silent one. A run admits the leaves first, so an unordered parent
  usually reads every summary anyway; the fallback is for the race the plan order
  cannot close.
- **The summary is one claim of a fixed predicate** (`summarizes`), so a parent
  reads one bounded summary per child and not the child's whole reading; the
  child's responsibilities and role stand beside it on its own page.
- **The plan refuses an over-wide module instead of synthesizing groups.** A
  grouping unit would have no node of the graph to stand on: its id would name no
  fact, its packet would have no scope read, and its writes would cite no bytes of
  its own. The tree's grouping is the deterministic stages' contract, and the
  refusal names the module, its count and the rule, so a tree that skips it is
  heard at plan time rather than read short at run time. The plan verifies the
  tree where it reads it: a parent that stands nowhere, a parent across
  repositories, and a cycle of parent links are each refused by name — a tree no
  unit order can name is heard at plan time, not at the split.
- **A parent whose children settled never seals them again.** The wrapper names,
  on every attempt, only the children the generation's sealed set does not hold
  (`StageContext.sealedChildren`), so the orchestrator's own re-seal refusal —
  "a parent whose children settled builds on them rather than sealing them
  again" — is reached by nothing of this stage.

- **Open points and known limitations**, named here rather than left to be found:
  - **A unit that splits at a limit and, on the joined attempt, answers the same
    partial over the same places, is blocked by the shape's own re-seal refusal.**
    The refusal is the shape's intentional answer for sealing settled work again;
    the unit stands blocked with the orchestrator's words, for a person's
    resolution. A real agent is asked again with the places of its scope in front
    of it and is expected to read on; the impact test's scripted fixture answers
    its members whole, which never splits.
  - **Complete coverage rests on the unit's own answer beside the section.** A
    unit whose children's summaries are `null` is told to answer `partial`, and
    the scripted tests hold that; the shape's `complete` computation cannot see
    the section. Wiring the section's null rows into the coverage is the shape's
    next change, not this stage's.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch is five commits
over `origin/main` `81a7a99d`, which it was rebased onto last (that base folds the
stage-cycle fix of 8f0c95ab, madarch 26.1's impact propagation, the doc-intent stage
of 24.3, the intent-history stage of 24.4 and the questions work of PR #123 in; the
second review round and the rebase conflict it resolved are the fourth and fifth
commits).

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch and after
  the rebase.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.5 --candidate worktree --target origin/main`) exit 0,
  clean, after every edit round and at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - Before the rebase: `test/fill-understanding-stage.test.ts` — 5 pass, 0 fail,
    exit 0; and with it `test/fill-stages.test.ts`, `test/fill-registry.test.ts`,
    `test/fill-agent-stage.test.ts`, `test/fill-overview-stage.test.ts`,
    `test/fill-agent-unit.test.ts`, `test/fill-agent-packet.test.ts`,
    `test/fill-orchestrator.test.ts`, `test/fill-crash-suite.test.ts`,
    `test/fill-graph-reads.test.ts` — 213 pass, 0 fail, exit 0.
  - After the review round and the rebase: `test/fill-understanding-stage.test.ts`
    — 6 pass, 0 fail, exit 0 (the deep-module round and the bound tests joined).
  - After the rebase, the stages that run together: `test/fill-understanding-stage.test.ts`,
    `test/fill-impact.test.ts`, `test/fill-stages.test.ts`,
    `test/fill-registry.test.ts`, `test/fill-doc-intent-stage.test.ts` — 82 pass,
    0 fail, exit 0 after the impact fixture served stage 12's units.
  - At hand-over, on the rebased branch: `test/fill-understanding-stage.test.ts`,
    `test/fill-impact.test.ts`, `test/fill-stages.test.ts`,
    `test/fill-registry.test.ts`, `test/fill-agent-stage.test.ts`,
    `test/fill-overview-stage.test.ts`, `test/fill-agent-unit.test.ts`,
    `test/fill-agent-packet.test.ts`, `test/fill-orchestrator.test.ts`,
    `test/fill-graph-reads.test.ts`, `test/fill-doc-intent-stage.test.ts`,
    `test/fill-intent-history-stage.test.ts` — **242 pass, 1 fail, exit 1**, the
    one fail a timeout of `test/fill-orchestrator.test.ts`'s wired-service test
    under the pod's load; rerun alone: `test/fill-orchestrator.test.ts` — 76 pass,
    0 fail, exit 0 — and `test/fill-crash-suite.test.ts` — 11 pass, 0 fail,
    exit 0; and `test/product-daemon.test.ts`, `test/product-cli.test.ts` (the
    direct importers of the host this change touches) — 117 pass, 0 fail, exit 0.
    The load rule is AGENTS.md's own: a timeout outside the changed code, checked
    alone before blaming the change.
- CI on the exact SHA of the branch: named in the queue entry.
- No mutation receipt: the owner's rule runs Stryker once per assembled stage,
  off the path; acceptance escalates per `mutationFallback: escalate`.
- The independent review, one fresh read-only session over
  `git diff origin/main...HEAD`, told not to run anything on this machine
  (`glm-5.3-flash-auto`): verdict `fix-before-ship`, five defects and eight
  findings, every defect answered in the second commit and re-checked:
  - **D1** (the wrapper had no answer for the orchestrator's work and depth split
    bounds: realistic trees block-loop): answered — the split names each child at
    the shape's own one-span estimate, and a module deeper than the shape's own
    plan depth runs unordered, its packet reading what its children published and
    its own answer naming the rest (`test/fill-understanding-stage.test.ts`, the
    deep-module test).
  - **D2** (the plan's tree verification missed cycles and cross-repository
    parents): answered — both are refused by name where the plan reads the tree,
    and the fan-in refusal's own words name the bound and the grouping.
  - **D3** (DONE WHEN's "every module of the fixture tree" held by one module):
    answered — every module of the three-level tree is scripted with the full set
    and the test asserts each module's published facts.
  - **D4** (the rounds test's leaves wrote no summaries): answered — each leaf
    writes its summary and the joined parent's nine rows are asserted.
  - **D5** (the summary bound and the section cap unexercised, constants
    duplicated): answered — both are derived from the declaration's own resolved
    scale, and the bound's cut, the ellipsis and the cap are held by the
    declaration test; the waiting attempt's recorded reads are pinned to the
    module tree alone.
  - **Findings 1–8**: the staleness fine print is recorded in the Design section;
    the consume was removed with the cycle it would draw (the coordinator's
    stage-cycle note and main's own 8f0c95ab agree); the impact test's fixture
    serves stage 12's units with the members-whole answer, whose units are then
    inherited in run-three and named in the run's reused list from the store;
    the re-seal exposure of a same-partial re-answer is named in the open points;
    and this evidence names its runs and each command's own exit status.
- The second review round (`glm-5.3-flash-auto`, read-only, over the follow-up
  commits and the whole branch): verdict `fix-before-ship`, two defects and seven
  findings, answered in the round-two commit and the rebase conflict it resolved:
  - **D1** (the cycle guard tested `Set.add` for membership, which is the set, and
    never fired): answered — the guard tests the set's own membership, and the
    plan's test feeds a cyclic parent chain through the reader the plan walks and
    quotes the refusal's own words.
  - **D2** (the section's fan-in cap held by no test while the evidence claimed
    it): answered — the cap is asserted beside the declaration, and the evidence's
    claim now names what the test holds.
  - **Findings**: the plan's three tree refusals are each exercised (a parent
    across repositories and a parent that stands nowhere in the store; the cycle
    through the reader, which is the seam the walk reads and the one place the
    store's own identity cannot hold the malformation); the ordering depth is the
    shape's own `MAX_PLAN_DEPTH - 1` rather than a literal; the waiting attempt's
    reads are pinned exactly; the deep fixture's root answers `partial` over its
    summary-less child and its coverage says incomplete; the impact test binds the
    stage's inherited units non-empty; the base drift the reviewer flagged for
    hand-over is this rebase.

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
