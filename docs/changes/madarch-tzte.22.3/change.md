# An agent unit runs inside its packet, turn, time and token limits, returns a partial result with its coverage, and is split

Change: madarch-tzte.22.3
Base: a2e49704
Tasks: madarch-tzte.22.3
Kind: no-behavior

## Intent

Decision 0026, "Units and limits": "Every agent unit has a 272K-token window:
planned size ~50%, a wrap-up signal at 70%, a hard stop at 80% (the rest is
reserved for reasoning and the answer); at most ~30 turns, ~10 minutes, 16K
output; a starting packet of at most 20K tokens; tool answers at most 8K tokens,
marked when truncated; code read through bounded spans (~200 lines). A unit at a
limit returns what it has with its coverage; the scheduler splits the scope and
runs the parts." And, "Agent input": "A fixed part (role, rules, limits, answer
schema with an example, tool descriptions), a per-unit packet assembled from the
graph without an agent (scope, place, ranked symbols without bodies, entry
points, edges, data, history, intent so far, children's summaries, expected
registry kinds, open questions, the task), and tools. No file content is
pasted."

The pieces it stands on have landed: the ACP client (madarch-tzte.22.1), the
per-unit MCP server bound to the snapshot, the scope and the limits
(madarch-tzte.22.2), the orchestrator with leases, splits, sealed children and
exactly one publication per generation (madarch-tzte.19.5), and the graph reads
and checked writes the tools answer through (madarch-tzte.20.3, 20.4). What was
missing is everything that turns those into a unit: nothing assembled a packet,
nothing counted a session's usage against 0026's thresholds, nothing stopped a
unit, and nothing handed a stopped unit's scope to the orchestrator as a split.

This change adds it, in five modules and the wiring between them:

