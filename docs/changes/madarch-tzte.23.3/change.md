# The wiki app shows every page-worthy graph node as a live page that appears and updates as facts arrive

Change: madarch-tzte.23.3
Base: c0a297f8f3c9a995685a486e81e508d8563f251b
Tasks: madarch-tzte.23.3
Kind: no-behavior

## Intent

Decision 0026, "Pages": "Every graph node of a page-worthy kind has a live page at
once, rendered from the graph without an agent (facts with code links, relations,
diagrams, intent, questions, coverage) and updated in the browser as facts arrive;
it is a view, not a file in git."

madarch-tzte.23.1 landed the server's side of it: the page set
(`GET /api/graph/pages`), one node's page model (`GET /api/graph/page?id=…`) and
the live channel of the pages each publication touched
(`GET /api/graph/events`, Server-Sent Events), all read from the fill's fact store.
Nothing read any of it. The wiki app showed the product's Markdown and its
registry model, and a graph page was an address the server answered with the app's
shell and the app then answered with a document 404.

This change gives the app its graph side:

- **`wiki/app/src/api.ts`** carries the three answers' shapes as types (`GraphPageSet`,
  `GraphPageModel` and everything a page shows) and the three reads
  (`getGraphPages`, `getGraphPage` and the channel's address); `RequestError`
  carries the status the server answered, so a 404 (a page that stands nowhere) is
  told from a failure.
- **`wiki/app/src/graph.ts`** is the app's graph state: `useGraphPages` reads the
  page set once and opens one stream per tab from the set's own `changeSeq` (so
  nothing published between the read and the subscription is lost), reads the set
  again for every publication the channel reports, and reconnects from the last
  change it saw; `useGraphPage` reads one node's page and again only for a
  publication that names it. The module also holds the pure rules the pages and
  the navigation share: the page set grouped by kind, and the code link a fact's
  provenance makes on its repository's host (`codeHref`, the same rule the wiki's
  document links keep in `src/wiki/documents.ts`).
- **`wiki/app/src/graph-pages.tsx`** is the reading: the graph's index — every
  page-worthy node, one group per kind with the kind's count, each node a link to
  its page, and the server's what-to-do message where the graph holds nothing —
  and one node's page: its own fact's fields, its facts with the place in code each
  stands at, its assumptions in their own section apart from them, its relations
  both ways as links to the pages of the nodes they join, the coverage of its
  scopes with the gaps it names, its open questions, and the drafts another unit
  holds, each marked as a draft.
- **`wiki/app/src/routes.ts`** reads a graph page's address (`/p/graph/` plus the
  node's fact id, the address the server hands out, made once in
  `addressOfGraphPage`) and the graph's index (`/p/graph`, the address
  madarch-tzte.23.2's `diagramHref` already hands out for a view, so a diagram's
  drill-down opens the graph and not a document that happens to be named `graph`).
- **`wiki/app/src/shell.tsx`** gives the navigation the graph's section: the
  server's page-worthy nodes by kind with their counts, each a link to its page,
  and a kind past the navigation's own bound pointing at the index so nothing is
  dropped in silence.
- **`wiki/app/src/app.tsx`** wires the state to the routes, the shell and the home
  page's entry to the index, and reads the graph's own live channel beside the
  wiki's change stream: a publication makes a node join the navigation and the
  index, and a page the publication names reads again — with no reload and no
  polling.
The document pages are untouched: a product whose server answers no page set (an
older server, a foreground serve) shows no graph section at all, and every document
page reads exactly as it did. No server file changes: the graph's index stands under
the app's existing `/p/` route, as a page's address does.

## Rationale

`no-behavior`: the change implements the accepted decision 0026's "Pages" in the
app that shows them, and adds no requirement of the product. The fill's capability is
proposed by `fill-pipeline-monday` and is not closed, so the graph pages' own
requirement text lands with the stage that closes decision 0026, exactly as
madarch-tzte.20.1–22.3 and 23.1 recorded theirs.

What a person sees is new: the app's navigation holds a graph section, the graph's
index at `/p/graph` and a node's page at `/p/graph/` plus the node's fact id are pages
of the app, and a page a publication touches changes under the reader without a
reload. None of it moves a requirement: a product whose server answers no page set
looks exactly as before, and the pages the wiki serves from the product's Markdown
are unchanged.

## Out of scope

- **The diagrams.** A node's page keeps a named slot for them (madarch-tzte.23.4
  draws madarch-tzte.23.2's view specifications under the renderer switcher); this
  change draws no diagram and names the slot rather than an empty frame.
