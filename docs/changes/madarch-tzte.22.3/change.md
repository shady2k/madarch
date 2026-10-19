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
  state, an entity, a question, a coverage) and the two edges an agent stage draws
  (`interaction`, `transition`). The edges are declared because 0026 makes `link`
  one of the unit's tools: a kind the stage did not declare would be refused after
  the unit had done its work, and the refusal would spend the unit's draft set. A
  link of any other edge kind — the read kinds a tool description names as examples
  (`call`, `import`, `dependency`) — is therefore refused, and the fixed part says
  which two the unit may draw so an agent cannot fall into it by following the tool
  description; a link that names the unit's own scope node as an end does move the
  packet's own edge counts, and that costs one replacement generation.
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
- **The packet says what was cut, and a cut member list is no scope a unit may
  call read whole.** The prompt's packet ends with a `marker`: the lists the 20K
  cap or a read's own 8K-token cap cut, each with what it cut and which cap cut
  it. A unit whose member list was cut was shown part of its scope, so its
  coverage can never be `complete` however much of what it was shown it read: the
  gap names the places its member list did not hold. 0026 and 0005 make a complete
  coverage the only ground for a claim of absence, and a unit that could not
  enumerate its scope has no ground for one.
- **The plan collapses a scope rather than dropping one.** A scope whose estimate
  is past 0026's planned size is planned as its member places, one level at a
  time; a scope whose member list an answer's cap cut, or one whose enumeration
  would take the plan past its own bound, stands as one unit instead — it splits
  at run time, and its own coverage names what it did not read. A plan that named
  a shorter list than the one it read would leave places no unit ever names, which
  is the one thing 0026 forbids outright.
- **A parent that already split does not seal the same children twice.** When a
  unit's next attempt names exactly the child set its own generation already
  sealed and published, the split is refused and the parent is blocked with the
  children named: a parent whose children published builds on them (that is what
  its join was for), and re-sealing published work would run it again and, for a
  unit that stops at its limit every time, never end. A genuinely different split
  is still allowed, and a person resolves the block the way 0027's blocked state
  says.
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
- **A unit may draw the two agent-stage edges, and the fixed part says so.** `link`
  is one of the unit's tools (0026, "Agents and tools"), so `interaction` and
  `transition` are among the kinds this stage declares it produces, and the fixed
  part names exactly those two: a kind the stage did not declare would be refused
  after the unit had done its work, and the refusal would spend the unit's draft set.
  The read consequence is named above with the read rule.
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
  - **A plan that cannot enumerate a scope names it as one unit**, and so does a
    scope the plan's own bound would not fit: the graph reads answer within 0026's
    8K-token cap, and the plan splits at most `MAX_PLAN_UNITS` places together. The
    unit then runs, its member list is what the answer held, and its coverage names
    the places the list did not hold; the plan may name up to one unit per
    repository past its bound, because collapsing a scope to itself is what keeps
    it from dropping one.
  - **The history section reads every commit fact of the repository.** The read
    grammar filters by one value field and has no window (madarch-tzte.20.3), so
    the packet's history read answers all of a repository's commits — bounded by
    the history stage's configured depth, a thousand by default — and keeps the
    newest twenty. The read is a tracked dependency, so its whole membership is
    replayed at each publication's recheck. A window in the read grammar would
    make it cheaper; nothing here is wrong, it is only larger than it needs to be.
  - **A unit's coverage is keyed by its scope node's fact id**, which is the unit's
    own id, while the landed producers key a coverage by a path or a repository id
    (`document-index` by a path, `history` by the unit's scope text, `snapshot` by
    the repository's fact id). `describe_scope` of the node therefore shows this
    unit's coverage and not the deterministic stages', and the `coverage` tool
    answers by the token it is given. One vocabulary for a scope across the fill is
    a later task's.
  - **This stage names at most eight children in one split** (`SPLIT_CHILDREN`),
    and the orchestrator's own bound is its own (`maxSplitChildren`, eight by
    default). A product that lowers the orchestrator's bound below eight blocks
    such a parent rather than sealing fewer children; a stage cannot read the run's
    limits today, and a split that named more places than its bound is the reason
    the coverage's gaps exist.
  - **A parent blocked by the re-seal refusal waits for a person.** The block is
    0027's own blocked state, so the run settles as `completed_partial` with that
    unit named, and a resolution (`unblockUnit`) makes the unit runnable — but a
    terminal run is not driven again by its own loop, so the unit's next attempt is
    a worker's own claim rather than the run continuing by itself. That is the
    consequence of a person's decision, never a silent stall: the run's evidence
    and its progress events name the blocked unit and the children it refused to
    seal again.
  - **A turn that never sends an event and never answers is bounded by nothing this
    guard can see.** ACP's `session/prompt` has no client-side bound (a turn may
    legitimately run for minutes), so a worker waiting on such a turn is still
    inside the await when 0027's lease lapses: the lease is a database row and the
    sweep retries the unit, but this process does not stop the turn. 0026's ten
    minutes therefore hold for an agent that streams what it does; for one that
    goes silent and never answers, the attempt's own connection close is the only
    end, and it needs the process to notice. Giving the prompt a bound is a change
    to the client (`src/fill/acp.ts`, madarch-tzte.22.1) and is named here rather
    than pretended.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## Acceptance evidence

