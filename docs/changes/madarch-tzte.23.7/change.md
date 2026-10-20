# A repository page draws its modules at the level that has structure, a module page its children and its neighbours, and every diagram on a page draws when the reader reaches it

Change: madarch-tzte.23.7
Base: aa19c35b4ca81c71a1fd1d140e9d809f510c3585
Tasks: madarch-tzte.23.7
Kind: no-behavior

## Intent

Defect against stage madarch-tzte.23, seen by the coordinator in madarch-tzte.23.5's
acceptance screenshots (2026-10-20,
`/home/dev/.cache/madarch-stage23-walk/.walk23-5/shots/`). On a real repository filled
by the deterministic stages (`engine`, a checkout of madarch at `4f67fc27`, 194 files,
101 modules published by stage 5) the repository page's "Module dependencies" and "C4
components" diagrams drew **one element, `madarch`**, and nothing under it: a reader
learned nothing about the code's structure. Below the first diagram, the Mermaid frames
of the further diagrams stood empty.

Two causes, both in how a page is drawn rather than in what the graph holds:

- **Stage 5 seeds its tree with the packages, and a repository of one package is one
  top-level module.** The page's two module views were scoped by the repository at a
  depth of one (`src/fill/graph-diagrams.ts`, `diagramSpecsFor`), so they drew that
  single top-level module (`madarch`) and not the level of folders below it (`docs`,
  `scripts`, `src`, `test`, `wiki` …) where the repository's structure actually stands.
  The node budget never came into it: one element is far inside forty.
- **A module's page drew the repository it stands in**, not the module: the same two
  specs, scoped by the repository id, so a module's page showed the level above it.
  Nothing in 0026's "Pages" or "Diagrams" says a module's page is about its repository.
- **Every diagram of a page was drawn the moment the page's diagram answer arrived.**
  A long page mounts two to five Mermaid panels (and, for a tab the reader never opens,
  none), each rendering its own source at once; a diagram far below the reader's window
  paid for its drawing before anyone looked at it, and a frame that had not been filled
  yet stood in the page as an empty box.

This change fixes all three, and walks the same tree as madarch-tzte.23.5 again with the
numbers and the screenshots the task asks for.

## Rationale

`no-behavior`: no requirement moves. Decision 0026's "Diagrams" — "an agent only chooses
what to show (a view specification: type, nodes, scenario, level), which madarch checks
against the graph … a diagram stays readable by size and collapses to the level above
with drill-down" — already asks for a view that shows the structure the graph holds, and
"Pages" already asks for every graph page to be drawn from the graph. What was wrong was
the *choice of nodes* a page made (one level above the structure, and the repository
instead of the module) and the moment a frame was drawn (before the reader could see it).

The fill's capability is proposed by `fill-pipeline-monday` and is not current, so the
graph diagrams' own requirement text lands with the stage that closes decision 0026, as
madarch-tzte.20.1–22.3, 23.1–23.6 recorded theirs.

What a person sees is new: a repository page's module and component diagrams draw the
repository's modules at the first level that has more than one, with their dependency
edges; a module page draws its own child modules and the modules it relates to; a
diagram is drawn when the reader scrolls to it, and says so in the page's own words
until then.

## Out of scope

- **The models themselves.** How a view is built, collapsed, made dashed and ordered is
  madarch-tzte.23.2's (`src/fill/diagrams.ts`); this change adds one depth to the level
  a module view may name (below) and changes no element, arrow or evidence rule.
- **The renderers.** Mermaid, archify and LikeC4 and their switcher are
  madarch-tzte.23.4's; this change draws none of them differently and adds no tab.
- **The page model and its reads.** The page set, the page model and the live channel
  are madarch-tzte.23.1's. Page speed on a large tree is madarch-tzte.23.8's, which the
  worker of this change kept out of the files it touched
  (`src/fill/graph-diagrams.ts`, `src/fill/diagrams.ts`, `wiki/app/src/graph-diagrams.tsx`
  and its catalogues) and rebased on `main` before the final push.
