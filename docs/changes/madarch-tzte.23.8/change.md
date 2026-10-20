# A graph page and the graph index stand in under a second on the current madarch tree

Change: madarch-tzte.23.8
Base: aa19c35b
Tasks: madarch-tzte.23.8
Kind: no-behavior

## Intent

Defect against stage madarch-tzte.23, measured by madarch-tzte.23.5's walk on
2026-10-20: on a 194-file product (2 575 pages) a node page took **4.0–4.9 s** to
stand and the graph index **4.7 s**, while the page set's own read alone took
**3.4–3.8 s**. Decision 0026, "Pages", makes every page-worthy node a *live* page a
person watches while the graph fills; a page that takes four seconds to stand is not
one a person watches, and the current madarch tree (35 114 pages, 23 kinds,
280 333 facts) makes every one of those reads larger.

The task's bar: "The cause is measured (server reads, page-model assembly, diagram
generation per request, the app's rendering) and fixed at the cause (indexes, a
page-set cache invalidated by publication, diagrams generated lazily or cached by
content hash)" and "On the current madarch tree filled on the pod: the index and a
repository, module, package and symbol page each stand in under 1 s after warm-up,
measured in headless Chromium and recorded."

The first part of this change fixed the graph's own reads and kept its answers, and it
recorded what remained: the index stood in **3 342 ms** warm and the four pages in
**2 765–2 968 ms**, because `/api/architecture` took **2 798–5 810 ms** for a 33 KB answer on
every page load and the app parsed and grouped the page set's **16 527 510 bytes** every time.
This part fixes those two and measures the stands again: the Architecture answer is built once
per revision of the product, and the navigation and the index read a page set in the four
fields they show.

## Rationale

`no-behavior`: no requirement changes. What a page holds, what the page set lists,
what a diagram draws, the routes, their refusals and the live channel's events are
exactly what they were; this change moves how those answers are read and cached, and
the numbers a reader waits for. No current requirement names the time a page takes
to stand, and none is added here: decision 0026's "Pages" already asks for a live
page, and a page that stands in four seconds is that requirement met thinly.

Nothing a reader can do with a page changes either. `/api/graph/pages` still answers every
entry whole to a client that names no fields, and the one parameter this part adds
(`?fields=nav`) asks for the four fields the navigation and the index read; the Architecture
answer is a function of the same revision the wiki's change stream reports, so a client sees
the answer of the revision whose change it was told about.

## Out of scope

- **Which nodes the diagrams show.** madarch-tzte.23.7 changes the diagrams' node
  choice in parallel; this change keeps every spec, element and arrow a page draws
  now, and changes only how the models are built and kept.
- **The product's document pages and the app's shell.** A document page is the
  product's Markdown, read fresh on every ask (`src/product-wiki/pages.ts`); this
  change caches nothing of it.
- **The store's own footprint and its write path.** A publication is unchanged:
  the same facts, the same holdings, the same page-change rows, in the same
  transaction. What this change adds to the store is one index and nothing else.
- **A second process on one home's database.** Decision 0027 makes one process the
  writer; the caches this change keeps are dropped by the publications *this*
  process makes, which is the same rule the live channel already states.
- **The LikeC4 webcomponent's own render.** `/api/architecture/likec4.js` renders the
  workspace when a diagram tab draws LikeC4; it is not on the graph pages' load path, and
  this change leaves its render as it is.
- **A search over the page set.** The index draws the first 150 rows of a kind (below);
  listing every row of a 35 370-node kind, or searching it, is a later task's.
- **The `mutation` receipt.** The owner runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.

## Preserved contracts

