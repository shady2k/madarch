# 0015. Architecture states are a chain inside the intended model

Status: accepted
Date: 2026-09-24

## Context and problem
Architects draw the system as it is and as it should become, often through
transition stages. The model must hold these states so that as-is, to-be and
the difference between them are views of one graph, reviewed together. Views
for states are not in the first milestone, but the format and the storage must
carry them from the start: changing the format later is the most expensive
change there is.

## Considered options
1. To-be lives on a git branch; as-is is the main line.
2. Named states inside the model, ordered as a chain; an element or relation
   may start or end at a state.
3. To-be as future valid time on the history axis (0009).

## Decision
Option 2. The model declares its states (`as-is`, transition stages, `to-be`),
each after the one before it (`after`). An element or relation exists from a
state and until a state; with neither it exists in all of them. A view is asked
for one state; the difference between two states is computed.

States are independent of environments (production in to-be is a valid
question) and of history (the to-be approved in March is the model's version at
that time).

## Consequences
- As-is and to-be live on the main line and are reviewed in one pull request;
  a long-lived target is not a branch nobody merges.
- Every element and relation gains two optional fields; the schema and
  examples must keep them out of the way of a model that uses no states.
- Strongest argument against: option 1 needs no format change and git already
  shows differences; it fails for targets that live for months and for several
  transition stages at once.
- Revisit if real models need branching futures (two alternative to-be states
  from one as-is) rather than one chain.
