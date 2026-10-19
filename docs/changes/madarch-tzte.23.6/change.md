# A node the graph does not hold is named by what the graph knows of it, not by its fact id

Change: madarch-tzte.23.6
Base: a2edc7de06349608349911f88f23ea34c10bf798
Tasks: madarch-tzte.23.6
Kind: no-behavior

## Intent

Defect against stage madarch-tzte.23, seen by the coordinator in
madarch-tzte.23.4's acceptance screenshots: a diagram element — and the page row
beside it — for a node the graph does not hold (an import target whose file fact
no unit holds any more) was labelled with the raw content-addressed fact id, for
example `file:150d60b9…`. The same id stood in the Mermaid module-dependency
diagram, in the diagram's element list, in the LikeC4 workspace and in archify's
page.

This change labels such a node by the name the graph really keeps of it:

- **An import's specifier, as written** (`./gone.js`): the importing file wrote it,
  it is the one name left of a file whose own fact is gone, and it is the name a
  reader can act on.
- **Its kind, where the graph keeps no name** (`state`): a transition of a state
  machine into a state no unit holds carries no specifier, so the label says what
  the element is.

Either way the label is marked `(unresolved)`, so nothing reads as a node the graph
holds, and the fact id stays reachable: the element's own id still carries it, and
the page lists the element with that id as the row's tooltip — the same place
madarch-tzte.23.4 already kept a link target for an element that has no page.

One name is chosen where an end is cited by several: the specifiers in code point
order, the first — a function of the graph alone, so two walks of one graph draw the
same label.

An ER table no fact holds already read as its repository's path and table name
(`acme-shop:public.audit`); it gains the same `(unresolved)` mark, so the three
shapes a placeholder takes — specifier, kind, repository table — say the same thing
in the same words.

## Rationale

`no-behavior`: no requirement changes. Decision 0026's diagrams and
`product-wiki/architecture`'s "one page per view with its diagram drawn in the
browser" already require an end the graph does not hold to be drawn (dashed, marked
`unresolved`); what was wrong was the label the model gave it, which was the one
string on the page that named nothing. The models' elements, arrows, evidence and
pages are unchanged.

## Out of scope

- **Ends the graph holds but that stand in no element of the view.** A file with no
  module above it in a module view is not drawn at all; that is a different question
  from naming an end the graph does not hold, and no requirement asks for it here.
- **The arrow labels.** An arrow is named by its kind or its event (`import`,
  `refund`), never by an end's id, and stays as it was.
- **madarch-tzte.23.4's record and its screenshots.** A change record is history; the
  defect was filed against it and is fixed here.
- **The `mutation` receipt.** The owner runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.

## Preserved contracts

- product-wiki/architecture: unchanged — a view's page still draws its diagram in the browser, and every element still links its page and its place in code.
- views/deterministic: unchanged — a model is still the same bytes for the same graph, and the new label is a function of the graph alone (the specifiers in code point order, else the kind), with nothing read from the clock, a store's collation or a renderer.
- product-wiki/internationalization: unchanged — a diagram's labels are the graph's own data and not app-owned strings; the element list's localized `unresolved` chip stays as it is, and no new app string is added.
- server/serves-wiki: unchanged — the answers carry the same shapes and routes; only the `label` of an element the graph does not hold gains its name and mark.

## Coverage

- product-wiki/architecture: test
- views/deterministic: test
- product-wiki/internationalization: test
- server/serves-wiki: test

## Blocking questions

None.

## Design and decisions

- **The name comes from the edges that cite the end, not from a second read.** The
  graph holds no fact for the end, so the only names of it are on the edges that name
  it: an `import`'s `specifier` is the one field any edge kind carries that names an
  end in words. The names are gathered from the view's own candidate edges
  (`missingEndNames`), which the model already read — no store read is added, and the
  model stays a pure function of the graph.
- **The kind is read off the id's own prefix.** A fact id is `kind:` and the digest,
  so an end the graph no longer holds still says what it was; that is what lets the
  label say `state (unresolved)` rather than repeat the digest.
- **The mark is in the label, not only in the renderer's style.** All three renderers
  draw the label and each marks the dashes in its own way (Mermaid a dashed class,
  LikeC4 `style line dashed`, archify its dashed class); a mark in the label says it
  in the one place every renderer carries, and a reader copying a box gets the word
  with it.
- **The id stays where it was.** The element's own id is `unresolved:` and the fact
  id, the page's row keeps that id as its tooltip, and an arrow's ends are the
  elements' ids — so tracing a name back to the fact an edge cited is unchanged.

## Acceptance evidence

Rendered on the pod (`MADARCH_WIKI_E2E=1` over the production-built app and a real
fill service), and read as the text the browser shows:

- The Mermaid module-dependency diagram draws the label `./gone.js (unresolved)` (and
  never the fact id); archify's page and LikeC4's own view (the C4 component view,
  which rolls the import up from the module that wrote it) carry the same name.
- The element list under the diagram names the element `./gone.js (unresolved)`, and
  its row keeps the id as the tooltip; the diagrams section's text carries no
  content-addressed id.
- Screenshots of that page in every renderer, fetched from the pod into
  `/home/dev/.cache/madarch-diagram-shots-2/`.
- `test/fill-diagrams.test.ts` and `test/fill-diagrams-store.test.ts`: the three shapes
  of a placeholder, no element label is a fact id under any view of the fixture, the
  arrows reaching a placeholder end at its own id, and the label is the same on two
  walks of one graph. `test/graph-diagrams-render.test.ts`: the name in the Mermaid
  source, the LikeC4 workspace and the archify document, and the app's answer carrying
  it with the id beside it.
