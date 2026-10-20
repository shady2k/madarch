# Stage 9 proposes the module-boundary refinements the clustering asks for, each with its evidence

Change: madarch-tzte.24.2
Base: 24ec77f2
Tasks: madarch-tzte.24.2
Kind: no-behavior

## Intent

Decision 0026, "Stages": "Agent: 8 overview hypothesis, 9 module-boundary
refinement, 10 intent from documents, 11 intent from comments and commits, 12
module understanding bottom-up (leaves first, parents from children's summaries),
13 system recovery and reconciliation (recovered architecture beside the intended
one with the mapping between them). Every stage writes facts into the graph and
reads its context from it." Stage 8 landed on the agent-stage shape of
madarch-tzte.24.1; stage 9 is the second of the six to declare itself on that
shape, and the one the modules stage (madarch-tzte.21.7) built its clustering
for: "a refined boundary is stage 9's".

The task's DONE WHEN: "Units per repository/package read the modules stage's
clustering (21.7) with its members, edges and importance, and propose boundary
changes (merge, split, rename) as claims with evidence spans; accepted by nothing
automatically (proposed)." And: "Fake ACP agent tests: proposals written as
checked draft writes, refused when they name nodes outside the unit's scope."

- **`src/fill/stages/boundaries.ts`** — stage 9 (`boundaries`, fact stage
  `9-boundaries`): one unit per repository that holds modules — the repository's
  clustering — estimated at the members stage 5 counted (a top-level module's
  count is its subtree's, so the sum is the whole tree of files and symbols);
  a repository past 0026's planned size is planned one unit per top-level
  module, whose scope is the folder the module's own files stand in, and a
  repository past the plan's unit bound stands as one unit, as every scope the
  bound cannot enumerate does. The packet adds the clustering of its scope to
  the shape's own sections: `clustering` (the modules with the members stage 5
  counted and the importance its PageRank gave them, most important first, each
  with the folder its own files stand in) and `moduleMembers` (the `contains`
  tree that holds the modules to their files and to each other — the edges the
  clustering holds; madarch-tzte.21.7 left a module-to-module dependency rollup
  out, so the tree is the edges there are). A unit's places are the modules of
  its scope at the level below it, each named by its folder — or by its own name
  where its files name no folder — and a module with no sub-modules stands as
  its one place, which no child of it covers.
- **What a unit writes.** Proposed modules — `module` facts at 0005's `inferred`
  layer, always `proposed`, each carrying the `proposal` the schema gives stage
  9: the change asked for (`merge`, `split` or `rename`) and `replaces`, the
  ids of the modules of the clustering it would replace — and questions, where
  the clustering does not say enough for a boundary to be proposed at all. The
  schema's own table gives the `module` kind to stage 9 beside stage 5 (a landed
  test holds the pair), so the proposal is a module the graph holds beside the
  modules it would replace — "claims with evidence spans" in the task's words —
  and never a rewrite of them: a person's acceptance is a record beside the
  facts (0005), so nothing this stage writes is accepted by anything
  automatically. The statements stand at the `meaning` level: a boundary is an
  assumption read out of the code, never a fact.
- **`src/fill/facts.ts`** — `ModuleValue.proposal` (`change`, `replaces`),
  `MODULE_PROPOSAL_CHANGES`, and the `module` kind's value shape at version 2;
  the identity is untouched, so a proposed module stands beside the modules it
  would replace, never over them. The check reads the rule the stage's own
  writing asks for: an `inferred` module is one proposal — the change and at
  least one module it would replace, in code point order, each once — and an
  extracted module carries no proposal; a proposed module's `seed` is `cluster`,
  the word for a cluster an agent read out of the code, never the package or
  build target a manifest seeds.
