# Diagram models for C4, module dependencies, ER, state and sequence, drawn from the graph, facts solid and assumptions dashed

Change: madarch-tzte.23.2
Base: c0a297f8f3c9a995685a486e81e508d8563f251b
Tasks: madarch-tzte.23.2
Kind: no-behavior

## Intent

Decision 0026, "Diagrams": "madarch draws them from the graph; an agent only
chooses what to show (a view specification: type, nodes, scenario, level), which
madarch checks against the graph. Types: C4 context, container and component,
module dependencies, sequence, state, activity, class/ER, deployment, use case.
Every diagram carries a switcher over every renderer that supports its type:
archify and Mermaid wherever they do, LikeC4 for C4 and deployment; the first tab
is a setting (MADARCH_WIKI_DIAGRAM). Solid lines are facts, dashed are
assumptions or unresolved; elements link to their pages and code; a diagram stays
readable by size and collapses to the level above with drill-down."

The graph the fill builds is landed: the fact store (`src/fill/fact-store.ts`),
the bounded reads over it (`src/fill/graph-reads.ts`), the schema's kinds
(`src/fill/facts.ts`), and the deterministic stages that publish files, symbols,
packages, tables, columns, modules and the edges between them. Nothing turned any
of it into a diagram: the views capability renders the *registry's* model, and no
code reads a diagram out of the graph at all.

This change adds the pure models the diagrams are drawn from, in one module:

- **`src/fill/diagrams.ts`** — the view specification 0026 gives an agent
  (`type`, `nodes`, `scenario`, `level`), its check against the graph, and the
  model of each of the seven types the schema's kinds answer: C4 context,
  container and component, module dependencies, ER (tables and columns), state
  (states and transitions) and sequence (interactions). Every element carries the
  address of its page and, where its provenance names one, its code place; facts
  are solid and assumptions or unresolved ends are dashed; a view past its node
  budget collapses to the level above, and every collapsed element carries the
  view it stands for as its drill-down link. The module reads the graph through
  a five-method interface (`DiagramGraphReads`) and writes nothing: its one
  implementation, `factStoreDiagramReads`, reads the landed `fill_fact` rows in
  the owner's `snapshot` transaction.

Nothing renders: no route, no page and no command calls this module, and a
diagram appears in a wiki only once madarch-tzte.23.1 serves the page model and
madarch-tzte.23.4 draws the models under its switcher.

## Out of scope

- **The renderers.** Mermaid, archify and LikeC4 text, the tab switcher and
  `MADARCH_WIKI_DIAGRAM` are madarch-tzte.23.4's; this change lands the model they
  draw from and the addresses the elements link to.
- **The pages.** The list of page-worthy nodes, one node's page model and the
  live updates as facts are published are madarch-tzte.23.1's; the wiki app's
  rendering of them is madarch-tzte.23.3's. This change decides only the address
  an element links to (`graphPageHref`), in one function, so the served route
  and the model cannot drift apart in two places.
- **`activity`, `class` and `deployment`.** 0026 names nine types; the schema
  holds no kind that answers these three (no activity or step, no class or
  attribute kind, no deployment target), so a type nothing can be read for is not
  offered, and a spec naming one is refused with the seven that are.
- **Relations that pass through a node that names no repository.** An
  api-endpoint names its contract and an environment variable its name, so the
  reads that scope edges by repository (`edgesIn`) cannot answer `provides` or
  `consumes`, and folding them through the endpoint or the variable onto the
  containers that own them is not done here. Named as a limitation below.
- **Draft facts.** A diagram draws what is published; the draft set another unit
  of a run holds is the page model's business (madarch-tzte.23.1), and a diagram
  that drew a draft as a fact would break 0026's own "solid lines are facts".
- **The fill's capability text.** The requirement this stage serves is proposed
  by `fill-pipeline-monday` and is not current; the rebuild's own requirement text
  lands with the stage that closes decision 0026, as madarch-tzte.20.1, 20.2,
  20.3, 20.4, 21.1, 21.7 and 22.3 recorded theirs.

## Preserved contracts

- product-wiki/pages: a page is still the product's Markdown in git (0017); this module writes no page and no file, and the address it makes is one a served page must answer, named in one function.
- views/deterministic: the same model still produces the same bytes; a diagram model is the same list of elements and arrows on every machine, ordered by label and id, never by a database's collation.
- release-binary/installers: no dependency is added; the models are this repository's own arithmetic over rows it already reads.
- server/protocol: no route, command or help text is added; nothing serves a diagram yet.

## Coverage

- product-wiki/pages: test
- views/deterministic: test
- release-binary/installers: test
- server/protocol: test

## Rationale

