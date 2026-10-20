# Stage 13 recovers the system's architecture and reconciles it with the intended one

Change: madarch-tzte.24.6
Base: dea75e75
Tasks: madarch-tzte.24.6
Kind: no-behavior

## Intent

Decision 0026, "Stages": "Agent: 8 overview hypothesis, 9 module-boundary
refinement, 10 intent from documents, 11 intent from comments and commits, 12
module understanding bottom-up (leaves first, parents from children's summaries),
13 system recovery and reconciliation (recovered architecture beside the intended
one with the mapping between them). Every stage writes facts into the graph and
reads its context from it." Stages 8, 10, 11 and 12 landed on the agent-stage
shape of madarch-tzte.24.1; stage 13 is the last of the six, and it stands at
0026's top level beside the overview: it states what the product's system is once
every lower reading has landed.

The task's DONE WHEN: "One unit per product reads the module summaries (stage
12), intent (10, 11) and the overview hypothesis (8) and writes the recovered
architecture beside the intended one (the product's model, if any) with the
mapping between them; mismatches become open questions." And: "Fake ACP agent
tests."

- **`src/fill/stages/recovery.ts`** — stage 13 (`recovery`, fact stage
  `13-recovery`): one unit per product (the shape's own `productUnits`), whose
  packet adds four sections to the shape's own — `moduleSummaries` (each module's
  `summarizes` claim of stage 12, cut to the summary bound, `null` where the
  module published none), `intent` (the intent claims the predicates of stages 10
  and 11 declare), `overview` (the claims about the product's parts the other
  sections do not hold — the hypothesis among them, no claim twice), and
  `intendedModel` (the files of the product repository's `madarch/` folder,
  decision 0002, named and never pasted) — whose places are the product's
  repositories, and which writes the recovered architecture (`claim`), the
  relations between recovered components (`interaction`), the mapping to the
  intended model (`maps-to` claims cited to the model bytes), and every mismatch
  as a question of type `contradiction`, beside the coverage the shape writes.
  The statements stand at the `meaning` level: an agent's reading, never a fact a
  reader may take as confirmed, and never the model's own words.
- **`src/fill/stages/index.ts`** — the stage's one import and one `.register`
  line beside stage 12's, where the run's wiring names an agent.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's "Stages",
"Agent input", "Scale", "Writing" and stage 13; 0027's plan, split and
publication; 0005's layers and statuses; self-filling's outcomes 4 and 5) without
moving a requirement of the product, exactly as madarch-tzte.24.1 recorded for
the shape and stage 8. The fill's capability is proposed by change
`fill-pipeline-monday` and is not closed, so the rebuild's own requirement text
lands with the stage that closes decision 0026.

No served surface moves: the daemon's fill wiring names no agent
(`src/product/fill-stages.ts`), so a run registers no agent stage today; the
registry's last agent stage is visible to a run that wires one, which is what
the tests do. No route, command, help text or product command changes.

## Out of scope

- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.
- **A compiled or served view of the recovery.** The stage writes facts into the
  graph; the pages and diagrams rendered from them are the live pages of
  madarch-tzte.21.x and 25.2, which read the graph without an agent.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and its declaration is still pure data; stage 13 registers beside stage 12 where 24.5 registered it.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest, and a run still snapshots what it resolved; the numbers a unit is held to are the limits its stage resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; stage 13's plan is the shape's own one unit per product, and the shape's split into repositories is unchanged.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence, with the unit's own MCP server opened for the attempt and closed when it ends.
- fill-orchestrator/split: a split still seals its child set and its parent's checkpoint in one transaction and suspends its parent; a product unit that stops still splits into the repositories its places name.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it.
- server/protocol: the unit tool route, its refusals and its order are unchanged.
- release-binary/installers: the release binary still builds, installs and runs, and no dependency is added.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test
- server/protocol: static
- release-binary/installers: static

## Blocking questions

None.

## Design and decisions