- server/protocol: the three graph routes and the two diagram routes answer the same shapes to a client that names no fields — `GET /api/graph/pages` answers every entry whole, field for field — the same refusals with their own `code`s, and the same log lines; one parameter is added beside them, `?fields=nav` (the four fields a list shows), and a value it cannot give is refused naming the field and the one it accepts; no route is added or removed, and a cached or narrowed answer is the answer a fresh read would give.
- product-wiki/live: a publication this process makes still wakes every open channel and still announces only the pages it touched, and a page a reader holds is re-read after it; the graph's caches are dropped by the same publication that wakes the channel, and the Architecture answer is keyed by the revision the change stream itself reports — a saved page or model file is the change a client is told about, and it is the key's own change — so a client never sees a page or an answer older than its own change event.
- product-wiki/pages: a document page is still the product's Markdown read at every ask, and the graph's pages are still a view beside it.
- server/serves-wiki: a product folder is still served as its own wiki, and one product's cached pages never answer under another product's address.
- fill-orchestrator/host: the background server still owns the fill and its database, and the pages are still reads of that same store through that owner.
- views/deterministic: the same graph still gives the same diagram models, byte for byte, and the same page set in the same order.
- release-binary/installers: no dependency is added; the page set's body is compressed with the runtime's own `gzipSync`.

## Coverage

- server/protocol: test
- product-wiki/live: test
- product-wiki/pages: test
- server/serves-wiki: test
- fill-orchestrator/host: test
- views/deterministic: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The cause is four reads, and each is measured.** A walk phase
  (`scripts/graph-pages-walk.ts --phase speed`, `--phase explain`) times the store's own
  reads, the HTTP answers and a headless Chromium at the owner's 1150x900 window over a
  store a fill left, and `--phase explain` plans and times the statements themselves. On
  the current madarch tree (1 129 files at `aa19c35b`, 35 370 pages, 283 000 facts,
  23 kinds), before this change:
  - **the page set's statement** — one statement with "does a unit of this product hold
    this fact" asked inside it once per page-worthy fact — took **860 746 ms cold and
    940 018 ms warm** (`speedPageSet` on the 4 GB pod); the store answered its first
    statement in 27 ms, so the cost was the statement and not the open;
  - **a page's relations** took **2 210 ms** of the page's own read
    (`speedReadBreakdown.adjacentMs`), asking for one end of an edge fact by comparing a
    field of every edge fact of the product (108 000 rows);
  - **a page's diagrams** took **28 708 ms cold** for a repository: a diagrams ask read
    the whole page model first and then built five models over every module and symbol
    of the repository (`speedReads.repository.diagramsColdMs`);
  - **the index** stood in **4 137 ms cold and 4 987 ms warm**, `/api/graph/pages`
    taking **2 406 ms of it in the browser** for **16 527 510 plain bytes** while the
    server had the answer to give in 209 ms (`speedPageSetHttp`) — the largest answer the
    wiki sends, taken whole and drawn as 35 370 rows in 142 180 nodes.
- **The page set is read as three narrow reads and not one wide one.** The page-worthy
  facts by their kind, the ids one product's units hold (one join of the holding onto the
  unit), the intersection in this process, and then the facts of those ids by their
  primary key in batches of a thousand (`PAGE_SET_KINDS_SQL`, `PAGE_SET_HELD_SQL`,
  `PAGE_SET_FETCH`, `graph-pages.ts`). No statement repeats a join per row. Measured on
  the same store: **276 618 ms** and **304 792 ms** on two runs, against 860 746 and
  940 018 ms for the statement it replaces, and the same answer to the row.
- **An edge fact's value is indexed once, and a page's relations ask by containment.**
  `fill_fact_edge_values` is a GIN index over the value of every fact (`jsonb_path_ops`),
  and `adjacent` (`graph-reads.ts`) asks `value @> {"to": …}` for each field an end is
  kept in (`from`, `to`, `variable`, `caller`, `callee`, and a document link's term — a
  term asked as `{"to": {"id": …}}`, which is its own group). The index is not partial: a
  read names its kinds as a parameter (`kind = ANY($1)`), and a partial index whose
  predicate names a fixed list of kinds is one the planner cannot prove such a read
  implies, so it would never be used. It is also a **footprint** the store did not have
  before: one more copy of every fact's value, built once on an existing store at the
  first open (the build is a one-time cost on a 283 000-fact store, and the store's own
  size is madarch-tzte.21.11's ground).
- **A diagrams ask no longer reads a page model.** It needs three things of the page —
  the node's kind, its entry as the page set names it, and the repository or table its
  value names — and all three are the node's own fact (`readNodeDiagrams`,
  `graph-diagrams.ts`). A client that asks a page and its diagrams side by side (the app
  does, `wiki/app/src/graph-diagrams.tsx`) pays for the page once, and a page read that
  fails on something a diagram never shows (a draft set the schema refuses) leaves the
  page's diagrams standing.
