# Each agent unit gets its own MCP server, bound to the snapshot, the scope and the limits, passed into the ACP session

Change: madarch-tzte.22.2
Base: d6e821d4e4dfb6df2de4df73484e9344f0b44a3e
Tasks: madarch-tzte.22.2
Kind: no-behavior

## Intent

Decision 0026, "Agents and tools": "madarch drives agents over the Agent Client
Protocol (ACP); for each unit it starts an MCP server bound to the snapshot, the
unit's scope and its limits and passes it into the ACP session. The agent's own
file tools are off: it reads code only through the server's evidence spans, and
every call is logged as the unit's dependency." And, "Writing": "The background
server owns the database and is its only writer; the units' MCP servers are thin
proxies to it."

The pieces it binds have landed: the six bounded reads and their tracked
dependencies (`src/fill/graph-reads.ts`, madarch-tzte.20.3), the four checked
writes and the draft set (`src/fill/checked-writes.ts`, madarch-tzte.20.4), the
ACP client with an MCP server attached to a session (`src/fill/acp.ts`,
madarch-tzte.22.1), and the background server that owns the orchestrator and the
process's one database (`src/fill/orchestrator-host.ts`). What is missing is the
server itself: nothing exposes the ten tools to an agent, and nothing binds them
to one unit.

This change adds it. `src/fill/unit-tools.ts` is the host half: the ten tools'
catalogue, the call that answers one of them through a unit's own sessions, and
the registry that binds a started server to the unit it serves by a token it
minted. `src/fill/unit-mcp.ts` is the protocol half: the Model Context
Protocol's stdio transport, hand-written from the specification. `src/fill/unit-mcp-server.ts`
is the program the agent starts (`madarch mcp-unit`): a thin proxy that carries a
call to the host over HTTP, with the address and the token from its environment
and nothing else. The host answers it on `POST /api/fill/unit/tool`
(`src/server/http.ts`) through the service it already holds
(`FillOrchestratorService.unitTool`), and opens a unit's session with
`FillOrchestratorService.unitTools`, which reads the unit's plan row, the reader
its reads are recorded in, the pinned snapshot its spans and writes read, the
graph its writes stand on, and the draft set its attempt hands over.

It also closes the open point stage 20's acceptance left: 0026 says a unit's
accepted writes are "visible to other units as draft", and until now the six
reads answered published facts only. The `describe_scope`, `neighbors`,
`references` and `claims_about` answers now carry a `draft` section — the writes
other units of the same run hold, each marked `asDraft: true` with the unit and
generation holding it — as a section of its own, never mixed into the published
rows.

## Rationale