`no-behavior`: the change adds one module and its tests. No route answers it, no
page shows it, no command calls it and no stage writes it, so the product behaves
exactly as it did; the behaviour a person sees arrives with madarch-tzte.23.1
(the pages), 23.3 (the app) and 23.4 (the renderers).

The module is a model and not a renderer on purpose: 0026 gives the diagram one
meaning and several renderers, and the one meaning is what has to be checked
against the graph — an unknown node, a kind a type cannot be made of, a level a
type does not have. Putting that check in each renderer would let the three
disagree about what a view is; putting it in the model lets every renderer draw
the same answer, which is what the switcher promises.

## Blocking questions

None.

## Design and decisions

- **The seven types are declared as a table, and what each one is made of is the
  graph's own kinds.** `DIAGRAM_TYPE_DECLARATIONS` names, per type, the kinds a
  view may be scoped by, the kinds its elements are, the edge kinds it draws, the
  kinds its level above stands in and whether an edge's ends roll up to their
  enclosing element. A spec's node of another kind is refused naming the node, its
  kind and the kinds the type takes; an edge named as a node, a node the graph
  does not hold, a level another than the type's own, a scenario on another type
  and a malformed id are each refused by name too. Nothing is dropped to make a
  spec fit.
- **A C4 context is the product's repositories; a container is a package, a deploy
  unit or a table of one; a component is a module of one.** The graph's own
  hierarchy is what each level is read from: repositories for the context, the
  containers 0026 means (something deployed, something built, a store) for level
  2, and the modules stage 5 clusters for level 3. A context view draws the
  relations between systems — call, consumes, dependency, import, inherits,
  interaction, reference, resolves — rolled up to the repositories that hold their
  ends, and not the two that place a node, the two that record where a document or
  a commit points, or a state machine's move inside one node.
- **A module dependency is rolled up from the files and symbols the modules
  hold.** Stage 5 writes `module` facts and `contains` edges and no module-level
  dependency edge; the diagram reads the `import` and `dependency` facts the
  stages published between the members of the view's modules and folds each pair
  of modules into one arrow, whose `facts` are the facts it stands on and whose
  `kinds` are theirs. That is 0026's "module dependencies" at the level the graph
  actually holds them (its record's own "Out of scope" already left the
  module-level rollup unwritten). An import into the view from outside it — a file
  of another repository, a node no module holds — stands for no element of the
  view and is not drawn; an import whose other end the graph does not hold at all
  is drawn, dashed, into a placeholder, because a relation the graph names and no
  unit holds is exactly what a reader must see.
- **ER joins a column to its table by the column's own value, and the schema holds
  no edge between two tables.** `ColumnValue.table` is the table's name and the
  column's repository is its own, so a table element carries the columns that name
  it, in code point order of their labels, with each column's type, page and place.
  A column whose table no fact of the view holds makes that table a dashed
  placeholder carrying the columns — the view says what the graph holds and not
  what it wishes it held. The tables of a view therefore stand beside each other
  with no arrows: `EDGE_END_KINDS` gives `table` no end of any edge kind.
- **A state view is one machine's states and the transitions between them.**
  `StateValue` carries the repository and the machine, so naming one state draws
  every state of its machine and naming a repository draws every machine of it; a
  `transition` is one arrow, named by its event, and a transition into a state no
  unit holds is a dashed arrow into a placeholder.
- **A sequence is drawn in the order the scenario gives, and the graph holds no
  order of its own.** `InteractionEdgeValue` has a caller, a callee and a form, and
  no sequence number, so the order is the chooser's — 0026's "an agent only
  chooses what to show". A scenario names its steps in order (each an `interaction`
  fact, each once); a view with no scenario draws every interaction between its
  participants by the code point order of their two ends and then of the fact. A
  step joined to a node the view does not name as a participant is refused by
  name: a scenario drawn shorter than it was chosen is not the scenario.
- **Solid and dashed are read off the fact, not chosen.** An `inferred` fact is an
  agent's reading and a `rejected` declaration is one a person turned down (0005):
  both are `assumption` and dashed. Every other fact is solid. An arrow one of
  whose ends the graph does not hold is `unresolved` and dashed whatever the fact
  says, and an arrow folding several facts takes the weakest of them — so a
  component arrow that carries one import and one interaction is dashed as the
  interaction is, which is 0026's "solid lines are facts, dashed are assumptions".
  A placeholder element is dashed, has no page and no place, and its id is the
  missing fact's under an `unresolved:` prefix no fact id can carry.
- **Every element links its page, and the address is made in one function.** 0026
  says elements link to their pages and code; `graphPageHref` makes
  `/p/graph/<fact id>` and `diagramHref` makes a view's address from its type, its
  level and its nodes. Neither is escaped: a fact id and a type are URL-safe by
  their own forms, and a reader copies the address it sees. The page-worthy kinds
  are madarch-tzte.23.1's to name; an element of a kind it does not page opens an
  address that answers "no page" rather than a link made up here.