- **`activity`, `class` and `deployment`.** The schema holds no kind for a step, an
  attribute or a deployment target (23.2's own limitation), and no deterministic stage
  writes `table`, `column`, `state`, `transition` or `interaction` (23.5's own evidence).
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not current, as
  the changes before this one recorded theirs.

## Preserved contracts

- product-wiki/pages: unchanged — a document page is still the product's Markdown in git, and a graph page still reads its diagrams from the server as its page stands; a diagram the reader has not reached is held back in the page's own words rather than drawn as an empty frame, and a diagram the reader's tab opens is drawn at once.
- product-wiki/architecture: unchanged — the Architecture section's own views keep their Mermaid, LikeC4 and archify panels and their mount rules; this change's deferral is the graph diagrams section's own.
- product-wiki/internationalization: unchanged — the one string this change adds ("The diagram is drawn when you scroll to it.") is written in English and Russian, and no other string moves.
- server/serves-wiki: unchanged — the routes and the shapes of their answers are as madarch-tzte.23.4 left them; what changes is which nodes a page's diagram specs name, which is the page's own answer and not an address.
- views/deterministic: unchanged — a view is still the same model for the same graph on every machine: the new depth draws the modules a view names in code point order, and the neighbours of a module are chosen by the graph's own edges, sorted by code point.
- release-binary/installers: unchanged — no dependency is added; the app's deferral is the platform's own `IntersectionObserver`.

## Coverage

- product-wiki/pages: test
- product-wiki/architecture: test
- product-wiki/internationalization: test
- server/serves-wiki: test
- views/deterministic: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **A repository page draws the first level of its clustering that has more than one module.** Stage 5 seeds the module tree with the packages and splits a cluster that is over its size threshold by the folder its files stand in, so a repository of one package is one top-level module holding a level of folders: the structure a reader wants is that level. `moduleViewScope` (`src/fill/graph-diagrams.ts`) walks the tree down from the repository while a level holds exactly one module and answers the scope whose children are the first level with more than one; a repository whose top level already has more than one, one whose single module has nothing below it, and one the stages never clustered all answer the repository itself. The page's two module views are then scoped by that module and not by the repository, and the spec's title says which module they draw (`Module dependencies: madarch`).
- **A module page draws its own child modules, and itself among the modules of its level it relates to.** The component view is scoped by the module, which draws the level below it. The module dependencies view names the module *and its neighbours*, at a depth of zero — a new depth (below) — because a neighbour is no child of the module's scope: no element a view of the module's children holds could stand for it.
- **A neighbour is read from the graph's own imports, rolled up the way the view rolls them up.** `moduleNeighbours` takes the modules of the module's level (its parent's children, or the repository's top-level ones), reads the `import` and `dependency` edges of the repository — the two kinds a module-dependency view draws — and rolls each end up to the nearest module of that level in its `contains` chain. So a file importing a file three levels down in another module names that other module, exactly as the view that draws the two folds the arrow. An end the graph does not hold, an end inside the module, and an end that reaches no module of the level (a file at the repository's root outside every module) are no neighbour: the view could not place them either. Two reads per module page, both of kinds the page's own views already read.
- **A depth of zero means the modules a view names themselves.** `module-dependency`'s `level` is its depth under the scopes it names; `0` draws the scopes and `1` (the default) what stands below them, and `modulesBelow` answers the container itself at zero. Nothing else changes: a C4 type still names no level, and a negative level is refused as it was. A collapsed depth-zero view's drill-down opens the modules it stood for at the same depth (its elements are the scopes, not their children).
- **A module with no neighbour has its children drawn twice rather than one box.** A module whose level relates it to nothing (the repository's single top-level module, a leaf no import names) would otherwise draw a diagram of itself. Its module-dependency view falls back to its children — the same elements as its component view, with the two kinds a module dependency is made of.
- **A diagram is drawn when the reader comes near it.** The section mounts a frame's renderer only when the diagram stands within a screenful of the reader's window (`useNearViewport`: 600 px above and below it), and the answer latches: a diagram is drawn once and never again. Until then the page stands in its own words ("The diagram is drawn when you scroll to it."), so a frame is never an empty box; and a tab the reader clicks is drawn at once whatever the position says, so no click is a button that does nothing. A document that lays nothing out (a test's DOM, a hidden container) draws at once: holding a drawing back is an optimisation of a long page, never a condition on the diagram.
  - **The position is read off the element's own box, not taken from `IntersectionObserver`.** The first attempt used the observer with `rootMargin: 600px`, and this change's own walk caught it: in headless Chromium the two diagrams that stood inside the margin at load were drawn, and the two below it stayed deferred through the whole scroll — the observer reported its first state and no later one. A drawing is a reader's, so the app reads the box on every scroll (in the capture phase, so a box inside the page that scrolls counts too), on every resize, once on the next animation frame, and every 400 ms until the diagram is near; then it stops. The walk's numbers below are that mechanism's.
- **The walk reads the page the way a reader does, and says so in numbers.** `scripts/graph-pages-walk.ts` gains a scroll pass: it takes the window from the top of the page to its foot a screenful at a time, waits at each step for the diagram that has just come into view to draw, records every diagram's frame (which renderer is mounted, the Mermaid drawing's boxes, labels and size, the words of a deferred, empty or failed frame), and names in `framesWithoutADrawing` any diagram that still holds no drawing once the reader has been down the whole page. Its screenshots of a diagram are now of the diagram's own tabs and frame (a clip of that box) beside the window shot 23.5's record named.

## Acceptance evidence

Rendered on the pod, the way AGENTS.md asks of a view: the same tree madarch-tzte.23.5
walked, once before this change and once after it, with the numbers the browser
computed. Nothing is estimated, and every figure below is a `STAGE23_WALK` line of the
run named with it.

### The walk's two runs, and what the two numbers are

`scripts/graph-pages-walk.ts` (23.5's walk, this change's scroll pass added) on
SkyPilot (`--avx2`, 2 CPU / 4 GB) over the same product both times: `stage23-product`,
whose code repository `engine` is a shallow checkout of madarch at
`4f67fc2710807d28f75bab8d77351c8fb7f5bc1b` (194 tracked files) — the pin 21.8's and
23.5's walks used. Both fills are the same: **536 units in 412 passes in 80.9 s**, 23
kinds and 19 403 facts, **2 575 pages**.

- **Before** — `/tmp/pre237`, a worktree of `origin/main` `aa19c35b` with the walk's new
  scroll pass and nothing else: `run-20261020-043039` (walk exit **0**, 500 s).
- **After** — this branch: `run-20261020-044152` (walk exit **0**, 496 s; the command
  before it in the same run built the app and ran the suites).

Screenshots: `/home/dev/.cache/madarch-23-7-shots/before/shots/` (35 files) and
`/home/dev/.cache/madarch-23-7-shots/after/shots/` (35 files), fetched from the pods
with `--fetch`; each diagram's screenshot is now a clip of that diagram's own tabs and
frame (`diagram-<type>-<renderer>.png`) beside the window shot 23.5's record named
(`window-diagram-<type>-<renderer>.png`).

### The repository page: one element before, nine after

`engine`'s page, in every renderer tab the type offers (`STAGE23_WALK diagrams`):

| diagram | before | after | elements and arrows (after) |
| --- | --- | --- | --- |
| c4-context | 2 nodes, 180×128, 2 labels at 16 px | 2 nodes, 180×128, 2 labels at 16 px | `engine`, `stage23-product`; no arrow |
| c4-container | 1 node, 168×64 | 1 node, 168×64 | `engine:madarch` |
| c4-component | **1 node, 166×70** | **9 nodes, 765×644**, 12 labels at 16 px, **0 overlaps**, 11 ms | `.beads`, `.githooks`, `.github`, `.shady2k`, `docs`, `schema`, `scripts`, `src`, `test`; 3 arrows: `scripts → src` (import, reference), `test → src` (call, import), `test → scripts` (import) |
| module-dependency | **1 node, 166×70** | **9 nodes, 724×673**, 12 labels at 16 px, **0 overlaps**, 11 ms | the same nine elements; 3 arrows: `scripts → src`, `test → src`, `test → scripts` (import) |
| er | empty, the page's own words, no tab | empty, the page's own words, no tab | the eight deterministic stages write no `table` or `column` fact (23.5's own evidence) |

The same two views in the other renderers, after: archify draws 9 nodes in 698×571 with
24 labels at 8 px and **0 overlaps** (c4-component) and 698×564 (module-dependency), and
LikeC4 draws the component view — `svgs: 3`, `undrawn: null`, its labels `.beads`,
`.githooks`, `.github` … `import, reference` — where 23.5 recorded the page's
`data-likec4-undrawn="empty"` for the one-box views it had (madarch-pdkl's own ground for
the two C4 levels, which still say `empty` here with 2 and 1 elements).

### The module page: the level above it before, its own children after

`madarch`'s page (`STAGE23_WALK page_module`), two diagrams:

- **before**: "C4 components: **engine**", 1 element (`madarch`) — the module's page drew
  the repository it stands in.
- **after**: "C4 components: **madarch**", **9 elements** (`.beads`, `.githooks`,
  `.github`, `.shady2k`, `docs`, `schema`, `scripts`, `src`, `test`) and **3 arrows**
  (`scripts → src`, `test → src`, `test → scripts`); its module-dependency view draws the
  same nine, because this module has no neighbour at its level (`madarch` is the
  repository's only top-level module) and falls back to its children rather than to one
  box.

### Every diagram draws when the reader scrolls to it

The scroll pass takes the repository page (4 340 px, 8 screenfuls at the 1150×900 window)
from its top to its foot and reads every diagram's frame as it comes into view
(`STAGE23_WALK scrollPass`):

- **before**: all **four** Mermaid panels were mounted at load and stood **empty**
  (`panel: "mermaid"`, `drawn: false`, no svg) until their renders resolved — 714 ms and
  715 ms for the first two, and the two below the reader's window stood empty for exactly
  as long, unseen. That is the empty frame the coordinator saw.
- **after**: at the top of the page the three diagrams the reader cannot see yet stand in
  the app's own words ("The diagram is drawn when you scroll to it.") and mount no frame
  at all; the c4-component view (near the first screenful) drew 9 nodes **3 ms** after the
  pass reached it and the module-dependency view **203 ms** after, with the 9 nodes and 3
  arrows above; `framesWithoutADrawing: []` — **no diagram on the page holds an empty
  frame once the reader has been down it**.
- The first attempt at the deferral used `IntersectionObserver`: the walk's own pass
  caught it (the two diagrams inside its 600 px margin drew, the two below it never did),
  which is why the position is read off the element's own box (above).

### Nothing else moved

- The graph's index stands in **3 856 ms** (before 4 926), `engine`'s page in **4 266 ms**
  (before 4 933) and `madarch`'s in **3 333 ms** (before 6 105): the two extra reads a
  module page makes are inside the noise of a page whose reads dominate it, and 23.8's
  own work is untouched.
- The live section is unchanged in kind: the one-file commit
  (`src/stage23walk/probe.ts`, commit `d9c5fbff`) adds two pages to the reader's index
  (**2 575 → 2 577**) in **8 799 ms** with the flag proving no reload, and the two views
  that roll the new import up still draw **9 elements and 3 arrows**, no dashed element
  and no dashed edge, because the import the walk adds stays inside the `madarch` module
  the repository page now draws.
- The ER view, the empty-diagram words and the file refusal are as 23.5 recorded them.

### The checks

Each command's own exit status, on the pod (`--avx2`), on the tree this record is
committed with:

- `bun run check` (`tsc --noEmit`) — **exit 0**; `wiki/app`'s `bun run check` — **exit
  0**.
- The focused root suites: `test/fill-graph-diagrams.test.ts` (new: 10 tests),
  `test/fill-diagrams.test.ts`, `test/fill-diagrams-store.test.ts`,
  `test/graph-diagrams-render.test.ts`, `test/server-graph-diagrams.test.ts`,
  `test/server-graph-pages.test.ts`, `test/fill-graph-pages.test.ts` — **120 pass, 0
  fail, exit 0**.
- `wiki/app`: `bun test` — **221 pass, 0 fail, exit 0** (two new tests: the deferral's
  words and the drawing on the reader's scroll, and a tab the reader opens), `bun run
  build` — **exit 0**.
- The walk above: **exit 0**.
- CI on the exact SHA of the branch and the independent review: named in the queue entry
  (`.integration-queue.md`) and in the task's `check:` receipts, because a rebase can
  move the SHA this record's text cannot follow.

### The independent review

One read-only `prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto`
session over `git diff origin/main...HEAD`, told to run nothing on this machine; its
findings and their answers are in the queue entry, with the commit that answers each.

## DONE WHEN

- A repository page's module-dependency and component diagrams show the repository's modules at the first level that has more than one (the clustering's real structure, within 0026's size bounds, collapsing to the level above with drill-down links), with their dependency edges; a module page shows its own child modules and its neighbours.
- Every diagram on a page draws when the reader scrolls to it (no empty Mermaid frame), proven by rendering a long page top to bottom on the pod.
- Walked again on the same tree as 23.5 with screenshots, element counts per diagram recorded.