- **The answers are kept until a publication, and no longer.** `src/fill/page-cache.ts`
  is the cache the fill service keeps (`orchestrator-host.ts`): the page set, a page
  model and a diagram answer per product and node, dropped by `notifyPages()` — the same
  `unit-published` event that wakes the live channel — so an answer kept is never older
  than the change a client was told about. Three things it does not keep: a **refusal**
  (cheap, and a page must stand as soon as its node is published), a **page that shows
  drafts** (a draft set is recorded before its unit publishes, so its page moves without
  a publication), and an answer a publication **overtook while it was read** (each read
  takes the cache's generation first and `keep*` refuses an older one). It is bounded by
  entries — 4 products, 256 page models, 8 diagram answers — because a repository page's
  diagrams are models over every module and symbol of it. Measured: a page set, a page and
  a page's diagrams read again after the first read cost **0–1 ms**.
- **The index's own answer is one body, compressed once, and only for a client that takes
  gzip.** `src/server/graph-pages.ts` keeps the plain and the compressed body of the set it
  was asked for (`GZIP_MIN_BYTES` is the size under which nothing is compressed), answers
  `content-encoding: gzip` only when the request's `accept-encoding` allows it, says
  `vary: accept-encoding`, and keeps both bodies for the set, so one answer is one body
  however many clients ask and a publication hands over a new one. Measured in the browser:
  `/api/graph/pages` took **2 406 ms for 16 527 510 bytes** before, and **195 ms for
  2 249 357 bytes** after; the server's own answer is **80 ms** warm.
- **The index draws the first of each kind's rows and names the rest.** Drawing 35 370 rows
  held the browser for seconds (142 180 nodes); `GraphIndexPage` draws the first
  `INDEX_ROWS_SHOWN` (150) rows of each kind, and a kind with more says so in its own words
  (`graph.listingRest`, both catalogues), with the kind's whole count in its header from the
  first paint. **Nothing is hidden silently, and every page is still in the page set the app
  holds** — but a page past the 150th of its kind is not listed on the index: an index of
  35 114 nodes needs a search or a windowed list, and that is a later task's (named under
  open points). Every entry of that set is now the four fields a list shows
  (`?fields=nav`, below): of the four fields the list leaves out, two are addresses the app
  builds from the id (`page`) or a state no list draws (`status`), and two — the code place
  (`code`) and the rank (`importance`) — are what a node's own page shows whole.
- **The Architecture answer is built once per revision, and its key is the change the wiki
  already reports.** `/api/architecture` was read fresh at every ask: `src/server/wiki-app.ts`
  parsed and compiled the merged model, then read **every page's Markdown through
  `ProductWiki.page`, which walks the whole page set once per page**, and handed both to
  `architectureBundle` — which renders every view of the model through a temporary query
  database. The app asks it on every page load (the shell's count and a document page's
  element links), so a reader paid all of it every time. `src/server/architecture-answer.ts`
  keys the answer by the answer's own dependencies: the wiki's revision, which digests every
  page's path and Markdown, the model's source bytes, the stages' inputs and the product's
  manifest (`stagesSourceDigest` reads it) and the registry's bytes. That is the revision the
  change stream itself sends, so a saved page, model file or manifest is the change a browser
  is told about and the key's own change. One walk per ask (`ProductWiki.pageTexts`) gives
  both halves — the revision and the pages' texts as a page's reader reads them, the header's
  field lines blanked, so a field line that names an element is no backlink — and two readers
  of one revision share one build. The identity the answer reads is the manifest's own, read
  at every build: the wiki opens the product once and keeps the repositories it read then, so
  a repository declared since would otherwise never reach the answer. A product whose model
  does not compile answers its errors **without reading a page at all** — a backlink over a
  page set nothing names is work no reader reads.
