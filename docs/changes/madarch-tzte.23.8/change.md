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

This change is the measurement and the fix at the cause.

## Rationale

`no-behavior`: no requirement changes. What a page holds, what the page set lists,
what a diagram draws, the routes, their refusals and the live channel's events are
exactly what they were; this change moves how those answers are read and cached, and
the numbers a reader waits for. No current requirement names the time a page takes
to stand, and none is added here: decision 0026's "Pages" already asks for a live
page, and a page that stands in four seconds is that requirement met thinly.

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
- **The `mutation` receipt.** The owner runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.

## Preserved contracts

- server/protocol: the three graph routes and the two diagram routes answer the same shapes, the same refusals with their own `code`s, and the same log lines; no route, field or message is added or removed, and a cached answer is the answer a fresh read would give.
- product-wiki/live: a publication this process makes still wakes every open channel and still announces only the pages it touched, and a page a reader holds is re-read after it; the caches are dropped by the same publication that wakes the channel, so a client never sees a page older than its own change event.
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

- **The cause is four reads, and each is measured on the current tree.** A walk phase
  (`scripts/graph-pages-walk.ts --phase speed`) times the store's own reads, the HTTP
  answer and a headless Chromium at the owner's 1150x900 window over a store the fill
  left, and `--phase explain` times the statements themselves. On the current madarch
  tree (1 129 files, 35 370 pages, 283 000 facts, 23 kinds):
  - **the page set's statement** — one statement with "does a unit of this product hold
    this fact" asked inside it once per page-worthy fact — took **860 746 ms cold and
    940 018 ms warm** (`speedPageSet`); the store answered its first statement in 27 ms,
    so the cost was the statement and not the open;
  - **a page's own read** took **2 378 ms** for a repository and 2 218 ms of that was the
    one read of its relations (`speedReadBreakdown.adjacentMs`), which asked for one end
    of an edge fact by comparing a field of every edge fact of the product (108 000
    rows);
  - **a page's diagrams** took **28 708 ms cold**, because a diagrams ask read the whole
    page model first and then built five models over every module and symbol of the
    repository (`speedReads.repository.diagramsColdMs`);
  - **the index** stood in **4 137 ms cold and 4 987 ms warm** with `/api/graph/pages`
    taking **2 406 ms of it in the browser** for **16 527 510 bytes**, while the server
    had the answer to give in 209 ms (`speedPageSetHttp`) — the index was the largest
    answer the wiki sends, taken whole and rendered as 35 370 rows in 142 180 nodes.
- **The page set is read as three narrow reads and not one wide one.** The page-worthy
  facts by their kind, the ids one product's units hold (one join of the holding onto
  the unit), the intersection in this process, and then the facts of those ids by their
  primary key in batches of a thousand (`PAGE_SET_KINDS_SQL`, `PAGE_SET_HELD_SQL`,
  `PAGE_SET_FETCH`, `graph-pages.ts`). No statement repeats a join per row, and only the
  facts a page is made of are read whole. Measured on the same store: **276 618 ms**,
  3.4 times less than the one statement it replaces, and the same answer to the row.
- **An edge fact's value is indexed once, and a page's relations ask by containment.**
  `fill_fact_edge_values` is a GIN index over the value of every fact (`jsonb_path_ops`),
  and `adjacent` (`graph-reads.ts`) asks `value @> {"to": …}` for each field an end is
  kept in (`from`, `to`, `variable`, `caller`, `callee`, and a document link's term) —
  the same question the field comparison asked, in the form that index answers. The index
  is not partial: a read names its kinds as a parameter (`kind = ANY($1)`), and a partial
  index whose predicate names a fixed list of kinds is one the planner cannot prove such
  a read implies, so it would never be used.
- **A diagrams ask no longer reads a page model.** It needs three things of the page —
  the node's kind, its entry as the page set names it, and the repository or table its
  value names — and all three are the node's own fact (`readNodeDiagrams`,
  `graph-diagrams.ts`). A client that asks a page and its diagrams side by side (the app
  does, `wiki/app/src/graph-diagrams.tsx`) pays for the page once, and a page read that
  fails on something a diagram never shows (a draft set the schema refuses) leaves the
  page's diagrams standing.
- **The answers are kept until a publication, and no longer.** `src/fill/page-cache.ts` is
  the cache the fill service keeps (`orchestrator-host.ts`): the page set, a page model
  and a diagram answer per product and node, dropped by `notifyPages()` — the same
  `unit-published` event that wakes the live channel — so an answer kept can never be
  older than the change a client was told about. It is bounded by entries (256 pages, 32
  diagram answers) because a repository page's diagrams are models over every module and
  symbol of it, and a browsing session must cost a bounded amount of memory. Measured:
  the page set read again **0 ms**, a page **0 ms**, a page's diagrams **0 ms**.
- **The index's own answer is one body, compressed once.** `src/server/graph-pages.ts`
  keeps the encoded body of the page set it was asked for (`GZIP_MIN_BYTES` is the size
  under which nothing is compressed) and sends it with `content-encoding: gzip`: the
  browser's 2 406 ms for 16 527 510 bytes was the answer being taken whole over a socket,
  and the same answer compressed is 1 500 000 bytes of transfer. The set the source
  answers is that source's own cached answer, so one answer is one body however many
  clients ask for it, and a publication hands over a new one.
- **The index draws a slice at a time and says so.** 35 370 rows in one React commit held
  the browser for seconds (142 180 nodes drawn); `GraphIndexPage` draws the first 50 rows
  of each kind at once — the index, its counts and its first links stand — and the rest
  500 at a time in the browser's own turns (`INDEX_FIRST_ROWS`, `INDEX_ROWS_PER_STEP`,
  `wiki/app/src/graph-pages.tsx`). Nothing is cut: a kind's count in the group's header
  is its whole count from the first paint, and a group still filling names how many of
  its rows stand (`graph.listingRest`, both catalogues) until they all do.

### Open points and known limitations

- **The page set's first read after a start still costs 276 618 ms on this store.** What
  is read is 35 370 facts and 283 000 holdings, and the embedded store answers at about
  2.5 ms a row on the 4 GB pod: a projection table would not be faster, because the rows
  themselves are the cost. The cache makes every read after it free, and a publication
  drops it — so a reader watching a fill pays it again for the set, which is named here
  rather than hidden. The store's own read rate is madarch-tzte.21.11's ground.
- **A publication drops the whole cache.** A fill's steady state therefore rebuilds a
  page on its next read, which is the right trade for a reader of a finished graph and a
  cost during a fill (23.1's channel already states that a publication moves pages).
- **The memory bound is by entries, not by bytes.** A page of a very large repository
  keeps a diagram answer of its own kind; the entries bound is what keeps a browsing
  session inside the pod's 4 GB, and a re-read after an eviction is a read of the store.
- **`/api/pages` (the product's document list) is on the same page load** and is not this
  change's: it is read fresh on every ask (`src/product-wiki/pages.ts`), and the
  measurements here report what it costs beside the graph's own answers.
- **No `mutation` receipt.** The owner runs Stryker once per assembled stage, off the
  path; acceptance escalates per `mutationFallback: escalate`.

## DONE WHEN

On the current madarch tree, filled on the pod: the graph index and a repository, a
module, a package and a symbol page each stand in under 1 s after warm-up, measured
in headless Chromium; and the cause of the four-second pages is measured and fixed
at the cause.