- **`src/fill/checked-writes.ts`** — a write names the nodes of its own scope.
  `WrittenNode` carries the node's repository (and the file its fact stands at,
  where it has one), `factGraph` answers both from the stored provenance, and
  the write path refuses a referenced node that stands outside the unit's scope
  — a proposal that would replace a module of another repository, or a claim
  whose subject stands at a file the scope's folder does not hold — naming both.
  A node the unit's own draft set took passed the check when it was written, and
  a unit of the whole product covers every repository the run pins, which the
  pinned-commit check of the cited bytes holds, as `scopeHolds` held before.
- **`src/fill/stages/index.ts`** — the stage's one import and one `.register`
  line beside stage 8's, where the run's wiring names an agent.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's "Stages",
"Agent input", "Scale" and "Writing"; 0027's plan, split and publication;
0005's layers and statuses; self-filling's outcome 4) without moving a
requirement of the product. The fill's capability is proposed by change
`fill-pipeline-monday` and is not closed, so the rebuild's own requirement text
lands with the stage that closes decision 0026, exactly as madarch-tzte.24.1
and 24.3 recorded theirs.

No served surface moves: the daemon's fill wiring names no agent
(`src/product/fill-stages.ts`), so a run registers no agent stage today; the
registry's and the write path's changes are visible to a run that wires one,
which is what the tests do. The write path's new refusal only narrows what a
wired run's units may write — a unit never could publish a fact about another
unit's scope honestly — and the schema's new field is read by nothing served.

## Out of scope

- **Stages 11 to 13.** 24.4 to 24.6 declare themselves on this shape; this
  change lands stage 9 only.
- **An acceptance path for proposals.** 0026 makes a person's acceptance a
  record beside the facts; nothing here applies a proposal to the graph, and
  the modules it would replace stand until that decision lands.
- **A module-to-module dependency rollup.** The clustering's edges are its
  `contains` tree; the `dependency` rollup madarch-tzte.21.7 left out is
  nobody's unit until a stage reads it, and a boundary the imports would move
  is the unit's to read out of the files the packet names.
- **The cost of the overview waiting for the refinement.** The overview's own
  required `module` consume (madarch-tzte.24.1) now draws an edge from this
  stage too, so a wired run's overview reads the graph after stage 9 publishes
  its proposals. That is the declared graph's honest answer — the overview
  reads the modules the graph holds, refined ones included — and stage 8's
  declaration is not this change's to amend.
- **A path-level refusal of a module that straddles the scope's folder.** A
  module fact carries no path, so the write path holds a named node to its
  repository and, where its fact cites a place, to the scope's folder. A
  package-level unit could name a same-repository module whose files stand
  outside its folder; the cited bytes stay inside the scope, and the proposal's
  own `replaces` is what a reader judges. The fix would be a path on the module
  fact, which is the clustering's to carry and not the schema's.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and the registered stages still read together with no cycle — stage 9 after the modules stage, by the `module` consume they share by rule (a stage that produces and consumes one capability reads its own earlier publication, and no edge runs from it to itself).
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest; the stage's own bounds (`BOUNDARIES_MODULE_ROWS`, `BOUNDARIES_MEMBER_ROWS`) are its section caps, not new limits a product configures.
- fill-orchestrator/plan: a run still plans its units from the declared stages; the plan reads the graph and nothing else, estimates in 0026's own measure, and stands a scope it cannot enumerate as one unit.
- fill-orchestrator/attempt: unchanged by this change — the shape runs the attempt, exactly as madarch-tzte.24.1 left it.
- fill-orchestrator/split: unchanged by this change — the split seals the uncovered places as the children's scopes, exactly as madarch-tzte.24.1 left it.
- fill-orchestrator/publish: unchanged by this change — the publication is one transaction, exactly as madarch-tzte.24.1 left it.
- server/protocol: the unit tool route, its refusals and its order are unchanged; the write path answers two refusals more (a referenced node outside the scope, and a module write whose id already stands in the graph), at the same field paths the other refusals name.
- release-binary/installers: no dependency is added; the plan and the sections are this repository's own reads.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test
- server/protocol: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **A proposal is a `module` fact, not a `claim`.** The schema's own table gives
  the `claim` kind to stages 8, 10, 11, 12 and 13 — and to stage 9 it gives the
  `module` kind, beside stage 5's (`test/fill-facts.test.ts` holds the pair). A
  boundary change is a module the graph should hold, so the proposal *is* one:
  the same identity rule (repository, parent, name), the same page a reader
  walks, standing beside the modules it would replace at the `inferred` layer
  and the `proposed` status 0005 gives every agent statement. The task's
  "claims with evidence spans" is the write path's own contract: every write
  cites bytes madarch reads at the pinned commit, and an accepted write lands
  in the draft set with that evidence.
