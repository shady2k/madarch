# A madarch checkout filled by the deterministic stages shows live graph pages with switchable diagrams, without an agent

Change: madarch-tzte.23.5
Base: c36945ae8a37190b69a2f21042196a717e537642
Tasks: madarch-tzte.23.5
Kind: no-behavior

## Intent

Decision 0026, "Pages" and "Diagrams", says a person watches the wiki fill: every
graph node of a page-worthy kind has a live page at once, rendered from the graph
without an agent, and every diagram carries a switcher over the renderers that
support its type. Stage madarch-tzte.23 landed that in four pieces — the server's
page set, page model and live channel (23.1), the diagram models (23.2), the app's
pages (23.3), the renderer switcher (23.4) — and each was accepted on a fixture:
the fill of a handful of hand-written facts, or of the diagram fixture's own set.
Nothing had walked them on a *product an agent never touched*: a madarch checkout
filled by the eight deterministic stages of madarch-tzte.21.8 alone, served, and
opened in a browser. This change is that walk — the stage's own acceptance walk,
its numbers and its screenshots — and the one script that makes the walk repeatable.

- **`scripts/graph-pages-walk.ts`** (new) is the walk. One process holds the fill's
  only writer (decision 0027) and serves the pages those runs publish: it makes a
  product of a shallow clone of madarch at its default branch (a `workspace.yaml`
  committed on top of it, as madarch-tzte.21.8's walk did), runs the eight stages
  through the orchestrator service with the stages wiring, starts the wiki server
  over that same store, and drives headless Chromium at the owner's 1150x900
  window. Phases `first`, `live` and `all`, and a scratch root that keeps the clone,
  the home and the store, so the sixteen-minute fill is paid once.
- **The walk's evidence** — the pages, the diagrams per type and renderer tab, the
  label sizes and the overlaps the browser computed, the render times, and the page
  that appears in the open browser while a second run publishes after a one-file
  commit — is in the "Acceptance evidence" section below, with the screenshots in
  `/home/dev/.cache/madarch-stage23-walk/`.

No product behaviour changes: the script is a walk, it ships in no binary path that
a reader runs, and every route, page and diagram it reads is a landed one.
`scripts/` is product code by the document rules, which is why this record exists.

## Rationale

`no-behavior`: the walk reads what madarch-tzte.23.1 to 23.4 and 23.6 landed and
writes no requirement. The graph pages' own requirement text lands with the change
that closes decision 0026 (as 23.1, 23.2, 23.3 and 23.4 recorded theirs): the fill's
capability `fill-stages` speaks of stages and facts, not of pages, and no current
requirement names a graph page, a diagram type or a renderer switcher. What this
change adds is the one-time check AGENTS.md asks of a view — "recorded in the
acceptance record" — and a script that repeats it.

The parts of the task's DONE WHEN that the walk cannot show as written are named in
the evidence rather than left out: see "What the deterministic fill cannot draw"
below, which is a gap between the bar and the stages' scope and not a defect this
change could fix.

**What the `Coverage` lines mean here.** Each names a requirement this change must not
break and the check that proves it is not broken: `test`, because the landed suites of
those requirements (and, for the walk itself, the walk's own run — AGENTS.md's
"views are accepted by rendering every page the way a reader sees it") are what hold
them. This change adds no test file: the walk is one-time evidence, and the code it
adds is a script no test exercises.

## Out of scope

- **The pages, the diagrams and the app.** 23.1 to 23.4 and 23.6 are theirs; this
  change found no defect in them (the walk's four defects are in the walk's own
  script, below, and in nothing a reader reads differently).
- **The agent stages 8 to 13 of decision 0026.** They are registered nowhere (21.8's
  own record), so no claim, rule, question, state, interaction, table or column fact
  exists on this walk, and the diagrams those kinds make are not drawn here.
- **A second walk on another product.** The script takes `--origin` and `--pin`, so
  a later walk can point at another checkout; nothing here runs one.
- **The store's own limits.** A run interrupted mid-read leaves a write-ahead log the
  next process replays before it answers anything; the walk's evidence says what that
  cost, and neither the store nor the pod is this change's to fix (madarch-tzte.21.11
  and its own record hold that ground).
