# Published facts are stored through the one database owner, a unit's publication replacing only its own facts

Change: madarch-tzte.20.2
Base: 5c712dea
Tasks: madarch-tzte.20.2
Kind: no-behavior

## Intent
Decision 0026 makes the fill write facts into the product graph and publish a
unit's set in one transaction; decision 0027 places the fact log, the queue and
the orchestrator's tables in one database owned by the process and leaves "where
a published fact set lands" to the host's wiring. The orchestrator has landed
(madarch-tzte.19.5) and publishes through that seam, but nothing implements it:
a run asked for today is refused with `fill-orchestrator/no-wiring`.

This change adds `src/fill/fact-store.ts`: the fill's own tables in the process's
database (`fill_fact`, one row per content-addressed id, and
`fill_fact_holding`, one row per fact and publishing unit), the sink the
orchestrator publishes through (`FACT_APPLICATION`), and the reads that answer
them — one unit's published facts with their publishers, one fact by id, and a
unit generation's draft set as draft. A publication replaces the facts of its own
unit and of no other, inside the publication's own transaction; a fact two units
publish is one row with both publishers, removed only when neither holds it; a
retracted draft leaves nothing; and a draft set is readable as draft by another
unit and is never mixed with a published fact. The background server hands this
store to every run whose wiring names no store of its own, so a published set
lands in the process's own tables, and the tables are created with the fill's
other ones when the service first opens its database.

One interface changes, in `src/fill/stage.ts`: a `link` write of the stage
contract's draft set carries the edge fact it writes in its `value`, as the other
three write kinds already carry theirs, and its own `from`/`to` are gone. Without
the fact a link can never be published — the store publishes the fact each write
carries, and a write that carries none is refused by name rather than dropped —
and with both the fact and a second pair of ends, a write could state an edge
whose ends nothing publishes. An edge's ends are its value's own
(`CallEdgeValue.from`, `ConsumesEdgeValue.variable`), named once.

## Rationale
Kind `no-behavior`: the change implements an accepted decision (0026, "Writing";
0027, "Publication, exactly once per unit generation" and "Storage ownership")
without moving a requirement of the product. The fill's capability is proposed
by change `fill-pipeline-monday` and not closed, so the rebuild's own requirement
text lands with the stage that closes decision 0026, exactly as
`madarch-tzte.20.1` (the schema) and `madarch-tzte.19.1` (the database owner)
recorded theirs. Nothing a person sees changes: no stage is registered yet and
no run reaches a publication outside the tests, so the tables stay empty in a
served product.

## Out of scope
- The write path and its checks that need the pinned snapshot (the cited bytes
  read at the commit, the referenced nodes existing, the write inside the unit's
  scope): madarch-tzte.20.4. This store is the last gate before the graph — it
  refuses a write the schema does not read — and the checks only the write path
  can make are its own.
- The bounded graph reads and their tracked dependencies (madarch-tzte.20.3):
  `describe_scope`, `neighbors`, `references`, `claims_about`, `coverage` and
  `evidence_span` and their caps are that task's; this change answers a fact by
  id and a unit's own facts, which is what a publication and a test need.
- The draft set's own storage: the machine records a generation's draft set in
  `fill_unit_draft` (madarch-tzte.19.5), and this store reads it as draft. What a
  unit's checked writes append while it runs is madarch-tzte.20.4's.
- Registering the fill's real stages, the MCP server a unit reads and writes
  through, and the pages and diagrams drawn from the graph.
- The old fill pipeline (`src/product/fill*.ts`): untouched, and it stores
  nothing here.

## Preserved contracts
- model-history/store-version: the history keeps its own tables, its own store and its own answers; this change adds the fill's tables to the process's one owner and writes in them, in a transaction of the owner and never one of its own.
- server/protocol: the server's routes, answers and the order in which it stops what it opened are unchanged; the fill orchestrator service it holds creates the fill's fact tables with its other ones when a run is first asked for, so a server that serves wikis still opens nothing and creates nothing.
- product-wiki/pages: a fact is a view's material and never a page (0017); nothing renders these tables, and the pages the wiki serves are the same documents in git.
- release-binary/installers: the release binary still builds, installs and runs; the tables are created by SQL at run time and nothing this change adds reads a file.

## Coverage
- model-history/store-version: test
- server/protocol: test
- product-wiki/pages: test
- release-binary/installers: test

## Blocking questions
None.

## Design and decisions
Taken from decisions 0026 and 0027; nothing here re-decides them.

