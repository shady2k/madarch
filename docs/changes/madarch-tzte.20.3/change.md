# The bounded graph reads answer within their caps and record every read as the reader's dependency

Change: madarch-tzte.20.3
Base: 74aba5e5aaf4e7572c5c2c76774044b1c7d4f754
Tasks: madarch-tzte.20.3
Kind: no-behavior

## Intent
Decision 0026 makes the product graph the place the fill's knowledge lives and
gives every agent unit one way to read it: six tools — `describe_scope`,
`neighbors`, `references`, `claims_about`, `coverage` and `evidence_span` — a
bounded answer each, and no file content pasted into a prompt. Decision 0027 adds
what makes those reads safe to build on: a unit's reads are its dependencies, and
a later publication that changes what a read answered replaces the unit instead
of letting it publish on top of a graph that moved.

The schema (madarch-tzte.20.1), the store (madarch-tzte.20.2) and the
orchestrator's tracked reads and staleness (madarch-tzte.19.5) have landed.
Nothing answers the six tools yet: a unit has no way to read the graph it is
filling.

This change adds `src/fill/graph-reads.ts`: the six tools as plain functions with
a typed request and a typed answer, over the store's own rows (`fill_fact`) and,
for a span, over the pinned commit's bytes (`SnapshotReader`); the caps 0026
fixes (a tool answer at most 8K tokens, an evidence span about 200 lines) with a
marker that names what a cap cut; and the context a unit reads through, which
records every read as that unit generation's tracked read — the query and the
membership of the rows it answered, an empty answer included — so the
orchestrator's own staleness sweep is what a moved graph meets.