- **The node budget is forty, it collapses rather than dropping, and it repeats.**
  0026 bounds a diagram by what a reader can still read and names no number, so
  forty is this module's own, overridable per call (`limits.nodes`). Past it each
  element is replaced by the level above its type names — a module by its parent
  module, else its repository; a container or a table by its repository — the
  replacements are re-folded, and the collapse repeats until the view fits or
  nothing is left to collapse. A collapsed element carries `standsFor` (the
  elements it replaced, never itself) and a `drillDown` that opens the same type at
  the same level scoped by them. A view no element of which has a level above it
  (every C4 context, every state and sequence view) keeps all its elements and
  says so in `marker`; nothing a budget cannot fit is dropped in silence.
- **The elements and arrows are ordered for a reader and not for a database.**
  Elements by label and then id, columns by label, arrows by their step (a
  sequence), then their two ends and then their first fact — all by code point, so
  a model is the same model on every machine, and a list a reader scans is in the
  order a reader reads. The store's own reads sort too, because PostgreSQL orders
  text by its own collation.
- **A rolled view reads the edges that start in a node of the scope, and not the
  ones that end in it.** The read joins the edge's from end (`EDGE_END_FIELDS`: the
  `from` field, or the `variable` field for `consumes` and `binds`) to its fact's
  repository. Joining both ends would be the prettier query and would answer
  nothing for an edge whose other end no unit holds — the one case 0026 requires to
  be drawn dashed. The other end is the view's own question: it rolls up to an
  element, or it does not stand for the view at all, or it is missing.
- **A relation whose two ends stand for one element is not drawn.** In a context
  view an import from one file of a repository to another rolls up to the
  repository itself; drawing it would be a frame to itself and a page of noise.
  The relation is still there in the graph and on the element's page.
- **Every view is built from five reads, and a test makes each one's answer.**
  `facts` (by id, whatever the kind), `kind` (every node of one kind), `factsWith`
  (one kind by one value field), `edges` (the edges that name one of the given ids
  at an end) and `edgesIn` (the edges that start in the nodes of a repository),
  plus `ancestors` (the `contains` chain upward, and the repository the fact's own
  value names, because a package, a deploy unit and a table stand in a repository
  the graph writes no `contains` edge for). The interface is what lets the pure
  suite draw from a fixture it makes and `fill-diagrams-store.test.ts` draw the
  same models from a PGlite the test fills through the store's own publication.

  - **Open points and known limitations**, named here rather than left to be found:
  - **`activity`, `class` and `deployment` are not offered.** The schema holds no
    kind for a step, an attribute or a deployment target, so these three of 0026's
    nine types are a later task's, with the kinds they need.
  - **Relations through an api-endpoint or an environment variable are not
    drawn.** `provides` ends at an endpoint's contract and `consumes` at a variable
    whose fact names no repository, so `edgesIn` does not answer them and no view
    folds them onto the containers that own them. A container diagram of the
    repository whose `package.json` declares the dependency still draws it, because
    stage 2 writes `dependency` between the packages themselves.
  - **`document-link` and `task-key` are drawn by no type.** They record where a
    document or a commit points, not a relation between two systems or two modules.
  - **A repository the stages have not clustered contributes no module and no
    component element.** The view is then empty rather than drawing the repository
    as if it were a module; a module with nothing below it *is* drawn as itself,
    because the finest cluster is the thing a reader asked to see.
  - **A state and a sequence view cannot collapse.** No element of either has a
    level above it in the graph (`StateValue.machine` is a name, not a node, and a
    participant has no container), so past the budget such a view keeps its
    elements and says the budget was not met. Collapsing a machine's states onto
    the machine would need a machine node the schema does not have.
  - **An ER view has no arrows**, for the reason above: the schema holds no edge
    between two tables. A foreign key between them is a fact nobody writes yet.
  - **The page address is a seam 0023.1 must serve.** `/p/graph/<fact id>` is this
    change's own choice, made in `graphPageHref` alone; madarch-tzte.23.1 serves
    the pages and madarch-tzte.23.3 shows them, and a served route that differs
    moves that one function.
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## DONE WHEN

- A pure module builds diagram models from the fact store for C4 context, container and component, module dependencies, ER (tables and columns), state (state facts and transitions) and sequence (interactions), each from a view specification (type, nodes, scenario, level) that is checked against the graph — an unknown node or a type the nodes cannot form is refused naming it.
- Facts are solid, assumptions or unresolved edges dashed; every element carries the link to its page and, where it has one, its code place.
- A diagram stays readable by size: past a node budget it collapses to the level above with drill-down links. Normally a fixture graph of two modules with one dependency yields a module-dependency model of two nodes and one solid edge.