- **The server's answers.** The page set, the page model, the live channel, their
  caps and their refusals are madarch-tzte.23.1's and are consumed as they are; no
  server file is touched by this change.
- **A code view of the repository.** A fact's code link opens its repository's own
  page on its host at the pinned commit and the lines it spans, exactly the way a
  document's code link does; a repository whose origin the hosts do not spell has
  its place shown as text, and the app opens no file of any checkout.
- **The narrative layer.** 0026's second layer — agent-written Markdown tied to fact
  ids, stored in the product's git as `proposed` — is not read or written here.
- **Answering a page's questions.** A page's open questions are shown; answering
  them is the questions view's and the fill's own business, and a graph question's
  answer path is not this task's.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not current,
  as the changes before this one recorded theirs.

## Preserved contracts

- product-wiki/pages: unchanged — a document page is still the product's Markdown read from the working tree at every ask, and the graph pages are added beside it; the graph pages' own app is this change, and 23.1 recorded the reads behind them.
- product-wiki/live: unchanged — the wiki's own change stream (`GET /api/events`) and its revision rule are untouched, and the graph's channel is a second stream of its own.
- server/protocol: unchanged — no route, handler, refusal or server file is touched; the graph's index is an app address under the `/p/` route the file fallback already answers.
- server/serves-wiki: unchanged — a product folder still serves its wiki and a products home still serves each product under its own prefix, and a graph page is asked under that prefix like every other app address.
- views/deterministic: unchanged — the graph section keeps the server's own order (kind, then label, then id), never a map's insertion or a locale's collation.
- release-binary/installers: unchanged — no dependency is added; the channel is the platform's own `ReadableStream` and `TextDecoder`.

## Coverage

- product-wiki/pages: test
- product-wiki/live: test
- server/protocol: test
- server/serves-wiki: test
- views/deterministic: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **A page is read from the answer, and only a shape the server promised is trusted.**
  `pageSetOf` refuses an answer that is no page set (`pages` a list, `total` a
  number), and the app then shows no graph section: a page built from a list it was
  not given would be a page of nothing. A server of another shape answers a
  document list and no graph, and that is exactly what the app shows.
- **The stream is opened from the set's own change number, and never polled.** The
  page set carries `changeSeq`; the app opens `/api/graph/events?after=<changeSeq>`,
  so a publication between the read and the subscription is replayed rather than
  lost, and a quiet product makes no request at all beyond its one stream. A
  dropped stream reconnects with backoff from the last change it saw (the wiki's own
  rule), and an answer that is no event stream stops the retries: a route this
  server does not offer is not polled.
- **A page reads again when a publication names it, and a burst of publications
  leaves every page its own latest one.** The channel's event carries the pages one
  publication touched; the app keeps, per node, the change number of the latest
  publication that named it, and that number is what a page depends on. A burst is
  real — a read of the channel answers every change since the last one in one
  flush, and a reconnection replays them the same way — so several events arrive in
  one task and a single "latest event" would leave a page stale whenever the event
  naming it was not the last. The tests hold all three: the page is not read for a
  publication that names another node, is read once for one that names it, and is
  read for a burst's first event even when a later event names another page.
- **A page that stands nowhere is the refusal's own words.** The server answers 404
  with the id and the reason (`graph-pages/no-such-node`, `graph-pages/not-a-page`),
  and the app shows that message with the link back to the graph's index — a node
  whose facts another publication dropped is a page that disappeared, which is how
  the navigation loses it, and never an empty page that reads as an absence nobody
  stated (0005).
- **A fact's layer and status are words, and assumptions stand apart.** 0005 makes
  an agent's reading `inferred` and a person's `declared`; a page shows both as
  words beside every fact, and the assumptions get their own section, outside the
  facts list. The tests hold that no inferred fact stands in the facts list and no
  asserted fact in the assumptions.
- **A relation always says what it joins, and links the page of the node it joins.**
  The server resolves a relation's other end to a node where the graph holds one and
  leaves a text end where it does not; the app links `node.page` when the server
  names one and shows the text end otherwise, so a page never mints a link that
  would be a 404.
- **A code link is the repository's own page at the pinned commit.** The fact's
  provenance is the repository's name, the commit, the file and the line span; the
  app reads the repository's declared origin from the wiki's own `/api/repos` and
  makes the host's address with it — the same hosts, the same encoding of the
  owner, the repository, the commit and every path segment, and the same spelling
  the wiki's document links keep (`hostFileUrl`, `src/wiki/documents.ts`): GitHub
  under `/blob/`, GitLab under `/-/blob/`. A repository with no origin those hosts
  spell, or none the manifest declares, shows the place as text with the reason in
  its title, and links nothing.
