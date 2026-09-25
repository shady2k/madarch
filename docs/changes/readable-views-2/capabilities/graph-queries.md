# Graph queries

Capability: graph-queries

## Purpose
Answering the questions views and agents ask of the graph at a time: what is
inside an element, what a view at a given scope and depth shows with relations
collapsed to what is visible, and what depends on what, transitively.
LadybugDB answers them, built from the model history.

## Requirement: as-of — Every answer is for a time on both axes
Every query shall take a valid time and a known time, both defaulting to now,
and a state, defaulting to the first state of the chain, and shall answer from
what the history held for those times; every hop of a traversal is filtered by
them.

### Scenario: dependency-appears
- Given: `orders-api` starts depending on `event-bus` in a commit of 5 September, stored the same day
- When: the elements that depend on `event-bus` are asked as of 3 September and as of 7 September
- Then: the first answer does not include `orders-api`; the second does

## Requirement: children — What is directly inside an element
When the children of an element are asked, the engine shall return the
elements whose parent it is, at the asked time and state. If the element does
not exist then, the answer is an error naming it and the time.

### Scenario: children
- Given: `payments` with the services `payments-api` and `payments-stub`
- When: the children of `payments` are asked
- Then: the answer is `payments-api` and `payments-stub`

## Requirement: view — A view collapses relations to what it shows
When a view is asked for a scope element (or the whole graph) and a depth, the
engine shall return the elements within the scope down to that depth and the
relations between them, each relation lifted to the nearest shown ancestor of
its ends, merged per pair of shown elements with the list of relations behind
it. A refinement is not counted beside the relation it refines, and a relation
whose ends fall inside one shown element is not drawn. When the view is asked
with its context, the engine shall also return, marked as neighbours, the
elements outside the scope that relations cross its boundary to or from, each
end outside lifted to its ancestor (or itself) whose parent is the scope's
parent or one of its ancestors, or which has no parent; those relations are
lifted and merged the same way. In a view with its context, a refinement
whose own end inside the scope is shown below the scope is drawn instead of
the relation it refines when that relation's end inside is the scope itself,
so an element's own view shows the part that does the work. Without a scope
there is nothing outside, and the context adds nothing.

### Scenario: refinement-in-own-view
- Given: `checkout-api` "takes payment" towards the domain `payments`, refined by its module `checkout-payment-step` authorizing through `payments-api`
- When: the view of `checkout-api` is asked with its context
- Then: one relation is drawn, from `checkout-payment-step` to the neighbour `payments`, standing for the refinement, and none from `checkout-api` itself

### Scenario: collapse
- Given: modules `checkout-cart` and `checkout-ui` of `checkout-web` both call `payments-api`
- When: a view of the whole graph at the depth of services is asked
- Then: one relation from `checkout-web` to `payments-api` is shown, with the two calls behind it

### Scenario: refinement-counted-once
- Given: `checkout-uses-payments` from `checkout-web` to `payments` and its refinement `checkout-charges-card` from `checkout-cart` to `payments-api`
- When: a view at the depth of domains and services is asked
- Then: one relation from `checkout-web` to `payments` is shown, standing for both, not two

### Scenario: context
- Given: `checkout-web` in domain `shop` calls `payments-api` in domain `payments`, and `shop` also holds `catalog-api`
- When: a view scoped to `shop` at depth one is asked with its context
- Then: `checkout-web` and `catalog-api` are shown inside the scope, `payments` is shown as a neighbour outside it, and one relation joins `checkout-web` to `payments`

### Scenario: inside-one-box
- Given: `checkout-cart` calls `checkout-ui`, both inside `checkout-web`
- When: a view at the depth of services is asked
- Then: no relation from `checkout-web` to itself is shown

## Requirement: dependencies — What depends on what, transitively
When the dependents or the dependencies of an element are asked, directly or
transitively up to a number of hops, the engine shall return the elements with
the chain of relations that joins each, at the asked time and state.

### Scenario: transitive-dependents
- Given: `checkout-web` calls `orders-api`, which publishes to `event-bus`
- When: the transitive dependents of `event-bus` are asked
- Then: the answer is `orders-api` through one relation and `checkout-web` through two

## Requirement: rebuild — The engine is derived and rebuildable
The query engine shall be built from the model history, updated after each
stored version, and rebuildable from the history at any time with the same
answers.

### Scenario: rebuild
- Given: a history with three versions of two sources, and the answers to a fixed set of queries
- When: the engine is thrown away and rebuilt from the history
- Then: the same queries return the same answers

## Quality requirements
- Performance: a view or a transitive query over a graph of 10 000 elements
  with history answers in under one second on a developer's laptop. Measured,
  since decision 0009 left it open.
- Reliability and recovery: the engine holds no state the history does not;
  losing it loses nothing.
- Compatibility and operation: runs under Bun 1.4.2 with LadybugDB 0.20.4 on
  macOS and Linux.
- Security, data, usability: not applicable beyond model-history.

## Context
Decision 0009 (LadybugDB as the rebuildable query engine), 0014 (relations at
any level, collapsing by projecting ends to the visible representative).

## Coverage limits
Queries per environment, per state difference and ad-hoc Cypher for agents are
not offered yet; the answers are for one state and the logical graph.
