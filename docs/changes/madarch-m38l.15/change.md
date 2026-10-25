# Diagrams on the product pages, with renderer switchers and drill-down

Change: madarch-m38l.15
Base: 2e0848bd86848f1a85e0651b2de0b5ad15b65118
Tasks: madarch-m38l.15
Kind: behavior

## Intent

A reader of the product wiki needs diagrams that follow the code graph and can be explored, rather than static boxes that hide the system's connections. This change replaces the old chain and system diagrams with graph-checked views rendered by LikeC4, Mermaid and archify. It adds the domain context map and domain page views, C4 context/container/component and deployment views, sequences, ER and state diagrams, renderer choice, links and drill-down, and full-screen controls with zoom.

## Out of scope

- Editing product model facts from a diagram.
- Treating a guessed relationship as a graph fact. Assumptions stay dashed and are explained.
- Replacing the existing neighborhood and treemap views.
- Adding product-specific content to the madarch engine or fixtures that depend on an outside checkout.

## Rationale

The former diagrams did not follow decision 0026 and did not provide the requested interactive renderer set. The server now validates view specifications against the graph and shapes the views; the wiki renders the returned diagrams. User additions to madarch-m38l.15 require a domain map/list and domain detail, C4 home and service views, and full-screen interaction on every diagram. English and Russian catalogues carry all app-owned text.

## Changes to requirements

- product-wiki/diagrams: replace the diagrams requirement with the complete proposed text in `capabilities/product-wiki.md`.

## Preserved contracts

- product-wiki/pages: diagram routes remain page/entity routes; existing pages are preserved.
- product-wiki/live: views are derived from the current graph and do not alter source data.

## Coverage

- product-wiki/diagrams: test, browser-walk
- product-wiki/pages: test
- product-wiki/live: test

## Where it is seen

Kind: screen
Place: the product wiki home, domain list and domain pages, and service, route, database and state-machine pages
Mockup: docs/prototypes/madarch-m38l.15/domain-diagrams.html

1. A reader opens a product home to see its C4 context and container views, switches renderers, and opens a service's component view.
2. A reader follows the domain map, then opens a domain to see its services, data, neighboring domains and named use cases.
3. A reader opens a route, database or source file to explore its sequence, ER or state view, and can expand any diagram to full screen, zoom, and follow links.

## Blocking questions

None.

## Design and decisions

- Diagram specifications are checked against the graph before rendering. The graph supplies facts; assumptions and unordered sequence steps are dashed and have a reason.
- View types include C4 context/container/component, domain map/domain, sequence, ER, state and deployment. The product's `diagram:` choice takes precedence over `MADARCH_WIKI_DIAGRAM`; LikeC4 is the default and a renderer unavailable for a type is not offered.
- Mermaid source is rendered in the app. LikeC4 and archify frames are generated from the same view model. Elements link to wiki pages and code locations; drill-down and up links keep the reader in the view.
- The existing treemap and neighborhood remain. Oversized diagrams fold at a real higher ownership level with drill-down. When that cannot keep a picture within forty elements, it shows the first forty with truthful counts and a working link to the adjacent list of all raw members and relationships; no synthetic owner is created.
- Coordinator decisions, 2026-10-25T00:47:08Z: database/table ER views offer only Mermaid `erDiagram`. All columns, PK/FK combinations, parallel foreign keys and their column labels remain. Table links are under the picture. No Archify/LikeC4 ER or vendored renderer change is included.
- Coordinator decision, 2026-10-25T04:30:05Z: at desktop widths (1150 px and wider), fullscreen shows the whole visible diagram with node titles at least 9 px. If the actual diagram is too dense, visible paged expansion with truthful "+N more" per group keeps the shown part within that overview; no node-title floor is lowered. At phone width (390 px), fullscreen may remain a top-left reading window at 9 px, with pan/zoom, a visible continuation hint and the complete adjacent member/fact list. Phone whole-fit is not required. Other first-view, no-cut, exact-plan and renderer guards remain unchanged. Desktop fit of the current fixtures is not measured yet; no speculative paging/layout change is claimed as implemented.
- The generated training repository and fixture data are the only test inputs; no test names an outside product repository.

## Acceptance evidence

SOURCE-ONLY UNVERIFIED checkpoint, 2026-10-25: all runtime evidence below predates
the current source repairs and is historical, not acceptance of this candidate.
The original final walk stopped at its recorded 1500-second bound with 2980 JSON
observations, 1490 IDs and 524 PNGs, without final measures. That failed evidence
is retained. Fresh native checks, mutation, complete matrix and coordinator visual
inspection remain required. The source checkpoint does not reduce review-5 floors
or claim any new runtime pass.

