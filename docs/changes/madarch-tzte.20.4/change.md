# The checked write path: a unit's writes land in its draft set only after the schema, the cited bytes, the referenced nodes and the scope are checked

Change: madarch-tzte.20.4
Base: 74aba5e5aaf4e7572c5c2c76774044b1c7d4f754
Tasks: madarch-tzte.20.4
Kind: no-behavior

## Intent

Decision 0026 gives an agent unit one way to write the graph: "The agent writes to
the graph through the same server (assert a fact, propose an entity, link, raise a
question). Every write is checked at once (schema, the cited bytes exist and are
read by madarch at the pinned commit, referenced nodes exist, the write is inside
the unit's scope) and lands in the unit's draft set, visible to other units as
draft." The schema landed (`src/fill/facts.ts`, madarch-tzte.20.1), the store that
a published set lands in (`src/fill/fact-store.ts`, madarch-tzte.20.2), the
orchestrator with its draft sets (`src/fill/orchestrator.ts`,
`src/fill/orchestrator-store.ts`, madarch-tzte.19.5) and the reader of a pinned
commit (`src/fill/snapshot.ts`, madarch-tzte.21.1). Nothing implements the checks
0026 names, so an agent unit has no way to write a fact at all today.

This change adds `src/fill/checked-writes.ts`: the four tools as plain functions
with a typed request and a typed answer — `assertFact`, `proposeEntity`, `link`,
`raiseQuestion` — each of them making the four checks in order and appending an
accepted fact to the unit's draft set, and the two wirings of that set (a stage's
own writer, and the machine's recorded rows, which make a write visible to
another unit as draft while the unit still runs). It adds the write path's own
graph port over the fill's fact store — whether a node stands, and which
`entity-proposal` facts are like the one proposed, which is what `propose_entity`
answers beside the write.

Nothing here is a second store and nothing here re-decides the architecture: the
draft set is 0027's `fill_unit_draft`, the facts are the schema's envelopes, the
bytes are `SnapshotReader`'s, and the layer of an agent's fact is `inferred` with
the status `proposed` (0005).

## Out of scope

- The bounded graph reads and their tracked dependencies (madarch-tzte.20.3):
  `describe_scope`, `neighbors`, `references`, `claims_about`, `coverage` and
  `evidence_span` and their caps are that task's. This change reads two things
  from the graph, and neither of them is a tool answer: whether one node the
  write names stands, and which entities are like a proposal.
- The per-unit MCP server (madarch-tzte.22.2), which wraps these four functions
  and the reads as tools bound to the snapshot, the scope and the draft set of one
  unit, and which records every call as the unit's dependency.
- The agent stages that call these tools (madarch-tzte.21.2 to 21.7), the run
  wiring that pins a product's repositories (madarch-tzte.21.8), and the pages and
  diagrams drawn from the graph.
- **Another unit's draft as a node a write may join.** A unit's own draft set is
  read here — a unit that writes a module and then a claim about it is the
  ordinary case — while a draft another unit holds is read as draft by that
  task's reads (madarch-tzte.20.3) and is not a node of this path: 0027 makes a
  node stand when its unit publishes, and a draft its holder may still retract is
  not a fact an edge may join.
- **An edge's ends being of the kinds the edge joins** (`EDGE_END_KINDS`): the
  task's bar is that the referenced nodes exist, and this change holds the write
  to that. A stricter check would refuse writes the task expects to land and
  belongs beside the schema's own kind rules.
- The fill's capability text: the requirement the write path serves is proposed by
  `fill-pipeline-monday`, not current, and the rebuild's requirement text lands
  with the stage that closes decision 0026.

## Preserved contracts

- product-wiki/pages: a fact is a view's material and never a page (0017); nothing here renders anything, and the wiki's pages stay the product's documents in git.
- product-repository/manifest: the manifest's reader is unchanged; this module reads no manifest and names no product's repositories — the pins a write reads its bytes from are the run wiring's (madarch-tzte.21.8).
- release-binary/installers: the release binary still builds, installs and runs; no dependency is added, and the only process this module runs is the same read-only `git` the snapshot reader already needs.

## Coverage