- **`fill_fact` is one row per fact.** The key is the id the schema computes
  (`facts.ts`, madarch-tzte.20.1): the digest of the fact's identity parts and of
  nothing else, so the same fact extracted twice, by two stages, in two runs, is
  one row, and `fill_fact_holding` carries one row per fact and publishing unit
  with the stage, the generation and the publication digest that put it there.
  The row keeps the envelope of the publication that stored it first: the fields
  an identity does not read — a call's `count`, a source's `version` — are two
  readers' observations of the same fact, not a second fact, and a publication
  that sees one of them differently does not rewrite what the graph holds.
- **`apply` replaces the unit's facts, in the caller's transaction.** It is the
  orchestrator's `FactApplication`, so it runs on the executor
  `publishUnitIn` opened, and it opens no transaction of its own: the facts, the
  generation's own state, the queue's settlement and the publication record are
  one transaction, and a refusal rolls back all of them. The unit's holdings are
  compared with the facts it publishes now — a holding the publication does not
  repeat is dropped, a fact another unit still holds keeps its row and loses only
  this unit's holding, and a fact whose last holding is dropped is removed. An
  empty draft set is a publication that holds nothing.
- **A write publishes the fact it carries.** The draft set is the stage
  contract's `StageDraftWrite`: a plain assertion, a proposed entity, a link and a
  question, and each carries the fact it writes in its `value`. The store checks
  each write with the schema's own `checkFact` — every problem at its path and,
  where the fact cites one, with its file and line — and requires the fact's kind
  to be the one that write writes (`entity-proposal` for a proposal, an edge for a
  link, `question` for a question). A write that is not a fact of the schema
  refuses the whole publication and names the write, the file, the line and the
  path; nothing of it is stored and never a smaller set is.
- **Two publications may run at once, so the sweep locks before it judges.** A
  unit's publication replaces its own facts inside its own transaction, and
  decision 0027 wants several worker processes on a server: two units of one
  stage over adjacent scopes writing one fact is the ordinary case. The facts a
  publication drops are therefore locked first (`SELECT … FOR UPDATE`) and judged
  by a statement of their own, so the sweep waits for a publisher beside it
  instead of removing a fact that publisher is putting back: the holding's
  foreign key onto `fill_fact` is what makes that publisher hold a lock on the
  fact's row until it commits. Deleting in the first statement's snapshot would
  remove a fact another unit holds — the holding's own foreign key would then
  leave neither a fact to read nor an error to see — and the foreign key refuses
  a holding without its fact outright, so the state is not one a reader has to
  survive.
- **A publication applies a set of facts.** A stage that saw one fact twice
  writes it once (a call folded from two sites is one edge), so what a publication
  applies is the distinct ids of its draft set's facts, and the count it answers
  is the number of facts the unit then holds from that publication. A draft set
  with no fact in it is a publication of nothing, and it replaces the unit's
  earlier facts with none: a stage that read a file that is no longer there
  publishes exactly that, and the coordinator's note from madarch-tzte.21.1's
  hand-over names it for the inventory stage. The scenario publishes a unit's one
  fact and then nothing, and holds the unit to no fact at all and the fact's row
  gone.
- **This store's order is code point order, whatever the database collates.** A
  database orders text by its own collation — PostgreSQL's is `en_US.UTF-8` in
  CI, where `unit-a` sorts before `Unit-a` — so the publishers a unit's facts
  come with are sorted here (`byCodePoint`), as the unit's own facts are, and the
  answer does not depend on the engine's locale. The scenario's two case-differing
  publishers are the check.
- **A draft set is read as draft, from the machine's own rows.** `readUnitDraft`
  answers a generation's draft set — its writes, the facts they would publish and
  the writes that are not facts — through the orchestrator's own read, and only
  while the generation is a draft: a retracted draft (`retracted_at`) and a
  published one (`fill_publication`) answer nothing, so a draft is never mixed
  with a published fact.
- **The store holds nothing between calls.** `apply` works on the executor it is
  given and the reads take the owner, so there is no state to open or close and
  no second copy of the process's database; the tables are created by
  `createFactStoreSchema` beside the fill's other tables, which the host's service
  does when it opens the process's database, lent or its own.
- **The host hands it over.** `ProductFillWiring.facts` is optional: a wiring
  that names no store gets the fill's own (`FACT_APPLICATION`), so the production
  path publishes into the process's own graph without a caller wiring one, and a
  host that keeps its graph elsewhere still wins by naming it.
