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
- The existing treemap and neighborhood remain. Oversized diagrams fold at a higher level with drill-down.
- The generated training repository and fixture data are the only test inputs; no test names an outside product repository.

## Acceptance evidence

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

Validation of this follow-up is pending; the historical walk above is not acceptance
of these fixes. The final binary walk is to be recorded in the worker report.