- **`src/fill/agent-packet.ts`** builds the fixed part (role, rules, 0026's
  limits with their numbers, the answer object with its example, the ten tools of
  the unit's server) and the per-unit part from the graph — the scope and its
  place, what it holds and the edges that touch it, its members ranked and
  without bodies, its data and entry points, the relations that reach it, and the
  product's history — bounded to 0026's 20K tokens, every cut named in the
  packet's own marker, and every read recorded as the unit's dependency.
- **`src/fill/unit-limits.ts`** is the guard: 70% of the window earns the
  wrap-up message, 80% stops the unit, and the turn count, the wall clock and the
  output are read at every turn's end. Every number is 0026's, taken from the
  stage's resolved configuration; the clock is a seam a test moves by hand.
- **`src/fill/stages/agent-unit.ts`** is the stage: a unit per scope (its id is
  the scope node's fact id, never a run), the packet, the ACP session with the
  unit's MCP server attached, the guard's verdicts, and the outcome — a draft
  when the unit covered its scope, or the unit's partial draft with a `coverage`
  fact and the places it did not cover as its children.
- **`src/fill/stage.ts`** gains `usesTools`: a stage whose units read and write
  through their own MCP server declares it, and the run hands it
  `StageContext.tools`.
- **`src/fill/orchestrator.ts`** opens a unit's tools for such a stage and closes
  them when the attempt ends, and records the stopping unit's partial draft set
  in the same transaction that seals its children — 0027's "splits atomically
  persist the parent's checkpoint and a sealed child set", where the checkpoint is
  what the unit wrote before the limit stopped it.
- **`src/fill/orchestrator-host.ts`** and `src/product/daemon.ts` give the
  service the address it answers a unit's tool calls at
  (`${server.url}/api/fill/unit/tool`, the point madarch-tzte.22.2's record left
  open) and wire the orchestrator's `unitTools` seam to the host that owns the
  database.

Tests drive the fake ACP agent (no real agent prompt is sent): the packet's
content, its 20K cap and its cuts; the guard's five limits, each through the
seam; and, end to end on a real orchestrator, a run whose unit is warned at 70%
and publishes, whose unit is cancelled past 80% and splits into two children that
run, whose unit that never answers is stopped at 30 turns, and whose unit is
stopped at ten minutes with no test waiting.

## Rationale

Kind `no-behavior`: the change implements accepted decisions (0026's "Units and
limits" and "Agent input"; 0027's split, publication and host) without moving a
requirement of the product. The fill's capability is proposed by change
`fill-pipeline-monday` and is not closed, so the rebuild's own requirement text
lands with the stage that closes decision 0026, exactly as madarch-tzte.20.1,
20.2, 20.3, 20.4, 21.1 and 22.2 recorded theirs.

Two surfaces move and neither answers a person's use of a served product: no
stage runs an agent until a host registers this one (the daemon registers no
stage today), and the daemon now hands its own address to the service it already
creates, which changes no route, no product command and no help text. The
release binary still starts its own unit server by the words `mcp-unit`
(`selfCommand`) and gains no dependency.

## Out of scope

- **The stages that read documents and comments, the module clustering and the
  reconciliation.** 0026's stages 8 to 13 differ in what they are told and what
  they produce, and madarch-tzte.24 and the modules stage (madarch-tzte.21.7)
  carry them. This change lands the unit those stages are made of.
- **Clustering and the unit hierarchy.** 0026's "Scale" (product → repository →
  package/build target → cluster → sub-cluster, summaries at ~2K tokens, fan-in
  at ~50) belongs to stage 5 and the tasks that follow it; this stage plans one
  unit per repository and splits a scope past 0026's planned size into its
  member places.
- **What the agent's answer means.** The unit contract asks for one answer object
  (`status`, `covered`, `remaining`, `summary`) and reads the unit's own draft
  set with it; an answer that establishes nothing is a unit that covered nothing,
  not an error.
- **A read that excludes a unit's own published facts.** The packet reads only
  the kinds a unit cannot write, so a unit's publication never moves its own
  packet's reads. A unit that reads, through its tools, a region it then writes to
  (the claims about its own scope, say) still meets 0027's staleness once and is
  replaced by a generation that publishes the same facts — the same overlap the
  landed read layer allows, named below as a limitation.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the six changes before this one recorded theirs.

## Preserved contracts

- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; the agent unit is one more stage in that plan, and its own units are the scopes the graph gives it.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence; what this change adds is the unit's own MCP server, opened for the attempt that runs it and closed when the attempt ends whatever it ended with.
- fill-orchestrator/split: a split still seals its child set in one transaction and suspends its parent; what this change adds to that transaction is the parent's own draft set, so a unit that stopped at a limit keeps what it established in the graph — 0027's checkpoint — rather than handing over an empty set.
- fill-orchestrator/join: a parent still resumes only when every child of its sealed set is published and fresh, and a child that failed is still propagated, blocked or accepted by the run's policy; what this change adds is a parent whose own attempt stopped at a limit, which joins like any other.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it; the coverage fact a unit writes is part of that set and no second path publishes it.
- fill-orchestrator/host: the background server still owns the orchestrator and remains the only writer of the database; what this change adds is the address the process answers a unit's tool calls at, read when a unit's tools are opened, and the orchestrator seam those tools are opened through.
- fill-stages/registry: a stage is still one module plus its registration line, and its declaration is still pure data; `usesTools` is one more declared field, and a stage that leaves it out is handed no tools and pays nothing for them.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest, and a run still snapshots what it resolved; the numbers a unit is held to are the limits its stage resolved, so a product that narrows its window narrows what the guard enforces.
- server/protocol: the unit tool route, its refusals and its order are unchanged; the daemon names the address it already serves and adds no route, no command and no help text.
- release-binary/installers: the release binary still builds, installs and runs, and a unit's MCP server is still started by this program's own command line (`selfCommand`, the words `mcp-unit`); no dependency is added by this change.

## Coverage

- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/join: test
- fill-orchestrator/publish: test
- fill-orchestrator/host: test
- fill-stages/registry: test
- fill-stages/configuration: test
- server/protocol: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027 and 0005; nothing here re-decides them.

- **The unit's id is the scope node's fact id.** 0026 requires ids that are
  "stable and never contain a run id", and the unit's scope is a node one of the
  deterministic stages published: its id is that node's, the unit's scope text is
  `<repository>[:<path>]` (the inventory's own shape, which `writeScope` reads),
  and a split's children are named by their own members' fact ids. Nothing about
  a run, a time or an attempt enters either.
- **The packet reads only what the unit cannot write, and here is why.** Every
  read the packet makes is recorded as the generation's dependency and rechecked
  after the unit publishes (0027). A packet that read the claims, questions or
  coverage about the unit's own scope would see its own publication arrive, be
  judged stale, and be replaced by a generation that publishes the same facts:
  one wasted agent run per unit, for every unit. The packet therefore reads the
  facts the deterministic stages publish about the scope — its node, what it
  holds, the edges that touch it, its members, the relations that reach it, the
  product's history — and the fixed part tells the unit to read the graph's own
  intent, coverage and questions through its tools (`claims_about`, `coverage`,
  `describe_scope`), which is what 0026's "Agents and tools" builds them for. The
  unit's declared kinds are the node kinds of understanding (a claim, a rule, a
  state, an entity, a question, a coverage), so it draws no edge: an edge inside
  its own scope would move the packet's own edge counts under it. 0026's `link`
  tool stays offered and a write of an edge kind is refused by name, which is the
  same refusal a stage gives a kind it does not produce.
- **Where the two token counts come from.** 0026 says "madarch counts tokens from
  the session and the server". The session's own figure is the agent's
  `usage_update` (what the agent says is in its context); the server's is what
  madarch itself sent (the packet, the wrap-up message, each turn's prompt). The
  unit's account is the larger of the two and never their sum: an agent that
  reports nothing leaves madarch's own count as the floor, so "not reported" is
  never read as "no room used", and the packet is never counted twice. A window
  an agent names narrows the unit's own and never widens it past 0026's 272K
  ("a unit never relies on a 1M window"), and a window it has narrowed to stands.
- **The wrap-up signal is a turn, and the hard stop is the protocol's cancel.**
  ACP has no way to speak into a turn in flight, so 70% earns the wrap-up message
  as the unit's own next turn — the agent reads it, writes what it has and answers
  — and 80% cancels the turn through `session/cancel`, whose answer is the
  `cancelled` stop reason the client already reads as a cancel rather than a
  failure. The turn count, the time and the output are read at every turn's end,
  which is where a limit that is no token count can be seen.
- **A unit that cannot finish splits its scope, and the split is the
  orchestrator's.** The unit answers `split` with the places of its scope it did
  not cover, one child per place in code point order, at most eight (0027's own
  default bound on one split); the places past that bound are not dropped, they
  are the coverage's own `budget` gaps. The parent's partial draft set is
  recorded in the sealing transaction — 0027's checkpoint — so a person watching
  the graph sees what the unit established even though the unit publishes
  nothing; the parent's later attempt starts from the graph its children filled.
- **A coverage fact is written by every unit, and it is the unit's own
  declaration.** 0026 makes a scope's coverage the ground of every claim about
  absence (0005): a unit that read three of five places says so, `complete: false`
  with the two it did not read as `budget` gaps, and a unit that read all of them
  says `complete: true`. The fact's identity names the repository, the scope and
  the reader (the schema's own table), so the same unit reading the same scope
  again replaces its coverage rather than adding a second one beside it.
- **The plan names units from the graph, within 0026's planned size.** A unit
  plans for about 50% of its window (136 000 of 272 000 tokens), and one member of
  a scope is estimated at one bounded span read (0026's ~200 lines, counted by the
  fill's own estimate of four code points a token). A repository past that size is
  planned as its member places, one level at a time, bounded by 0027's own split
  depth and by a plan-wide unit bound; a scope whose member list the answer's cap
  cut is not an enumeration, so it stands as one unit and the run's own split
  bounds take it from there. The plan reads the graph and nothing else (0027's
  `plan(graph)`), so it estimates against 0026's default window: a product that
  narrows its window makes a unit split earlier at run time, never later, because
  the guard reads the resolved limits.
- **A unit's tools are opened by the run, not by the stage.** 0026 makes the
  background server the only database writer and the units' servers thin proxies
  to it; the only thing that knows a unit's store identity, its generation, its
  plan row and its draft set is the orchestrator's attempt, so the attempt opens
  the tools (0026's `usesTools` declaration decides which stages) and closes them
  when the attempt ends. The stage is handed the server to attach and nothing
  else, and a stage that declares `usesTools` and is handed none refuses by name
  rather than starting an agent that cannot read.
- **Time is a seam.** The guard reads the clock it is given and is evaluated on
  the session's own events; the tests move that clock by hand, so ten minutes pass
  in milliseconds and 0026's time limit is checked without a sleep. A turn that
  sends nothing at all is not an event the guard can see: the connection closes
  when the attempt ends, and 0027's lease is the bound behind that.

  - **Open points and known limitations**, named here rather than left to be found:
  - **A unit that reads what it writes is replaced once.** The landed read layer
    records a unit's reads and rechecks them after its publication; it excludes a
    unit's own drafts (madarch-tzte.22.2) and not its own published facts. A unit
    whose *packet* reads only what it cannot write is therefore stable, and a unit
    that calls `claims_about` or `coverage` on a region it then writes to is
    rechecked as stale, replaced by a generation that publishes the same facts and
    settles. The fix is a read that excludes the reading generation's own facts
    (the rule 22.2 applies to drafts), which belongs to the read layer
    (madarch-tzte.20.3) and is not taken here.
  - **The packet holds no intent, questions or coverage.** For the reason above
    they are read by the unit through its tools; the fixed part tells it so. A
    stage whose units write no claim of their own may put them back in the packet
    without this cost.
  - **A plan that cannot enumerate a scope names it as one unit.** The graph
    reads answer within 0026's 8K-token cap, so a scope with more members than one
    answer holds cannot be split by the plan: the unit runs, its member list is
    what the answer held, and what it does not cover becomes the coverage's gaps
    and the children of its own split. Nothing is silently smaller; the coverage
    names every place nobody read.
  - **A stop between turns is not seen until the next event.** A time limit that
    passes while an agent streams nothing and answers nothing is ended by the
    attempt's own end (0027's lease), not by this guard.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## DONE WHEN

- An agent unit (fake ACP agent) receives a fixed part and a packet of at most 20K tokens assembled from the graph, is warned at 70% and stopped at 80% of a 272K window, at about 30 turns and about 10 minutes, and returns a partial result with its coverage; the orchestrator splits its scope and runs the parts.
- Normally a unit that finishes within limits publishes its draft set; a unit the fake agent drives past 80% is cancelled, its partial draft and coverage recorded, and two child units are planned.