- **The navigation is bounded, and says so.** A kind lists at most
  `NAV_NODES_PER_KIND` nodes and its last row names the rest and opens the graph's
  index, so a large graph never turns the sidebar into a wall and nothing is
  dropped in silence. The graph's index page lists every node of every kind.
- **An empty graph has no sidebar section.** A graph that holds no page has no
  nodes to list; the server's what-to-do message stands on the graph's own index
  page (where a reader asked for it, quoted as the server's own words), and the home
  page's graph entry carries the zero — never an empty section in every product's
  navigation.
- **The home page names the graph.** An entry with the number of page-worthy nodes,
  shown only where the server answers a page set, opens the index; a product whose
  server answers none shows no such entry.
- **The graph's index is `/p/graph`, under the page route the server already
  answers.** It is the address madarch-tzte.23.2's `diagramHref` hands out for a view
  (`/p/graph?diagram=…&node=…`), so a diagram's drill-down opens the graph and not a
  document named `graph`; no server file changes, and the index opens directly, is
  reloadable and is linkable like every `/p/` address. A path under `/p/graph/` that
  is no fact id stays a document path, so a product that keeps a document in a
  `graph/` folder still opens it.
- **The diagrams' slot is named and not drawn.** A node's page carries a
  `graph-diagrams` section saying what will stand in it; madarch-tzte.23.4 fills it
  with the models madarch-tzte.23.2 builds. An empty frame would read as a diagram
  that failed.

## Acceptance evidence

Accepted by rendering, as AGENTS.md asks of a view: the app built the way a reader
gets it (`wiki/app` built by Vite) served by a real server over a real fill service
and its PGlite store, opened in headless Chromium at the owner's 1150×900 window,
with the sizes and boxes the browser computed read out of the page.

- `test/wiki-graph-pages-e2e.test.ts` (run with `MADARCH_WIKI_E2E=1` on the pod):
  the navigation listed the two page-worthy nodes the server answered and the index
  named them by kind; a click on a node's link opened its page at
  `/p/graph/symbol:…`, titled with the server's own label
  (`acme-shop:src/checkout.ts#checkout.place`) with its relations drawn from the
  graph; then a unit published — the fixture's stage ran again over a moved pin —
  and the new module joined the navigation **within the same browser page** (a flag
  the test set on `window` before the publication was still there afterwards, so no
  reload happened) in under 10 s. Its page then held the module's fact, its
  assumption apart (2 rows, `inferred`), 2 relations (`contains`, `provides`) with
  their pages linked, 1 coverage record with its gap, 1 open question, 6 places in
  code and the diagrams' slot — each count asserted, not read from the code. The
  product's own Markdown page still opened beside it, with the graph's section in
  the navigation.
- The measurements of the page a reader saw (`GRAPH_PAGE_MEASURED`, asserted by the
  test): the window 1150×900, the navigation 260×900, the page column 794 px wide,
  the title at 36 px, the facts' labels at 18 px and the chips at 14 px, **0
  overlapping rows** and **0 elements wider than the column they stand in**.
- Screenshots (fetched from the pod with `--fetch`): `graph-index.png`,
  `graph-node.png`, `graph-module-page.png`, `graph-index-after-publish.png` and
  `document-beside-graph.png`, all 1150×900.

### Known limitations

- **The app reads the graph's channel beside the wiki's own.** Two long-lived
  streams stand open per tab where a server answers both: the wiki's change stream
  and the graph's channel. Each is one request held open and neither is polled; a
  server that answers no page set opens none.
- **A publication from a process the server does not drive is not announced.** The
  channel is woken inside the publishing process (0027 makes that process a home's
  only writer), so a second writer's rows are read on the next reconnection and not
  pushed; the page set is read afresh at load and after every event either way.
- **The navigation's bound is a count of rows, not of importance.** A kind with
  more nodes than `NAV_NODES_PER_KIND` lists the server's first twelve (the set's
  own order: label, then id) and points at the index for the rest; ranking the rows
  by stage 5's `importance` is a later refinement, and the index holds every node in
  the same order today.
- **A draft's own words are the fact's kind and the values the server sends.** The
  page marks every draft row as a draft, names the unit, its generation, its scope
  and its evidence, and shows the fact's kind and label where the write carries
  them; it does not read a draft's fact into a full page of its own, because the
  server's model gives the write and not a page.
- **No `mutation` receipt.** The owner's rule runs Stryker once per assembled stage,
  off the path; acceptance escalates per `mutationFallback: escalate`.