- product-wiki/pages: test
- product-repository/manifest: test
- release-binary/installers: test

## Rationale

Kind `no-behavior`: the change implements an accepted decision (0026, "Writing";
0027's unit generation and draft set) without moving a requirement of the product.
The fill's capability is proposed by change `fill-pipeline-monday` and not closed,
so the rebuild's own requirement text lands with the stage that closes decision
0026, exactly as `madarch-tzte.20.1`, `madarch-tzte.20.2` and `madarch-tzte.21.1`
recorded theirs. Nothing a person sees changes: no stage is registered yet, no
run calls these functions outside the tests, and the tables stay empty in a served
product.

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027 and 0005; nothing here re-decides them.

- **A tool is a plain function with a typed request and a typed answer.** Each
  tool takes the unit's session (what it writes about, where its bytes are read,
  where a write lands, what the graph answers) and a request, and answers either
  the fact that landed — its id, its place, the write as the draft set holds it,
  its position — or every reason it did not. A refusal is a value and never an
  exception: an agent that wrote a bad field learns which field and why and
  writes again, and a refusal that was an exception would be the session's
  transport deciding the agent's next turn. The one failure that does raise is a
  draft set that was retracted: the generation's authority is gone (0027) and its
  attempt is over, so a write is refused loudly rather than recorded into a set
  nothing publishes.
- **The fact's envelope is the write path's, and the agent's part is the value.**
  A request carries a kind, the kind's own value and the place it cites — never an
  id, a commit, a layer or a status. The path builds the provenance (git's version
  from the pinned reader, the repository, the commit and the place), the layer
  from the session and the status `proposed` (0005: only a declaration of the
  product's own words stands accepted), computes the id with the schema's `factId`
  and then judges the whole envelope with `checkFact`. So an agent can neither
  invent an id nor name a commit, and the id it writes is the one the store holds
  (0026: "an id is never written but computed").
- **The four checks, and the order they stand in.** The schema first (its refusals
  are at the field's own path, with the file and the line the fact cites); then the
  scope, because it needs no bytes; then the cited bytes; then the referenced
  nodes; then the write lands. Every check runs before the answer, so a write that
  got two things wrong names both at once.
- **The scope is the plan's own text.** A unit covers a repository, a folder in it
  or one file, and the orchestrator's plan carries that as one string; the
  inventory's units are named `<repository>:<path>` (madarch-tzte.21.1), and this
  path reads exactly that form rather than inventing a second vocabulary: a
  repository name that is no name, an empty path and a path that is no repository
  path are refused by name. A scope that names a path covers that file or folder
  and everything below it; a bare repository name covers the whole repository.
- **A cited file is read, and its bytes are what the span is held to.** The path
  opens the pinned commit's reader for the write's repository, requires the file
  in that commit's tree (a path outside the tree is refused with the reader's own
  words, naming the repository, the commit and the path) and reads its bytes, so a
  write stands on bytes madarch saw itself — the decision's own words are "the
  cited bytes exist and are read by madarch at the pinned commit". The span is
  held to those bytes: lines are counted as a reader counts them (an empty text
  holds none, and a newline ends a line rather than starting one), columns are
  UTF-16 code units of the line, and a span past the last line or a column past
  the end of its line is refused naming the span and what the file holds. The
  columns a request leaves out are the whole lines it names, so a write citing
  lines 3 to 5 stands from the first character of line 3 to the end of line 5.
  Nothing records this read as the unit's dependency: the commit is pinned and its
  bytes never change, while 0027's staleness is the membership of the graph reads
  the unit made (madarch-tzte.20.3).
- **A referenced node is one the graph holds, of a kind the edge joins.**
  Every fact id the write carries is looked for — an edge's ends, a claim's node
  end, a `rule`'s subject, a question's subject, an occurrence's symbol — by
  walking the value, so any id a kind carries is found and named at its own field
  path; a write whose node stands nowhere is refused at that field. The unit's own
  draft set counts: a unit that writes a module and then a claim about it writes
  both in one attempt, and the claim's node is a write its own set already took.
  An edge's end is also held to the kinds the edge joins, which the schema declares
  and names for this check: `EDGE_END_KINDS`' own comment reads "a write's
  'referenced nodes exist' check reads this table (0026)", so a `call`-like
  interaction whose callee is a module is refused at `value.callee` naming both
  kinds, and an end the table gives as `term` is not held to one. What the port
  reads for the rest is the wiring's: `factGraph` answers from the fill's own fact
  store (`fill_fact`), so a node another unit published stands from the moment its
  generation was published.
- **`propose_entity` answers beside the write.** The answer names the entities the
  graph already holds whose name is like the one proposed, closest first — the
  same folded name, one folded name holding the other as whole words, or a shared
  word of three characters or more (folding lower-cases and reads every run of
  characters that are no letter or digit as one space) — and the list is capped at
  `SIMILAR_ENTITY_CAP` with the total and a truncation flag, so a cut answer is
  never read as the whole list (0026: a tool answer is bounded, and a cut answer
  says so). The similar entities are answered whether the write landed or was
  refused: what an agent does next turns on both. The order is a rank by closeness
  and then code point order of the ids — never the database's own collation, which
  orders text by its locale.
- **A draft set is the machine's row, and one write appends one write.** The
  session's port is asynchronous, and the module ships both wirings: `draftSetOf`
  over a stage's own `StageDraftWriter` (what the orchestrator hands `execute`
  today, which it records at the end of the attempt), and `recordedDraftSet` over
  `fill_unit_draft`, which appends each accepted write in a transaction of the
  process's one owner — that is "visible to other units as draft" while the unit
  runs, and `readUnitDraft` (`fact-store.ts`) answers such a set as draft. A
  writer of the same unit and generation must be the only one in flight: two ports
  over one generation would each record the set they hold.
