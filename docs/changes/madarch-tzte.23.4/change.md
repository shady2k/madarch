# Every graph diagram renders under a switcher over archify, Mermaid and LikeC4, the first tab following MADARCH_WIKI_DIAGRAM

Change: madarch-tzte.23.4
Base: 47fa3a8a7324a9a51d5c5babe1a8ecabef7802ce
Tasks: madarch-tzte.23.4
Kind: no-behavior

## Intent

Decision 0026, "Diagrams": "Every diagram carries a switcher over every renderer
that supports its type: archify and Mermaid wherever they do, LikeC4 for C4 and
deployment; the first tab is a setting (MADARCH_WIKI_DIAGRAM). Solid lines are
facts, dashed are assumptions or unresolved; elements link to their pages and
code; a diagram stays readable by size."

madarch-tzte.23.2 landed the diagram models — the view specification checked
against the graph, facts solid and assumptions dashed, every element carrying its
page and its code place — and madarch-tzte.23.3 gave a node's page the slot where
a diagram would stand. Nothing rendered one: no renderer read a graph model, and
`MADARCH_WIKI_DIAGRAM` had no effect on a graph page.

This change renders them:

- **`src/fill/graph-diagrams.ts`** decides which diagrams one node's page draws,
  by the node's own kind, and builds each model out of the fact store: a
  repository is the product's context, its own containers, its modules and its
  tables; a package, a deploy unit, a table and a column are the containers they
  stand in; a module is drawn among its siblings; a symbol by the sequence of the
  interactions that name it; a state by its machine. A kind that no type of
  0026's seven is scoped by (a question, a rule, an entity proposal) draws none,
  and the page says so rather than showing an empty frame.
- **`src/product-wiki/graph-mermaid.ts`** writes a model as Mermaid source: the
  box-and-arrow types as a `flowchart LR` with `-.->` for an assumption or an
  unresolved end and a dashed node class for an assumption, a sequence as a
  `sequenceDiagram` with `-->>` for an assumption and its steps in the scenario's
  order.
- **`src/product-wiki/graph-workspace.ts`** writes a model as the LikeC4
  workspace two renderers read: every element an element of its kind with its code
  place in `technology` and its page in `link`, every arrow a relationship with
  `style { line dashed }` where the model says dashed, and one view that holds them
  all. The webcomponent element's name is made from the workspace's own bytes
  (`webcomponentPrefix`), because LikeC4's bundle defines its custom element
  unconditionally and two diagrams' bundles stand on one page.
- **`src/product-wiki/graph-render.ts`** makes the two generated documents: the
  LikeC4 page over the bundle the pinned `likec4` generates from that workspace
  (`likec4Webcomponent`, now with a prefix of the caller's), and the archify page
  from the layout LikeC4 computes for the same workspace (`layoutedViews`,
  `archifyDocument`, the vendored renderer) with every element wrapped in a link to
  its page (`archifyPageLinks`). Both are kept by content hash under the wiki's
  cache root, so a second ask reads what the first generated.
- **`src/product-wiki/graph-diagrams.ts`** is the answer the app receives: one
  diagram per type the node stands in, each with the tabs of every renderer that
  supports it, the chosen renderer's tab first, and the same list of elements and
  arrows under every tab.
- **`src/server/graph-diagrams.ts`** serves it (`GET /api/graph/diagrams`) and the
  two generated documents (`GET /api/graph/likec4.js`, `GET /api/graph/likec4.html`,
  `GET /api/graph/archify`), over the same source the pages come from; a
  `MADARCH_WIKI_DIAGRAM` the wiki does not hold is refused naming the value and the
  three it accepts, as the static build refuses it.
- **`wiki/app/src/graph-diagrams.tsx`** is the switcher: one section per diagram,
  one button per renderer in the server's order, the chosen renderer's panel open
  first, only the open panel mounted (the LikeC4 bundle is megabytes and the
  archify page is rendered on its first ask), and under every tab the diagram's
  elements and arrows as lists — each element opening its page and its place in
  code, each arrow saying whether it stands on a fact or an assumption.
- **The navigation's labels** (from 23.3's acceptance): a sidebar row shows the
  node's short name — a symbol's qualified name, a table's name after its
  repository — with the graph's whole label as its tooltip, instead of a truncated
  `acme-shop:src/checkout.ts#ch…`.