Kind `no-behavior`: the change implements accepted decisions (0026's "Agents and
tools" and "Writing"; 0027's run, unit generation and draft set) without moving a
requirement of the product. The fill's capability is proposed by change
`fill-pipeline-monday` and is not closed, so the rebuild's own requirement text
lands with the stage that closes decision 0026, exactly as madarch-tzte.20.1,
20.2, 20.3, 20.4, 21.1 and 22.1 recorded theirs.

Two surfaces are new and neither answers a person's use of a served product: the
route `POST /api/fill/unit/tool` stands only when the process serves a fill's
unit tools, answers `401` for a token no open session holds, and a session exists
only while a unit runs — no stage runs an agent yet (madarch-tzte.22.3); and
`madarch mcp-unit` is a program an agent's session starts, in no help text, with
no argument of its own. The server's other routes, the product's commands and the
release binary behave exactly as they did.

## Out of scope

- **A unit's limits of turns, time and context, and the split.** 0026's 70%/80%
  thresholds, ~30 turns, ~10 minutes, the wrap-up message, the cancellation and
  the split of a scope that cannot fit are madarch-tzte.22.3's. This change binds
  the tool caps 0026 states (a tool answer at most 8K tokens, an evidence span
  about 200 lines) and nothing else.
- **The unit's packet.** What a unit is told before it reads (0026's "a per-unit
  packet assembled from the graph without an agent") is 22.3's.
- **The stage that runs an agent, and where a run's tool endpoint comes from.**
  `unitTools` is given the address its process answers at; the daemon that starts
  the server (`src/product/daemon.ts`) does not hand its own address to a stage
  yet, because no stage starts an agent until 22.3. That task's wiring passes
  `${server.url}/api/fill/unit/tool`.
- **A unit's writes joining another unit's draft.** madarch-tzte.20.4 decided that
  a node stands when its unit publishes, and this change keeps it: the reads show
  another unit's draft, marked as draft, while a write still joins a published
  node or a write of its own draft set (a draft its holder may still retract is no
  node an edge may join).
- **A real agent's connection to the server.** The probe and the ACP client are
  madarch-tzte.22.1's, and no real agent prompt is sent here: the tests drive the
  server with the fake ACP agent.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the four changes before this one recorded theirs.

## Preserved contracts

- server/protocol: the model routes, their refusals and their order of stopping what the server opened are unchanged; the one route this change adds stands only when the process serves a fill's unit tools, and it answers a tool's own JSON, never a model or a wiki answer.
- model-history/store-version: the history keeps its own tables and answers; this change adds no table to the fact store, and the rows it writes are the orchestrator's own (`fill_unit_read`, `fill_unit_draft`).
- product-wiki/pages: a fact is a view's material and never a page (0017); nothing here renders a draft or a fact, and a draft is shown to a unit, never written anywhere.
- release-binary/installers: the release binary still builds, installs and runs, and it starts its own unit server by the words `mcp-unit` (`selfCommand`), exactly as it starts `daemon-serve`; no dependency is added — the protocol is hand-written from its specification, and the proxy reaches the host with the runtime's own `fetch`.

## Coverage

- server/protocol: test
- model-history/store-version: test
- product-wiki/pages: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027 and 0005; nothing here re-decides them.

- **The tools are the landed functions, not a second copy.** `callUnitTool`
  names the six reads of `graph-reads.ts` and the four writes of
  `checked-writes.ts` and hands each the session it was built for: the reader a
  unit's calls are recorded in (`GraphReadContext`), and the write session that
  holds its scope, the pinned bytes it cites, its draft set and the graph its
  writes stand on (`CheckedWriteSession`). "Every call is logged as the unit's
  dependency" therefore holds by construction: a read is recorded by the reader
  it goes through, with the query and the membership of what it answered,
  `fill_unit_read`; and a write lands in the unit's draft set, `fill_unit_draft`.
- **The server is a process, and the host is where everything else lives.** The
  agent starts `madarch mcp-unit` through the ACP session's `mcpServers` (the
  protocol's stdio shape: a command, its arguments and an environment). That
  process holds the host's address and one token, and no database, no snapshot,
  no scope and no limit of its own: it cannot answer anything the host does not
  answer for it, and a token that names no live session answers nothing. That is
  what makes the background server "the only writer" a fact of the design rather
  than a rule a proxy could break.
- **A token is the unit's whole authority.** The host mints one per session
  (`crypto.randomUUID`) and binds it to the unit generation, the reader, the write
  session and the caps. The child carries it in its environment, so a confused or
  compromised child can neither widen its unit's scope nor answer another unit's
  question, and the session ends when its unit's attempt ends (`close`) or when
  the service stops.
- **A refusal is a value, never an exception.** The reads raise where a request
  is not a read of theirs, and the writes answer their own refusals; both reach
  the agent as the tool's own result with `isError: true` and the refusal's own
  words, handed on as they stand: a read's error names the file, the line and
  the column it was raised at (`src/fill/fsm-core.ts`), a write's refusal names
  each field it refused, and a tool this server has none of is refused by name.
  The protocol's own rule is
  what this follows: a tool's failure is content the model reads and acts on, and
  a protocol error would end the call instead. A name that is no tool, and a
  `tools/call` with no name, are protocol errors (`-32602`), because no tool was
  called; and a method this server has none of is `-32601`, naming what it offers.
  A host that cannot be reached, answers another status, or misses its bound is
  the same kind of answer: the agent reads the address, the status and the host's
  own words instead of waiting for a call that will never end.
- **The protocol is hand-written from its specification, and here is why.** The
  brief allows the official TypeScript SDK when it works under Bun and in the
  compiled binary, and a minimal server per the specification otherwise. The
  server answers four methods (`initialize`, `ping`, `tools/list`, `tools/call`)
  and ignores every notification; a dependency that brings its own transports,
  its own schema validation and its own resource and prompt machinery would be
  more surface than the server has, and the compiled binary would carry it. So the
  framing and the four answers are in `src/fill/unit-mcp.ts`, hand-written the way
  the fake ACP agent is, so a test proves this server speaks the protocol and not
  merely that it agrees with a library. The revisions named are 2025-06-18,
  2025-03-26 and 2024-11-05; a client whose version is not one of them is
  answered with the newest this build knows, which is the specification's rule for
  an unsupported version.
- **The answer's text is the answer's own JSON, compact.** The caps 0026 states
  are counts of what a tool answers (four code points a token), so the text the
  agent reads is the very object the caps bounded: a pretty-printed copy would be
  a longer text than the one the marker counted.
- **The drafts other units hold, as 0026 says they are visible.** A tool answers
  them in a section of its own, `draft`, each row `{asDraft: true, unit,
  generation, scope, write, evidence, fact}`: the holding unit, the scope its plan
  gave it, the kind of write, what the write cites, and the fact it would publish.
  Never inside `rows`, so no reader can take a draft for a published fact, and the
  same cap bounds it, with a marker of its own saying what it cut.
- **Three sets of the run are no draft of a read**, and each for its own reason:
  - **A retracted set** (0027's `retract-draft`, which a rerun's attempt meets) is
    the attempt before it, so a retried unit starts clean rather than seeing what
    it already withdrew.
  - **A published set** is not a draft: its facts stand in `fill_fact`, and nothing
    keeps its set as a draft afterwards. Reading it as one would answer the same
    fact twice in one answer — once in `rows`, once as a draft — and, worse, fill
    the draft section with the deterministic stages' published output during an
    agent run, crowding out what really is a draft. So the read excludes a
    generation the publication record holds (`fill_publication`), and the
    consequence is taken deliberately: a unit that read another unit's draft is
    refused as stale when that other unit publishes (0027's recheck of recorded
    reads), which is exactly what a graph that moved means.
  - **The reading generation's own set** is not another unit's draft. 0026 says a
    draft is "visible to *other* units as draft", and the alternative is a
    self-inflicted staleness loop: a unit reads `neighbors(X)` (nothing of its own
    set names X), then writes a claim about X through the machine's own port
    (`recordedDraftSet`, which records while the attempt runs), and its own read's
    membership has moved — so the publication refuses it, the attempt retries,
    reads before writing, writes, and is refused again until the retries are gone.
    Excluding the reader's generation is therefore the decision's own reading, not
    an optimisation.
- **Which drafts a tool shows is the question it was asked.**
  - `neighbors`, `references` and `claims_about` show the writes of the run that
    name the node asked about — as the fact's own id, or anywhere in its value
    (an edge's end, a claim's subject or object, a question's about).
  - `describe_scope` shows a scope's drafts by its own place — a repository, a
    folder or a file, whose value names one — by the write path's own rule for
    "inside a scope" (`scopeHolds`, one rule and no second). A module and a package
    name no place (a module's extent is its members, a package's is the manifest
    its value cites), and a place filter for them would answer every draft of the
    repository as "inside the module" and make a module unit stale on an unrelated
    draft anywhere in that repository: their section is the writes that name the
    node, and the answer's `draftScope` (`{by: 'place' | 'node', scope}`) says
    which of the two it read.
  - A write that cites no place — a `snapshot`, a `repository` or a `directory`
    fact, which the schema asks for no place of — stands in no scope, so no scope's
    section holds it. That is the rule the filter applies, and the module says so
    rather than leaving a reader to guess.
  - `coverage` and `evidence_span` show none, and their own descriptions say why,
    so an agent can tell "no drafts are about this" from "this tool does not show
    drafts": a coverage row is a stage's published declaration of what it read
    whole, and an evidence span is the commit's own bytes, which no draft can
    change.
  A read of drafts is a read of the pinned graph like any other: it is recorded
  with the query and the membership of the drafts it answered, so a draft that
  appears or moves marks the unit that read without it stale (0027's recheck), and
  a draft about another node does not. The reads are the run's own: another run's
  unretracted draft sets are not this unit's business.
- **Where a unit's scope and run come from.** The plan row (`fill_unit_plan`,
  0027) names both: the run whose drafts the unit sees and the scope text its
  writes are held to (`writeScope`, the write path's own reading of
  `<repository>[:<path>]`). A unit whose generation holds no plan row is refused
  by name rather than given a session that would answer for nobody.
- **The reader records, and it is the wiring's own.** A unit's reads go through
  the reader its wiring gives (`ProductFillWiring.graph`), which answers this
  module's read grammar and passes a stage's SQL through as it stands
  (madarch-tzte.20.3), and the host records each query as the generation's tracked
  read exactly as the orchestrator records one a stage makes itself. So the same
  reader serves a stage's own reads and its unit's tools, and no second graph
  source is invented.
- **The pinned bytes.** `evidence_span` and the cited bytes of a write come from
  the run's own pinned repositories (`ProductFillWiring.source()`, `snapshot.ts`).
  A host that wires none gets a source whose every question is refused by name, so
  a unit's span reads and writes answer that the host wired no snapshot, rather
  than an empty graph a reader could take for an absence.
- **The graph a write stands on.** The fill's own fact store (`factGraph`) where
  the wiring's published facts land there, which is the default; a host that lands
  them elsewhere names its own (`ProductFillWiring.writeGraph()`), and one that
  does neither is refused by name rather than answered from a graph its facts are
  not in.
- **The program's own name.** `selfCommand` (`src/product/self-command.ts`) is the
  one place that says whether this program is a checkout (`bun scripts/madarch.ts
  …`) or a compiled binary (itself, with the same words); `daemonCommand` now
  reads it too, so the daemon and the unit's server cannot disagree about what
  this build's command line is. The measurements are the daemon's own: the bundle
  marker, the embedded files, and a derived script path that answers no file.

  - **Open points and known limitations**, named here rather than left to be found:
  - **A read of drafts costs one query per tool call over the run's draft sets.**
    The statement joins `fill_unit_draft` to `fill_unit_plan` on the run, so it
    reads one row per unit of the run; the filtering to the node or the place
    happens in this process. A run of thousands of units pays thousands of rows per
    call; the alternative (a narrower statement) needs a text search inside a JSON
    value, which would be a guess where this is exact.
  - **Another unit's draft is no node a write may join** (madarch-tzte.20.4's
    decision, kept): an agent that reads a draft and links to it is refused, and the
    refusal names the node and the fact that it stands nowhere published.
  - **A draft set whose plan row names another run, or none at all, is no row of a
    read.** The statement joins the draft set to its plan row on the run, so a set
    that no plan row attributes to this run cannot be read as this run's — a
    defined rule rather than an omission, and the damaged case (a draft row with no
    plan row at all) needs a store nobody's write path makes.
  - **A tool's `isError` is the answer's own, not the transport's.** An agent that
    ignores `isError` sees a refusal's JSON as if it were an answer; the protocol
    has no stronger way to say it.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.
  - **The daemon does not hand its address to a stage yet** (madarch-tzte.22.3's
    wiring): `unitTools` takes the address it answers at, and the route stands in
    the daemon's server today, so the only thing missing is the caller.

## Acceptance evidence

The checks, each command's own exit status, at hand-over:

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.22.2 --candidate worktree --target origin/main`) exit 0,
  clean, at every commit (it runs in the pre-commit hook too).
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - `test/fill-unit-tools.test.ts` — 28 pass, 0 fail, exit 0 at the first review's
    answers (21 at the first revision; the seven cases it added are a published
    unit's set, the reading generation's own set, a module scope's drafts, a damaged
    draft set, a unit with no plan row, the route's refusals and a host's close-all,
    and the cap case was rewritten to assert `tokens <= cap`), and 29 pass, 0 fail,
    exit 0 after the second round's.
  - `test/fill-graph-reads.test.ts` + `test/fill-unit-tools.test.ts` — 56 pass,
    0 fail, exit 0 at the first review's answers, and 57 pass, 0 fail, exit 0 after
    the second round's (a draft whose fact names a version that is no whole
    number, refused by name).
  - `test/fill-graph-reads.test.ts` + `test/fill-acp.test.ts` +
    `test/fill-acp-probe.test.ts` — 76 pass, 0 fail, exit 0.
  - `test/product-cli.test.ts` + `test/product-daemon.test.ts` +
    `test/contract-serve.test.ts` — 117 pass, 0 fail, exit 0.
  - `test/fill-orchestrator.test.ts` + `test/fill-fact-store.test.ts` — 79 pass,
    0 fail, exit 0.
  - `test/product-daemon.test.ts` + `test/fill-checked-writes.test.ts` +
    `test/fill-orchestrator.test.ts` — 92 pass, 0 fail, exit 0, after the first
    review's answers.
- The independent review, a fresh read-only
  `prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto`
  session over `git diff origin/main...HEAD`.
  - Round 1 (`/tmp/review-222.log`): verdict `fix-before-ship`; two defects — a
    published unit's set read as a draft, and the reading generation's own set
    making its own read stale — and twelve smaller findings (S1–S7, N1–N5), all
    answered in the second commit.
  - Round 2 (`/tmp/review-222b.log`), over `fb327909`: verdict `fix-before-ship`;
    every one of the first round's findings answered, and one defect the answers
    themselves introduced — the whole-number check on a row's `schema_version`,
    lost when the draft fact's spelling was moved to `draftFactOfRow` — with three
    nits (the marker count of `coverage` and `describe_scope`, a module-scope test
    that only proved the section empty, and these acceptance lines). All four are
    answered in the third commit.
  - The narrow re-check (`/tmp/review-222c.log`), over `a248f16a`: the three code
    items answered, and one leftover line of these acceptance notes with no count —
    which the fourth commit removes — so its verdict was `fix-before-ship` for the
    notes alone. Its own note stands as a limitation, not a defect of this change:
    one coverage row can push two cut sentences into one marker, so an answer with
    several cut coverage rows can pass the cap by their words (the same shape the
    landed reader has, `coverageRows`).
- CI on the exact SHA of the branch: named in the task's `check:` records and in
  the queue entry (`## madarch-tzte.22.2 — READY …`).

## DONE WHEN

- For each agent unit madarch starts an MCP server bound to the snapshot, the unit's scope and its limits, exposing the bounded reads and checked writes as tools, as a thin proxy to the background server (the only database writer); it is passed into the ACP session (src/fill/acp.ts) with the agent's own file tools off.
- Every call is logged as the unit's dependency; a tool answer over 8K tokens is truncated with its marker. Normally the fake ACP agent's tool call `neighbors` reaches the store and its answer comes back in the session.