The checks, each command's own exit status, at hand-over:

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch, the
  rebase onto `origin/main` `fad2419e` included.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.22.3 --candidate worktree --target origin/main`) exit 0,
  clean, after every edit round (it runs in the pre-commit hook too).
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - `test/fill-unit-limits.test.ts` (11 tests) + `test/fill-agent-packet.test.ts`
    (9) + `test/fill-agent-unit.test.ts` (15) — 35 pass, 0 fail, exit 0 at the
    third review's answers. The earlier revisions ran the same files at 25
    (first), 26 (first review's answers), 28 (second review's answers) and the
    counts grew as the reviews' cases were added.
  - `test/fill-unit-limits.test.ts` + `test/fill-agent-packet.test.ts` +
    `test/fill-agent-unit.test.ts` + `test/fill-unit-tools.test.ts` +
    `test/fill-orchestrator.test.ts` + `test/fill-crash-suite.test.ts` —
    130 pass, 0 fail, exit 0, at the second review's answers (the split
    transaction and the tools seam moved, and the crash suite kills workers
    around exactly that transaction).
  - Every deterministic stage's own suite with `test/product-cli.test.ts`,
    `test/product-daemon.test.ts`, `test/fill-facts.test.ts` and
    `test/fill-state-store.test.ts` (the direct importers of `stage.ts`,
    `stages/index.ts` and `daemon.ts`) — 396 pass, 0 fail, exit 0.
  - `test/fill-orchestrator.test.ts` + `test/fill-crash-suite.test.ts` +
    `test/fill-registry.test.ts` + `test/fill-unit-tools.test.ts` +
    `test/product-daemon.test.ts` + `test/fill-agent-unit.test.ts` — 175 pass,
    0 fail, exit 0.
  - After the rebase: `test/fill-unit-limits.test.ts` +
    `test/fill-agent-packet.test.ts` + `test/fill-agent-unit.test.ts` +
    `test/fill-registry.test.ts` + `test/fill-modules-stage.test.ts` +
    `test/fill-orchestrator.test.ts` — 166 pass, 0 fail, exit 0.
- The independent review, fresh read-only
  `prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto`
  sessions over `git diff origin/main...HEAD`, each told not to run anything on
  this machine (no `bun`, no tests, no mutation).
  - Round 1 (`/tmp/review-223.log`): verdict `fix-before-ship`; four defects —
    the plan dropped the scopes past its bound and reported `planned`; a member
    list cut by a read's cap could still publish `coverage{complete: true}` while
    the cut never reached the agent; a parent that joined could split into the
    same, already published children for ever; and a unit's tool session leaked
    when the stage's configuration refused after the tools were opened — plus
    twelve findings. All four were answered **with the test that catches each**,
    and the twelve with them (`f1bc846c` before the rebase, `469995cb` after it).
  - Round 2 (`/tmp/review-223b.log`): verdict `fix-before-ship`; five defects —
    a file's scope (whose members are its symbols) was named by no unit at all;
    the re-seal refusal missed the run's `accept-partial` policy; the packet was
    counted into the guard's own figure twice; the answers the unit's own MCP
    server returned were never counted, which 0026 requires ("the session and the
    server"); and `link` still invited the read kinds a tool description names as
    examples, which cost the unit its whole draft — plus eleven findings. All
    five are answered in `a54c8acf` with their tests (the file-scope plan case,
    the `accept-partial` end-to-end case, the packet counted once per prompt, the
    host's per-session answer count with `test/fill-unit-tools.test.ts` proving
    it, and the two declared edge kinds named in the fixed part), and the findings
    with them: the sealing transaction names `fill_unit_draft`; the attempt's
    authority and tools are opened inside one `try`; the packet's lists are
    charged in the currency the prompt is sent in; the marker names which cap cut;
    a comment neighbour is named by its place; `validateDraft` is the landed
    `checkFactDraft` with its four write kinds; `readUnitAnswer`, `coveredPlaces`,
    `splitChildren` and `placesOfMembers` have unit tests; the packet test's
    `relations` and `data` are filled by a graph that holds one of each.
  - Round 3 (`/tmp/review-223c.log`), a narrow re-check of the answers: it found
    all nine defects of the two rounds answered; its two blocking findings were
    this record's own numbers (it re-derived them from `git log` and the test
    files, and the counts above are the ones it asked for) and an attempt
    cancelled before its session opened still running one uncancelled turn
    (fixed: the loop reads the abort before any turn, and the listener is
    registered whatever the signal says). Its thirteen smaller findings are
    answered too: the server's answers are counted before the turn is judged; a
    test proves the host's count; the refused split still records the checkpoint
    it was meant to hand over; the wrap threshold is floored like the stop; the
    form list comes from the schema's own `REPOSITORY_FORMS`; the test's worlds
    are `mkdtemp` folders; the packet test no longer restates a bound the code
    enforces by refusing; the words of `boundedText`'s own cut and of the
    never-ending turn's bound are corrected.
- CI on the exact SHA of the branch: named in the task's `check:` records and in
  the queue entry (`## madarch-tzte.22.3 — READY …`).

## DONE WHEN

- An agent unit (fake ACP agent) receives a fixed part and a packet of at most 20K tokens assembled from the graph, is warned at 70% and stopped at 80% of a 272K window, at about 30 turns and about 10 minutes, and returns a partial result with its coverage; the orchestrator splits its scope and runs the parts.
- Normally a unit that finishes within limits publishes its draft set; a unit the fake agent drives past 80% is cancelled, its partial draft and coverage recorded, and two child units are planned.
