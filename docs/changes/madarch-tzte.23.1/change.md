# The background server answers the graph's page-worthy nodes, each node's page model, and pushes the pages every publication touches

Change: madarch-tzte.23.1
Base: c0a297f8f3c9a995685a486e81e508d8563f251b
Tasks: madarch-tzte.23.1
Kind: no-behavior

## Intent

Decision 0026, "Pages": "Every graph node of a page-worthy kind has a live page at
once, rendered from the graph without an agent (facts with code links, relations,
diagrams, intent, questions, coverage) and updated in the browser as facts arrive;
it is a view, not a file in git." And, "Updates": "On a default-branch commit: the
deterministic stages run for what changed; impact propagates over graph edges; only
affected agent units and pages rerun, in dependency order."

The pieces it stands on have landed: the fact store with its publication and its
reads (`src/fill/fact-store.ts`, madarch-tzte.20.2), the bounded graph reads
(`src/fill/graph-reads.ts`, 20.3), the fact schema and its bridge to the product
registry's kinds (`REGISTRY_KIND_MAPPINGS`, `src/fill/facts.ts`, 20.1), the
orchestrator that publishes a unit's facts in one transaction and reports every
step once it is committed (`src/fill/orchestrator*.ts`, 19.5 and 27's host), and the
background server with its product wiki and its live change stream
(`src/server/`, `wiki/app/`). What was missing is everything between the graph and
a page: nothing answered which nodes have a page, nothing answered what a page shows,
and nothing told a browser which pages a publication moved.

This change adds it, in five pieces and the wiring between them:

- **`src/fill/page-changes.ts`** is the rule and its one table: which fact kinds a
  page exists for (the registry mapping's own role column, `subject` — the nodes a
  document of a registry kind may be about, which is where the modules and packages
  0026 names stand), whether an id is a page (from the id's own kind), and
  `pagesTouchedBy` — the pages one publication's facts touch, for the facts it writes
  and the facts it stops holding.
- **`src/fill/graph-pages.ts`** is the reads: the page set of a product, one node's
  page model (its facts with code links, the assumptions kept apart, the relations
  both ways, the coverage, the open questions and the drafts marked as draft), and
  the changes a product's publications made after one sequence number. Every read is
  a read of the fact store; nothing here writes the graph.
- **`src/fill/fact-store.ts`** records, inside the publication's own transaction,
  one `fill_page_change` row per page the publication touched — so a page is a change
  only once the facts behind it are committed, and a publication that rolled back
  announced nothing.
- **`src/server/graph-pages.ts`** carries the three answers over HTTP —
  `GET /api/graph/pages`, `GET /api/graph/page?id=…` and the live channel
  `GET /api/graph/events[?after=N]` — beside the wiki's own routes, and holds the
  Server-Sent Events stream. The routes are one more entry in the route table
  (`src/server/http.ts`, decision 0012), so they answer under a product's prefix in a
  products home and need no new layer.
- **`src/fill/orchestrator-host.ts`** gives the fill service `pages(folder)` — the
  source those routes read — and composes the orchestrator's own `sink` so every
  `unit-published` event wakes the open channel. **`src/product/daemon.ts`** hands
  each served product that source, so the background server's pages are the store its
  own orchestrator writes.

An empty graph answers an empty page set with the message naming the fill that would
write it, never an error: a server that holds no fill's graph at all (a foreground
`madarch serve`) answers the empty set with the message saying where the pages are
served, and a home whose fill never ran answers it without opening a database.

## Rationale

Kind `no-behavior`: the change implements accepted decisions (0026's "Pages" and
"Updates"; 0027's one owner and one writer) without moving a requirement of the
product. The fill's capability is proposed by change `fill-pipeline-monday` and is
not closed, so the graph pages' own requirement text lands with the stage that closes
decision 0026, exactly as madarch-tzte.20.1–22.3 recorded theirs. No current
capability names graph pages, and the app that reads them is madarch-tzte.23.3.

Two things a person can observe are new, and they are named here rather than folded
into "a view beside the document pages": a served product answers three addresses it
did not answer before (`/api/graph/pages`, `/api/graph/page`, `/api/graph/events`,
and the app's `/graph/` route), and every publication now writes its page-change rows
in the home's fill database (`fill_page_change`) inside its own transaction. Neither
moves a requirement, and neither changes an answer an existing route gave: a product
with no fill answers the empty page set with the message saying which fill writes the
pages.

## Out of scope

- **The wiki app's side.** The app lists the graph's pages, renders a page model and
  follows the live channel in madarch-tzte.23.3; the diagram models and their
  renderer switcher are 23.2 and 23.4. This change documents the shapes they consume
  (below) and serves them.
- **A page's diagram models.** A page's answer carries the facts, relations, coverage
  and questions a diagram is drawn from; the view specification a diagram is drawn by
  is 23.2's (`type`, `nodes`, `scenario`, `level`).
- **The narrative layer.** 0026's second layer — agent-written Markdown tied to fact
  ids, stored in the product's git as `proposed` — is not read or written here.
- **A page for the kinds whose role is `place` or `evidence`** (a file, a document, a
  section, a snapshot, a commit, an occurrence, a comment, a claim, a coverage, and a
  directory — a folder is where things stand, an `evidence` role in the table). They are
  shown, with their code links, on the page of the node they are about; the reasoning is
  in the design notes below.
- **A fill's own start from the server.** The run that writes the graph is
  madarch-tzte.21.8's command; this change reads whatever the store holds and pushes
  what a run publishes while the server serves.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not current,
  as the changes before this one recorded theirs.

## Preserved contracts

- server/protocol: the three graph routes are one more entry in the route table; every existing route, its refusals and its log line are unchanged — the one visible difference is that the wiki's unknown-path 404 lists the new routes among the ones the server offers, as it lists every route — and the log line of a graph request is the handler's own (method, path, status, milliseconds), with no fact value and no product content in it. A graph refusal carries its own `code` in the error envelope beside the message and the field, and a graph failure the stream cannot answer goes to the error log, never to the browser.
- server/serves-wiki: a server given a product folder still serves that product's wiki, and a products home still serves each product under its own prefix; the graph pages are asked per product folder, so one product's pages never answer under another's address.
- server/explains: a page asked for that the graph holds none of is refused with a 404 naming the id and why (no such node, or a kind with no page), and a request naming no id or a sequence number that is none is a 400 naming the field — never an empty answer.
- product-wiki/pages: a page stays the product's Markdown in git (0017); the graph pages are a view read from the graph, added beside the document pages, and no document page is read, moved or written by this change.
- product-wiki/live: the wiki's own change stream (`GET /api/events`, the tree's revision) is unchanged; the graph pages' channel is its own route, and a change of a document is still one `change` event on the old stream.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with its reads rechecked; what the transaction now also writes is the publication's own page-change rows, so a rolled-back publication announces nothing and a page never moves before its facts are committed.
- fill-orchestrator/host: the background server still owns the orchestrator and remains the only writer of the database; the pages are reads of that same store through the same owner, and the service's `sink` is composed with the host's — an event the host asked for is still delivered, after the channel was woken.
- fill-orchestrator/attempt: nothing a unit does changes; a publication's page-change rows are written by the store's application, not by a stage, and a stage that publishes no page-worthy fact wakes no page.
- fill-stages/registry: the stages, their declarations and their plans are untouched; the pages are read from what they published.
- release-binary/installers: no dependency is added; the stream is the platform's own `ReadableStream` and `TextEncoder`, as the wiki's change stream already is.

## Coverage

- server/protocol: test
- server/serves-wiki: test
- server/explains: test
- product-wiki/pages: test
- product-wiki/live: test
- fill-orchestrator/publish: test
- fill-orchestrator/host: test
- fill-orchestrator/attempt: test
- fill-stages/registry: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026 and 0027 and from the task's own DONE WHEN; nothing here
re-decides them.

- **A page exists for the kinds the registry may be *about*.** 0026 says every graph
  node of a page-worthy kind has a page, and the task names the kinds the registry
  storage forms map (`REGISTRY_KIND_MAPPINGS`) plus modules and packages. That table
  is the one place the two vocabularies meet, and its third column is exactly the
  question a page asks: a fact kind is a `place` (where a document lives: a file, a
  directory, a document, a section), an `evidence` (what a claim cites: a snapshot, a
  commit, an occurrence, a comment, a claim, a coverage) or a `subject` (a node a
  document may be about). A page is *about* one node, so `PAGE_KINDS` is the
  `subject` role, read from the table and never restated: today the repositories,
  packages, deploy units, API endpoints, tables, columns, environment variables,
  symbols, entry points, tests, modules, entity proposals, rules, states and
  questions — modules and packages among them, as the task asks. A file, a directory,
  a claim, a coverage or a commit is shown, with its code link, on the page of the node
  it is about: a page per file would be a page about a place, and a page per claim a
  page about evidence.
- **An id answers the question without a read.** A fact id carries its kind in front
  of its digest, so `isPageId` decides whether a page exists from the id alone. The
  publication needs that: it records the pages it touched for the nodes whose facts it
  drops as well as for the ones it writes, and a dropped fact's row is gone by then.
- **Which pages a publication touches.** The publication's own facts *and* the facts
  it stops holding: a page-worthy fact touches its own page, and every fact touches
  the pages of the page-worthy ids it names anywhere in its value (an edge its two
  ends, a claim its subject and its object, a question what it is about, a rule its
  subject, a coverage the scope it read). Nothing else is announced. So a unit that
  adds one module wakes that module's page and the pages of the nodes its edges name,
  and a page whose facts another unit published and this one did not touch is not
  announced at all — which is what "only for nodes the publication touched" asks and
  what the live-channel test checks with a package fact a second stage published and
  the second run inherited.
- **The change record is written inside the publication's transaction.** A sink call
  after the commit cannot know what the publication dropped, and a notification before
  it could announce facts that roll back; the store's own application knows both, so
  `applyPublishedFacts` writes one `fill_page_change` row per page and publication on
  the executor the publication lent it. The rows are the store's, not a second store:
  they hold a page id, the publishing unit, its generation and the publication digest,
  and they are read back by `readPageChanges`.
- **A stream is woken by the process that published, and reads the record itself.**
  The orchestrator's `sink` fires once per committed publication (`unit-published`);
  the service composes the host's sink with a wake-up of its open channels, and each
  channel then reads the changes after the sequence number it last sent — so a wake-up
  carries no payload a failed read could lose, and a publication that touched no page
  wakes the streams that then write nothing at all.
- **The client is never polled.** The channel is Server-Sent Events, the same shape as
  the wiki's change stream: a `retry:` line first, then one `pages` event per
  publication, its `id` the store's own sequence number, and a `: ping` comment every
  30 s so a quiet product keeps its connection. A client subscribes from the number a
  page set's own `changeSeq` carries (`?after=<seq>`), so the window between reading
  the set and subscribing loses nothing; a client that names none starts from the
  product's latest change and replays nothing.
- **The pages are a product's, not a home's.** A home's fill database carries every
  product's facts, and two products that declare a repository of the same name
  publish facts of one content-addressed id — so every read of a page is scoped to
  the product. The read grammar's four store reads take an optional `product`
  (`graph-reads.ts`), answered as "a fact one of that product's units published
  (`fill_fact_holding` joined onto `fill_unit.product`)", and the page's own reads add
  it to every request they make — including the ones the coverage read makes for
  itself. A unit's own reads name no product and are answered as they were: a run's
  graph is one product's. The product is the name the product's own manifest gives it
  (`readProduct(folder).product.name`, read when the source is asked), and the store's
  `fill_unit.product` is the name the *caller* of `service.run` passes
  (`FillProduct.name`). Today's one caller — madarch-tzte.21.8's walk, whose
  `createStagesFill` names the product by its manifest's name — passes the same name.
  A caller that named it otherwise would leave the pages answering the empty set, whose
  message names the product it read (so the mismatch is visible, not silent), and tying
  the two names together belongs to that caller's change.
- **A page's address is a route the app answers.** `pageAddress` is `/graph/<the id,
  percent-escaped as one segment>`, and the wiki app's own route table takes `/graph/`
  (`src/server/wiki-app.ts`, `APP_ROUTE_PREFIXES`): the address a page set hands out
  opens the app, which reads the node's id from it (madarch-tzte.23.3 renders it).
- **An empty graph answers a message.** A page set with no page says which product it
  read and that a fill run writes the pages; a server that holds no fill's graph says
  where they are served (`madarch start`). A home whose fill never ran answers it
  without creating the fill's database: a server that serves wikis pays nothing for a
  graph nobody filled.
- **A page's cap is the page's own, and every list of it is bounded.** A page is read by a
  person, so its lists are read under 32K tokens (four code points a token, the fill's own
  estimate) rather than a unit's 8K window, by the read layer's own `bounded`: the facts
  and the assumptions (one budget, the assumptions a part of it), the relations, the
  questions, the drafts, and each coverage scope. A list a cap cut says so in `marker`
  and `truncated`, naming what was cut and by which cap, and the page's own `tokens` is
  its whole size as a reader receives it. The coverage section is read by up to three scope tokens — the
  node's own id, its place (`<repository>:<path>`, the fill's spelling of a scope) and
  the snapshot fact of the commit it was read at (stage 5 keys a repository's coverage
  by its snapshot) — and the page names them in `coverageScopes`, so a reader sees
  which scopes the section is about.
- **A page is read in one transaction.** A page asks a dozen questions of the store (its
  node, its claims both ways, its rules, its questions, its edges, the nodes those name,
  the coverage of up to three scopes, its drafts), and every one of them runs on the
  transaction the page opens: the page can never show a fact of one publication beside a
  relation of another, and one page read is one transaction of the process's single
  connection. Every list is sorted here, including the drafts (by the holding unit's id
  in code point order, then its generation): a database orders text by its own collation.
- **A page is nobody's dependency.** A unit's reads are recorded and rechecked; a page
  is read by a person and its read is not a dependency, so the page reads through the
  landed read grammar (`answerGraphRead`) and records nothing. A page also reads no
  bytes: its code links are the facts' own provenance (`repository`, `commit`, `file`,
  the line span), so no snapshot is opened for a page.
- **The drafts a page shows are its product's live ones.** The read layer's `drafts`
  read is bound to one run and to a reading generation, because 0026 makes a draft
  visible to *other units* of the run; a page belongs to no run and to no unit, so it
  reads the product's draft sets itself — retracted and published sets are no drafts,
  another product's sets are not this page's, and every row it shows is marked
  `asDraft: true`. A draft write the schema refuses is refused by name rather than
  skipped, as the landed drafts read does.

### The shapes a client reads (for madarch-tzte.23.3)

All three answers are plain typed JSON (`src/fill/graph-pages.ts` holds the types).

**`GET /api/graph/pages` — the page set.**

```
{ product: string,                      // the product's own name, as its manifest gives it
  pages: [ { id, kind, label, page,     // page is "/graph/<percent-escaped id>"
             layer, status,             // "declared" | "extracted" | "inferred" | "observed"; "proposed" | "accepted" | "rejected"
             code?: { repository, commit, file, startLine, endLine },
             importance?: number } ],   // stage 5's rank, on the kinds that carry one
  counts: [ { kind, count } ],          // every kind's share, in code point order of the kind
  total: number,
  changeSeq: number,                    // subscribe from this: /api/graph/events?after=<changeSeq>
  readAt: number,                       // epoch milliseconds
  message: string | null }              // the what-to-do message when pages is empty, else null
```

The pages are in code point order of the kind, then of the label, then of the id.

**`GET /api/graph/page?id=<fact id>` — one page's model.** 404 with
`{"message", "error": {"field": "id"}}` when the graph holds no page of that id
(`graph-pages/no-such-node`, or `graph-pages/not-a-page` naming the kind and the
kinds that have pages); the message always names the id asked for.

```
{ product, node: <a page set entry>, page: "/graph/…",
  value: <the node fact's own value, the kind's fields as the stage wrote them>,
  facts: [ { id, kind, label, layer, status, code?: {repository, commit, file, startLine, endLine},
             ends?: { subject?: { id, kind, label, file?, line? },   // a claim's own ends, resolved to nodes
                      object?:  { id, kind, label, file?, line? } } } ],
  assumptions: [ … the same shape, layer "inferred" … ],      // kept apart from the facts (0005)
  relations: { out: [ { direction: "out"|"both", edge: <a fact row>,
                        node?: { id, kind, label, file?, line? },   // the node at the other end, when it is one
                        end?: string } ],                           // or what the end names when it is no node
               in:  [ { direction: "in"|"both",  edge: <a fact row>, node?, end? } ] },
  coverage: [ { id, repository, scope, complete, readCount, read: [string], readCut,
                unread: [ { what, reason } ], unreadCut, file?, line? } ],
  coverageScopes: [string],             // the scope tokens the coverage section was read by
  questions: [ { id, type, about?, prompt, layer, status, code? } ],
  drafts: [ { asDraft: true, unit, generation, scope, write, evidence, fact: <the fact the write would publish> } ],
  counts: { facts, assumptions, out, in, coverage, questions, drafts },
  truncated: boolean, marker: string | null, tokens: number, readAt: number }
```

**`GET /api/graph/events[?after=<seq>]` — the live channel.** `text/event-stream`;
`after` is required to be a whole number and a refusal naming `after` is a 400; with
no `after`, the stream starts from the product's latest change. Each event:

```
id: <seq>
event: pages
data: { "seq": 1234, "nodes": ["module:…", "symbol:…"], "unit": "graph-fixture/src",
        "generation": 2, "publication": "<the publication digest>" }
```

`nodes` holds the pages the publication touched, in code point order — the client asks
for those pages again (`/api/graph/page?id=…`) and for the page set
(`/api/graph/pages`), and nothing else changed. A client reconnecting sends the last
`seq` it saw as `after` and loses nothing.

### Open points and known limitations

- **The pages follow a fill run that this server's own process drives.** Decision 0027 makes
  a home's fill database one owner's, and a PGlite data directory is opened by one process
  at a time: a fill run started from a command while the background server holds the
  database is that command's refusal, and the pages then follow the runs the server
  itself drives. Starting the server after a run serves the pages that run published, and
  the channel reports what later runs publish.
- **A publication made by a process that is not this service is not announced.** The
  wake-up comes from the run's own `unit-published` sink in the process that published,
  which decision 0027 makes the database's only writer for a home. A second process
  writing the same database would write the change rows (the store does it) but not
  wake this process's streams; a client's next reconnection reads them, since the
  record is durable. Sharing one database between two servers is outside 0027 today.
- **A wake-up that arrives while a stream is reading is coalesced, never dropped**: the
  stream reads again when the current read finishes, so no change is lost, and a burst
  of publications inside one read is answered by as many events as there are
  publications (one publication is one change).
- **A claim's ends are resolved to their nodes.** A page's claim rows carry `ends`, the
  two nodes a claim names, read in the same walk as the relations' ends, so a reader can
  open the page of what a claim is about; an end that names no node (an address outside
  the repositories, a literal) is left out.
- **A page's relations are the edge facts that name the node**, and their ends are read by
  the read layer's own table: `endsOf(kind, value)` (`graph-reads.ts`) decides where a
  kind keeps its from and to ends — a `consumes` edge names a variable, an `interaction`
  a caller and a callee — so a node at either end is a node and links to its page. An end
  that is no fact id is listed as text and links nothing: a `provides` edge's contract, a
  `task-key` edge's key, a `binds` edge's environment, a `document-link` edge's address
  outside the repositories (`EDGE_TEXT_END_FIELDS`), and a relation always says what it
  joins — the edge's own id is the last resort — so the page never names itself as the
  neighbour.
- **The page set is not capped.** 0026 wants a page for every page-worthy node, so the
  answer holds them all (counts included) however many there are; a large graph answers
  a large list. Paging is the app's to ask for when it needs it.
- **A change is answered whole or not at all.** A read of the changes asks for one row
  past its bound, so a full answer is told from a cut one; when the row past the bound
  continues the last change, that change is left for the next read rather than answered
  with some of its pages. A publication that alone fills the bound is answered as it
  stands, and its marker says the bound cut it — a reader that could hold nothing would
  read the same change for ever.
- **A change may name a page that is gone.** A publication that stops holding a node's
  facts announces the node's page, and by the time a client asks for it the page may be
  no longer there: the client's re-read is a 404 with the code
  `graph-pages/no-such-node`, which is how a page disappears from the app's navigation.
- **The change record grows with the fill's history.** `fill_page_change` keeps one row
  per page and publication and nothing prunes it yet: a long-lived home's fill database
  holds one row per page each publication touched. Pruning rows older than what a
  connected client could ask for is a later task's. The reads go by the store's own
  sequence (`seq` is the table's primary key) and the latest-change read walks it
  backwards until it meets one of the product's rows; `fill_page_change_unit` answers a
  unit's rows.
- **A coverage keyed by a snapshot fact id is only found through the node's own
  commit.** A node whose facts were read at one commit and whose repository's coverage
  was written at another shows no coverage; the page names the scopes it read so a
  reader can see why.
- **No `mutation` receipt.** The owner's rule runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.

## DONE WHEN

- The background server answers the list of page-worthy graph nodes of a product and
  one node's page model read from the fact store: its facts with code links
  (repository path and line span at the pinned commit), its relations both ways, its
  coverage, its open questions, layer and status per fact (facts vs assumptions kept
  apart), drafts marked as draft.
- The page set and a page's model update as the orchestrator publishes: a client
  subscribed to the product receives the change without polling, and only for nodes
  the publication touched. Normally publishing a unit that adds one module makes that
  module's page appear for a subscribed client within the same second.
- No agent is involved; an empty graph answers an empty page set with the what-to-do
  message, never an error.

## Acceptance evidence

### The independent review and its answers

One independent read-only review, a fresh `prime-agent --provider shady2k-gateway
--model deepseek-v4.1-flash-auto` session over `git diff origin/main...HEAD`, told to
run nothing on this machine (log `/tmp/review-231.log`). Verdict **fix-before-ship**:
seven defects and nineteen findings. Every defect is answered below with the test that
holds it; the findings are answered with them or named where they are not taken.

**The defects.**

1. **Only three of a page's reads were scoped to its product** — the claims, rules,
   questions, edges, the nodes they name and the coverage scopes were read from the
   whole store, so a second product of the same home that declares the same repository
   (and so publishes facts of the same id) could reach this product's page. Answered in
   the read grammar, once: the four store reads take an optional `product`
   (`src/fill/graph-reads.ts`), and the page adds it to every request, the coverage
   read's own included. `test/fill-graph-pages.test.ts`'s "a page is its own product's"
   publishes a claim and a package from another product's unit in the same store and
   holds this product's page set and page to their own facts — and the other product's
   page to its own.
2. **The ends of an edge were hand-parsed, and four kinds were wrong** — a `provides`
   edge's contract and a `task-key` edge's key were dropped, a `consumes` edge's
   variable was shown as text instead of the node it is, and a `binds` edge named the
   page itself. Answered with the read layer's own `endsOf(kind, value)` and one table
   for the ends that are no node (`EDGE_TEXT_END_FIELDS`), and with a relation that
   always says what it joins. The module's page (a `provides` edge), the symbol's (a
   `consumes` edge) and the variable's (a `binds` edge) are held by three tests, the
   last asserting that no relation of it carries neither a node nor a text end.
3. **Only the coverage list was capped**, though the record and the code documented a
   page cap. Answered by bounding every list with the read layer's own `bounded` (the
   facts and the assumptions on one budget, the relations, the questions, the drafts,
   and each coverage scope), with a marker naming the cap and the cut. The test reads a
   page under a 120-token cap and holds `truncated`, the marker's own number and the
   page's `tokens`.
4. **The drafts were ordered by the database's collation.** Answered by sorting them
   here, by the holding unit's id in code point order and then its generation; the test
   uses two unit ids whose first letters differ in case (`Zeta/late`, `alpha/early`),
   which a locale collation orders the other way.
5. **The page address handed out was a 404.** Answered by taking `/graph/` into the
   app's own route table (`src/server/wiki-app.ts`), so the address a page set carries
   opens the app; the server test asks for one and holds the app's shell.
6. **`readPageChanges` reported a cut at exactly its bound.** Answered by reading one
   row past the bound: a full answer is no cut, and a change the bound falls inside is
   left for the next read rather than answered in part (a publication that alone fills
   the bound is answered as it stands, and its marker says so — a reader that could
   hold nothing would read the same change for ever). Two tests: exactly the rows it
   holds, and a bound that holds one publication whole beside a second's first row.
7. **A stream's failed change read went to the browser and never to the log.** Answered
   by giving the routes the error log: the cause (which names files, lines and tables)
   is logged, and the stream's comment says only that the changes could not be read
   now. The test drives a source whose read always fails and holds both.

**Round 2** (a fresh read-only session over the same diff, log
`/tmp/review-231b.log`, this machine's): verdict **fix-before-ship** again — three
defects and twelve findings, with each round-1 answer judged: four held outright
(drafts order, page address, the change bound, the stream's failure), three partly.
The three defects and what became of them:

1. **A fact another product still holds was announced to nobody.** The dropped-fact
   set was filtered by "the row was deleted", so when this product's unit stopped
   holding a fact a *second product's* unit kept, this product's page lost it and no
   client heard. Answered by filtering on the product instead: a fact announced with
   the drops is one that no unit *of this product* holds any more (`goneFromProduct`,
   `applyPublishedFacts`), whether the row survived for another product or not. The
   test publishes one module and one containment from two products' units, has this
   product's unit drop them, and holds this product's channel to the module's page and
   the other product's channel to silence with its page still showing the edge.
2. **The new product field was dropped from a read's recorded text** for `facts` and
   `adjacent` (a scoped read and an unscoped one shared one text and one dependency
   digest, and a replay would answer the wider set). Answered in `canonicalSets`, with
   `held` (the fourth store read) given the field too, and a test that holds the five
   scoped reads to a text of their own, a replay of themselves, and a refusal of an
   empty product.
3. **An empty `after` was accepted** where the record promises a 400. Answered: an
   empty value is refused like any other wrong one, and the test asks for both
   `?after=soon` and `?after=`.

The findings taken: the page's cap is a *list* cap and is now documented as one
(`PAGE_LIST_TOKENS`), the coverage of every scope is bounded as one list with its own
marker, the snapshot scopes are bounded (`PAGE_SNAPSHOT_SCOPES`) with a marker naming
the cut, a page's `facts` lead with the node's own fact, a `provides` edge's contract
is resolved to the `api-endpoint` node it is (so the page links the endpoint's page),
every node a page names carries its page's address where it has one (`pageRefOf`, so a
client never mints a link to a page that does not exist), a stopped service refuses to
read rather than claiming the graph is empty, a stream that cannot learn where to start
answers 503 rather than replaying the product's whole history, the change table's index
claim is corrected in the record, and the dead import is gone. Left as they are and
said so: a page's drafts are read by one query over the product's live draft sets; and
the `fill_page_change` rows are not pruned yet.

**The findings, and what became of them.** Taken: one multi-row `INSERT` for a
publication's page rows and an ids-first read of what a unit held (both in
`applyPublishedFacts`); the whole page read in one transaction (one snapshot, one
connection); the announcement of a dropped fact only when the sweep really removed it
(a fact another unit still publishes is no change to a page); a draft write that names
nothing on the page is skipped before it is judged, so one damaged draft set elsewhere
cannot make every page unreadable; the no-`after` start of a stream catches a failed
read and says so in the log rather than refusing the stream; a refusal's code in the
error envelope; a malformed id answered as a wrong value (400, `not-a-fact-id`) and a
page that stands nowhere as a 404; no machine path in any answer a browser reads; the
architecture document's paragraph order; and the tests' own shape (a world of its own
for the run that stops holding facts, and the page kinds named once in the test as the
decision's list as well as derived from the mapping). Left as they are, and said so
here: the grouping of a change's rows assumes a publication's rows are contiguous in
the store's sequence — they are written in one statement in one transaction, and a
publication that alone fills a read's bound is answered in part with its marker; and a
page's drafts are read by one query over the product's live draft sets, filtered in
process — exact, and the cost of a product with many live sets.

### The checks

- `bun run check` (`tsc --noEmit`) exit **0** after every edit round and at hand-over
  (head `1339f057`).
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.23.1 --candidate worktree --target origin/main`) exit **0**,
  clean, after every edit round and at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  - `test/fill-graph-pages.test.ts` + `test/server-graph-pages.test.ts` +
    `test/fill-graph-reads.test.ts` — **55 pass, 0 fail, exit 0**
    (`run-20261019-103239`), which is this change's own files (after both review
    rounds: 16 + 8 page and server tests and the read layer's own suite): the
    page kinds, the page set, one page's model, the changes a publication makes, the
    three routes and their refusals, the live channel (a subscribed client is woken
    by the publication that adds one module, within the same second, with the pages
    the publication touched and no other), and the empty graph's message.
  - `test/fill-fact-store.test.ts` + `test/fill-orchestrator.test.ts` +
    `test/product-daemon.test.ts` + `test/server-wiki.test.ts` +
    `test/product-wiki-serve.test.ts` + `test/fill-fact-store-postgres.test.ts` —
    **155 pass, 0 fail, exit 0** (`run-20261019-093551`): the store whose
    publication now records its pages (on PGlite and on PostgreSQL), the
    orchestrator whose sink the host composes, the daemon that hands each product
    its source, and the server and wiki routes beside the new ones.
  - `test/fill-crash-suite.test.ts` + `test/fill-unit-tools.test.ts` +
    `test/fill-graph-reads.test.ts` — **69 pass, 0 fail, exit 0**
    (`run-20261019-094311`): the crash suite, which holds a publication to one
    transaction and settles it every time, with the read layer this change reads
    through.
- CI on the exact SHA of the branch: run **39217311854 success** on **1339f057** —
  `checks`, test shards 1–5 and the aggregate `test`, every job green — and Product
  documents **39217311842 success** on the same SHA. The first push (`e09dc039`) was
  green too (run 39214259907, Product documents 39214259775) before the second review
  round's answers; the SHA that CI judged last is the one this record's evidence
  above reports.