- **Publishing the walk's screenshots.** They stay outside the repository, in the
  cache folder the coordinator reads, as 23.3's and 23.4's did.

## Preserved contracts

- product-repository/manifest: the walk reads a product's manifest with the landed reader and refuses what it refuses; a clone plus a `workspace.yaml` is a product, and a manifest that does not read stops the walk before a database is opened.
- server/serves-wiki: the walk serves one product's wiki from a product folder, exactly the way a person's `madarch serve` does; the app, its assets and the document pages answer as they did.
- product-wiki/pages: a document page is still the product's Markdown read at every ask; the walk opens one beside the graph's pages, and the graph's pages are added beside it.
- views/deterministic: every diagram the walk draws is the model the filled graph gives, byte for byte, on any machine; the walk reads it and changes nothing.
- release-binary/installers: no dependency is added to the product; the walk uses `puppeteer`, `likec4` and `mermaid`, which are already devDependencies for the wiki app and its acceptance walks.

## Coverage

- product-repository/manifest: test
- server/serves-wiki: test
- product-wiki/pages: test
- views/deterministic: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The product is shaped as `madarch new` and `madarch repo add` leave one.** A
  product repository holding `workspace.yaml` (`name: stage23-product`) and
  `docs/vision.md`, `repos/` untracked, and the code repository `engine` cloned under
  it: that is what a person's product looks like, and it is what makes the walk's
  "elements link to pages and code" true — the app builds a code link from the
  manifest's own repository origin (`codeHref`, 23.3), so a product that declares
  none (21.8's own walk made the checkout the product) shows every place as text.
- **The fill runs in the process that serves the pages.** Decision 0027 makes one
  process the writer of a home's fill database, and a PGlite data directory is
  opened by one process at a time: a `madarch fill-stages` command started while the
  server holds the store is that command's refusal (23.1's own limitation). A walk
  that must see a page appear *while a run publishes* therefore builds what the
  daemon builds when the agent stages land: the stages' wiring (`createStagesFill`),
  the orchestrator service that owns the store, and the server whose `graphPages` is
  that service's own source. So the pages a reader sees are the pages that process
  published, which is the shape 0026's "Updates" asks for.
- **One phase runs the fill and the browser, and the run that publishes is the small
  one.** The first run over a checkout plans hundreds of units; the second, after one
  committed file, plans a handful. The walk runs the first before it opens a browser
  (the pod has 4 GB, and a Chromium beside a fill whose peak 21.11 measured at 1.83 GB
  is a risk with no evidence behind it), then opens the pages, then commits one file
  and drives the second run under the reader's open index.
- **The one-file commit is designed to make both appearances true at once.** It adds
  `src/stage23walk/probe.ts` in a folder of its own: a new directory, a new file, a
  symbol nothing else names, an entry point the syntax stage writes for it (so a
  *symbol* page and an *entry-point* page appear), and an import of `./probe-gone.js`,
  a file no tree holds — exactly the unresolved end 0026 draws dashed. The symbol's
  name carries the moment, so a second walk commits a second symbol rather than
  re-committing the first.