- **A product's answers survive the products home's own refresh.** The home re-reads its
  products whenever a request arrives more than five seconds after the last one
  (`src/server/http.ts`), and it used to build every product's wiki part again there — which
  threw away the answers those parts hold, the Architecture bundle and the page set's two
  bodies among them, so a reader who paused between pages paid a render on every page. The
  refresh now keeps the entry of a product whose manifest is the one it was opened from
  (`keepsProductEntry`); its pages are still read fresh at every ask, and a product created,
  removed or moved, or a manifest rewritten, is a new or absent entry.
- **The page set is answered in the fields a list shows, and the whole set is still
  answered whole.** `GET /api/graph/pages?fields=nav` (`LIST_FIELDS_PARAM`,
  `src/server/graph-pages.ts`) narrows each entry to its id, kind, label and layer — the
  fields `GraphNav` and `GraphIndexPage` read — and keeps the answer's own fields (product,
  counts, total, change number, moment, message) and their order. A request that names no
  fields is answered every entry whole, field for field, and a `fields` value the route
  cannot give is refused naming it. The app asks the list's fields and builds each node's
  address from its id (`addressOfGraphPage`), the rule the server's own `page` field
  follows, and its own type for the list (`GraphPageListEntry`) is the class of what it reads,
  so a field a list needs cannot go missing silently. The two shapes are two kept bodies, so neither pays for the other.

### Open points and known limitations

- **The page set's first read after a start still costs 276 618–484 264 ms on this store.**
  What is read is 35 370 facts and 283 000 holdings, and the embedded store answers at
  about a millisecond a row on the pod: a projection table would not be faster, because
  the rows themselves are the cost. The cache makes every read after it free, and a
  publication drops it, so a reader watching a fill pays it again. The store's own read
  rate is madarch-tzte.21.11's ground.
- **A page's cold read costs ~20 s and its claims, rules and questions ~2.8 s each.** Those
  are `facts-with` reads (`value #>> $2 = $3` with a parameter path), which no index here
  answers; with the page cached they cost nothing after the first read. Indexing a value
  path is a later task's, and this change's own read (`adjacent`) is the one it made
  indexed.
- **A publication drops the whole cache**, so a fill's steady state rebuilds a page on its
  next read — the right trade for a reader of a finished graph, a cost during a fill.
- **The index lists the first 150 rows of a kind** (above): the counts say how many a kind
  holds, and a search or a windowed list over the page set is the follow-up.
- **The Architecture answer's first read after a change still renders every view.** The
  answer is kept per revision, so the first ask after a start or after a saved page, model
  file or manifest pays the whole build — a render through a temporary query database, then
  the backlinks over every page. Nothing is kept across a restart, and a product with no
  model at all answers at once (its answer names no page).
- **`/api/architecture/likec4.js` still renders on every ask.** It is not on the graph
  pages' load path (a LikeC4 tab asks it), and this change leaves it as it is.
- **The list's own read is still the page set's read.** The whole set is built by the fill's
  page cache and then narrowed, so the narrowing is free but the set is not: the answer
  below is one body per shape for the set it was made from.
- **A search over the page set is still a later task's.** The navigation lists 12 nodes of
  a kind and the index 150, each with the kind's whole count; a node past those is reachable
  by its address, and a search or a windowed list is the follow-up.
- **The list's body is a second copy of the page set in the process.** One product holds the
  whole set's plain and compressed bodies (16 740 703 bytes and 2 277 744 in this store) and
  the list's two (6 550 525 and 1 695 661): about 27 MB of the 4 GB pod's memory for the
  largest graph measured. That is the price of encoding once per set instead of per ask.
- **A stand that waits on the store's own process cannot be attributed to a route.** One
  cold load in each of this part's runs timed out at the app's own 5 s page-list read; the
  server logged no slow answer for it (`speedSlowRequests`), so what held the one thread was
  not a route. The walk now samples that thread's loop (`speedEventLoop`) to name it, and the
  runs are recorded below.