- **The unit's publication publishes exactly what it wrote.** The write each tool
  appends is the store's own `StageDraftWrite` — its kind is the tool that wrote
  it (`fact`, `entity`, `link`, `question`), its evidence is `repository@commit:file`
  and its value is the whole fact — so a unit's accepted writes are the set its
  publication applies, with no translation between the write path and
  `applyPublishedFacts`. The test publishes a unit's checked writes through the
  machine's own publication and holds the store to the ids the writes carried.

### What the review changed

An independent read-only review (`prime-agent --provider shady2k-gateway --model
deepseek-v4.1-flash-auto`) read `git diff origin/main...HEAD` and the change
record, and its findings are answered here with a test where a test can say it.

### The defect this change found in the landed schema

`interaction`'s identity names the carrier it goes through — `['via',
identityNameOrNull(value.via)]` — and an identity part that reads as `null` needs
its own form in `IDENTITY_PART_FORMS`, as `symbol.disambiguator` and
`module.parent` have. `interaction.via` had none, so `checkFact` refused
**every** interaction that names no carrier: "null is no text: this part of an
identity is text a reader can see", at `value.via`. The schema's own suite never
saw it because its one interaction sample carries a `via` (`test/fill-facts.test.ts`,
the `SAMPLES` table), and nothing else writes an interaction yet. The write path
walked straight into it: a `link` of two nodes the agent saw no carrier for could
not be written at all. `facts.ts` gains `'interaction.via': orAbsent(textPart)`,
and the fix is held by a test of its own — an interaction without a `via` is a
fact the schema reads, contributes `['via', null]` to its identity, and is another
fact than the same edge through a named carrier. No value shape moves, so the
kind's schema version stays 1.

## Acceptance evidence

Recorded on the task as `check:` comments against the change's revision: the
focused suite `test/fill-checked-writes.test.ts` (the four tools, the four checks,
the draft set the machine records and the store's own publication), `bun run
check`, a bounded manual mutation sample, and the independent review over each
round.

## DONE WHEN

- `assert_fact`, `propose_entity`, `link` and `raise_question` check each write at once: the schema (`checkFact`), the cited bytes exist and are read by madarch at the pinned commit, referenced nodes exist, the write lies in the unit's scope; a refused write names the field and the reason.
- An accepted write lands in the unit's draft set, visible as draft; `propose_entity` answers with similar existing entities. Normally a fact citing lines 3–5 of a file that has them is accepted and visible as draft, and the same fact citing line 900 of a 10-line file is refused naming the span.