- **The reader sits on the graph's index, and a flag proves it never reloaded.** The
  index is where a page appearing is visible (a kind's group gains a row). Before the
  run the walk sets `window.__stage23Walk`; after the new row is found the flag is
  still there, the evidence 23.3's own acceptance used. The row is found from the live
  channel's own change rows — a change names the pages its publication touched, so the
  walk reads one change at a time instead of the whole page set (2 575 pages here) on
  every turn — and the browser is asked for the row until it shows it.
- **A page the app could not load is opened again.** Under the pod's load the app's
  own document list (`/api/pages`, read on every page load) sometimes misses its
  five-second bound and the app says so in words; the walk opens a page up to three
  times and the record keeps the pages that stood (23.4's record met the same line and
  answered it the same way). A page that never stands is a failure of the walk, not a
  silent gap: it names the address and what the page showed instead.
- **A diagram the graph cannot fill offers no tab, and the walk reads its words.** An
  empty model draws no frame (`src/product-wiki/graph-diagrams.ts` answers `empty:
  true`, the app renders `graph-diagram-empty` and no tab strip), so a type whose tabs
  are none is recorded with the page's own sentence instead of a click nobody can make
  — that is how ER appears on this fill.
- **A file is a place, not a page, and the walk says what a reader gets instead.** The
  brief's list of pages ends with "a file"; the graph's own table gives `file` the role
  `place` (23.1's decision: a page is *about* a node, and a file is where a node
  stands), so the index holds no file, `/p/graph/file:<id>` is the app's refusal in the
  server's words, and the file's place in code is linked from the facts and relations
  of the nodes it holds. The walk opens the refusal and the product's document page
  (`docs/vision.md`) beside the graph's pages.
- **The walk reports numbers, not pictures.** Every measurement is a `STAGE23_WALK`
  JSON line and a key in `report.json`, so the record's figures can be read back
  without the screenshots; the screenshots are for a person. Label sizes and overlaps
  are the browser's own computed values at the owner's window (AGENTS.md's view
  acceptance), and the screenshots are that window, not a full-page capture.
- **`--copy-into` writes only into a folder of the worktree.** The copy replaces the
  folder it names, so a mistyped `--copy-into .` is refused rather than deleting the
  checkout; the screenshots stay outside the repository otherwise.

## Acceptance evidence

### The walk, and why the browser walk is the pinned checkout

Two products stand on this walk's path, and both are madarch checkouts filled by the
eight deterministic stages with no agent:

- **The current tree, filled from scratch.** A product made of a shallow clone of
  `main` at `c36945ae` (1 128 tracked files) with the walk's own `workspace.yaml`
  committed on top: `succeeded`, `settled`, **2 968 units planned and executed in 1 871
  passes in 1 240.5 s (20.7 min)** — inventory 1 684, syntax 463, semantic-resolution
  463, document-index 347, build-configuration 8, snapshot 1, modules 1, history 1 — and
  the graph held **23 kinds and 280 333 facts**: occurrence 115 107, reference 34 145,
  contains 32 458, symbol 29 353, defines 29 353, comment 14 203, call 9 918, section
  6 164, test 3 088, entry-point 2 374, import 1 419, coverage 1 284, file 1 128,
  directory 556, module 293, task-key 222, document 347, document-link 97, inherits 29,
  package 5, commit 2, snapshot 1, repository 1. Its page set is **35 114 pages**:
  symbol 29 353, test 3 088, entry-point 2 374, module 293, package 5, repository 1.
  This run's product declares no code repository (the checkout is the product, as 21.8's
  walk made it), so its pages carry no code links — which is why the browser walk uses a
  product shaped the way `madarch new` leaves one.