- **The packet reads what the earlier agent stages established, through the
  claims' own contract words.** The graph holds every agent statement as a
  `claim`, and the landed stages declare how their claims read: stage 12's
  summary is the one claim of the `summarizes` predicate (its own contract with
  its parents' packets), stage 11's rules name `intent` and `why`, stage 10's
  name `states`, `promises` and `requires`. The `moduleSummaries` section reads
  the first of those, the `intent` section the other five (one tracked read per
  predicate, the grammar filtering by one value field), and the `overview`
  section holds the rest — the claims whose subject is a node of the graph and
  whose predicate no other section reads, which is where stage 8's hypothesis
  stands, since an overview's predicates are the agent's own kebab tokens. The
  three sections read the claim set once between them, so no claim stands twice
  in the packet, and each is bounded with its cut named in the packet's marker.
- **The ordering is `after`, and it cannot name the doc-intent stage.** The
  stage must read what stages 8, 10, 11 and 12 published, and a consume cannot
  express that: every agent stage writes `claim`, so a declared consume of it
  draws an edge from this stage into every sibling that consumes claims — the
  doc-intent stage does (24.3) — and the sibling's consume draws one back, the
  cycle the registry refuses for every product (madarch-tzte.26.1 removed the
  same one from stage 8). The stage therefore stands `after` the stages whose
  reading it opens (`overview`, `intent-history`, `understanding`), whose edges
  are optional and drawn only where both stages run, and the intent claims stage
  10 writes are read as they stand when the unit runs. A publication that lands
  after the unit's own makes its recorded read stale, and 0027's staleness plans
  the generation's replacement: the run's own repair, never a silent gap.
- **The intended model is named, not pasted.** 0026's "Agent input" pastes no
  file content; the `intendedModel` section reads the product repository's file
  facts (the inventory's) and holds the rows under `madarch/` whose names end in
  `.yaml` — the folder decision 0002 keeps the model in and `src/model/load.ts`
  reads it from. The unit reads the bytes with `evidence_span` at the pinned
  commit, each read recorded as its dependency. A product whose repository
  declares no model holds no rows: the section is read as absent, the unit
  recovers without a model side, and no mismatch is raised for a model that is
  not there.
- **The mapping is a claim of a fixed predicate, and a mismatch is a question.**
  A `maps-to` claim's subject is the recovered component, its object a literal
  naming the intended element exactly as the model spells it, and its evidence
  the model bytes that declare the element — the same shape a document's intent
  claim takes to the code node it names. A recovered part no intended element
  answers to, and an intended element nothing recovered answers to, is a
  question of type `contradiction` (self-filling's outcome 5, the type stage 10
  raises for a document that contradicts the code) naming both sides. The stage
  writes the model's words as nothing: what the model declares is the product's
  own, and the agent's reading of it is proposed at the `meaning` level.
- **Interactions run between the nodes the schema lets an interaction join.**
  `EDGE_END_KINDS.interaction` names deploy units and symbols, so a recovered
  relation between two components of the system is written between the deploy
  units that run them (or the symbols that carry it), with `form` one of call,
  event, http, message or sql and `via` naming what carries it — the graph's own
  vocabulary, never a second one.
- **A stage's own sections describe the product.** The split's children stand at
  the repository level, where the stage's sections hold nothing: a child's packet
  is the shape's own of its repository, and its coverage is what it read there.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch is two commits
over `origin/main` `b68f1c65`, which it was rebased onto last (that rebase folds
stage 9 of madarch-tzte.24.2 and the pages stage of 25.1 in, whose registration
lines stand beside this stage's in `src/fill/stages/index.ts`; the review round's
fixes are the second commit).

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch and after
  the rebase.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.6 --candidate worktree --target origin/main`) exit 0,
  clean, after every edit round and at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - Before the rebase: `test/fill-recovery-stage.test.ts` — 9 pass, 0 fail, exit 0
    (`run-20261020-200119`); `test/fill-impact.test.ts` — 4 pass, 0 fail, exit 0
    (`run-20261020-200449`), after its reran list named this stage's unit; and with
    it the suites of every file the branch touches and their direct importers —
    `test/fill-recovery-stage.test.ts`, `test/fill-impact.test.ts`,
    `test/fill-stages.test.ts`, `test/fill-registry.test.ts`,
    `test/fill-agent-stage.test.ts`, `test/fill-overview-stage.test.ts`,
    `test/fill-agent-packet.test.ts`, `test/fill-agent-unit.test.ts`,
    `test/fill-checked-writes.test.ts`, `test/fill-doc-intent-stage.test.ts`,
    `test/fill-intent-history-stage.test.ts`,
    `test/fill-understanding-stage.test.ts` — 169 pass, 0 fail, exit 0
    (`run-20261020-200544`); and `test/fill-orchestrator.test.ts`,
    `test/fill-crash-suite.test.ts`, `test/product-daemon.test.ts`,
    `test/product-cli.test.ts` — 204 pass, 0 fail, exit 0
    (`run-20261020-200812`).
  - After the review round and the rebase (stage 9 and 25.1 in):
    `test/fill-recovery-stage.test.ts`, `test/fill-impact.test.ts`,
    `test/fill-facts.test.ts`, `test/fill-registry.test.ts`,
    `test/fill-stages.test.ts`, `test/fill-boundaries-stage.test.ts`,
    `test/fill-narrative-stage.test.ts`, `test/fill-narrative-pages.test.ts`,
    `test/fill-understanding-stage.test.ts` — **219 pass, 0 fail, exit 0**
    (`run-20261020-204121`).
- CI on the exact SHA of the branch: named in the queue entry.
- No mutation receipt: the owner's rule runs Stryker once per assembled stage,
  off the path; acceptance escalates per `mutationFallback: escalate`.
- The independent review, one fresh read-only session over
  `git diff origin/main...HEAD`, told not to run anything on this machine
  (`glm-5.3-flash-auto`): verdict `fix-before-ship`, two defects and eight
  findings, every one answered here.
  - **D1**: the record's evidence sentence named `origin/main` `dea75e75`, the
    base the branch started from, after the branch had been rebased onto the
    narrative-stage merge. Answered: the sentence names the base the branch was
    rebased onto last, as 24.5's record does.
  - **D2**: the intended-model filter matched YAML files below a folder of
    `madarch/` (`madarch/spec/old.yaml`), which the model loader never reads
    (`src/model/load.ts` lists the folder, no recursion), so the unit could have
    mapped a recovered part to an element no loaded model holds. Answered: the
    filter refuses a further `/` after the folder, and the suite feeds a nested
    YAML file through the fixture and asserts the section holds only the model's
    own (`test/fill-recovery-stage.test.ts`).
  - **Findings 1–8**: the ordering reasoning and its test, the absence of dead
    consumes, the schema's stage table and end kinds, the packet's shape, the
    DONE WHEN clause by clause — each checked and held; the places reader's and
    the summary text reader's duplication of the siblings' is the shape's own
    pattern for a stage that declares itself (finding 5); the `overview`
    section's holding the stage's own earlier claims on a rerun is the read
    standing as it stands (finding 6); the impact fixture's block comment now
    names the recovery unit beside the pages stage's (finding 7); and the test
    file's duplicate imports are folded (finding 8).

## DONE WHEN

- One unit per product reads the module summaries (stage 12), intent (10, 11) and
  the overview hypothesis (8) and writes the recovered architecture beside the
  intended one (the product's model, if any) with the mapping between them;
  mismatches become open questions.
- Fake ACP agent tests.