Checks. `bun run check` (root) and `bun run check` in `wiki/app` pass on c682bdef; `node .shady2k/documents.mjs check --phase feature --change madarch-m38l.15 --candidate worktree --target origin/main` passes. GitHub CI on c682bdef is green: the `checks` job (the app's own install, type check, its 168 tests in 12 files and its build, plus the postgres legs, `views:check` and `contract:check`) and all five test shards. The app suite on an AVX2 pod ran 167 of 168 in one process; the one failure (`the agent stage > a stage that ended with a failure says so and offers to try again`, added by #159) passes alone (36 of 36 in its file) and in CI, and failed only under the pod's load — it is main's test and this change does not touch the fill card.

The compiled binary (the owner's only way to run madarch). `bun scripts/build-binary.ts --version 0.0.1` on an AVX2 pod, from a tree holding this change: the wiki app is built there (`vite build` then `bun scripts/build-wiki-archify.ts`), the vendored archify renderer is bundled into `wiki/app/dist/archify` (3.4 MB of the 14 MB dist), and the binary is 129 381 856 bytes with the smoke's `graph-store smoke ok`. The walk below ran against that binary's own server and its embedded app: no checkout and no Node.js beside it.

The browser defect this walk found, and its fix. The first walk against the binary showed every page dying at first paint: `(0, Ltt.createRequire) is not a function`. LikeC4's model entry begins with its rolldown runtime, which calls `createRequire(import.meta.url)` from `node:module`, and a browser build has no such module. `wiki/app/vite.config.ts` now aliases `node:module` to `wiki/app/src/shims/node-module.ts`, which lets the call stand and refuses a module load with a sentence naming the file, and the walk after that fix reported no page error at all.

The acceptance walk (scripts/diagram-shots.ts, `--binary`). Ten pages of a filled training product — the product home, the domain list, a domain, two routes, two services, a file, a function, a table and a database — at 1150 px and 390 px, light and dark, and every view of each page under every renderer that draws it. 144 pictures and `measures.json` beside them: 100 views measured, **no overlapping labels in any of them**, and the context, container, component, domain-map, domain, sequence, ER, state and deployment views all drew from the binary's server. Twelve of the pictures — the home page's context view in both themes, the domain map, the domain view, the service's component view under LikeC4 and archify, the ER view, and the 390 px pages — are committed under `docs/prototypes/madarch-m38l.15/shots/`; the whole walk (144 pictures and `measures.json`) stayed in the scratch folder `/home/dev/.cache/m38l15-shots/diagram-shots3`, whose every path the worker's report lists. The walk captured the home page's context view and not its container or the deployment view: the block holds them (test/knowledge-diagrams.test.ts:201-223 asserts both on the home page, and the app's switcher test asserts the tabs), and the walker's tab stepping did not reach the second tab, so their pictures are a gap in the evidence and not in the feature.

Two readings of the numbers are the walker's, not the app's: the 20 LikeC4 entries carry `drawn: false` because that build of the walker still waited for an `iframe[data-renderer=likec4]`, while the same entries measured 13-63 labels — the LikeC4 tab draws in the page now, and the walker in this change waits for the element nodes instead; and 4 Mermaid entries report `texts: 0` with their `svg` present, only in one theme each.

Limits. The model that ran this session has no vision, so the pictures were read through the walker's own numbers (label size, overlaps, drawn flags) and a blank-page scan of every PNG, not by eye at 1150 px and 390 px; that eye review is still owed by whoever accepts the change. Dense views fit to the frame rather than keep a 12 px floor: the payments and orders component views measure 2-3 px labels at 390 px (and 3 px at 1150 px), and the domain view 1.5-3.7 px, so a reader must open full screen and zoom — which the full-screen control and the pan/zoom frame now allow on every type. Folding applies at forty elements, so a dense view stays dense; a floor that scrolls instead of shrinking is the next step if the owner reads it as one.

## DONE WHEN

The product home shows the C4 context and container diagrams with a renderer switcher; service pages show component views; domain list and domain pages show the requested map and details; sequence, ER, state and deployment views work from the graph; assumptions are visibly dashed with reasons; links and drill-down work; and every diagram can be expanded full-screen with working zoom and links. The English and Russian interface catalogues match, and the reader-facing diagrams have been inspected at 1150 px and 390 px in light and dark themes.

### Binary follow-up after coordinator review 4

The served app hash matched the fresh pod dist (`index-2uLxE74X.js`, SHA256
`848a62112dcbfbf85e5554ba56e37d175a247cba7f427711901654af775f17b3`) and contained the
old `.86` floor. Staleness was ruled out for that binary. Release builds now rebuild
the app unconditionally and log the embedded index hash so the proof is repeatable.

The real archify route failed with `Module not found /$bunfs/root/wiki-app/dist/archify/vendor/archify/renderers/architecture/render-architecture.mjs`.
A `BUN_BE_BUN` child cannot read its parent's embedded filesystem. The parent now
copies the complete renderer tree into a private temporary directory for that child
and removes it in a finally block. The regression compiles and runs an embedded
asset, rather than substituting an ordinary disk folder. The release smoke also
fills a one-service repository through the built server, requests the archify frame,
and requires an SVG in the response.

LikeC4 passed the floor to React Flow but not to its internal controller, which fitted
again at its default minimum. The view now uses the typed `ReactLikeC4` API and sets
the controller's floor before fitting after initialization. Zoom 1 preserves its
smallest 12 px labels; full-screen entry remounts the view in its new frame. The
1080 px minimum frame width is removed, so centering uses the reader's real column.

The embedded materialization uses explicit reads and writes: native `copyfile` cannot
read Bun's virtual files, as the release CI smoke proved. The parent retains the
full renderer tree, and the compiled regression checks the output outside the checkout.

An early browser probe of the binary found archify's own page fitting labels down to
3.52 px despite the natural-size CSS. The frame now computes a scale from its SVG
viewBox and smallest label, takes the larger of screen-fit and a 12 px floor, and
centres its scroll position. It repeats the calculation on full-screen resize. The
binary probe now measures 12 px for archify and zoom 1 for LikeC4 in the 792 px reader
column. The walker waits for the archify SVG, not only an iframe, and measures the
frame within the correct block rather than guessing its sibling index.

The cross-platform release smoke also exposed archify's inappropriate use of the
install cache: Windows has no POSIX mode bits to satisfy that cache's checks. Derived
view HTML now uses a private, randomly named per-process temporary folder, removed
on normal exit. The install cache's ownership and mode checks are unchanged.

The merged localized-sources tree passes the root and app type checks, the compiled
archify regression and a fresh binary build/server-route SVG smoke (each exit 0).
The final binary walk and CI for the final pushed head remain pending; the historical
walk above is not acceptance of these fixes. Their result belongs in the worker report.

### Coordinator review 5 supersedes the earlier numerical acceptance

The e walk is rejected: its all-text 12px floor enlarged boxes until the first frame
showed only a crop, often without names. Acceptance now measures node titles only:
11px in the page, 9px in full screen. The whole diagram is the first view whenever
that title floor permits it; otherwise the reading viewport starts at top-left content,
with at least two complete titles and a scroll/zoom hint. Full screen recomputes the
fit as an overview. A title may not straddle a frame edge. Mermaid bounds include
every drawn primitive so a long edge label is not lost outside the root viewBox.
The f walk records whole-fit, actual scale, smallest title pixels, fully visible
title names and cut titles/edge labels for both normal and full-screen observations.
The coordinator's 2026-10-25T04:30:05Z clarification supersedes the unconditional
fullscreen whole-fit rule only at phone width: 390 px can use the readable top-left
9 px window, with measured continuation hint, pan/zoom and a complete adjacent list.
The 1150 px fullscreen whole-overview guard remains strict. The walker and pure
first-view fixtures now distinguish those contracts in source; runtime verification
is pending. Validation of these revised rules is pending; the earlier e numbers
do not accept them.


### Independent source review follow-up (pending verification)

Nine source findings on frozen `af921eab` are being repaired in the existing scope.
First-view search must retain the earliest content node; an impossible reading window
is an explicit bilingual limitation, never a later cluster counted as the beginning.
Domain-map ownership stays grouped. ER columns and incoming/outgoing truncation counts
survive renderer conversion. Renderer failures keep HTTP 500, their escaped diagnostic,
and an explicit fallback reason. Asynchronous model reads clear stale layout and show
network/JSON errors. Literal examples cannot create executable state-machine facts.
Embedded archify exposes its touch zoom controls. The next walk atomically checkpoints
each observation and records JSON, page, renderer and measurement failures in a manifest;
any such failure makes its final exit nonzero. The authenticated archify message listener
binds during the DOM commit, before an immediately responding iframe can report its
failure. Its regression rejects both a wrong source and a wrong origin before requiring
the selected iframe's full diagnostic to remain visible after fallback. The failed
passive-effect version is retained in the retry log; runtime confirmation of this
commit-time repair is pending. No runtime, visual or final-head acceptance of these
edits has been recorded. The earlier f walk and evidence remain frozen.

### Fixed acceptance pipeline (source implementation, not yet run)

`python3 scripts/diagram-acceptance-launch.py` (host lease-only launcher) and
`scripts/diagram-acceptance.py --out <new scratch folder> --deadline <absolute Unix time>` (pod) is one stop-first-failure
pipeline with an owner-approved 5400-second overall ceiling, including remote readiness and cleanup when invoked
through the native run ledger. Owner 2026-10-25T07:39:10Z grants a task-owned
2 CPU / 8 GB AVX2 pod and a 2700-second combined JSON/matrix evidence allowance.
The full test suite runs in CI; only focused tests run on the pod. It runs root/app checks, focused UI/backend and filled
render tests, app build and fresh binary smoke/provenance, scoped Stryker 9 with
TypeScript 5 under 600 seconds, then the concrete walker phases. Each command keeps
its own exit, elapsed time and full raw log. No skipped stage counts as a pass.

The walker prepares and fills once. It freezes exact entity IDs in both languages
and each page/block/view-query/renderer/normal/fullscreen screenshot identity before
acceptance shots. The eight fixed matrices cover en/ru, light/dark and 1150/390 for
all eleven training pages. Three explicitly named synthetic pages additionally render
64 ER columns (combined PK/FK and parallel column labels), 45 roots and 45 children
through real view builders and the app. They replace no training page. Their JSON
payloads and source-generated LikeC4/Archify fixture frames are frozen in the immutable plan; those three explicit synthetic cases intercept only their own page/frame requests. The eleven training pages still use the compiled binary's unmodified routes. An exact-set aggregator rejects missing,
duplicate or unplanned identities, incomplete cleanup, changed inputs or failed strict
numeric guards. The coordinator must still inspect the complete fetched picture tree.

The stopped graph snapshot is restored before each phase at its original absolute
store path and compared file-by-file before the daemon starts. No phase regenerates
the repository or calls fill/reset. This allows PGlite physical read housekeeping
without mistaking a hash of an unused backup for proof of the served graph. Role
settings are seeded before initial server startup. Failed attempts remain separate.
The original 1500-second walk timeout and its 524 partial pictures remain FAILED;
this fixed phase implementation is new source, not evidence that it completed.


### Successor runtime diagnosis and harness evidence limits

The 2026-10-25 queued run passed root/app type checks and the focused app tests,
then failed `test/graph-diagrams-render.test.ts:102`: its factual ER fixture
contains tables and columns, but no foreign-key relationship. The test wrongly
required `factual.edges[0]`. The repair keeps the native no-relation case, supplies
an explicit renderer-level relationship between the two held tables with its FK
column metadata, checks the solid native ER label/endpoints/columns, and retains
the dashed-assumption refusal. No FK fact is fabricated in the product fill or
shared graph fixture. Fresh verification is pending.

The acceptance harness now freezes adjacent-list identities from original API
payloads and compares actual member/sequence rows, not counts alone. It compares
the visible reading hint to the exact English or Russian catalogue text. After
baseline pictures it exercises actual zoom controls and a pan gesture and records
scale/position before and after, with bounded readiness predicates. These checks
are source changes pending verification, not claims of working interaction.


### Shared historical-file reader repair (integration note)

The full JSON walk on `01930351` stopped at
`code.file:services/orders/src/order.go`: the filled graph explicitly relates
that historical path to `code.file:services/orders/internal/domain/order.go`
through `code.renamed-to`, while the old path has no bytes at the filled tip.
The retained response `walk/json/pages/00864-en.json` records that exact edge.

Under coordinator authorization, this task ports only the `sourceBlock` missing
file branch from graph task commit
`9194a67acea12b3c4f324e5f2e008917c64bc496`. It is byte-identical to that branch:
only a same-scope `code.file` successor reached by an explicit outgoing
`code.renamed-to` edge and readable at the filled revision is listed. The
bilingual sentence explains that the original path is absent. It never presents
the successor's bytes as the old file. No edge, another scope or an unreadable
successor preserves the original located problem. The regression copies that
positive case and all three negatives. No seed, extractor, ER or rebuild change
is imported. Integrating the graph and diagram PRs must retain this identical
shared branch once, not create a second behavior.

The same failed run also found that the walker passed `--port` to `madarch stop`,
whose contract accepts only `--home`. The walker now supplies the port only to
`start`; cleanup remains required. The failure, partial JSON and later NOTRUN
matrix/mutation evidence remain retained, not accepted as a complete walk.