- **The product the browser reads.** `stage23-product`: a product repository holding
  `workspace.yaml` and `docs/vision.md`, with its code repository `engine` a shallow
  checkout of `https://github.com/shady2k/madarch.git` at `4f67fc27` (194 tracked files
  — the pin 21.8's own walk used). The fill: `succeeded`, `settled`, **536 units in 412
  passes in 82.4 s** — inventory 396, syntax 49, semantic-resolution 49, document-index
  34, build-configuration 2, modules 2, snapshot 2, history 2 — and the graph held **23
  kinds and 20 102 facts**. **2 575 pages**: symbol 1 986, test 338, entry-point 147,
  module 101, repository 2, package 1; 2 472 of them carry a code place and 2 087 stage
  5's importance. A page set read is one statement: **3.4 s** here, and 3.4-3.8 s on
  every later read of the run.
- **Why the browser is the pinned checkout.** The current tree's store is 1.5 GB on disk
  on this 2 CPU / 4 GB pod, and a run interrupted mid-read leaves a write-ahead log the
  next process replays before it answers anything: the same store's next open spent
  **over twelve minutes** at 100 % CPU before its first statement returned (two probe
  runs, both stopped by hand). 21.11 measured this tree's fill at 1.83 GB peak RSS, so a
  Chromium beside it would put the pod's headroom in doubt and the walk's evidence at its
  mercy. The walk therefore fills and serves in one process on a checkout the pod holds,
  and the current tree's own fill stands above as a run of its own.

### What a reader sees: the index and four node pages

- **The graph's index** (`/p/graph`) stands in **4.7 s** with all **2 575 rows** in six
  kind groups (entry-point 147, module 101, package 1, repository 2, symbol 1 986, test
  338), the lead line naming the product and the count, and 51 node links in the
  sidebar (12 per kind, the navigation's own bound).
- **A repository page** (`engine`, the code repository) stands in **4.9 s**: its fields
  (Kind/Repository, Obtained/extracted, Status/proposed, Repository/engine), **1 fact**,
  **0 assumptions**, **17 relations** (all outgoing, each naming what it joins and
  linking the page of the node at its other end where that node has a page), **2
  coverage records**, 0 open questions, 0 drafts, **2 code links** and **5 diagrams**.
- **A package page** (`engine:madarch`) stands in **4.0 s**: Kind/Package with `In code
  engine · package.json:2`, 1 fact, 1 coverage record, **4 code links** — one of them
  `https://github.com/shady2k/madarch/blob/4f67fc2710807d28f75bab8d77351c8fb7f5bc1b/package.json#L2`
  — and 1 diagram.
- **A module page** (`madarch`, the repository's top module, importance 1) stands in
  **4.7 s**: 1 fact, 17 relations (16 out, 1 in), 1 coverage record, 1 code link and 2
  diagrams.
- **A symbol page** (`engine:src/model/errors.ts#ModelError`) stands in **4.1 s**: 1
  fact with `In code engine · src/model/errors.ts:6-14`, **43 relations** (all
  incoming), 1 coverage record, **45 code links** (one of them
  `https://github.com/shady2k/madarch/blob/4f67fc2710807d28f75bab8d77351c8fb7f5bc1b/src/model/errors.ts#L6-L14`),
  0 drafts, and no diagram — the page says so in its own words ("no diagram of this
  node's kind is drawn from the graph yet"), which is what a symbol's page holds on a
  fill with no `interaction` fact.

### The diagrams, type by type and tab by tab

The repository page draws five diagrams in the order its kind gives them
(`["c4-context","c4-container","c4-component","module-dependency","er"]`), and each is
rendered in every tab its type supports, `MADARCH_WIKI_DIAGRAM` deciding the first:

| diagram | tabs (first = the setting's) | Mermaid | archify | LikeC4 |
| --- | --- | --- | --- | --- |
| c4-context | `mermaid`, `likec4`, `archify` (first `mermaid`) | 2 nodes, 180×128, 2 labels at 16 px, 0 overlaps, 472 ms | 2 nodes, 698×1063, 7 labels at 8 px, 0 overlaps, 1 007 ms | the page's own words, `data-likec4-undrawn="empty"` |
| c4-container | `mermaid`, `likec4`, `archify` (first `mermaid`) | 1 node, 168×64, 16 px, 0 overlaps, 15 ms | 1 node, 698×481, 5 labels at 8 px, 0 overlaps, 27 ms | the page's own words |
| c4-component | `mermaid`, `likec4`, `archify` (first `mermaid`) | 1 node, 166×70, 16 px, 0 overlaps, 14 ms | 1 node, 698×481, 5 labels at 8 px, 0 overlaps, 43 ms | the page's own words |
| module-dependency | `mermaid`, `archify` (first `mermaid`) | 1 node, 166×70, 16 px, 0 overlaps, 14 ms | 1 node, 698×481, 5 labels at 8 px, 0 overlaps, 15 ms | — (the type offers none) |
| er | **none** | — | — | — |

- **The first tab follows the setting.** On the server whose setting is `mermaid` every
  diagram's first tab is Mermaid and Mermaid is the open panel; the same page on the
  servers set to `archify` and to `likec4` puts that renderer first (the walk opens all
  three servers over one store, so the setting is the only difference).
- **ER has no tab and says why**: "The graph holds nothing this view shows: no element
  of this diagram stands in the graph yet." (`diagram-er-empty.png`).
- **The module diagrams collapse.** The engine repository's 101 modules are folded to
  the level above by the model's own node budget (`DEFAULT_DIAGRAM_NODE_BUDGET`, 40), so
  the module-dependency view draws one element, `madarch` — 0026's "collapses to the
  level above with drill-down", not a missing module.
- **Every element carries its page and says how it stands.** The element rows under
  every tab are one list: `engine` and `stage23-product` for the context (each linking
  its page, evidence `fact`, `data-dashed="false"`), `engine:madarch` for the container,
  `madarch` for the component and the module view.
- **LikeC4's three tabs stand, and their page's own word is `empty`.** The bundle is
  generated on the first ask (37.5 s for the context view, 20.1 s and 20.1 s for the
  next two, each kept by content hash) and the page reports
  `data-likec4-undrawn="empty"` after the walk had waited twenty seconds past the page's
  eight-second sentence. Its composed tree does carry the model's labels (`engine`,
  `stage23-product`, `engine:madarch`, `engine · package.json:2-2`, `madarch`), so what
  is missing is the drawing the page's watchdog counts, not the model. **This is a
  finding for the LikeC4 page's owner, not this change's**: on these small views the
  page says "the view is empty" while its boxes stand
  (`src/product-wiki/likec4-watch.ts`, `data-likec4-undrawn`); the Mermaid and archify
  tabs draw the same models and the numbers above are theirs. A model without image
  reading took this walk's screenshots, so the sentence and the label text are the
  evidence; the coordinator reads the picture.

### A page appearing in the open browser while a run publishes

The reader sits on the graph's index (2 575 rows) with `window.__stage23Walk` set; the
walk commits one file to the code repository — `src/stage23walk/probe.ts`, a new folder
with a symbol and an import of `./probe-gone.js`, which no tree holds — and drives the
second run in the same process:

- the run planned **8 units, 5 of them inherited**, ran 4 passes and published in
  **12.0 s** (`stoppedBecause: "a pass and its claims together changed nothing"`);
- the walk's own read of the live channel saw the new page **7.7 s** after the run began,
  and the reader's index showed its row **11.8 s** after it — **no reload**: the flag was
  still there when the row was found (`flagSurvived: true`);
- the index grew from **2 575 to 2 577 rows** and gained **two pages**: the symbol
  `engine:src/stage23walk/probe.ts#stage23WalkProbe20261020002109` and its entry point;
- the new symbol's page then stood in **4.0 s** with its fact (`In code engine ·
  src/stage23walk/probe.ts:5-7`), 1 relation, 0 assumptions and 4 code links, one of
  them `.../blob/bb6930b73aea3be3ffc920bbb85dcf7e20955b78/src/stage23walk/probe.ts#L5-L7`.

### What the deterministic fill cannot draw, and what the walk shows instead

The task's DONE WHEN names five diagram types on these pages. The eight deterministic
stages publish no fact that three of them are made of, so the walk records their absence
with the reason rather than a picture:

- **ER** stands on a repository page as a spec (`src/fill/graph-diagrams.ts:58`) and
  draws the repository's `table` facts (`src/fill/diagrams.ts`, `gatherTables`). No stage
  writes `table` or `column`: the only declared writer is the agent unit
  (`src/fill/stages/agent-unit.ts:114`), and a stage may not write a kind it does not
  declare (`src/fill/stages/draft.ts`). The model is therefore empty and the page says so
  in its own words, with no tab to switch.
- **state** is given to a `state` node only (`src/fill/graph-diagrams.ts:72-73`), and no
  stage writes a `state` or a `transition` fact, so no page holds the type.
- **sequence** is added to a symbol's page only when the graph holds `interaction` edges
  naming it (`src/fill/graph-diagrams.ts:145-148`), and no stage writes `interaction`.
- **Assumptions dashed.** Every fact a deterministic stage publishes is `extracted`; an
  assumption is an `inferred` fact (`src/fill/graph-pages.ts:551-553`), and this fill has
  none — the walk counts 0 assumption rows on every page it opens. The other half of
  0026's rule, the *unresolved* end drawn dashed, is the model's (`data-dashed` on the
  element and edge rows) and is 23.4's and 23.6's evidence; on this product the walk's
  one unresolved import stays inside the module the repository view collapses to, so no
  dashed line stands on these pages.
- **A file's page.** `file` is a `place` in the registry's own table
  (`src/fill/facts.ts:2666`), so a file has no page and the index holds none; the walk
  opens what a reader gets instead: the app's refusal in the server's words at
  `/p/graph/file:<id>` ("This page stands nowhere… a "file" fact, and no page exists for
  that kind"), the product's own document page (`docs/vision.md`, "Stage 23 product", in
  3.5 s beside the graph's navigation) and the file's place in code linked from the facts
  and relations of the nodes it holds, as the package and symbol rows above show.

These are gaps between the task's bar and the stages' scope, not defects of the pages:
23.2 and 23.4 accepted ER, state and sequence by rendering them from a fixture whose
facts an agent would have written, and this walk is the one that shows what a product
*without* an agent has.

### What the walk found in itself, and fixed

- **A diagram the graph cannot fill has no tab to click.** The first walk waited for the
  ER diagram's Mermaid panel: an empty model draws no frame and no tab strip, so the walk
  would have waited for ever. It now reads a diagram's tabs first and records the page's
  own sentence for a type that offers none.
- **A page load can lose the app's own document list.** `/api/pages` is read on every page
  load under a five-second bound (23.3's app); under the pod's load it misses it and the
  app shows "Could not read the page list: the request to `/api/pages` timed out after
  5000 ms" — seen here on the file-refusal page (two attempts, 66.7 s wall) and on an
  earlier run's repository page, whose second attempt stood. The walk opens a page up to
  three times (23.4's acceptance walk met the same line and answered it the same way) and
  reports the attempt that stood.
- **A second run of one product cannot start while an earlier one is still recorded
  running.** A walk that stopped a run before it settled left the product's chain active
  and the next run was refused `fill-orchestrator/chain-active`, naming the earlier run;
  the walk therefore runs each walk's fill and browser in one process and one root.
- **The store's write-ahead log, not the page set, is the slow thing.** `EXPLAIN ANALYZE`
  of the page set's own statement over the current tree's store (281 547 holdings, 35 114
  rows) ran in 3.0 s, while the first statement after an interrupted run's open waited
  over twelve minutes — the numbers behind the pinned browser walk.

### The checks

- `bun run check` (`tsc --noEmit`): this change touches no file under `src` or `test`;
  the walk's script is under `scripts/`, which `tsconfig.json` does not include, so it is
  checked by bundling it for the pod's runtime (`bun build
  scripts/graph-pages-walk.ts --target bun`, which resolves and parses every import) and
  by running it.
- The feature document gate for this change: clean (`node .shady2k/documents.mjs check
  --phase feature --change madarch-tzte.23.5 --candidate worktree --target origin/main`).
- The walk itself on the pod (SkyPilot, `--avx2`, 2 CPU / 4 GB): **exit 0 in 455 s**, all
  phases in one process, 23 screenshots and `report.json` fetched out of it.
- The landed suites the walk reads through, on the same pod; CI on the exact SHA. Both
  are named in the queue entry with their own exit statuses.

## DONE WHEN

On a madarch checkout filled by the deterministic stages, the wiki shows a live page
for every page-worthy node and a page appears in an open browser while the run
publishes, without an agent; C4, module dependencies, ER, state and sequence
diagrams render on those pages under the switcher, first tab per
`MADARCH_WIKI_DIAGRAM`, facts solid, assumptions dashed, elements linking to pages
and code; and it is recorded as the stage's acceptance walk with the screenshots'
numbers.