- **The proposal names the change and the replaced modules, because the graph
  must say it alone.** A merge that only added a module named `checkout-payments`
  would leave a reader guessing which modules it meant; `proposal.replaces`
  names them by id, in code point order, each once — and the referenced-node
  check (which every fact-id field a value carries goes through) holds each of
  them to a node the graph holds and to the unit's own scope.
- **An `inferred` module is one proposal, and an extracted one is none.** The
  two layers of one kind would otherwise be read the same way, and a reader
  could not tell stage 5's clustering from stage 9's refinement without reading
  the provenance's source. The rule sits in the schema's check, where the layer
  is already read, and it refuses the seed that would make no sense (`package`
  or `build-target` on a proposal) with it.
- **The plan splits at the top-level modules' folders.** 0026's hierarchy runs
  product → repository → package/build target → cluster, and the clustering's
  own top level is where its seeds — the packages and build targets — stand. A
  scope of one folder keeps the unit's cited bytes inside it, which is what the
  checked writes hold a unit to. A module whose files name no folder (a
  cluster-seeded root, a grouping level) is planned at the repository's own
  scope, and it is no place of any unit: a place is what a child unit would
  cover, its scope text would be the parent's own, and the shape's own rule for
  what a place is ("a file's symbols are no place") keeps such a module in the
  unit's own scope, read through the packet's clustering like every other
  module of it. The coverage's completeness therefore says what the packet
  enumerated whole — every module of the scope, nameless ones included — and
  the places say only what a split would name.