## Rationale

`no-behavior`: the change draws the models madarch-tzte.23.2 landed on the pages
madarch-tzte.23.3 gave them, and adds no product requirement. The fill's
capability is proposed by `fill-pipeline-monday` and is not current, so the graph
diagrams' own requirement text lands with the stage that closes decision 0026, as
madarch-tzte.20.1–22.3, 23.1, 23.2 and 23.3 recorded theirs.

What a person sees is new: a node's page holds its diagrams, each under a switcher
over the renderers that can draw its type, with the first tab the server's own
setting; a product the graph has not filled holds no diagram and says so.

## Out of scope

- **The models.** Which elements and arrows a diagram shows is madarch-tzte.23.2's
  (`src/fill/diagrams.ts`), read as it stands; this change adds no node budget, no
  collapse rule and no evidence rule of its own.
- **The pages.** The page set, the page model and the live channel are
  madarch-tzte.23.1's; this change adds routes beside them and reads the same
  source.
- **`activity`, `class` and `deployment`.** The schema holds no kind for a step, an
  attribute or a deployment target, so no type nothing can be read for is offered
  (23.2's own limitation).
- **The static wiki's tabs.** `wiki/diagrams` renders the registry model's views in
  a built site and is untouched; this change draws the graph's models in the served
  app.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.

## Preserved contracts

- product-wiki/pages: unchanged — a document page is still the product's Markdown read at every ask, and a graph page shows one more section beside its facts.
- product-wiki/live: unchanged — a publication still re-reads the page it names, and the diagrams are read again with the page's own `readAt`.
- product-wiki/architecture: unchanged — the Architecture section's own views keep their Mermaid and LikeC4 panels and its bundle its own element name; a graph diagram's bundle names a second element, so the two cannot collide.
- product-wiki/internationalization: test — every new string is in English and Russian.
- server/serves-wiki: unchanged — the new routes answer under a product's prefix in a products home like every other app address, and the generated documents carry that prefix in their own links.
- views/deterministic: test — a Mermaid source, a LikeC4 workspace and an archify document are the same bytes for the same model on every machine: elements in the model's order, ids made from positions, nothing read from the clock or a database's collation.
- release-binary/installers: unchanged — no dependency is added; the renderers are the pinned `mermaid`, `likec4` and the vendored archify already in devDependencies.

## Coverage

- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/architecture: test
- product-wiki/internationalization: test
- server/serves-wiki: test
- views/deterministic: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The renderers a type is offered on are a table, and no tab is offered that draws
  nothing.** `DIAGRAM_RENDERERS_OF` gives each type Its renderers: LikeC4 the three
  C4 levels (0026 gives it C4 and deployment; no deployment kind exists), archify
  every type that is components and connections — the C4 levels, module
  dependencies, ER and state — and Mermaid all seven. A sequence is Mermaid's
  alone: archify's document is components and connections, and a lifeline with an
  order is neither.
- **The first tab is the setting's, and a type the setting cannot draw falls back
  to the first renderer that can.** The tabs stand in the one order the static
  wiki's own tabs keep (LikeC4, Mermaid, Archify) with the chosen renderer moved to
  the front, so "the first tab follows `MADARCH_WIKI_DIAGRAM`" is literally the
  leftmost button and the open panel — and a sequence is drawn by Mermaid whatever
  the setting says, because a setting is a reader's preference and not a promise
  that one renderer draws everything.
- **An unknown `MADARCH_WIKI_DIAGRAM` is a refusal, not a default.** The diagrams
  route answers 500 naming the value and the three formats, the way the static
  build exits 2 for the same value: a wiki whose first tab nobody can name is a
  wiki somebody configured wrong, and it says so instead of choosing a tab in
  silence.
- **Mermaid draws the box-and-arrow types as a flowchart, and only the types that
  need their own syntax get it.** Mermaid's `erDiagram` carries a table's columns
  as attributes and no dashed style at all, and `stateDiagram-v2` has no dashed
  transition: 0026's bar is that assumptions and unresolved ends are drawn dashed
  in every renderer, so an ER table is a node carrying its columns in its own label
  and a machine is states with arrows named by their events — and a sequence keeps
  Mermaid's own sequence syntax, which is the one that carries a scenario's order
  and draws a dashed arrow as readily as a solid one.
- **The elements' pages and code places survive into every renderer, each the way
  that renderer can carry them.** LikeC4 gets the page as the element's `link` and
  the code place as its `technology` line; archify gets the page as the anchor
  wrapped around the rendered component (`archifyPageLinks`, archify's schema has no
  link field); Mermaid's own `click` directives are disabled at the security level
  the app renders with, so under every tab the page lists the diagram's elements
  with their page links and code places — one list, the same for the three
  renderers, and the reason a reader can reach a code place from a Mermaid tab.
- **LikeC4 draws in a page of its own, and the app frames it.** LikeC4's
  webcomponent renders into a shadow root it owns; inside the app's own React tree
  the element drew an empty instance in Chromium and said nothing, while the same
  bundle in a document of its own is the way the static wiki has always shown it.
  The server therefore serves the document (`GET /api/graph/likec4.html`) and the
  tab frames it — the same generation, drawn the same way, and a page that cannot be
  broken by the app's own load order.
- **A LikeC4 page that draws nothing says so, and names which failure it saw.** The
  page carries a watchdog: eight seconds in, a page whose element holds no drawing
  states it in words — `customElements.get` separates a bundle that never arrived
  from a view that stands empty — instead of leaving an empty frame that reads as a
  diagram nobody could draw, and points the reader at the tabs that do draw the model. This build's Chromium
  draws nothing for any LikeC4 bundle (a hand-written five-element workspace, the
  plain prefix, `browser="false"` and the prefixed one alike), so the acceptance
  records the words and not a picture; the tab stands, the failure is visible, and
  the finding is filed rather than hidden.
- **The two generated documents are kept by the model's own bytes.** The LikeC4
  bundle is generated under the wiki's cache root by the workspace's content hash
  (the pinned `likec4 gen webcomponent`, bounded like every other external tool),
  and the archify page under a folder named the same way; a second ask reads what
  the first wrote, and two diagrams never share a folder. The first reader of a
  diagram pays for its generation — measured on the pod at about twenty seconds for
  a bundle and two for an archify page — and nobody after them does.
- **A tab's panel is mounted only while it is open.** The LikeC4 bundle is some
  megabytes and the archify page is rendered on its first ask, so a reader who never
  opens them pays for neither; the first tab the setting names is the one the page
  opens, which is the one a reader of that preference asked for.
- **The diagrams are read from the product's own facts, as the page model is.** Every read behind a diagram is
  scoped to the product's own rows (`fill_fact_holding` joined onto `fill_unit.product`, the join
  `readPageSet` reads its pages through): a home's store carries every product's facts, and a diagram of one
  product drawn from all of them would draw another product's repositories and call a repository name two
  products share ambiguous.
