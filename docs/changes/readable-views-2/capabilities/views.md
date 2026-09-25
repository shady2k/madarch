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

## Requirement: labels — Every arrow says what it carries
Every arrow shall carry a short label. An arrow standing for one relation
shall be labelled with that relation's name. An arrow standing for several
shall be labelled with their distinct names in id order joined by "; " when
that is 40 characters or fewer, and otherwise with the number of relations and
the arrow's row in the view's table ("7 relations, see 3"). A relation without
a name shall be named by its interface's contract, or its id where it names no
interface; the model already warned about it when loaded. Every arrow's full
list of names shall be in the view's table.

### Scenario: merged-label
- Given: `checkout-cart` "reserves stock" and `checkout-ui` "shows stock" towards `stock-api`
- When: the view of `shop` is rendered
- Then: the one arrow from `checkout-web` to `stock-api` is labelled "reserves stock; shows stock"

### Scenario: long-merged-label
- Given: five relations from `orders-api`'s modules to `event-bus` whose names together run past 40 characters, making the view's third arrow
- When: the view is rendered
- Then: the arrow is labelled "5 relations, see 3", and row 3 of the view's table lists the five names

### Scenario: unnamed-fallback
- Given: an unnamed relation `checkout-to-orders` naming the interface with contract `http::POST::/api/orders`, and an unnamed relation `checkout-to-stock` with no interface
- When: a view showing both is rendered
- Then: the first arrow is labelled `http::POST::/api/orders` and the second `checkout-to-stock`

## Requirement: mermaid — Views as Mermaid pages
The renderer shall write each view as a Markdown page holding one Mermaid
flowchart: the view's element drawn as a frame around its children, the
neighbours outside it, persons, stores and brokers in their own shapes and
externals marked apart, and, under the diagram, a table of its arrows (row
number, from, to, every name behind the arrow) and links to the page of every
shown element that has a view and to the page one level up. Every flowchart
shall be accepted by Mermaid's parser. Rendered by GitHub's Mermaid in a
1150-pixel column, its labels shall be at least 12 pixels high and none shall
overlap another label or a box.

### Scenario: mermaid-page
- Given: the model of the drill-down scenario
- When: the page of `shop` is rendered
- Then: its flowchart parses, frames `checkout-web` and `catalog-api` inside `shop`, draws `payments` outside it, and the page links to the page of `checkout-web` and to the landscape

## Requirement: likec4 — Views as a LikeC4 workspace
The renderer shall write one LikeC4 workspace holding the element kinds, every
element nested under its parent, every relation with its label, and the same
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