- **The estimate is the members stage 5 counted.** A top-level module's
  `members` is its subtree's count of files and symbols
  (madarch-tzte.21.7), so the sum over the top level is the whole tree — the
  reading one unit of this stage does — and the plan computes it from the graph
  and nothing else (0027's `plan(graph)`), against 0026's default window.
- **A write names the nodes of its own scope.** The DONE WHEN asks for the
  refusal, and the honest place for it is the write path, where the unit's
  scope is already known and every referenced id is already looked up. The port
  gained the node's repository (and its file, where its fact cites a place), so
  the check is the same rule `scopeHolds` applies to a cited place, applied to
  the nodes a write names.
- **No consume of a kind an agent stage writes.** The stage produces `module`
  and consumes it — the registry's own rule reads a stage's earlier publication
  there and draws no self-edge — and it consumes nothing else an agent stage
  writes: a declared `question` or `claim` consume would order stage 9 after
  every later stage that writes them and close the cycle madarch-tzte.26.1 cut
  out of the pair above it.

  - **Open points and known limitations**, named here rather than left to be found:
  - **Two top-level modules whose own files share one common folder plan two
    units at the same scope text.** The scope is the folder the module's own
    files stand in, so two modules of one folder (a clustering that cut on
    nothing else) are two units that read the same tree and can propose
    overlapping boundaries of it. The plan dedupes nothing: the units are the
    modules the graph names, and their proposals name the modules they would
    replace, which is what a reader judges. A second spelling would have the
    plan invent a grouping the graph does not hold.
  - **A unit of one module's folder sees its module's subtree only.** A merge
    across a repository's top-level modules is proposed by the repository unit —
    the one a repository whose clustering fits plans — and a repository past the
    planned size is refined per module, so its cross-module merges wait for a
    smaller clustering. The packet's own bounds and the run-time split are what
    0026 divides a scope with, and the coverage names what nobody read.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## Acceptance evidence

The checks, each command's own exit status, at hand-over.

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.2 --candidate worktree --target origin/main`)
  exit 0, clean, at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - On the rebased tree (this branch's own commit over origin/main):
    `test/fill-impact.test.ts`, `test/fill-registry.test.ts`,
    `test/fill-facts.test.ts`, `test/fill-boundaries-stage.test.ts`,
    `test/fill-doc-intent-stage.test.ts`, `test/fill-checked-writes.test.ts`,
    `test/fill-overview-stage.test.ts` — **219 pass, 1 fail** (run-20261020-165710),
    the one failure the landed impact expectation that now names stage 9's
    inherited units (the change record's own correction), and
    `test/fill-impact.test.ts` again after it — **4 pass, 0 fail, exit 0**
    (run-20261020-174826). Stage 10's suite passes beside this change's write
    path unchanged (run-20261020-165710).
  - On the pre-rebase tree, whose fill files this rebase carries unchanged:
    the agent set `test/fill-agent-packet/-agent-unit/-agent-stage` and the
    overview, unit-tools and unit-limits suites — **88 pass, 0 fail, exit 0**
    (run-20261020-164722); the orchestrator, crash-suite, graph-reads, stages
    and product-daemon suites — **106 pass, 1 fail** (run-20261020-164838),
    the one a fixture of `test/fill-graph-reads.test.ts` whose inferred module
    now carries its proposal (this change's own rule), re-run alone —
    **29 pass, 0 fail, exit 0** (run-20261020-165330); stage 9's own suite —
    **7 pass, 0 fail, exit 0** (run-20261020-164611).
- CI on the exact SHA of the branch: named in the queue entry.
- The independent review, one fresh read-only session over
  `git diff origin/main...HEAD`, told not to run anything on this machine
  (`glm-5.3-flash-auto`): verdict `fix-before-ship`, three defects and five
  findings, every defect answered in code or tests, every finding answered:
  - **D1**: a proposal named after a module of the clustering digests to that
    module's own id (the identity is repository, parent, name), and the
    publication's measured-field merge would overwrite the extracted fact —
    the seed and the member count would be the proposal's, and the proposal
    itself would never land. Answered twice: the schema refuses a proposal
    that names its own id among the modules it replaces, and the write path
    refuses a `module` write whose id already stands in the graph, naming it —
    "a proposal stands beside the modules it would replace, never over them".
    Held by `test/fill-facts.test.ts` (the schema's leg),
    `test/fill-checked-writes.test.ts` (the write path's leg, the rename that
    would collide) and `test/fill-boundaries-stage.test.ts` (a proposal named
    `checkout` beside the standing `checkout` lands nothing).
  - **D2**: the `moduleMembers` section's comment claimed an importance order
    the sort's first key (the module's id) does not carry. Answered: the
    comment says the tree is ordered by the module that holds each row, then
    files before modules, then the path.
  - **D3**: no test wrote a `split` proposal. Answered: the end-to-end suite's
    unit now proposes the split of the checkout module, one proposed part
    nested in the module it would leave, and publishes it beside the merge and
    the rename.
  - **F1** (two top-level modules of one folder plan two units at one scope
    text): recorded as a known limitation, with the reason the plan dedupes
    nothing. **F2** (the `file` consume's scope): declared at `repository`,
    the breadth the section's one read has, as stage 5's own declaration names
    it. **F3** (the packet read its clustering once per section): one read set
    per unit, both sections answering the same rows. **F4** (a fixture
    comment claimed a published module): the comment says what stands and why
    the tool-level check is not this test's. **F5**: judged acceptable and
    recorded (the repository line is the finest a module fact carries).

## DONE WHEN

- Units per repository/package read the modules stage's clustering (21.7) with
  its members, edges and importance, and propose boundary changes (merge,
  split, rename) as claims with evidence spans; accepted by nothing
  automatically (proposed).
- Fake ACP agent tests: proposals written as checked draft writes, refused when
  they name nodes outside the unit's scope.