- **Every address a generated document carries is root-relative.** A products home prefixes an HTML answer
  once when it serves it (`http.ts`, `withProductPrefix`), so the LikeC4 page's script and the archify page's
  element links are written the way the app writes its own addresses, and the prefix lands exactly once.
- **A diagram the graph answers with nothing is words, not a frame.** The model is
  still a model with zero elements (0026 makes an empty graph a fact about the
  product and not a reader's mistake), and the page says the view holds nothing
  instead of drawing an empty box.
- **One project's diagrams are read one at a time, each in its own snapshot
  transaction.** A page's diagrams are two to five models, each built by
  `buildFactStoreDiagram` inside one transaction: an element read before a
  publication is never drawn beside an arrow read after it, and two diagrams of one
  page are two states of the graph that a publication may have moved between.
- **The navigation's short name is derived from the graph's own label, with the
  label kept whole.** The server's label is the node's identity (`repository:path#name`
  for a symbol, `repository:name` for a table); the sidebar shows the part a reader
  says out loud and keeps the identity in the row's `title`, because a sidebar column
  is too narrow for it and a truncated identity is the worst of both.

## Acceptance evidence

Accepted by rendering every diagram type in every renderer that supports it, on the
pod, as AGENTS.md asks of a view (the numbers below are the browser's own).

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch and after every edit round; `wiki/app`'s `bun run check`, `bun test` (207 pass) and `bun run build` exit 0.
- The focused suites, run in SkyPilot: `test/graph-diagrams-render.test.ts` (15 pass) — the Mermaid source of five models, the LikeC4 workspace of every type validated by the pinned `likec4`, the tab order and the setting's refusals, one diagram as the app receives it — and `test/server-graph-pages.test.ts`, `test/fill-diagrams.test.ts`, `test/fill-diagrams-store.test.ts`, `test/wiki-archify.test.ts` beside it.
- The acceptance walk, `test/wiki-graph-diagrams-e2e.test.ts` with `MADARCH_WIKI_E2E=1` on `--avx2`: the production-built app, a real server over a real fill service and its PGlite store, and the diagram facts of `test/fill-diagram-fixture.ts` published through a stage. Two servers, one set to `MADARCH_WIKI_DIAGRAM=mermaid` and one to `archify`, prove the first tab.
  - A repository page (`acme-shop`) draws five diagrams in the order its kind gives them (C4 context, containers, components, module dependencies, data model), each on the tabs its type supports: `["mermaid","likec4","archify"]` for the three C4 levels, `["mermaid","archify"]` for the module and ER views. A state is `["mermaid","archify"]` and a sequence `["mermaid"]` alone.
  - The first tab followed the setting in both servers: `mermaid` first on the first, and `["archify","likec4","mermaid"]` with archify open on the second.
  - The archify pages carry the model's dashes: `GRAPH_DIAGRAM_ARCHIFY_DASHED {"type":"c4-context","dashed":3}`, `c4-container` 1, `c4-component` 7, `module-dependency` 3, `er` 1 (elements drawn with the renderer's dashed class).
  - Measured at the owner's 1150×900 window (`GRAPH_DIAGRAM_MEASURED`, printed by the test):
    - Mermaid: c4-context 765×41 (viewBox 1196×64, 7 labels, smallest 16 px), c4-container 583×398 (6 labels, 16 px), c4-component 765×128 (9 labels, 16 px), module-dependency 765×136 (7 labels, 16 px), er 204×496 (3 labels, 16 px), state 765×95 (10 labels, 16 px), sequence 567×323 (8 labels, 12 px) — **0 overlapping elements in every one**.
    - archify: c4-context 11 labels, c4-container 12, c4-component 14, module-dependency 13, er 9 — smallest 8 px (the renderer's own floor is 7.5 px), **0 overlapping components**.
    - LikeC4: `{"type":"c4-context","svgs":0,"undrawn":"empty"}` and the same for the other two C4 levels — the page's own words, `GRAPH_DIAGRAM_LIKEC4`, naming that the element is defined and its view empty; see the limitation below.
  - Every element opens its page (`/p/graph/<fact id>`) and its place in code (`https://github.com/acme/shop/blob/<commit>/…`) from the element list under any tab, and an arrow of the component view says `assumption` where it folds an import and an interaction.
  - Screenshots (fetched from the pod with `--fetch` into a scratch folder outside the checkout): `diagram-c4-context-mermaid.png`, `diagram-c4-container-mermaid.png`, `diagram-c4-component-mermaid.png`, `diagram-module-dependency-mermaid.png`, `diagram-er-mermaid.png`, `diagram-state-mermaid.png`, `diagram-sequence-mermaid.png`; `diagram-{c4-context,c4-container,c4-component,module-dependency,er}-archify.png`; `diagram-{c4-context,c4-container,c4-component}-likec4.png`; `diagram-table-er-archify.png`; `diagram-c4-context-archify-first.png` — all 1150×900.
- The diagram routes over a stand-in source (`test/server-graph-diagrams.test.ts`): one page's diagrams with the setting's tab first, the page model's own 404 for a node the graph does not hold, a 400 for a missing id, the 500 and the log line for an unknown `MADARCH_WIKI_DIAGRAM`, and the two document routes' own 400s.
- The per-kind rules (`diagramSpecsFor`), the archify document's dashed variant, the ER table's columns beside its place, and the root-relative links of both generated documents (`test/graph-diagrams-render.test.ts`).
- The app's own tests (`wiki/app/src/graph-diagrams.test.tsx`, `graph.test.tsx`): the tabs in the server's order with the first open, a tab the reader opens drawing its renderer and the one it left unmounting, the LikeC4 tab framing the server's page, the element list's pages and places and evidence words under any tab, an empty diagram's words, a failed read's message, and the navigation's short name with the whole label as its tooltip.

### Known limitations

- **LikeC4 draws nothing in this build's Chromium, and the tab says so.** The
  bundle the pinned `likec4` generates loads, defines its element, carries the
  model and the layouted view, and the element's shadow root holds its stylesheet
  and an empty instance: a hand-written five-element workspace, the plain prefix and
  the prefixed one, `browser="false"`, a page of its own and the app's own tree all
  draw nothing. That is filed as its own bug (madarch-pdkl, with the smallest
  reproduction and every variant ruled out), not worked around here; the page says it in words and the other tabs
  draw the same model, so no reader is left with an empty frame.
- **The first reader of a diagram pays for its generation.** The LikeC4 bundle is
  generated on the first ask (measured about twenty seconds on the pod) and the
  archify page's layout and render about two seconds each; both are kept by content
  hash, and a tab nobody opens costs nothing because its panel is not mounted.
- **A page sometimes stands in its loading line under the pod's load.** The
  acceptance walk reloads a page that has not left its loading line after 45
  seconds, and says so in its log; the page then draws. It is the app's page read
  (madarch-tzte.23.3's), not this change's, and it is named here rather than hidden
  in the walk.
- **A sequence's row of steps is the interaction facts' code point order.** The
  graph holds no order between two interactions, so a symbol's page takes the one
  order it can state (0026 makes the order the chooser's, and a symbol has no
  chooser).
- **An ER table's columns are carried where each renderer has a place for them.**
  Mermaid's own ER syntax would draw them as attributes and could not draw an
  assumption dashed, so the Mermaid tab keeps them inside the table's label; the
  LikeC4 workspace gives them the one spare line under the table's name, beside its
  place; archify's document has no field for a column at all (its component carries a
  label, a sublabel, a tag and sources), so the archify tab shows them in the element
  list the page keeps under every tab, each with its own page and place.
- **A diagram is one level of the graph, and a drill-down is its own link.** A
  collapsed element carries the view it stands for (`graphDiagramOf`'s
  `drillDown`), which opens `/p/graph?diagram=…`; that address is the graph's index
  today, so the drill-down link is shown but opens the index rather than the folded
  view. Naming the view's own page is a later task's, as 23.3's record said of its
  own addresses.
- **No `mutation` receipt.** The owner's rule runs Stryker once per assembled stage,
  off the path; acceptance escalates per `mutationFallback: escalate`.
