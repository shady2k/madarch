# The LikeC4 tab draws its view, and its page no longer calls a drawing empty

Change: madarch-pdkl
Base: a2edc7de06349608349911f88f23ea34c10bf798
Tasks: madarch-pdkl
Kind: no-behavior

## Intent

madarch-pdkl reported that the pinned `likec4` webcomponent draws nothing in
Chromium, for any bundle, and that the graph pages' LikeC4 tab therefore shows a
page saying in words that LikeC4 drew nothing (madarch-tzte.23.4's acceptance
recorded `GRAPH_DIAGRAM_LIKEC4 {"type":"c4-context","svgs":0,"undrawn":true}`).
The coordinator read the tab's own screenshot and saw blue C4 boxes drawn in it,
which contradicted that record. This change settles which of the two is true, on
the pod, with the bug's own smallest reproduction, and fixes what is really broken.

The answer: **LikeC4 draws.** The measurement was empty, not the renderer. Measured
on the pod in the pinned Chromium, with the bug's own five-line workspace
(`likec4 gen webcomponent` over `a = softwareSystem "Shop"`, `b = softwareSystem
"We"`, one `a -> b`, one view):

- `PROBE round 1 {"rf":{"nodes":3,...},"walk":{"svgs":1,...},"defined":true,
  "outerSvgs":0,"undrawn":null}` — the element is defined, its **own** shadow root
  holds **0** svgs (exactly the figure the bug recorded), and **1** svg sits one
  level deeper.
- The screenshot of that page carries 92 487 pixels of the C4 blue `#3B82F6`
  beside white: the two systems and their arrow are drawn, within 3 s of the page's
  load, with no console error and no page error.

The cause is LikeC4's own composition: its webcomponent attaches a shadow root of
its own (the element the bundle defines, named after the generation prefix), and
inside it its React tree renders a `div` that attaches a **second**, nested shadow
root (`ShadowRootHost`, `likec4/react`) — the drawing is in that one. `element.shadowRoot.querySelector('svg')` can never find it, so both
places that asked the question answered "nothing drawn": the page's watchdog, which
then wrote a sentence over a drawn diagram, and the acceptance walk, which recorded
`svgs: 0` and accepted the sentence as the outcome.

What changes:

- **`src/product-wiki/likec4-drawings.ts`** (new) holds the one answer to "what did
  LikeC4 draw": a function expression that walks the element's whole composed tree —
  its own open shadow root and every shadow root inside it, at any depth — and
  answers with the svgs it finds.
- **`src/product-wiki/graph-render.ts`** inlines that source into the LikeC4 page and
  asks it, so the watchdog speaks only for a browser where LikeC4 really drew
  nothing, and keeps naming which failure it saw (`not-loaded` when the bundle never
  arrived, `empty` when the element is defined and holds no drawing).
- **`test/wiki-graph-diagrams-e2e.test.ts`** measures the LikeC4 page with the same
  bytes and now *requires* the drawing: no `data-likec4-undrawn` marker, at least one
  drawing, and the labels the composed tree shows. It also reads the drawing's labels
  as text, because LikeC4 draws its element boxes as HTML over an svg of the arrows —
  a count of svgs and `svg text` alone reads a diagram of boxes as empty.
- **`test/graph-diagrams-render.test.ts`** covers the probe against a stand-in DOM in
  LikeC4's own shape (a shadow root inside a shadow root), so a regression to
  `element.shadowRoot` fails without a browser.

## Rationale

`no-behavior`: no requirement changes. Decision 0026's "an agent only chooses what to
show … every diagram carries a switcher over every renderer that supports its type"
and `product-wiki/architecture`'s "one page per view with its diagram drawn in the
browser" already require the drawing; what was wrong was the detection of it, in the
code that reported it and in the walk that accepted the report. The tab set, the
page design, the models and the routes are untouched.

## Out of scope

- **The LikeC4 page's own design.** The tab keeps framing a document of the server's
  over the generated bundle: the bundle is a script that defines the element, and a
  page is what the static wiki ships too. How the element composes its shadow roots
  is LikeC4's own business.
- **madarch-tzte.23.4's record.** A change record is history and is not edited: its
  `svgs: 0` figure and its limitation stand as what that walk measured; this change
  says what the measurement was.
- **The archify and Mermaid tabs.** They drew, and their measurement is unchanged
  except that the archify frame's "has it drawn" count now goes through the same
  composed-tree walk.
- **The `mutation` receipt.** The owner runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.

## Preserved contracts

- product-wiki/architecture: unchanged — the Architecture section's own views keep their Mermaid and LikeC4 panels, and a view's page still draws its diagram in the browser; only how the LikeC4 page checks its own drawing moved.
- server/serves-wiki: unchanged — `GET /api/graph/likec4.js` and `GET /api/graph/likec4.html` answer as before, under a products home's prefix like every other app address.
- product-wiki/internationalization: unchanged — the page's words are the server's own (not app-owned strings, no catalogue), exactly as before; no new app string is added.

## Coverage

- product-wiki/architecture: test
- server/serves-wiki: test
- product-wiki/internationalization: test

## Blocking questions

None.

## Design and decisions

- **One probe, two callers.** The question "did LikeC4 draw?" was asked twice — by
  the page's watchdog and by the acceptance walk — and answered wrongly twice, in two
  separate places. It is now one exported source string that both run, so the walk
  measures exactly what the page decides on; the walk reads a name off the drawing
  for madarch-tzte.23.6 through the same composed tree.
- **The walk counts drawings and reads labels.** LikeC4 renders with react-flow: the
  arrows are one svg element, the element boxes are HTML (measured: `rf.nodes: 3` with
  the texts `Shop` and `Web`, one svg holding 3 `g` and 4 `path`). A page that counted
  `svg text` would call a diagram of boxes empty, so the walk's labels are the text of
  the composed tree's leaves.
- **The watchdog stays.** A browser where the bundle never loads, or where the element
  stays empty, still says so in words rather than showing an empty frame; only the
  question it asks changed.
- **The tab keeps a document of its own.** Why the app frames a page is unchanged and
  is not what madarch-pdkl measured: the bundle is a script that defines the element,
  and the page is the way the static wiki already shows it.

## Acceptance evidence

Rendered on the pod (`MADARCH_WIKI_E2E=1` over the production-built app, a real server
over a real fill service and its PGlite store), read as numbers the browser computed:

- The bug's smallest reproduction, on the pod: `outerSvgs: 0` in the element's own
  shadow root and `walk.svgs: 1` one level deeper, the element defined, no console
  error, drawn within 3 s; screenshot
  `madarch-diagram-shots-2/probe-out/likec4-smallest-reproduction.png` (92 487 C4-blue
  pixels).
- `GRAPH_DIAGRAM_LIKEC4` for the three C4 levels of the fixture's repository page:
  a drawing found, `undrawn: null`, and the labels the drawing shows — see the run's
  log and the report.
- Screenshots of the three LikeC4 tabs (`diagram-{c4-context,c4-container,c4-component}-likec4.png`)
  fetched from the pod into `/home/dev/.cache/madarch-diagram-shots-2/`.
