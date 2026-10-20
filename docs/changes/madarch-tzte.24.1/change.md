# The agent stages share one shape, and stage 8 writes the product's overview hypothesis from the graph

Change: madarch-tzte.24.1
Base: dbf138d8
Tasks: madarch-tzte.24.1
Kind: no-behavior

## Intent

Decision 0026, "Stages": "Agent: 8 overview hypothesis, 9 module-boundary
refinement, 10 intent from documents, 11 intent from comments and commits, 12
module understanding bottom-up (leaves first, parents from children's summaries),
13 system recovery and reconciliation (recovered architecture beside the intended
one with the mapping between them). Every stage writes facts into the graph and
reads its context from it." Its "Agent input" and "Scale" say what every one of
those six has in common: "A fixed part (role, rules, limits, answer schema with an
example, tool descriptions), a per-unit packet assembled from the graph without an
agent …, and tools. No file content is pasted." And: "Units form a hierarchy:
product → repository → package/build target → cluster → sub-cluster, split until a
unit's estimate (computed from the graph) fits. Summaries are bounded (~2K tokens)
and fan-in is bounded (~50 children …), so every level, the product overview
included, fits a unit."

The unit that reads and writes the graph landed as madarch-tzte.22.3: a packet of
at most 20K tokens, the guard of the session's and the server's usage, a partial
result with its coverage, and the orchestrator's split (madarch-tzte.19.5, 20.4,
22.2). What did not land is the part that tells six stages apart: that stage has
one hard-coded role, one hard-coded rule set, one answer contract, one packet and
one plan, and a second stage built beside it would be a second copy of all five.

This change lands the shape those six declare themselves in, and stage 8 on it:

- **`src/fill/stages/agent-stage.ts`** — the shape. A stage declares its **fixed
  part** (role, its own rules, its answer schema with an example, and the level of
  the fill's three its statements stand at), **how its per-unit packet is assembled
  from the graph** (the stage's own sections, each a read of the graph recorded as
  the unit's dependency), **its scope plan** (units from the graph at one level of
  0026's hierarchy, the two bounds that decision fixes — a child's summary at ~2K
  tokens and a parent's fan-in at ~50 — and what one unit's places are, so a split
  names the level below), and **what it may write** (the fact kinds, and the layer and status the
  shape fixes for every agent stage). The module then runs one unit: the packet, the
  ACP session with the unit's MCP server, 0026's limits, the coverage, and the split.
- **`src/fill/stages/overview.ts`** — stage 8, the product's overview hypothesis:
  one unit per product, whose packet holds the repository-level graph (the product's
  repositories, its modules with stage 5's PageRank importance, its entry points, its
  packages, its documents' sections), and which writes a claim set with its sources.
- **`src/fill/agent-packet.ts`** — the fixed part and the packet are parameterized:
  the role, the rules, the answer (shape, reading, example and fields), the level,
  the stage's own sections, and a **product place** for a unit of the whole product.
  `readAgentAnswer` judges a turn against the fields the stage declared and names the
  field it got wrong, which is what a unit that answered wrong is asked again with.
- **`src/fill/checked-writes.ts`** — a unit's scope may be **the product**
  (`PRODUCT_SCOPE`, `"*"`): every repository the run pins. A write of such a unit
  cites the bytes it read in whichever repository they stand in, and its evidence, its
  provenance, its question's and its proposal's repository are the ones the cited
  bytes name — the run's pins are what keeps it to the product's own repositories.
- **`src/fill/stages/agent-unit.ts`** — the landed stage of 22.3, kept as the shape's
  reference declaration: it is the generic unit (one unit per repository, 0026's own
  answer, the eight kinds an agent unit may write) in the shape's terms, and it is no
  stage of a run — `stages/index.ts` registers stage 8 where it registered it, so a
  run does not read the same scopes twice and spend the owner's caps on a claim set
  0026 asks no stage for.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's "Agent input",
"Scale" and stage 8; 0027's plan, split and publication; 0005's layers and statuses;
self-filling's outcome 4) without moving a requirement of the product. The fill's
capability is proposed by change `fill-pipeline-monday` and is not closed, so the
rebuild's own requirement text lands with the stage that closes decision 0026,
exactly as madarch-tzte.20.1 to 22.3 recorded theirs.

No served surface moves: the daemon's fill wiring names no agent (`src/product/
fill-stages.ts`), so a run registers no agent stage today; the registry's change is
visible to a run that wires one, which is what the tests do. No route, command, help
text or product command changes.

## Out of scope

- **Stages 9 to 13.** 24.2 to 24.6 declare themselves on this shape (module
  boundaries, the intent of documents, the intent of comments and commits, modules
  bottom-up, the recovered system); this change lands the shape and stage 8 only.
  Their capability declarations, their places, their sections and their kinds are
  theirs to declare.
- **Children's summaries and the fan-in grouping level.** 0026's "Scale" bounds a
  summary at ~2K tokens and a parent's fan-in at ~50 children. This change declares
  the level a unit stands at, the level below it and both bounds (`scale`,
  `resolvedScale`), and tells every unit of them; the packet section that reads a
  child's summary, and the intermediate grouping level a plan inserts once a level
  holds more than the fan-in bound, are the bottom-up stage's (24.5), which is the
  one that reads children.
- **A registry entry for every agent stage of a build.** `stages/index.ts` registers
  the agent stages this build holds — stage 8 today — and each of 24.2 to 24.6 adds
  its own line there.
- **What the agent's answer means beyond its coverage.** A stage's answer fields are
  its own (its status, its places, its texts); the claims and questions it writes go
  through the checked write path, not through the answer.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not current,
  as the changes before this one recorded theirs.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and its declaration is still pure data; the agent stages of this build are registered where the shape's own reference stage stood, one per stage of 0026 as each lands.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest, and a run still snapshots what it resolved; the numbers a unit is held to are the limits its stage resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; stage 8's plan is one unit per product, and the generic unit's plan (one per repository, split into member places) is unchanged.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence, with the unit's own MCP server opened for the attempt and closed when it ends.
- fill-orchestrator/split: a split still seals its child set and its parent's checkpoint in one transaction and suspends its parent; what a child covers is now the level below the unit in 0026's hierarchy (a repository for a unit of the product), and a place that is the unit's own scope is still no child of it.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it.
- server/protocol: the unit tool route, its refusals and its order are unchanged; a write's evidence and provenance now name the repository the cited bytes stand in, which is the repository the unit was planned for in every case that existed before this change.
- release-binary/installers: the release binary still builds, installs and runs, and a unit's MCP server is still started by this program's own command line; no dependency is added.

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

Taken from decisions 0026, 0027, 0005 and self-filling's outcome 4; nothing here
re-decides them.

- **The four things a stage declares, and why exactly those.** 0026's "Agent input"
  splits a prompt into a fixed part and a per-unit packet, and its "Scale" says what
  a plan is for; its "Writing" says what a unit may write. So a declaration holds a
  role, rules and an answer (the fixed part), sections plus the shape's own packet
  (the per-unit part), a plan and places (the plan), and kinds plus a level (what it
  may write) — and nothing else. A stage that needed a fifth thing would be a stage
  whose difference is not any of those, and none of 0026's six is.
- **The answer schema is data, and a wrong answer is refused by the field.** A stage
  declares its fields (a status, lists of places, texts) with the JSON sketch, the
  reading and the example 0026 asks for, and `readAgentAnswer` reads the last object
  of a turn the schema holds. A turn that answers wrong is refused with the field's
  own name — `status` is `done` or `partial`, `covered` is a list of places, the
  answer names no `finding` — and the unit is asked again inside 0026's turn limit,
  which is what 0026's "returns what it has" needs to be a limit and not a guess.
  A list entry that is no text names no place: an answer is read as covering fewer
  places, never more, so a malformed list can only make a unit split more.
- **A unit's places are what its coverage counts and what its children cover.**
  0026's scale rule splits "until a unit's estimate fits", and 0027's split names the
  children of a stopped unit. One declaration says both: a unit's places are a
  repository's folders and files (`placesOfMembers` of its packet) or the product's
  repositories, each place carries the scope a child covering it would carry, and the
  places a unit did not cover are the children of its split — in code point order, at
  most `SPLIT_CHILDREN`, the rest named as `budget` gaps in its coverage.
- **A unit of the whole product writes in every repository it pins.** 0026's
  hierarchy puts the product at the top and both the overview and the recovered
  system stand there; their claims are about the product's parts, and their sources
  are the bytes those parts stand in. A scope of one repository would force every
  claim to cite the product repository's documents, which is not where the evidence
  is. So the write scope gained the product's own text (`"*"`, the one text that is no
  repository name), the write path names the repository its cited bytes stand in, and
  the pinned-commit check — which already refused a repository the run does not pin —
  is what keeps such a unit inside the product. The refusal names the pinned
  repositories, as it did before.
- **The product's coverage is one fact per repository.** A coverage's identity is its
  repository, its scope and its reader (`FACT_KINDS.coverage`), so a unit of the
  product cannot state its coverage in one fact: it writes one per repository its
  places stand in, each saying whether that repository of the product's reading was
  read whole, with its own commit as the evidence. The landed unit of one repository
  writes the one fact it wrote before, its scope named by the node it covers.
- **The overview hypothesis is one unit per product, and its place is the product's
  own word.** 0026's stage 8 reads the repository-level graph and its hierarchy's top
  is the product; the unit's id is the graph's own word for that scope (`product`,
  the token `CoverageValue` already uses for a product-wide scope) because no node of
  the graph stands for it and an id carrying a run would be a second unit every run
  (0026, "Updates"). Its places are the product's repositories, so a unit that cannot
  finish splits into them, which is the level below it in 0026's hierarchy.
- **What stage 8 may write is a claim, a question and its coverage.** 0026 makes an
  agent's statement `proposed` at 0005's `inferred` layer, and the schema's own table
  gives the claim kind to stages 8, 10, 11, 12 and 13. The overview states what the
  product is (claims), asks a person where the graph does not say enough (questions),
  and reports what it read (coverage, which the shape writes for every agent stage).
  The level of its statements is `meaning` in self-filling's three — "meaning (only
  assumed)" — and the fixed part tells every unit of it so; an intent stage declares
  `intent` and gets the other sentence.
- **A packet's keys are the packet's, and a stage's section takes one of its own.** A
  stage adds lists to a unit's packet (`sections`), and a section whose key the packet
  already holds — one of the shape's (`unit`, `place`, `scope`, `members`,
  `entryPoints`, `data`, `relations`, `history`, `writes`) or another stage section's —
  is refused by name when the packet is built. A silent replacement would drop a list
  the packet had already read and charged for, which is 0026's "no silently smaller
  result" broken in the assembly that promises to name every cut. A section may say
  which units hold it (`when`): a stage whose sections describe the product declares
  them for the product's unit, and the units of the level below read the shape's own
  sections of their repository.
- **A write of a kind the stage does not declare is refused when it is made.** 0026's
  "every write is checked at once" is the tool's contract, not the publication's: a
  unit's write session carries the kinds its stage produces, and a write of any other
  kind is refused with the stage and the kinds it does declare. Without it the refusal
  would arrive at publication, where it spends the unit's whole draft set and the agent
  run with it — the trap madarch-tzte.22.3 named for the kinds it declared broadly.
  The registry refuses the declaration itself earlier still: a kind the schema's table
  does not give the stage's own stage of 0026 (or a kind the schema lacks) is refused
  where the stage is registered, naming both.
- **The member that stands at a place names it, never one that merely cites it.** A
  packet's members are ranked (0026: "ranked symbols without bodies"), so an entry
  point or a module at a file's path comes before the file. A child named by such a
  member would describe a node whose own places lie outside the child's write scope, so
  the folder or the file of the scope names the place (the rule `splitChildren` always
  held, now the shape's own place reader).
- **The unit's own word for how far it got is part of its coverage.** A unit that
  answers `partial` publishes no complete coverage, whatever its `remaining` list says:
  0005 makes a complete coverage the only ground for a claim of absence, and `partial`
  is the unit's own word for not having finished.
- **A stage's plan estimates 0026's planned size, never the run's limits.** A plan
  reads the graph and nothing else (0027's `plan(graph)`), so the generic repository
  plan estimates against 0026's default window: a product that narrows its window
  makes a unit split earlier at run time, never later, because the guard reads the
  resolved limits.
- **The generic unit of 22.3 stays as the shape's reference declaration.** Its
  behaviour is the one its own tests hold (packet, limits, coverage, split, join,
  re-seal refusal), so it is the cheapest proof the shape did not change what it
  refactored. A run does not register it: stage 8 stands where it stood, because two
  agent stages reading one scope would double the owner's agent spend for a claim set
  no stage of 0026 asks for.

  - **Open points and known limitations**, named here rather than left to be found:
  - **A cut repository list is not a scope a product unit may call read whole.** The
    product's places are the repository facts, which the store answers whole, so
    nothing is cut today; a cut list would put the gap in the first place's coverage
    and no place would be claimed complete. 0026's fan-in bound (~50 children) is
    where a real product's list stops fitting a unit, and that bound belongs to 12
    (24.5), which reads children's summaries.
  - **A child unit of stage 8 reads the graph of its repository, not the product's.**
    A unit the split makes covers one repository, so its packet is the shape's own
    sections of that repository (its node, its ranked members, its entry points, its
    data, the relations reaching it, its history) and not the stage's product-level
    lists. Whether a repository-level overview should be written at all is a question
    for 24.7's answer-key report, not for the shape.
  - **The product's plan names one unit whatever its estimate.** 0026's top level is
    one unit per product ("so every level, the product overview included, fits a
    unit"), so `productUnits` does not split a product of many repositories: the
    packet's own bounded sections and markers, and the split into repositories when
    the unit cannot finish, are what keep it reading. Splitting the product level
    itself would be a repository-level reading, which is what 0026's lower levels are
    for.
  - **The shape adds `coverage` to a stage's declared kinds.** Every unit writes the
    coverage of what it read, so `produces` holds the stage's kinds and `coverage`,
    in code point order; a stage that declared it itself gets one entry, not two.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch is one commit over
`origin/main` `6e0dd507`, which it was rebased onto last (that rebase folds
madarch-tzte.38's turn watch in: the shape's own attempt arms `watchUnitTimeLimit` for
every turn in flight, where the landed stage's code had stood, and carries its tests).

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch and after the
  rebase.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.1 --candidate worktree --target origin/main`) exit 0, clean,
  after every edit round and at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - `test/fill-agent-packet.test.ts`, `test/fill-agent-unit.test.ts`,
    `test/fill-agent-stage.test.ts`, `test/fill-overview-stage.test.ts`,
    `test/fill-checked-writes.test.ts`, `test/fill-unit-tools.test.ts`,
    `test/fill-unit-limits.test.ts`, `test/fill-stages.test.ts`,
    `test/fill-registry.test.ts` — **171 pass, 0 fail, exit 0** (`run-20261020-120003`).
  - `test/fill-orchestrator.test.ts`, `test/fill-crash-suite.test.ts`,
    `test/fill-graph-reads.test.ts` — 107 pass, 0 fail, exit 0 (`run-20261020-120122`).
  - After the rebase (madarch-tzte.38's tests in): the first list again — **178 pass,
    0 fail, exit 0** (`run-20261020-121754`), and `test/fill-orchestrator` +
    `test/fill-crash-suite` + `test/fill-acp` + `test/product-daemon` — 138 pass,
    0 fail, exit 0 (`run-20261020-121937`).
  - `test/product-daemon.test.ts`, `test/product-cli.test.ts` (the direct importers of
    the host this change touches) — 115 pass, 0 fail, exit 0 (`run-20261020-120450`).
  - Before the review's answers: the same files with the stage-8 suite at 5 tests — 165
    pass, 0 fail, exit 0 (`run-20261020-105539`), and `test/fill-orchestrator` +
    `test/fill-crash-suite` + `test/fill-graph-reads*` + `test/fill-fact-store` — 127
    pass, 0 fail, exit 0 (`run-20261020-105649`).
- CI on the exact SHA of the branch: named in the queue entry.
- The independent review, one fresh read-only session over `git diff origin/main...HEAD`,
  told not to run anything on this machine (`deepseek-v4.1-flash-auto`): verdict
  `fix-before-ship`, seven defects and fourteen findings, every one answered here.
  - **D1**: a stage section could replace one of the shape's keys silently (a stage-8
    child would have lost the shape's `entryPoints`, with no marker). Answered: the
    packet refuses a section whose key it already holds, `AgentPacketSection.when` lets a
    stage speak for one level, and the split test now runs both children and asserts
    their packets' keys (`test/fill-agent-stage.test.ts`, `test/fill-overview-stage.test.ts`).
  - **D2**: the shape's place reader named a place by the first ranked member rather than
    the folder or file that stands there, so a child could be named by a module and then
    be unable to write in its own scope. Answered in `memberPlaces`, with the test that
    holds both members at one path; the landed signatures that hid it (`splitChildren`,
    `coveredPlaces`, `placesOfMembers`) are gone, and the landed tests now drive the
    functions production runs.
  - **D3**: the tools invited kinds a narrow stage does not declare, and the refusal
    arrived at publication, spending the whole draft set. Answered at once by the write
    path (`CheckedWriteSession.kinds`, wired by the host from the registry), by the
    registry's own refusal of a declaration the schema's table does not give the stage,
    and in the fixed part's words; tested in `test/fill-checked-writes.test.ts`,
    `test/fill-agent-stage.test.ts` and the stage-8 suite.
  - **D4**: the product unit's id was `*` where the record said `product`. Answered:
    the plan's id and a coverage's scope are `PRODUCT_SCOPE_NAME` (`product`, the token
    `CoverageValue.scope` documents), and the scope *text* stays `"*"`, which is the one
    text no repository can be named by.
  - **D5**: the tree was dirty at review time. Answered: every edit is in the branch's
    commit, and the checks above belong to it.
  - **D6**: a product unit that answered wrong was nudged with "the scope * names no
    place of its own". Answered: the places are read before the session and the nudge
    names the repositories of the product; asserted in the stage-8 suite.
  - **D7**: an answer's `status` was read and ignored. Answered: a `partial` answer never
    publishes a complete coverage, and the stage-8 suite holds it.
  - **Findings 1–14** are answered too: the dead landed duplicates are removed (1);
    `factStage` is now what refuses a kind the stage's own stage of 0026 does not write
    (2), which also refuses an unknown kind by name (3); `produces`'s scope mapping is
    named for what it maps and commented for what it is (4); one level type, and the
    unused list is gone (5); the hierarchy sentence names the place level (6); the
    product plan's own estimate is documented as not splitting (7), and the record says
    so; the dead expression and the unsorted `unread` are gone (8); the `writes` note
    promises nothing the stage refuses (9); the reference declaration uses the packet's
    own role constant (10); the import spelling is the siblings' (11); the record names
    `memberPlaces` (12); packet-section tests cover a cut, a bound, a duplicate refused
    and a `when` that leaves a section out, and the stage-8 suite runs a child unit (13);
    and this evidence names its runs and each command's own exit status (14).

## DONE WHEN

- A shared agent-stage shape in `src/fill/stages/` declares a stage's fixed part
  (role, rules, answer schema with an example), how its per-unit packet is assembled
  from the graph without an agent, its scope plan from the graph at 0026's hierarchy,
  and what facts it may write (proposed, inferred, `meaning` or `intent`).
- Stage 8 is registered on it: one unit per product reading the repository-level graph
  (modules, PageRank, entry points, packages, documents' sections) and writing an
  overview claim set with sources.
- Tested end to end with the fake ACP agent scripted to answer by the schema: the
  packet is at most 20K tokens, the writes are checked and published, and a malformed
  answer is refused by name and asked again within the limits. No real agent prompt.
