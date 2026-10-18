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
- **The checks, and the order they stand in.** The request's own shape first (a
  kind the schema names, a value that is an object, a place whose fields read);
  then the place — the scope, the pinned repository, the file in the commit's
  tree, and the span inside the bytes; then the fact is built and judged by
  `checkFact`; then the referenced nodes; then the write lands. Each stage answers
  its own refusals and the answer carries all of them, so a refused write is never
  refused twice for one reason. The place is read before the value is judged, and
  that is not an accident of the order: the fact's place — and with it its id — is
  fixed by the bytes (a request that names no columns cites whole lines, whose end
  is the line's own length), so a write with a bad field *and* a span past the file
  is refused by the span first and by the field on the next try. What never happens
  is a write that lands while any refusal stands.
- **The scope is the plan's own text.** A unit covers a repository, a folder in it
  or one file, and the orchestrator's plan carries that as one string; the
  inventory's units are named `<repository>:<path>` (madarch-tzte.21.1), and this
  path reads exactly that form rather than inventing a second vocabulary: a
  repository name that is no name, an empty path and a path that is no repository
  path are refused by name. A scope that names a path covers that file or folder
  and everything below it; a bare repository name covers the whole repository. The
  check reads the place a write cites and nothing else: a `coverage` fact's own
  `scope` field says what the unit reports it read, in the graph's own terms
  (`product`, a module's fact id, a place's path), and holding that to the unit's
  scope text would decide a question this path cannot answer.
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
  kinds, and an end the table gives as `term` is not held to one — a node that
  stands behind such an end is joined, and no kind is asked of it. The walk reads
  every string a value holds, so a kind whose ids this path has not been told about
  is still held to the nodes it names; the price is that a literal spelled like a
  fact id (a kind, a colon and 64 hexadecimal digits) is read as a reference and
  refused where nothing stands there — a text a reader sees is never a reference,
  and the refusal names the field it stands at. What the port
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
- **A draft set has one writer, and the two wirings are alternatives.** The
  session's port is asynchronous, and the module ships both: `draftSetOf` over the
  writer a stage's context hands `execute` (each accepted write goes into the set
  the attempt records at its end, and nothing is recorded before that), and
  `recordedDraftSet` over `fill_unit_draft`, which appends each accepted write in a
  transaction of the process's one owner — that is "visible to other units as
  draft" while the unit runs, and `readUnitDraft` (`fact-store.ts`) answers such a
  set as draft.

  The two are not two halves of one draft set. The orchestrator's attempt records
  its own context's set when the unit drafts (`recordUnitDraft` replaces the row
  with that set, `orchestrator.ts`), so a unit whose accepted writes went through a
  port of their own, and whose stage pushes nothing into its context, loses them at
  that moment and in silence. A unit that runs inside the orchestrator therefore
  wires `draftSetOf(context.draft)` — which is what the per-unit MCP server
  (madarch-tzte.22.2) is handed — while `recordedDraftSet` is for a caller that
  owns a generation's draft set itself, which is exactly what "visible to other
  units as draft" is about. `recordedDraftSet` reads the machine's row before every
  append, so a session that starts again over the same generation joins the writes
  that are already there, and a retraction is the attempt before this one (0027
  retracts a generation's draft so the next attempt starts clean): the writes it
  covered are not this attempt's, and recording clears the retraction, as the
  landed store's own `recordUnitDraftIn` does for a rerun. The port also answers
  the set it holds, so a later call of one writer is held to what the earlier one
  wrote.

  A late writer is not refused here: this path carries no lease or fence, and the
  one that decides whether a generation may publish is the orchestrator's
  (`publishUnit` checks the fence and the run's control inside the publication's
  own transaction, 0027). A write that arrives after the run moved past its
  generation reaches a draft set its retraction or its replacement covers, so it
  is written and never published; where a session is bound to one generation
  (madarch-tzte.22.2) the authority that stops it early is that session's to pass
  in.
- **The unit's publication publishes exactly what it wrote.** The write each tool
  appends is the store's own `StageDraftWrite` — its kind is the tool that wrote
  it (`fact`, `entity`, `link`, `question`), its evidence is `repository@commit:file`
  and its value is the whole fact — so a unit's accepted writes are the set its
  publication applies, with no translation between the write path and
  `applyPublishedFacts`. The test publishes a unit's checked writes through the
  machine's own publication and holds the store to the ids the writes carried.

### What the review changed

An independent read-only review (`prime-agent --provider shady2k-gateway --model
deepseek-v4.1-flash-auto`) read `git diff origin/main...HEAD` and this record and
answered `fix`: both DONE WHEN bullets hold on a unit's first attempt, and it found
one blocking defect and sixteen smaller items. Every one is answered here, with a
test where a test can say it.

- **Blocking — a retried attempt could not write at all.** `retryAttempt`
  (`orchestrator.ts`) retracts a generation's draft set and re-enqueues *the same
  generation* (a stage that raised, a draft the validation refused, a lapsed
  lease), and the landed store clears the retraction when a set is recorded
  (`recordUnitDraftIn`). `recordedDraftSet` refused an append to a retracted set,
  so the first accepted write of every retry raised and a unit whose first attempt
  failed could never write again. The guard is gone: a retraction covers the
  attempt before this one, the attempt that starts next begins with an empty set
  (0027: "a rerun starts clean" — the retracted writes are not this attempt's), and
  recording clears the retraction as the store's own write does. The case is held
  by a test that retracts a unit's draft the way `retryAttempt` does and then
  writes through the same unit and generation.
- **Should-fix — the port answered its own cache, not the machine's row.** A port
  built after the unit had already recorded writes (a session that starts again
  over the same generation) started empty, so a write joining what the unit had
  already written was refused as "stands nowhere in the graph" while the same
  answer's position counted the row. `CheckedWriteDraft.writes()` is asynchronous
  and reads the machine's own row; the case is held by a test with a second port
  over one generation.
- **Should-fix — two bullets of this record contradicted each other** about
  `EDGE_END_KINDS`: the "Out of scope" bullet still said an edge's ends are not
  held to the kinds the edge joins, while the code and the design bullet hold them,
  which is what the schema's own comment asks for. The stale bullet is gone.
- **Should-fix — the record claimed every check runs before the answer.** It does
  not: each stage answers its own refusals, and the place is read before the value
  is judged. The bullet now says what the code does, and why the bytes must be read
  before the fact's own id is fixed.
- **Should-fix — a refusal about the pinned tree named no repository and no
  commit.** It carried `SnapshotError.detail`, which is the reader's words *without*
  them. It carries the reader's whole message now, and the test holds the refusal
  to the repository and the commit.
- **Should-fix — the record did not say which writer owns the row.** The
  orchestrator's attempt records its own context's set when the unit drafts, so a
  unit whose tool writes went through a port of their own loses them there, in
  silence. The bullet now names that consequence and says who wires what.
- **Should-fix — `draftSetOf` had no test.** It has one now: an accepted write
  reaches the stage's own writer, `fill_unit_draft` stays empty until the attempt
  records the set, and the attempt's own record publishes it.
- **Should-fix — this section named no findings.** It is this list.
- **Nit — the scope check reads the place alone**, so a `coverage` fact's own
  `scope` field is not held to the unit's scope; recorded above with the reason.
- **Nit — every id-shaped string in a value is a reference**, so a literal spelled
  like a fact id is refused where nothing stands there; recorded above.
- **Nit — a same-line span whose columns read backwards** reached `checkFact` and
  was refused at a provenance path; it is refused at `place.range`, naming both
  columns, and the case is in the test that walks the place's refusals.
- **Nit — a span past the end of the file answered `line: 10`** (the file's last
  line) while the write cites 900; a refusal's line is the line the write cites.
- **Nit — `consumes.variable` was said to be an end the table gives as `term`.**
  It is not: `EDGE_END_KINDS.consumes.to` is `['environment-variable']`, so the end
  is held to its kind and the module's mapping is right.
- **Nit — an unreadable proposal name answered `total: 0`.** It stands beside the
  refusal at `value.name`: the write never lands, nothing is compared, and the
  field says why — kept, with the reason.
- **Nit — another stage's scope form is read as a repository name and a path.**
  `<repository>[:<path>]` is the form this path reads; a history scope
  (`repository:<name>@<commit>`) becomes the repository `repository`, which is not
  one the run pins, so it is refused loudly and never widened in silence.
- **Nit — several refusals had no test** (a place that is not an object, a key a
  place does not hold, a repository the run does not pin, a file whose bytes are
  empty, a line counted from zero, columns that read backwards). One test walks
  them, and they are the refusals an agent meets first.
- **Nit — the acceptance evidence read as recorded.** It says what is recorded
  where, and the records are posted with the handover.
- **The review found nothing wrong with the `interaction.via` fix**: the diagnosis
  is right, the form is the smallest right one, it is covered twice, and no other
  kind carries the same latent defect — every identity part that may be `null` has
  a form of its own in `IDENTITY_PART_FORMS`.

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