## Rationale
Kind `no-behavior`: the change implements an accepted decision (0026, "Agents and
tools", "Units and limits" and "Updates"; 0027, "Publication, exactly once per
unit generation" and "Staleness comes from tracked reads") without moving a
requirement of the product. The fill's capability is proposed by change
`fill-pipeline-monday` and is not closed, so the rebuild's own requirement text
lands with the stage that closes decision 0026, exactly as madarch-tzte.20.1 (the
schema), madarch-tzte.20.2 (the store) and madarch-tzte.19.1 (the database owner)
recorded theirs. No stage is registered yet and no run reaches a read outside the
tests, so nothing a person sees changes.

## Out of scope
- The checked writes and their draft set (madarch-tzte.20.4): `assert_fact`,
  `propose_entity`, `link`, `raise_question`, the schema check, the cited bytes
  read at the pinned commit, the referenced nodes existing and the unit's scope.
  This change reads; it writes nothing but the unit's own read record.
- The per-unit MCP server that exposes these six tools to an agent over ACP
  (madarch-tzte.22.2) and the token accounting of a session: the tools here are
  plain functions, and the caps are the unit's own, handed in when its server is
  built.
- The graph a *stage* reads while it plans (`UnitGraphReader.query`): the landed
  stages send SQL of their own (`src/fill/stages/history.ts` and
  `src/fill/stages/inventory.ts`), and wiring the deterministic stages to this
  store is madarch-tzte.21.8. This module's reader answers a stage's own SQL as it
  stands and this module's own read requests, so the same seam serves both.
- Rendering anything: a read is an answer to a unit, never a page (0017).
- The scheduler's splitting of a unit whose reads say it cannot fit: the caps here
  bound one answer; what a unit does when its scope is too large is the
  orchestrator's and the stage's own.

## Preserved contracts
- model-history/store-version: the history keeps its own tables, its own store and its own answers; this change adds no table to the fact store and writes no row of it (the one row it writes is the orchestrator's own `fill_unit_read`).
- server/protocol: the server's routes, answers and the order in which it stops what it opened are unchanged; nothing here is reachable from a served product until a stage or a unit's server calls it.
- product-wiki/pages: a fact is a view's material and never a page (0017); a read answers a unit, and nothing renders what it answered.
- release-binary/installers: the release binary still builds, installs and runs; this module reads SQL rows and a git commit, opens no file of the checkout's working tree and adds no dependency.

## Coverage
- model-history/store-version: test
- server/protocol: test
- product-wiki/pages: test
- release-binary/installers: test

## Blocking questions
None.

## Design and decisions
The six tools, the caps, the recorded reads and the reader are the design this
change lands. Nothing here re-decides 0026 or 0027: where a number or a rule comes
from one of them, it is named.

- **One read grammar, and the recorded query is the request.** A tool answers only
  through the context it is given (`GraphReadContext.read`), and every read is one
  value of `GraphRead`: one of four reads of the store (`fact`, `facts`,
  `adjacent`, `held`, `facts-with`) or a `span` read of the pinned commit's bytes.
  The query a dependency is recorded by is the canonical JSON of that value
  (`readText`, keys in code point order), so two reads differ exactly when their
  requests differ — their ids, kinds and windows included — and a read replayed at
  publication is the same read. No value ever reaches SQL as text: the reader
  binds every one of them as a parameter (`ANY($1::text[])`, `value #>> $2::text[]`),
  which is what makes an id, a kind, a path, a scope and a window safe to read by.
- **The reader answers the fill's own requests and passes anything else on.** The
  orchestrator's seam takes text (`UnitGraphReader.query`). A text that opens a
  JSON object is parsed as a read of this grammar — a malformed one is refused by
  name, never answered as SQL — and any other text is sent to the store unchanged,
  so a landed stage's own SQL keeps working through the same reader (21.8 wires
  the stages). A read made inside a publication's recheck is made on the
  transaction the caller holds; otherwise the reader opens a snapshot of its own.
- **Every read is recorded, and nothing has to remember to record it.** The
  context's one method answers *and* records
  (`recordUnitRead`/`recordUnitReadIn`, `orchestrator-store.ts`), so "every read
  is recorded as the reading unit's dependency" holds by construction. An empty
  answer is a membership of its own (`readMembership([])`), which decision 0027
  rechecks like any other: a read that answered nothing and answers a row later
  moves the generation. A stage that calls the tools through its own context reads
  through `graphReadsOver(context.graph)`, so the orchestrator records and replays
  those reads as it records everything a stage reads.
- **The caps are 0026's numbers, and the estimate is the fill's own.** A tool
  answer holds at most 8K tokens and an evidence span about 200 lines
  (`DEFAULT_GRAPH_READ_LIMITS`), the unit's own numbers when its server names them
  (0026: "a unit's MCP server bound to the snapshot, the unit's scope and its
  limits"). Tokens are counted as one per four code points and the estimate is
  said in the answer (`tokens`) and in the marker that names a cut: a cap a server
  enforces must not need the tokeniser of the model that will read the answer.
- **The cap is the whole answer.** Before its rows are bounded, an answer reserves
  what its own envelope costs — the request it echoes, the reads it stands on and
  the words of the marker (`rowsCap`, `MARKER_RESERVE`) — so 0026's "at most 8K
  tokens" holds of the answer a unit receives and not only of its rows, while the
  marker still names the cap the *reader* set and not the smaller one its rows were
  bounded by. The tests hold every cut answer to `tokens <= the cap`.
- **An answer names each read by its digest, not by its text.** `reads` is the
  read's kind and the digest of its canonical text — the very digest the
  orchestrator records the dependency row under (`queryDigest`,
  `fill_unit_read.query_digest`), so an answer names the records it made without
  carrying a second copy of their queries (which was the envelope's largest part).
- **Never silently smaller.** Rows are added while the cap has room for them and
  the rest are counted: `truncated` is true and `marker` is one sentence naming
  how many rows the cap cut. A row too large for the cap on its own leaves the
  answer with none of them and says exactly that — a whole answer is smaller than
  a silent one. What a cut answer holds is always a prefix of the whole answer in
  its own order, never a different sample. `coverage` bounds the sample of what a
  stage read (`COVERAGE_READ_SAMPLE`) and the gaps it shows
  (`COVERAGE_GAP_LIMIT`) per row and counts both cuts in the marker, so a gap is
  never dropped in silence.
- **The order is code point order, read here and not left to the database.** A
  database orders text by its own collation — PostgreSQL's is `en_US.UTF-8` in CI,
  where `unit-a` sorts before `Unit-a` — so every list this module answers is
  sorted in `byCodePoint` after the rows come back. The fixture's three callers
  are `OrderService.Zed`, `OrderService.alpha` and `OrderService.beta`: code point
  order puts `Zed` first and a locale-aware collation would put it last, so the
  order the test holds can only be produced one way.
- **`neighbors` answers the relations of a node, not what it sits in.** Its
  default kinds are every edge kind but `contains` and `defines` (the two that
  *place* a node), which is what makes the decision's own case hold: a symbol with
  three callers answers those three, in code point order, untruncated, with its
  file's own `defines` edge not standing among them. Nothing is hidden: the answer
  carries the kinds it walked (`kinds`), and a caller that means the placement too
  asks for `contains` or `defines` by name. A neighbour the graph no longer holds
  is answered by its id with `kind: null` rather than dropped.
- **`describe_scope` answers one scope whole.** The scope node, the kinds of the
  nodes it holds (`contains`, `defines`) with their counts, the edges that touch it
  counted by kind and direction, and the coverage facts that name it. A scope the
  graph does not hold, and an id that is a fact of a kind no scope is
  (`SCOPE_KINDS`: directory, file, module, package, repository), are each refused
  by name: an answer about either would read as "nothing here", which is a
  statement about the graph nobody made.
- **What a scope holds joins only the kinds whose ends the store can join.**
  `held` counts the nodes the edges of the kinds it is given point at, and the
  store's own rows carry those ends in the edge value's `from` and `to` fields, so
  a kind whose end stands elsewhere — `provides` names a contract, `binds` an
  environment, `task-key` a key, and `document-link` its target as a term — is
  refused by name (`HOLDING_EDGE_KINDS`). A read that asked for one would answer
  nothing rather than be counted, and that silence is what the refusal prevents.
- **`references` says where, not only who.** The edges of the citing kinds that
  point at the node, each with the node it comes from and the place the edge stands
  at — a call's place is the code-point-smallest call site its producer folded, with
  the count it folded — in code point order of the file, then by line, then by the
  citing node's label and id. `contains` and `defines` are not citations, because
  they place a node rather than name it.
- **`coverage` answers what is known, and never turns a gap into an absence.** Each
  coverage fact of the scope with the count of what it read, a bounded sample of it
  and every gap it names. A scope no stage covered is `complete: null` with no rows
  — 0005's "not enough data", never "there is nothing".
- **`evidence_span` answers the commit's own bytes.** The lines of one file at the
  pin, counted as a reader counts them (a file that ends with a newline has no
  empty line after it), with the bytes kept as they stand. A span that names no end
  is the file from the start of the window to the cap; an end past the file's last
  line is the file's own last line (nothing was cut); a start past it is refused
  naming the file, the line, the file's own line count and the path. The read this
  answer stands on is exactly the window it shows, so a unit's dependency is what
  it read and no more.
- **What a reader sees.** `GraphNodeRef` is the id a join uses, the kind, the label
  a person reads and the place the fact stands at, and `labelOf` is that label by
  kind (a symbol by its qualified name in its file, a file by its path in its
  repository, a claim by what it says). A label is for a reader and never for a
  join: every filter a read makes is by fact id. A label longer than 80 code points
  is cut with an ellipsis and is not a cut answer: it is a display name inside a row
  whose fact and id are both in the answer, and `truncated` is about what the caps
  left out of an answer.
- **Every refusal names the file, the line and the path.** `src/fill/graph-reads.ts`
  raises through the fill's own `raise`/`withLocation`, so a refusal names the file,
  line and column it was raised from, and — where the refusal is about a fact or a
  span — the file and line of that fact or that span, or the repository path the
  read names. A row that is not a fact of the schema, a count that is not a number,
  a gap that names no reason and a span row without its lines are refused by name
  rather than skipped: a reader that skipped them would answer a smaller graph than
  the one that stands.
- **What the review changed.** One fresh read-only review
  (`prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto` over
  `git diff origin/main...HEAD`, log `/tmp/graph-reads-review.log`) read this change
  and computed its way through it; it ran nothing on this machine. Verdict
  **fix-before-ship**: two defects and seven should-fix items, each answered here,
  every one of them with a test where a test can say it.

  - **Defect.** The cap counted the rows of an answer and not the answer: at 8K it
    overshot by the envelope's own size — the request it echoes, the reads it names
    and the marker — and the marker named the cap the rows were bounded by rather
    than the reader's. Answered: an answer reserves what its envelope costs, its
    marker's words included (`rowsCap`, `MARKER_RESERVE`), `bounded` names the
    reader's own cap in every marker it writes, and every cut answer in the test
    holds `tokens <= the cap`. The echo that was the envelope's largest part is
    compact now (`reads` names each read by its kind and its recorded digest).
  - **Should-fix.** `describe_scope` accepted any fact id, so a `symbol:` id
    answered a scope that holds nothing; it refuses a kind no scope is now
    (`SCOPE_KINDS`, tested).
  - **Should-fix.** `held`'s guard checked a field's name and its SQL hardcoded
    `from`/`to`, so a `document-link` (whose target is a term) passed the guard and
    answered `[]` in silence; the kinds it accepts are read from the same table the
    adjacency query is built from (`HOLDING_EDGE_KINDS`) and the rest are refused by
    name, tested through the reader.
  - **Should-fix.** An `adjacent` read with an empty kind list built `... AND ()`,
    a database syntax error instead of a refusal; the reader refuses it by name,
    tested.
  - **Should-fix.** Expectations taken from the module: `answer.kinds` was compared
    with the imported constant, and the recorded query with the module's own
    `readText` on both sides, so a `readText` that sorted nothing would have passed.
    The two kind lists are written out in the test, one test pins the exact
    canonical texts literal by literal (and that two requests differing only in the
    order of a set are one read), and the recorded queries are compared with a
    canonical text built in the test. The answers' read digests are cross-checked
    against the orchestrator's own recorded rows (`fill_unit_read.query_digest`).
  - **Should-fix.** The reader's SQL pass-through and its refusal of a malformed
    read were claimed and untested; both are tested now (a stage's own `SELECT`
    answers its rows, a `{"read":…}` that is no read is refused by name and never
    sent to the database).
  - **Should-fix.** The review found the placeholder this section replaces; the
    change record's `## Acceptance evidence` carries the checks.
  - **Nits answered.** `evidence_span`'s `asked` echoes the request as it was made
    (an end past the file's last line is not rewritten; what the answer holds is
    `endLine`), its marker names only the caps that actually cut, and its read
    window is described exactly; `GraphSnapshotSource` is the landed
    `Pick<SnapshotSource, 'open'>` rather than a re-declaration; a claim without a
    predicate and a coverage value that is not the schema's are refused by name
    rather than answered with empty fields; the executor a context is lent is
    documented as one a write is allowed in (`recordUnitReadIn` writes the read
    record); the unused import is gone.
  - **Nit declined, with its reason.** The review asked for one row mapper for
    `fill_fact` instead of this module's own: the store's reads open a transaction
    of the owner, and a read made inside a publication's recheck must run on the
    transaction the caller holds (`orchestrator.ts`'s `revalidate`), so this module
    reads the table through its own select on a borrowed executor, and the shape it
    refuses by name is checked where it is read. Sharing the mapper means editing
    `fact-store.ts`, which the parallel checked-writes task (madarch-tzte.20.4) is
    building on.

- **Open points and known limitations**, named here rather than left to be found:
  - A `provides` edge's to end is an api-endpoint named by its contract id (0003's
    rendezvous point), which is the endpoint's identity but not its fact id, so the
    store cannot join it: an endpoint's providers are counted by `describe_scope` of
    the providing element and are not answered by `neighbors` of the endpoint. A task
    that needs them reads the contract through a read of its own; this change says so
    in `EDGE_END_FIELDS` rather than guessing a join.
  - `held` counts the nodes the graph holds: an end whose fact no unit holds any more
    (a retracted publication, since the checked writes of madarch-tzte.20.4 refuse a
    write naming a node that does not exist) is not counted, while `neighbors` names
    such a node by its id with `kind: null`.
  - `COVERAGE_READ_SAMPLE` (50) and `COVERAGE_GAP_LIMIT` (200) are this module's
    numbers, not 0026's: they bound one coverage row's own lists inside the answer's
    token cap, and every cut they make is counted in the answer's marker.