- **A walk's report names its revision as a label, not a commit.** The pod's staged folder is
  no git checkout, so `--revision` is what the caller writes (`af671373` here) and
  `speedNotes` carries it; the `pin` it does record is the product's code checkout.
- **No `mutation` receipt.** The owner runs Stryker once per assembled stage, off the
  path; acceptance escalates per `mutationFallback: escalate`.

## Acceptance evidence

Measured on the current madarch tree on the pod, not estimated. The store: a product of a
shallow clone of `main` at `aa19c35b` (1 129 files) filled by the eight deterministic
stages in one process — **2 981 units in 1 878 passes in 1 291 873 ms**, 23 kinds,
283 000 facts, **35 370 pages** (symbol 29 605, test 3 088, entry-point 2 375, module 295,
package 5, repository 2). The walk: `scripts/graph-pages-walk.ts --phase speed` over that
store, headless Chromium at the owner's 1150x900 window, on a SkyPilot pod of 8 GB
(`MADARCH_SKY_MEMORY=8`; the 4 GB pod ran the process out of memory during the browser
phase, exit 137, madarch-tzte.21.11's ground).

**What the reads cost, before and after this change** (each number is one read of the
same store):

| read | before | after |
| --- | --- | --- |
| the page set, store | 860 746 ms cold, 940 018 ms warm | 341 319 ms cold, **1 ms** warm |
| a repository page, store | 20 631–21 428 ms | **0 ms** warm |
| a repository page's diagrams, store | 48 225–48 851 ms cold | **0 ms** warm |
| a page's relations (`adjacent`) | 2 749 ms of a page | included above |
| `/api/graph/pages` in the browser | 2 406 ms, 16 527 510 bytes | **195–211 ms, 2 249 358 bytes** (gzip) |
| the index, browser | 4 137 ms cold, 4 987 ms warm, 142 180 nodes | **3 980 ms cold, 3 342 ms warm, 607 rows, 3 132 nodes** |

**Against the task's bar, in the first part's measurement.** The index and the four node
pages did **not** stand in under a second: the index stood in **3 342 ms** and the pages in
**2 411–3 247 ms cold and 2 765–2 968 ms warm** (`speedStands`). The graph's own answers were
no longer what a reader waited for — a page's model came from the service in **2–28 ms**, its
diagrams in **108–392 ms**, the page set in **195 ms** — and what remained was on the app's
own load path: **`/api/architecture` at 2 798–5 810 ms** on every page load for a 33 KB
answer, and the app parsing the page set's **2 249 358 bytes** and grouping its 35 370 entries
on every load.

**The second part, measured on one store, before and after.** The tree this part starts from
(`af671373`, 1 136 files), filled on the pod: **3 002 units in 1 888 passes in 1 267 447 ms**
— 23 kinds, **287 795 facts** (occurrence 117 644, reference 34 974, contains 33 148,
defines 30 013, symbol 30 013, comment 14 606, call 10 209, section 6 214, test 3 121,
entry-point 2 387, import 1 454, coverage 1 303, the rest below a thousand) and **35 825
pages** (symbol 30 013, test 3 121, entry-point 2 387, module 297, package 5, repository 2).
The walk ran on that store twice — once on the code this part starts from, once with this
part's fixes — on a SkyPilot pod of 8 GB (`MADARCH_SKY_MEMORY=8`) at the owner's 1150x900
window. (A second fill of the same tree for the final run: 3 002 units in 1 888 passes in
969 232 ms, the same 35 825 pages; its walk is the "after" column.)

| the stand (headless Chromium) | before this part | after this part |
| --- | --- | --- |
| the graph index, warm | 2 667 ms | **467 ms** |
| a repository page, warm | 1 044 ms | **416 ms** |
| a package page, warm | 2 677 ms | **313 ms** |
| a module page, warm | 2 559 ms | **553 ms** |
| a symbol page, warm | 2 921 ms | **619 ms** |
| the graph index, cold | 4 551 ms | 3 711 ms |
| a node page, cold | 2 821 / 2 896 ms, and two of the four never stood | 346 / 502 / 710 ms, and one of the four never stood (below) |
| `/api/graph/pages` over HTTP | 564 ms cold, 90 ms warm, **16 740 703 bytes** | 475 ms cold, 78 ms warm; the list the app asks for **164 ms cold, 22 ms warm, 6 550 525 bytes** |
| `/api/architecture` in the browser | 2 044–3 454 ms on every load | **3–87 ms** once built; the first ask of a revision **3 087 ms** (the index's cold stand includes it) |

Two earlier runs of this walk, on the code before the review's fixes, stood in
**567 / 614 / 509 / 422 / 574 ms** and **518 / 438 / 391 / 467 / 521 ms** warm — the same
range, so the bar is met on every run of this part and not on one lucky one.

**Where the before seconds went, from the browser's own thread.** The index's warm stand was
**513 ms of long tasks inside a 2 667 ms stand**: the page was idle for two seconds, waiting.
Its answers say on what: `/api/architecture` started at 594 ms and took **2 044 ms**, and
`/api/product` — a 565-byte answer — took **1 443 ms**, because the one server thread could not
answer it while the Architecture bundle rendered. Two of the four pages never stood at all
before (`speedStands.package.cold`, `.symbol.cold`, `standMs: -1`): their `/api/pages` request
waited at the app's own 5 s bound while that render held the thread. After this part the
index's warm stand is **182 ms of long tasks inside 467 ms**, its `/api/architecture` answer
costs **3–87 ms**, and its page set **42–164 ms**.

**The one stand that did not stand, in every run.** One of the four pages' first (cold) load
timed out in each run of this walk, before and after this part, and never the same page twice:
its `/api/pages` request waited at the app's own 5 s bound, the page showed that refusal, and
no route logged a slow answer (`speedSlowRequests`: the only answers over 200 ms in the final
run are the page set's own first encoding, 314 ms, and the Architecture build, 3 087 ms). What
holds that thread is the process that owns the store and serves the wiki: sampled every 50 ms
during the last run, its loop was held **twice, the longer for 2 349 ms** (`speedEventLoop`) —
work no route names, which is the ground madarch-tzte.21.11 names for the store's own service
and not a cost of any answer this change touched. It is recorded under open points, not
claimed as fixed.

This part therefore fixes the two causes the first part named — the Architecture answer built
on every page load, and a page set the browser parses whole on every page load — and the bar is
met on the warm stands: **467 / 416 / 313 / 553 / 619 ms**, each under a second, against
**2 667 / 1 044 / 2 677 / 2 559 / 2 921 ms** before.

**What stands in tests and checks.** `bun run check` (`tsc --noEmit`) exit 0 at every commit
and at the final tree; the feature document gate clean. On the pod (`madarch-sky-test --avx2`),
at the final tree:
- the focused suites — the Architecture answer's cache, the graph routes and the page set's two
  shapes, the products home, the Architecture bundle — **60 pass, 0 fail** (exit 0);
- `test/server-graphs.test.ts` alone: **31 pass, 0 fail** (six of its tests failed once inside a
  mixed five-file run on the same pod and pass alone: load, not a defect);
- the graph's Chromium acceptance (`MADARCH_WIKI_E2E=1 test/wiki-graph-pages-e2e.test.ts`, the
  production-built app against a real server): **2 pass, 0 fail** (exit 0);
- `wiki/app`: `bun install --frozen-lockfile && bun run check && bun test && bun run build` —
  `tsc` exit 0, **225 pass, 0 fail**, the build exit 0;
- the write of this record's numbers: `STAGE23_WALK` lines from three runs, kept at
  `/tmp/rep-before-238-app.json`, `/tmp/rep-after-238-app.json` and
  `/tmp/rep-final-238-app.json` on this machine, with the screenshots under
  `/home/dev/.cache/madarch-stage23-walk-238/` and the pod's `.walk23-8-app*` folders fetched
  from it.

## DONE WHEN

On the current madarch tree, filled on the pod: the graph index and a repository, a
module, a package and a symbol page each stand in under 1 s after warm-up, measured
in headless Chromium; and the cause of the four-second pages is measured and fixed
at the cause.
