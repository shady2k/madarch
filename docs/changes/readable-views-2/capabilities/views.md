# Views

Capability: views

## Purpose
Turning a stored model into views people read: a set of views from the whole
system down to the modules of a service, rendered as Mermaid pages for
documents and as a LikeC4 workspace for navigation. Every view is computed
from the graph at one time and state; nothing is laid out by hand.

## Requirement: view-set — From the whole system down to modules
When the views of a model are rendered, the renderer shall produce a landscape
view of the elements that have no parent, and one view of every element that
has children, showing its children with their neighbours outside it, all at
one asked time and state (by default now and the first state).

### Scenario: drill-down
- Given: domains `shop` and `payments`, `shop` holding the services `checkout-web` and `catalog-api`, `checkout-web` holding the modules `checkout-cart` and `checkout-ui`, and `payments-api` without children
- When: the views are rendered
- Then: there is a landscape view, a view of `shop`, of `payments` and of `checkout-web`, and none of `payments-api`

## Requirement: labels — Every relation says what it does
Every arrow is drawn from the initiator, as the relations behind it go, and
stands for every relation between the two shown elements. Each relation has a
name and a label. Its name is its own, or for a relation without one its
interface's contract, or its id where it names no interface; the model already
warned about it when loaded. Its label is its name, except for a relation that
marks its action on a topic or queue, whose label is its role there:
"publishes" or "subscribes to" for a topic, "sends to" or "receives from" for a
queue, followed by the topic or queue, its contract after `kind::`
("subscribes to order-placed"). An arrow whose relations all mark their action
is drawn dashed.

### Scenario: event-labels
- Given: `orders-publishes-placed` "publishes order-placed" from `orders-api` to `event-bus` through `topic-order-placed` with `action: send`, and `inventory-reserves-stock` "reserves stock for placed orders" from `inventory-api` to `event-bus` through the same topic with `action: receive`
- When: a view showing all three is rendered
- Then: the second relation's label is "subscribes to order-placed" and its name "reserves stock for placed orders", the first's label and name are both "publishes order-placed", and both arrows go to `event-bus` and are dashed

### Scenario: unnamed-fallback
- Given: an unnamed relation `checkout-to-orders` naming the interface with contract `http::POST::/api/orders`, and an unnamed relation `checkout-to-stock` with no interface
- When: a view showing both is rendered
- Then: the first relation is named `http::POST::/api/orders` and the second `checkout-to-stock`

## Requirement: mermaid — Views as Mermaid pages
The renderer shall write each view as a Markdown page holding one Mermaid
flowchart with straight lines: the view's element drawn as a frame around its
children, the neighbours outside it, persons, stores and brokers in their own
shapes and externals marked apart with dark text on their light fill, and,
under the diagram, a table of its arrows, and links to the page of every shown
element that has a view and to the page one level up. Each arrow shall be
labelled with its row number in that table, dashed where its relations all mark
their action. Each row shall hold the number, the arrow's two ends and every
relation behind the arrow in relation-id order, each by its name, one marking
its action by its label and then its name ("subscribes to order-placed:
reserves stock for placed orders"), or its label alone where the two are the
same, separated by "; ", a text shared by several relations repeated for each. Every flowchart shall be accepted by
Mermaid's parser. Rendered by GitHub's Mermaid in a 1150-pixel column, its
labels shall be at least 12 pixels high and none shall overlap another label or
a box.

### Scenario: mermaid-page
- Given: the model of the drill-down scenario
- When: the page of `shop` is rendered
- Then: its flowchart parses, frames `checkout-web` and `catalog-api` inside `shop`, draws `payments` outside it, and the page links to the page of `checkout-web` and to the landscape

### Scenario: numbered-arrows
- Given: `checkout-cart` "reserves stock" and `checkout-ui` "shows stock" towards `stock-api`, the only arrow of the view of `shop` besides one to `payments` that sorts before it
- When: the page of `shop` is rendered
- Then: the arrow from `checkout-web` to `stock-api` is labelled "2", and row 2 of the table lists "reserves stock; shows stock"

### Scenario: event-row
- Given: the model of the event-labels scenario
- When: its page is rendered
- Then: the row of the arrow from `inventory-api` lists "subscribes to order-placed: reserves stock for placed orders", the row of the arrow from `orders-api` "publishes order-placed", and both arrows are drawn dashed

## Requirement: likec4 — Views as a LikeC4 workspace
The renderer shall write one LikeC4 workspace holding the element kinds, every
element nested under its parent, every relation labelled with its label (a
relation marking its action drawn dashed), and the same
views as the view set, so that opening an element leads to its own view. The
workspace shall pass `likec4 validate`.

### Scenario: likec4-validates
- Given: the model of the drill-down scenario
- When: its LikeC4 workspace is rendered and validated
- Then: validation passes, and the workspace has the views `index`, `shop`, `payments` and `checkout-web`

## Requirement: deterministic — Same model, same bytes
When the same model is rendered twice at the same time and state, the renderer
shall write byte-identical files.

### Scenario: twice
- Given: one model
- When: its views are rendered twice
- Then: every file is byte-identical

## Quality requirements
- Performance: rendering every view of a model of 1 000 elements nested as a
  system is (a few levels: domains, services, modules) takes under ten seconds
  on a developer's laptop.
- Usability: the landscape of a large system stays readable only if the model
  keeps its top level small; the renderer draws what the model holds and does
  not regroup it.
- Reliability, security, data: not applicable beyond graph-queries; rendering
  writes only the files it is asked to.
- Compatibility and operation: Mermaid pages render on GitHub; the LikeC4
  workspace validates with the pinned `likec4`.

## Context
Decisions 0001 (the graph as backend, frontends replaceable) and 0014
(relations collapsed to what is visible). Glossary: view, renderer.
Capabilities graph-queries (views with context) and compiled-model (names,
kinds, contracts).

## Coverage limits
Views per environment and per architecture state, zones drawn as boundaries,
flows, and layout beyond what Mermaid and LikeC4 choose are not offered yet.
Mermaid's parser accepting a flowchart is checked automatically; the label
size and overlaps are checked by rendering every page at acceptance, not in CI.
Element ids that differ only by letter case are not rendered as pages.
Nesting hundreds of levels deep renders, but slowly: the time grows with the
square of the depth. LikeC4 cannot draw a relation of an element with itself
or with its own descendant; such relations are left out of the workspace and
listed by the renderer, never dropped silently.