- **What the review changed.** A fresh read-only review
  (`prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto` over
  `git diff origin/main...HEAD`) read this change and ran both suites itself; a
  second round reviewed the answers below. The first round found one blocking
  defect and three should-fix items, each answered here with a test where a test
  can say it.

  - **Blocking.** The orphan sweep decided from its own transaction's snapshot, so
    a holding another publication had inserted but not committed was invisible and
    the fact's row was removed under it: the publication reported a fact that no
    read could answer, and the dangling holding was not refused by anything. It is
    answered twice over: `fill_fact_holding.id` now references `fill_fact (id)`, so
    a publisher holds a lock on the fact's row until it commits and a holding
    without its fact is a state the database refuses; and the sweep locks the facts
    this publication dropped, then judges them in a statement of its own, so the
    candidates are read as the database stands after that wait.
    `test/fill-fact-store-postgres.test.ts` holds one publication open at its fact's
    row, runs a second unit's publication beside it, waits for the lock it takes,
    and asserts the shared fact still has both publishers; with the sweep as it was,
    no publication ever waits and the test fails on the sweep's own message
    (`no publication waited on the fact row`), which is what releasing the held
    publication in the test's `finally` is for — a failure before that release
    would otherwise be reported as a bare timeout while the owner's close waits for
    the client the open transaction holds.
  - **Should-fix.** `readUnitFacts` answered the publishers of a fact in the
    database's collation while `readFact` answered them in code point order, and
    the comment claimed the opposite; both sort in code point order now and the
    scenario publishes one fact from `unit-case` and `Unit-case`, which the checks
    hold to `['Unit-case', 'unit-case']` on both engines.
  - **Should-fix.** A link write's `from`/`to` were never read, so a stage could
    declare one edge and name another pair of ends; the ends are the edge fact's own
    and the pair is gone from the write (above), which is what the review's own
    alternative asked for.
  - **Should-fix/nit.** The refusal counted problems as writes ("holds 3 writes"
    for one write the schema refused in three places): it counts the writes and
    names the problems behind them. A write whose kind the union does not know — a
    row read back from `fill_unit_draft`, where a kind can be anything — was read
    as a property of nothing and threw a `TypeError` naming no file, line or path;
    it is refused by name now.

  - **Round two**, over the answers above, returned `ship` and these items, all
    answered here: a write kind that names something of the object itself
    (`constructor`, `toString`) was still read as a property of nothing, since the
    lookup walked the prototype chain — it is an own-property lookup now, and the
    scenario holds four such kinds to a refusal by name; the refusal's
    "(3 problems)" for one write is what the checks hold, the scenario naming a
    write the schema refuses in three places; `createFactStoreSchema` restores the
    holding table's foreign key on a database whose table predates it (a store
    without it would be a sweep that waits for nobody), which the store's own test
    holds; and the held publication is released even when a step failed, so the
    sweep's own message is what a reader sees.
  - **What the foreign key makes loud, named for the orchestrator.** With it, two
    ordinary interleavings abort a publication instead of damaging rows: a
    publisher whose holding insert loses the race to a sweep that already removed
    the fact is refused by the foreign key (SQLSTATE 23503), and two publications
    that each drop a fact the other publishes deadlock (40P01). Both leave no
    dangling holding and no removed fact a holding names, and both are errors of
    the caller's own transaction: the attempt is what retries them, which is
    0027's lease sweep (madarch-tzte.19.5) — and the open point for
    madarch-tzte.19.6 is that a raised publication must be a retried attempt
    rather than a lost run.

  The review's judgement of the two interface decisions, in its own words: a link
  must carry its edge fact ("the write kind alone can neither name the edge kind nor
  produce the id"), and `facts` may default to the fill's own store because `apply`
  receives the publication's own executor, "so the default cannot land outside the
  publication's transaction".


## Acceptance evidence
Recorded on the task as `check:` comments against the change's revision: the
focused suites `test/fill-fact-store.test.ts` (PGlite, and the host's own wiring)
and `test/fill-fact-store-postgres.test.ts` (the same scenario, the same
expectations and the concurrent publication on the server CI starts), `bun run
check`, and the independent review over each round. The mutation check is not
run: the owner's rule runs mutation once per assembled stage, and the acceptance
escalates per `mutationFallback`.

## DONE WHEN
- A fact store (tables through `src/adapters/database-owner.ts`) implements the orchestrator's sink for a published fact set: a unit's publication replaces only that unit's own facts in one transaction; a retracted draft leaves nothing; a fact two units publish keeps one row with both publishers, removed only when neither holds it.
- Draft sets are readable as draft by other units and never mixed with published facts; publishing a unit's three facts and then republishing two of them leaves exactly those two for that unit.
- Runs on PGlite and on PostgreSQL.
